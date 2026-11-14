import { IllegalTransitionError } from './errors';

/**
 * The workspace lifecycle, matching `WorkspaceState` in `schema.prisma` exactly.
 * Two lists of the same names is a migration waiting to happen, so the test
 * suite asserts the enum is the source of truth.
 *
 * ## Phase 4: the states a durable reaper needs
 *
 * The Phase 3 vocabulary described what happened to a *run*. It had no way to say what
 * happens to the **directory** after the process that owned it is gone, so `failed` was
 * overloaded for both "the run failed" and "the cleanup failed", and a leaked directory
 * was indistinguishable from a successful run whose bytes were simply still there.
 *
 *   allocated        a row exists and a path is reserved; nothing written yet
 *   finalizing       the run is over; artifacts still being collected
 *   cleanup_pending  reclaimable, queued for the reaper (retried in place)
 *   cleaned          bytes gone, verified
 *   cleanup_failed   the reaper tried three times and gave up; an operator decides
 *   quarantined      deliberately retained (incident, evidence hold); never reaped
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
  'allocated',
  'finalizing',
  'cleanup_pending',
  'cleaned',
  'cleanup_failed',
  'quarantined',
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
 *
 * Phase 4 additions:
 *
 * - **Every non-terminal state can reach `cleanup_pending`.** That is the whole point of
 *   a reaper: it acts on whatever state a dead worker left behind. There is no
 *   "recoverable" subset to enumerate, because the reaper's evidence is the lease, not
 *   the state.
 * - **`cleanup_pending` does not go back to itself.** A retry inside the reaper keeps
 *   the row in `cleanup_pending` and increments `cleanupAttempts`; the state only
 *   changes when the outcome is known, so a crash mid-cleanup leaves a row that says
 *   "still reclaimable" rather than one that lies about progress.
 * - **`cleanup_failed` is terminal.** Retries happen *before* it, bounded at three. If
 *   it were retryable the reaper would loop forever on a directory it cannot remove,
 *   and "three attempts then a human" is the only honest stopping rule. An operator
 *   requeues by writing `cleanup_pending` themselves, which is a decision with a name
 *   attached to it.
 * - **`quarantined` is reachable from any non-terminal state and from `cleanup_pending`**,
 *   because holding evidence is always allowed. It is terminal: nothing reaps it.
 * - **`completed` is terminal and does not reach `cleanup_pending`.** A completed
 *   workspace whose bytes were not removed is a cleanup that failed *after* the run, and
 *   that is expressed by `cleanedAt` being null — the reaper sweeps terminal rows with
 *   `cleanedAt IS NULL` separately, rather than by inventing a transition out of a
 *   terminal state.
 */
export const WORKSPACE_TRANSITIONS: Readonly<Record<WorkspaceState, readonly WorkspaceState[]>> = {
  requested: ['allocated', 'provisioning', 'failed', 'cancelled', 'cleanup_pending', 'quarantined'],
  allocated: ['requested', 'provisioning', 'failed', 'cancelled', 'cleanup_pending', 'quarantined'],
  provisioning: ['ready', 'failed', 'requested', 'cancelled', 'cleanup_pending', 'quarantined'],
  ready: ['executing', 'preserving', 'failed', 'cancelled', 'cleanup_pending', 'quarantined'],
  executing: [
    'ready',
    'preserving',
    'completed',
    'failed',
    'cancelled',
    'cleanup_pending',
    'quarantined',
  ],
  preserving: ['finalizing', 'completed', 'failed', 'cancelled', 'cleanup_pending', 'quarantined'],
  finalizing: ['completed', 'failed', 'cancelled', 'cleanup_pending', 'quarantined'],
  cleanup_pending: ['cleaned', 'cleanup_failed', 'quarantined'],
  completed: [],
  failed: [],
  cancelled: [],
  cleaned: [],
  cleanup_failed: [],
  quarantined: [],
};

export function canTransition(from: WorkspaceState, to: WorkspaceState): boolean {
  return WORKSPACE_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: WorkspaceState, to: WorkspaceState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/**
 * Terminal states never become anything else. Used by `cleanup` and `recover`.
 *
 * Structurally defined — "terminal" is exactly "no outgoing edge" — so this cannot drift
 * from `WORKSPACE_TRANSITIONS`. The six terminal Phase 4 labels (`cleaned`,
 * `cleanup_failed`, `quarantined`, plus the three Phase 3 ones) fall out of the table;
 * `cleanup_pending`, `finalizing`, `allocated` and `executing` do not.
 */
export function isTerminal(state: WorkspaceState): boolean {
  return WORKSPACE_TRANSITIONS[state].length === 0;
}

/** A workspace whose bytes may still be on disk. The reaper's driving predicate. */
export function isReclaimable(state: WorkspaceState): boolean {
  return state === 'cleanup_pending';
}

/**
 * States the reaper may *take over* when a lease has expired: everything that is not
 * terminal and not already queued for cleanup.
 */
export function isAbandonable(state: WorkspaceState): boolean {
  return !isTerminal(state) && state !== 'cleanup_pending';
}
