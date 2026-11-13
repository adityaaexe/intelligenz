import { type TaskStatus } from '@intelligenz/contracts';

/**
 * The subset of the task state machine a **user** may drive.
 *
 * `canTransition` in `@intelligenz/contracts` stays the global truth: the worker
 * performs the execution edges, and `PATCH` is not the worker. Without this
 * narrower table a MEMBER could walk
 *
 *   ready → queued → running → verifying → succeeded
 *
 * over four `PATCH` calls and produce a terminal "success" with no workflow run,
 * no agent run and no artifact. That is not a permission bug in one endpoint, it
 * is the product's central integrity claim ("a succeeded task was executed and
 * verified") being writable by any member. The machine says the *task* may reach
 * `succeeded`; only the thing that did the work may set it.
 *
 * Exactly two edges are a human's:
 *
 *   - `draft → ready`   — the initial promotion, the owner's decision to schedule.
 *   - `blocked → ready` — the retry path, and it must carry a reason.
 *
 * Everything else is system-managed:
 *
 *   `ready → queued`, `queued → running`, `running → verifying`,
 *   `verifying → succeeded|failed`, `running → failed`.
 *
 * Cancellation is not here because it has its own endpoint (`POST …/cancel`),
 * which also cancels the Temporal execution — a `PATCH` to `cancelled` would
 * have changed the row while the workflow kept running.
 */
export const HUMAN_TRANSITIONS = {
  draft: ['ready'],
  blocked: ['ready'],
} as const satisfies Partial<Record<TaskStatus, readonly TaskStatus[]>>;

/** Every edge the orchestrator owns, named so the refusal message can be precise. */
export const SYSTEM_MANAGED_TRANSITIONS = [
  'ready→queued',
  'queued→running',
  'running→verifying',
  'verifying→succeeded',
  'verifying→failed',
  'running→failed',
] as const satisfies readonly `${TaskStatus}→${TaskStatus}`[];

/**
 * True only for the edges in `HUMAN_TRANSITIONS`. A pair that is not a legal edge
 * at all is `false` too, so callers must test `canTransition` first to keep the
 * two refusals (422 illegal / 409 system-managed) distinct.
 */
export function isHumanTransition(from: TaskStatus, to: TaskStatus): boolean {
  const allowed = HUMAN_TRANSITIONS[from as keyof typeof HUMAN_TRANSITIONS] as
    readonly TaskStatus[] | undefined;

  return allowed?.includes(to) ?? false;
}
