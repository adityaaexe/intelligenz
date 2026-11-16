import { z } from 'zod';

import { Environment, RiskClass, TaskPriority, TaskStatus } from './enums';

/**
 * Request DTOs.
 *
 * Rules that apply to every schema in this file:
 * - `.strict()` — an unknown field is a client bug, not something to strip
 *   silently. It also makes "orgId in the body" impossible by construction
 *   (ADR-005): there is no tenant field to populate.
 * - `orgId`, `userId`, roles and timestamps are never accepted from a request.
 *   They are resolved from the authenticated membership.
 * - Strings are trimmed before they reach the database, so `" Acme "` and
 *   `"Acme"` cannot become two rows that look identical in the UI.
 */

/**
 * Email is normalised at the boundary (contract §15 A5): stored lower-cased with
 * a unique index, no `citext` dependency. `pipe` makes the order explicit —
 * trim, lower-case, then validate the result.
 */
const NormalisedEmail = z.string().trim().toLowerCase().pipe(z.email());

export const LoginInput = z
  .object({
    email: NormalisedEmail,
    password: z.string().min(8).max(200),
  })
  .strict();

export type LoginInput = z.infer<typeof LoginInput>;

export const CreateProjectInput = z
  .object({
    // Short, stable, human-quoted identifier ("CTRL", "REVEIL"). Upper-case so
    // two clients cannot produce "ctrl" and "CTRL" as different projects.
    key: z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{2,8}$/, {
        message: 'key must be 2-8 upper-case alphanumeric characters',
      }),
    name: z.string().trim().min(1).max(80),
    environment: Environment,
  })
  .strict();

export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

/**
 * Execution profiles a task may request. Deliberately a closed set: the profile is
 * part of an approval's binding and a free-text value would make "the same profile"
 * unfalsifiable. Adding one is a policy change, not a client choice.
 */
export const ExecutionProfile = z.enum(['standard', 'heavy']);
export type ExecutionProfile = z.infer<typeof ExecutionProfile>;

export const CreateTaskInput = z
  .object({
    title: z.string().trim().min(1).max(120),
    goal: z.string().trim().min(1).max(4000),
    /**
     * **Advisory only** since Phase 4 (D-006). The server derives the effective class
     * in `apps/api/src/risk` and stores that; this field is kept so an existing client
     * does not break, and so a disagreement between what the caller asserted and what
     * the policy derived can be recorded (`clientAttemptedDowngrade`) instead of
     * silently dropped. Optional because a caller no longer has to guess a class.
     */
    riskClass: RiskClass.optional(),
    // Optional at the boundary: the database default ('normal') is the single
    // place that decision is made.
    priority: TaskPriority.optional(),
    acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)).max(20),
    /**
     * The execution profile the task is expected to run under. Part of the approval
     * binding: a grant for `standard` must not authorise `heavy`. Server default is
     * `standard` (`DEFAULT_EXECUTION_PROFILE` in the API).
     */
    executionProfile: ExecutionProfile.optional(),
    /**
     * Where the work will be checked out from, and the exact commit it is pinned to.
     * Both are part of the approval binding and of the repository-trust signal: a repo
     * is `trusted` only when it matches an allowlisted source AND the commit is pinned.
     */
    sourceRef: z.string().trim().min(1).max(500).optional(),
    baseCommit: z.string().trim().regex(/^[0-9a-f]{7,64}$/, {
      message: 'baseCommit must be 7-64 lower-case hex characters',
    }).optional(),
    /**
     * Server-owned fields. Declared so `.strict()` accepts a body that still carries
     * them (a stale client, or someone probing for a bypass) and then dropped before
     * the service sees it. They are never read: a client cannot label its own work.
     */
    riskSource: z.unknown().optional(),
    derivedRiskClass: z.unknown().optional(),
    riskPolicyVersion: z.unknown().optional(),
    riskFactors: z.unknown().optional(),
  })
  .strict()
  .transform((value) => {
    const {
      riskSource,
      derivedRiskClass,
      riskPolicyVersion,
      riskFactors,
      ...accepted
    } = value;

    // Explicitly discarded. `void` reads keep the bindings meaningful to the type
    // checker and to a reviewer; the request succeeds with server values.
    void riskSource;
    void derivedRiskClass;
    void riskPolicyVersion;
    void riskFactors;

    return accepted;
  });

export type CreateTaskInput = z.infer<typeof CreateTaskInput>;

/**
 * The execution request. A body is optional (`RunTaskInput.default({})` at the route),
 * so `POST /run` with no body keeps working.
 *
 * Everything here is an **assertion**, not a command: the API compares it with the
 * binding recorded on the approval and refuses on a mismatch. The grant is for
 * (content, profile, source, commit); a run that intends to use a different profile or
 * checkout cannot spend it.
 */
export const RunTaskInput = z
  .object({
    executionProfile: ExecutionProfile.optional(),
    sourceRef: z.string().trim().min(1).max(500).optional(),
    baseCommit: z.string().trim().regex(/^[0-9a-f]{7,64}$/, {
      message: 'baseCommit must be 7-64 lower-case hex characters',
    }).optional(),
  })
  .strict();

export type RunTaskInput = z.infer<typeof RunTaskInput>;

/**
 * Status change payload.
 *
 * `reason` is mandatory when a task is put back into `ready`. The state machine
 * allows `draft → ready` and `blocked → ready`; the DTO cannot see the current
 * status, so it requires a reason for every `status: 'ready'` request. That is
 * stricter than the retry case alone, and deliberately so: it guarantees the
 * retry path can never arrive without a reason. `transitionRequiresReason()`
 * carries the precise per-edge rule for the service layer.
 */
export const UpdateTaskStatusInput = z
  .object({
    status: TaskStatus,
    reason: z.string().trim().min(1).max(2000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === 'ready' && value.reason === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'A reason is required when a task is moved to ready.',
      });
    }
  });

export type UpdateTaskStatusInput = z.infer<typeof UpdateTaskStatusInput>;

/**
 * A programme submission: one objective, expressed as a dependency graph over tasks that
 * already exist.
 *
 * The graph is written against **task ids**, not node ids the server would have to mint
 * first — the caller creates the tasks, so the caller knows them. `dependsOn` is the only
 * edge in the system. It is validated by `validateProgrammeGraph` before anything is
 * persisted, and validated again by the parent workflow before anything is dispatched.
 *
 * `objective` is not parsed and not executed. It is the sentence an operator reads on the
 * programme page, and the reason a programme row exists at all: "these five tasks are one
 * objective" is not information any single task row carries.
 */
export const SubmitProgrammeInput = z
  .object({
    projectId: z.uuid(),
    objective: z.string().trim().min(1).max(500),
    tasks: z
      .array(
        z
          .object({
            taskId: z.uuid(),
            // Duplicate edges are tolerated by the validator (the same edge twice), so
            // the array is not deduplicated here — refusing it would be taste, not safety.
            dependsOn: z.array(z.uuid()).max(50).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

export type SubmitProgrammeInput = z.infer<typeof SubmitProgrammeInput>;

/**
 * Cursor pagination. `limit` is coerced because query strings are text; the
 * default lives here so every list endpoint has the same page size.
 */
export const PaginationQuery = z
  .object({
    cursor: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type PaginationQuery = z.infer<typeof PaginationQuery>;
