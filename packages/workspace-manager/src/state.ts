import { IllegalTransitionError } from './errors';

/**
 * The workspace lifecycle, matching `WorkspaceState` in `schema.prisma` exactly.
 * Two lists of the same eight names is a migration waiting to happen, so the test
 * suite asserts the enum is the source of truth.
 */
export const WORKSPACE_STATES = [
  'requested',
  'provisioning',
  'ready',
  'executing',
  'preserving',
  'completed',
  'failed',
  'cancelled',
] as const;

export type WorkspaceState = (typeof WORKSPACE_STATES)[number];

/**
 * The legal edges. Exported as data, not hidden in a `switch`, because the worker
 * needs to render "what could happen next" and a reviewer needs to read it.
 *
 * Deliberate choices:
 *
 * - `provisioning -> requested` exists **only** for recovery: a provisioning run that
 *   died before touching the disk is indistinguishable from one that never started,
 *   so it is reset rather than failed. Nothing else may move backwards.
 * - `ready -> executing` and `executing -> ready` are both legal: a run can finish and
 *   the next attempt reuse the same directory (a retry on a warm workspace).
 * - `preserving` is a distinct state, not a flag: "we are deleting the working tree
 *   but keeping the evidence" must survive a crash, or a retry deletes the evidence.
 * - `completed`, `failed` and `cancelled` are terminal. `failed -> provisioning`
 *   does **not** exist: a failed workspace is evidence, and reusing its directory
 *   would make the failure unreproducible. A retry gets a new `workspaceId`.
 */
export const WORKSPACE_TRANSITIONS: Readonly<Record<WorkspaceState, readonly WorkspaceState[]>> = {
  requested: ['provisioning', 'cancelled'],
  provisioning: ['ready', 'failed', 'requested', 'cancelled'],
  ready: ['executing', 'preserving', 'cancelled'],
  executing: ['ready', 'preserving', 'completed', 'failed', 'cancelled'],
  preserving: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: WorkspaceState, to: WorkspaceState): boolean {
  return WORKSPACE_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: WorkspaceState, to: WorkspaceState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/** Terminal states never become anything else. Used by `cleanup` and `recover`. */
export function isTerminal(state: WorkspaceState): boolean {
  return WORKSPACE_TRANSITIONS[state].length === 0;
}
