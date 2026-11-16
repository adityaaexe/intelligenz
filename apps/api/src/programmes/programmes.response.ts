/**
 * The programme wire shape.
 *
 * Distinct from `Programme` (the database model) and from the workflow's internal types:
 * the API exposes state names and counts an operator reads, and never a Prisma row. The
 * `ErrorCode` values in the service are the machine-readable half of the same contract.
 */

import { PROGRAMME_REASON_CODES, type ProgrammeReasonCode } from '@intelligenz/contracts';

export interface ProgrammeTaskResponse {
  readonly taskId: string;
  /** Task ids this node waits for — the edges, as submitted and validated. */
  readonly dependsOn: readonly string[];
  /** `pending` | `running` | `succeeded` | `failed` | `blocked` | `waiting_for_approval` | `cancelled`. */
  readonly status: string;
  /** How many execution attempts the programme reserved for this node. 0 until dispatched. */
  readonly attemptCount: number;
}

export interface ProgrammeResponse {
  readonly programmeId: string;
  readonly projectId: string;
  readonly objective: string;
  /** `pending` | `running` | `succeeded` | `failed` | `blocked` | `cancelled` | `timed_out`. */
  readonly status: string;
  /** Present only for a non-success: why the programme stopped. */
  readonly failureReason: string | null;
  /**
   * The same reason as a stable code, so a client can filter, group and report on it
   * without parsing `failureReason` (which embeds task ids).
   *
   * `null` exactly when there is no failure to name: a `succeeded` programme, or one still
   * `pending`/`running`. A **terminal non-success** with no stored code is `UNSPECIFIED` —
   * an explicit "this row cannot say why" (it predates the column, or was closed by an
   * older worker), never a value that reads as success.
   */
  readonly failureCode: ProgrammeReasonCode | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly tasks: readonly ProgrammeTaskResponse[];
}

/** Statuses that can carry a failure. `succeeded` deliberately is not one. */
const FAILURE_STATUSES: ReadonlySet<string> = new Set([
  'failed',
  'blocked',
  'cancelled',
  'timed_out',
]);

const KNOWN_REASON_CODES: ReadonlySet<string> = new Set(PROGRAMME_REASON_CODES);

/**
 * `Programme.failureCode` → the wire value.
 *
 * Two conversions, both deliberate:
 *
 *   - a NULL column on a terminal non-success becomes `UNSPECIFIED`, because the column's
 *     absence of a value is not the absence of a reason — the programme did stop, and this
 *     build cannot say why;
 *   - a code this build does not know (a newer worker writing during a rolling deploy)
 *     becomes `UNSPECIFIED` too, rather than a string the declared union does not contain.
 *
 * A `succeeded` programme and a programme that has not finished yet both answer `null`:
 * neither has a failure, and `UNSPECIFIED` there would be a lie about state, not a
 * limitation of the reader.
 */
export function toFailureCode(
  status: string,
  failureCode: string | null,
): ProgrammeReasonCode | null {
  if (failureCode !== null) {
    return KNOWN_REASON_CODES.has(failureCode)
      ? (failureCode as ProgrammeReasonCode)
      : 'UNSPECIFIED';
  }

  return FAILURE_STATUSES.has(status) ? 'UNSPECIFIED' : null;
}

/**
 * What `POST /programmes/:programmeId/cancel` answers.
 *
 * `cancellation` is the fact the caller acts on, and `recordedBy` is the half that makes
 * the fact verifiable: a request that only reached a running scheduler is `requested` until
 * the workflow records the terminal state, while a programme cancelled before it ever
 * started carries no workflow to record anything — the API wrote it.
 *
 * `recordedBy` is absent for `already_cancelled`: the row was already terminal when the
 * request arrived, so this call recorded nothing and naming a writer would be a claim about
 * another request.
 */
export interface CancelProgrammeResponse {
  readonly programmeId: string;
  /**
   * `already_cancelled` — the row was `cancelled` before this call; nothing was written and
   * no orchestrator call was made.
   * `requested` — the parent execution was cancelled; the scheduler owns the row and will
   * write `cancelled`.
   * `cancelled_before_start` — no scheduler ever ran (`startedAt` null), so the API wrote the
   * terminal state itself.
   */
  readonly cancellation: 'already_cancelled' | 'requested' | 'cancelled_before_start';
  /** Who writes (or already wrote) the terminal status: the workflow, or the API. */
  readonly recordedBy?: 'workflow' | 'api';
}
