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

export const CreateTaskInput = z
  .object({
    title: z.string().trim().min(1).max(120),
    goal: z.string().trim().min(1).max(4000),
    riskClass: RiskClass,
    // Optional at the boundary: the database default ('normal') is the single
    // place that decision is made.
    priority: TaskPriority.optional(),
    acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)).max(20),
  })
  .strict();

export type CreateTaskInput = z.infer<typeof CreateTaskInput>;

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
