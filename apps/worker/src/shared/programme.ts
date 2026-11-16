/**
 * The programme workflow ↔ activity wire types.
 *
 * Same discipline as `shared/contracts.ts`: every import here is `import type`, so nothing
 * in this file reaches the workflow bundle at runtime. The workflow decides; the
 * activities read and write.
 *
 * Statuses are string literal unions rather than the Prisma enums on purpose — the
 * workflow must not import the generated client, even as a value, and a literal union is
 * the same vocabulary written down where the sandbox can see it.
 */

/** The scheduler's verdict for the programme as a whole. Mirrors `ProgrammeStatus`. */
export type ProgrammeRunStatus = 'succeeded' | 'failed' | 'blocked' | 'timed_out';

/** What the scheduler observed for one node. Mirrors `ProgrammeTaskStatus`. */
export type ProgrammeNodeStatus =
  'pending' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'waiting_for_approval' | 'cancelled';

/** Where each checkpoint outcome lands the node. One table, used by both sides. */
export const NODE_STATUS_BY_OUTCOME: Readonly<
  Record<ProgrammeCheckpointOutcome, ProgrammeNodeStatus>
> = {
  succeeded: 'succeeded',
  already_succeeded: 'succeeded',
  failed: 'failed',
  dispatch_failed: 'failed',
  blocked: 'blocked',
  waiting_for_approval: 'waiting_for_approval',
  cancelled: 'cancelled',
};

export interface RunProgrammeWorkflowInput {
  readonly programmeId: string;
  readonly orgId: string;
  /**
   * ISO-8601. A soft deadline: the workflow stops dispatching when it passes and records
   * `timed_out`. Carried in the input rather than computed here so Continue-As-New keeps
   * the same deadline instead of restarting the budget.
   */
  readonly deadlineAt: string;
  /**
   * The concurrency ceiling. Defaults to 1 in the workflow, which is the only safe
   * default until per-attempt isolation (8.5) exists: two real agent runs sharing a host
   * need their own cgroups and workspaces before they may run side by side. Sequential
   * chains do not need it; parallel branches do.
   */
  readonly maxConcurrent?: number;
}

/** What the parent reports. Counts, not a log: the rows are the record. */
export interface RunProgrammeWorkflowResult {
  readonly status: ProgrammeRunStatus;
  readonly succeeded: number;
  readonly failed: number;
  readonly blocked: number;
  readonly checkpoints: number;
}

export interface LoadProgrammeActivityInput {
  readonly programmeId: string;
  readonly orgId: string;
}

export interface ProgrammeNode {
  readonly taskId: string;
  readonly dependsOn: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly status: ProgrammeNodeStatus;
  readonly attemptCount: number;
  /**
   * The task's own status at load time. The scheduler only reads it to reconcile a node
   * left `running` by an earlier attempt of this same programme — the node status is the
   * schedule, the task status is the work.
   */
  readonly taskStatus: string;
}

export interface LoadProgrammeActivityResult {
  readonly programme: {
    readonly id: string;
    readonly projectId: string;
    readonly objective: string;
    readonly status:
      'pending' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'timed_out';
  };
  readonly nodes: readonly ProgrammeNode[];
  /** How many checkpoints already exist. The next sequence is this plus one. */
  readonly checkpointCount: number;
  /**
   * The checkpoints already recorded, by node. Loaded so a resumed scheduler does not
   * append a second row for work it has already reported, and so a node left `running`
   * can be reconciled from what was actually written rather than re-dispatched.
   */
  readonly checkpoints: readonly { readonly taskId: string; readonly outcome: string }[];
}

export interface ReserveProgrammeTaskInput {
  readonly programmeId: string;
  readonly orgId: string;
  readonly taskId: string;
  /** 1-based. Deterministic, and the id space the reservation's row ids derive from. */
  readonly attemptNumber: number;
  /**
   * The correlation id for the audit row, minted by the workflow (`uuid4()`, so it is
   * stable across replay) and forwarded to the child too. The envelope contract requires a
   * UUID, which is why it is not a readable `programme:…` string.
   */
  readonly correlationId: string;
}

export type ReserveProgrammeTaskResult =
  /** A reservation exists (or was just created) and the task may be dispatched. */
  | {
      readonly outcome: 'reserved';
      readonly attemptId: string;
      readonly workflowRunId: string;
    }
  /** The task had already finished before the programme reached it. Nothing to do. */
  | { readonly outcome: 'already_succeeded' }
  /**
   * `HIGH`/`CRITICAL` tasks need a live approval, and a grant is spent by `POST /run` in
   * the transaction that reserves the attempt. The programme does not spend grants: it
   * records the node as waiting and leaves the approval to a human.
   */
  | { readonly outcome: 'approval_required' }
  /** The task is not in a state the programme can start: terminal, or held by a run. */
  | {
      readonly outcome: 'not_runnable';
      readonly taskStatus: string;
      readonly detail: string;
    }
  | { readonly outcome: 'not_found' };

export type ProgrammeCheckpointOutcome =
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'waiting_for_approval'
  | 'already_succeeded'
  | 'cancelled'
  | 'dispatch_failed';

/** The links that make a checkpoint evidence rather than an assertion. */
export interface ProgrammeCheckpointEvidence {
  readonly attemptId?: string;
  readonly workflowRunId?: string;
  /** The Temporal child execution, as the server named it. */
  readonly childWorkflowId?: string;
  readonly childRunId?: string;
  /** The child's own verdict, verbatim. */
  readonly summary?: string;
  readonly reason?: string;
}

export interface RecordProgrammeCheckpointInput {
  readonly programmeId: string;
  readonly orgId: string;
  /** 1-based, allocated by the workflow. Unique per programme — a retry upserts. */
  readonly sequence: number;
  readonly taskId: string;
  readonly outcome: ProgrammeCheckpointOutcome;
  readonly evidence: ProgrammeCheckpointEvidence | null;
}

export interface RecordProgrammeCheckpointResult {
  readonly sequence: number;
}

export interface FinishProgrammeInput {
  readonly programmeId: string;
  readonly orgId: string;
  readonly status: ProgrammeRunStatus | 'cancelled';
  /** Why, in one line. Recorded in `Programme.failureReason` only for non-success. */
  readonly reason: string;
}

export interface FinishProgrammeResult {
  readonly status: string;
  readonly changed: boolean;
}
