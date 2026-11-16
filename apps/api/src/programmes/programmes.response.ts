/**
 * The programme wire shape.
 *
 * Distinct from `Programme` (the database model) and from the workflow's internal types:
 * the API exposes state names and counts an operator reads, and never a Prisma row. The
 * `ErrorCode` values in the service are the machine-readable half of the same contract.
 */

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
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly tasks: readonly ProgrammeTaskResponse[];
}
