import type { TaskStatus } from './enums';

/**
 * Task state machine — contract §6, contract §15 A3 (approval is a precondition,
 * not a state).
 *
 * The table is exhaustive by type: adding a status to `TaskStatus` without giving
 * it a row here is a compile error, so a missing edge is caught by `tsc`, not by a
 * task stuck in `queued` in production.
 *
 * Exactly these edges exist. Self-transitions do not, including `failed → failed`:
 * retrying is `blocked → ready → queued`, which is an explicit, auditable path.
 */
export const TASK_TRANSITIONS = {
  draft: ['ready'],
  ready: ['queued'],
  queued: ['running', 'cancelled'],
  running: ['verifying', 'failed', 'cancelled'],
  verifying: ['succeeded', 'failed', 'blocked'],
  blocked: ['ready'],
  succeeded: [],
  failed: [],
  cancelled: [],
} as const satisfies Record<TaskStatus, readonly TaskStatus[]>;

/**
 * Pure predicate. No I/O, no ambient state — the API, the worker and a test can
 * all ask the same question and get the same answer.
 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return (TASK_TRANSITIONS[from] as readonly TaskStatus[]).includes(to);
}

/**
 * True for the only edge that must carry an explanation: returning a task to
 * `ready` from `blocked` (the retry path, contract §6). `draft → ready` is the
 * initial promotion and needs no justification.
 */
export function transitionRequiresReason(from: TaskStatus, to: TaskStatus): boolean {
  return to === 'ready' && from !== 'draft';
}
