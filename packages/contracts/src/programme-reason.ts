/**
 * Why a programme stopped, as a code.
 *
 * `Programme.failureReason` is a sentence for a person, and it embeds task ids ("Task
 * failure in 5e1c…; dependents were blocked"), which makes it useful to read and useless to
 * filter on. "Blocked because an approval is pending" and "blocked because a dependency
 * failed" are different operational facts, and before this file the only way to tell them
 * apart was to parse English or re-derive the node states from `ProgrammeTask`.
 *
 * These codes are the machine-readable half. They are a **closed set**, stored in a
 * `String?` column rather than a Postgres enum for the same reason
 * `ProgrammeCheckpoint.outcome` is a string: the vocabulary belongs to the scheduler, and a
 * state a newer worker can write must not require a migration before an older API can read
 * it. `UNSPECIFIED` exists so a terminal row with no code says so, instead of a NULL that
 * every caller is free to read as "fine".
 *
 * ## Why this file has no dependencies
 *
 * `packages/contracts` is bundled into the Temporal workflow sandbox. Anything reachable
 * from the barrel that imports `node:crypto` breaks that bundle at worker start (the same
 * defect `plan-hash.ts` avoids by not being re-exported). This module is a `const` array of
 * strings and a union type, and must stay that way.
 */

export const PROGRAMME_REASON_CODES = [
  /** A node's task failed or was cancelled; its dependents were blocked. */
  'TASK_FAILED',
  /** A node is gated on an approval the scheduler does not spend. */
  'APPROVAL_PENDING',
  /** Work remains that cannot be scheduled — a held task, a not-runnable state, or a
   * dependent of a node that never succeeded. */
  'DEPENDENCY_BLOCKED',
  /** Nothing was runnable and nothing had failed: the graph was not schedulable. */
  'NO_READY_NODE',
  /** `deadlineAt` passed; no further node was dispatched. */
  'DEADLINE_EXCEEDED',
  /** The API persisted the programme but Temporal refused the start. */
  'ORCHESTRATOR_UNAVAILABLE',
  /** The API's submission failed for a reason that is not an orchestrator outage. */
  'START_FAILED',
  /** The graph failed validation inside the workflow. */
  'GRAPH_INVALID',
  /** The parent workflow was cancelled. */
  'CANCELLED',
  /**
   * The row carries no code. For a terminal non-success that means "this build cannot say
   * why" — a row written before the column existed, or one an older worker closed. It is
   * never a success: a succeeded programme has **no** failure code, and `null` is how the
   * API says so.
   */
  'UNSPECIFIED',
] as const;

export type ProgrammeReasonCode = (typeof PROGRAMME_REASON_CODES)[number];
