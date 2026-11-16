import { z } from 'zod';

import { validateProgrammeGraph, type ProgrammeGraphIssue } from './programme-graph';

/**
 * The proposed-plan contract — model output, treated as untrusted input.
 *
 * ## The one sentence this file exists to make true
 *
 * **The planner proposes; deterministic validation judges; a human authorises; the
 * existing programme workflow executes.** Nothing here converts a model's output into
 * execution authority. A `ProposedPlanV1` is *data*: it has no status, no approver, no
 * content hash, no programme id and no provider. Those fields belong to the `Plan` row,
 * which only the API writes.
 *
 * ## Why the schema is strict at every level
 *
 * `.strict()` on the root and on each task means an extra key is a validation failure,
 * not a field to be ignored. That is the mechanism behind "a model cannot claim its own
 * provider": a response carrying `provider`, `simulated`, `status`, `approvedById` or
 * `programmeId` is rejected outright rather than silently dropped. Silently dropping it
 * would leave the response readable and the claim unrecorded; rejecting it makes the
 * attempt visible in the failure.
 *
 * ## Why the caps mirror `CreateTaskInput`
 *
 * A plan that validates but cannot be materialised as a `Task` is a trap: it can be
 * approved and then fail at submission, after a human has spent a decision on it. So
 * `title` and `goal` carry the same limits as `CreateTaskInput` (`120`, `4000`), task
 * count matches `SubmitProgrammeInput` (`50`), and criteria match the task boundary
 * (`20` items, `1000` characters each). The numbers are duplicated rather than imported
 * because the DTO is the *task* boundary and this is the *plan* boundary: if they ever
 * diverge, the divergence should be a visible diff, not one constant serving two
 * contracts with different reasons.
 *
 * ## What is *not* decided here
 *
 * `riskClass` is the model's **claim**. Phase 4 (D-006) derives the effective class
 * server-side when the task is created; the claim is recorded and compared, never
 * obeyed. The type is here so the proposal can state its intent; the authority is not.
 */

/** Bumping this is a migration: a stored proposal is re-read against the version it was written under. */
export const PLAN_VERSION = 1;

/**
 * A task key: a slug, not a uuid.
 *
 * The planner does not know database ids — the tasks do not exist when it proposes. What
 * it does know is a short stable name it can use to express edges, so `dependsOn` refers
 * to keys. The server maps them to real ids at submission, after creation.
 */
export const PLAN_TASK_KEY = /^[a-z][a-z0-9-]{1,63}$/;

export const ProposedPlanTaskV1 = z
  .object({
    key: z.string().regex(PLAN_TASK_KEY, {
      message: 'must be a slug: lower-case letters, digits and hyphens, starting with a letter',
    }),
    title: z.string().trim().min(1).max(120),
    goal: z.string().trim().min(1).max(4000),
    acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)).min(1).max(20),
    dependsOn: z.array(z.string().regex(PLAN_TASK_KEY)).max(50).default([]),
    riskClass: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  })
  .strict();

export const ProposedPlanV1 = z
  .object({
    version: z.literal(PLAN_VERSION),
    objective: z.string().trim().min(1).max(500),
    tasks: z.array(ProposedPlanTaskV1).min(1).max(50),
    assumptions: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
    unresolved: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  })
  .strict();

export type ProposedPlanTaskV1 = z.infer<typeof ProposedPlanTaskV1>;
export type ProposedPlanV1 = z.infer<typeof ProposedPlanV1>;

/**
 * The issue vocabulary. Deliberately the same codes as `validateProgrammeGraph`, because
 * a plan and a programme are judged by the same rules — a second vocabulary would let
 * the two disagree about what "cycle" means.
 */
export type PlanIssueCode =
  | 'empty'
  | 'duplicate_task'
  | 'self_dependency'
  | 'unknown_dependency'
  | 'cycle'
  | 'missing_acceptance_criteria';

export interface PlanIssue {
  readonly code: PlanIssueCode;
  /** The plan task key the issue belongs to; `null` only for an issue about the plan. */
  readonly taskKey: string | null;
  /** One sentence, addressed to whoever authored the plan. */
  readonly message: string;
}

export interface PlanValidation {
  /** True exactly when `issues` is empty. */
  readonly ok: boolean;
  readonly issues: readonly PlanIssue[];
}

/**
 * The synthetic id space the shared validator sees.
 *
 * `validateProgrammeGraph` speaks task ids because its other caller validates rows that
 * already exist. A plan's tasks do not exist yet, so each key is projected into a
 * distinct id space. The prefix is what makes the projection reversible: translating
 * back is a prefix strip, not a lookup that can silently miss.
 */
const PLAN_ID_PREFIX = 'plan:';

/**
 * Validate a plan's *graph*, delegating every rule to `validateProgrammeGraph`.
 *
 * This function deliberately implements **no** graph rule of its own. Cycle detection,
 * duplicate keys, self-dependency, unknown dependency and missing acceptance criteria are
 * all answered by the shared validator, which is what keeps `POST /plans` and
 * `POST /programmes` from disagreeing about a graph one of them accepts.
 *
 * The three checks that look local are already enforced by the schema above and are
 * therefore *not* repeated here — a rejected `dependsOn` key is `unknown_dependency` in
 * the shared validator, an empty trimmed `title`/`goal` is a Zod failure before this
 * runs, and `tasks.length > 50` is a Zod failure too. Re-checking any of them would be a
 * second validator wearing a helper's name, and a test proves the boundary rather than a
 * duplicate check pretending to be one.
 *
 * Pure: no I/O, no clock, no randomness. The same plan always produces the same report.
 */
export function validateProposedPlan(plan: ProposedPlanV1): PlanValidation {
  const graph = validateProgrammeGraph(
    plan.tasks.map((task) => ({
      taskId: `${PLAN_ID_PREFIX}${task.key}`,
      dependsOn: task.dependsOn.map((dependency) => `${PLAN_ID_PREFIX}${dependency}`),
      acceptanceCriteria: task.acceptanceCriteria,
    })),
  );

  const issues = graph.issues.map(toPlanIssue);

  return { ok: issues.length === 0, issues };
}

/**
 * Translate one shared-validator issue back into the plan's key space.
 *
 * The message is the shared one with the synthetic prefix removed, so a reader sees
 * `Task build depends on test, which is not a task in this plan.` and never `plan:build`.
 * Order is inherited from the validator, which iterates in declaration order — a report
 * that reorders itself between runs is hard to talk about.
 */
function toPlanIssue(issue: ProgrammeGraphIssue): PlanIssue {
  return {
    code: issue.code,
    taskKey: issue.taskId === null ? null : stripPrefix(issue.taskId),
    message: issue.message.split(PLAN_ID_PREFIX).join(''),
  };
}

function stripPrefix(taskId: string): string {
  return taskId.startsWith(PLAN_ID_PREFIX) ? taskId.slice(PLAN_ID_PREFIX.length) : taskId;
}

/**
 * The canonical serialisation an approval hash is taken over.
 *
 * ## Why canonical, and why not `JSON.stringify(proposal)`
 *
 * The hash is the approval's binding: "yes, to *this* content". Two structurally equal
 * plans must hash identically (otherwise a retry that reorders tasks invalidates an
 * approval it did not change) and any changed word must hash differently. So:
 *
 *   - fields are enumerated in a **declared order**, not in whatever order the model
 *     emitted them;
 *   - tasks are sorted by `key`, and `dependsOn` is sorted, because an edge list is a set
 *     and the model has no reason to emit it in one order;
 *   - `acceptanceCriteria` is **not** sorted — order is part of what was agreed ("first
 *     this, then that"), and reordering it is a change to the plan;
 *   - `assumptions` and `unresolved` keep their declared order for the same reason.
 *
 * `version` and `objective` lead so a hash can be eyeballed against its plan.
 *
 * The hash is taken over exactly this string — see `planContentHash` in `./plan-hash.ts`.
 */
export function canonicalPlanContent(plan: ProposedPlanV1): string {
  const tasks = [...plan.tasks]
    .sort((left, right) => compareKeys(left.key, right.key))
    .map((task) => ({
      key: task.key,
      title: task.title,
      goal: task.goal,
      acceptanceCriteria: [...task.acceptanceCriteria],
      dependsOn: [...task.dependsOn].sort(compareStrings),
      riskClass: task.riskClass,
    }));

  return JSON.stringify({
    version: plan.version,
    objective: plan.objective,
    tasks,
    assumptions: [...plan.assumptions],
    unresolved: [...plan.unresolved],
  });
}

/**
 * The digest itself lives in `./plan-hash.ts`, not here, and deliberately not on the root
 * barrel: `@intelligenz/contracts` is bundled into the Temporal workflow sandbox, whose
 * webpack build refuses the `node:` scheme. This module must stay pure (schemas,
 * comparators, string building) so a workflow can import the contract without dragging a
 * Node built-in into the sandbox. The API imports the hash from
 * `@intelligenz/contracts/plan-hash`, where `node:crypto` is available and appropriate.
 */

/**
 * Where a proposal came from. **Outside** `ProposedPlanV1` on purpose.
 *
 * A model that could set `provider: 'human'` or `simulated: false` would be attesting to
 * its own authenticity, which is the one claim it must never control. Provenance is
 * assembled by the provider implementation after it has actually made the call; the
 * proposal schema is `.strict()`, so a model that tries to supply these keys fails
 * validation rather than having them ignored.
 */
export const PlannerProvenance = z
  .object({
    /** The provider implementation's own name, e.g. `http-llm`. Never model-supplied. */
    provider: z.string().trim().min(1).max(100),
    /** The configured model id, or `null` when the provider has none. */
    model: z.string().trim().min(1).max(200).nullable().default(null),
    /**
     * Defaults to `true` — "simulated" is the safe assumption. Only a provider that
     * actually performed a model call may construct this with `false`.
     */
    simulated: z.boolean().default(true),
  })
  .strict();

export type PlannerProvenance = z.infer<typeof PlannerProvenance>;

function compareKeys(left: string, right: string): number {
  return compareStrings(left, right);
}

/** One comparator for every sort here, so "stable" does not depend on locale. */
function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;

  return 0;
}
