import type { ExecutionResult } from '@intelligenz/agent-runtime';
import type { EventEnvelope, RiskClass, TaskStatus } from '@intelligenz/contracts';

/**
 * The workflow ↔ activity wire types (contract §16).
 *
 * This module exists so the workflow and the activities agree on one set of shapes
 * **without** the workflow importing the activity implementations. Every import here
 * is `import type`, so nothing in this file reaches the workflow bundle at runtime —
 * the Temporal sandbox would reject `node:fs` and Prisma if it did (ADR-003).
 *
 * The six activity signatures are contract §16's literals. Where an activity needs a
 * richer return value than §16 specifies, the *return* carries it; the parameters are
 * unchanged.
 */

/**
 * Contract §16 signature, extended in Phase 5 with `attemptId`.
 *
 * `attemptId` is **optional in the type and required in practice**: the API always sends
 * it, and since Phase 6 (F3) a workflow started without one is refused
 * (`EXECUTION_CLAIM_REFUSED`) instead of running unclaimed — an execution with no
 * reservation cannot be shown to be the only one, so "start the workflow by hand" now
 * requires the attempt id `POST /run` minted. Optional in the type so an old execution
 * recorded before the field existed replays into a *refusal* rather than a
 * deserialization failure.
 */
export interface RunTaskWorkflowInput {
  readonly taskId: string;
  readonly orgId: string;
  readonly correlationId: string;
  readonly attemptId?: string;
}

/** Contract §16, verbatim. `status` is the workflow's verdict, not the task's history. */
export interface RunTaskWorkflowResult {
  readonly status: 'succeeded' | 'failed' | 'cancelled';
  readonly summary: string;
}

// ─── validateTaskActivity ────────────────────────────────────────────────────

export interface ValidateTaskActivityInput {
  readonly taskId: string;
  readonly orgId: string;
  /**
   * Phase 5. The attempt the API reserved before starting this workflow. The grant this
   * task's approval was spent on must name this same attempt; absent or different is a
   * refusal, because otherwise a second execution could run on a grant that was already
   * spent.
   */
  readonly attemptId?: string;
  /**
   * Phase 6. The request this run belongs to, used as the correlation id on the execution
   * claim's audit rows. Optional because a direct invocation (a test, an operational
   * script) has no request; the claim falls back to the execution identity, which is a
   * server-side id either way.
   */
  readonly correlationId?: string;
  /**
   * Phase 6. Temporal's run id — **only consulted when the activity has no execution
   * context**, which is the direct-invocation case. Inside a worker the activity reads
   * `Context.current().info.workflowExecution.runId`, because an input field is a
   * parameter and a parameter can be forged by anything that can start a workflow,
   * while the execution context is set by the server that dispatched the attempt.
   *
   * This is the same id `RecordStartActivityInput.workflowRunId` carries, and it is *not*
   * `WorkflowRun.id`.
   */
  readonly workflowRunId?: string;
}

/** Everything the workflow needs to build an event envelope without touching the DB. */
export interface RunnableTask {
  readonly id: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly title: string;
  readonly goal: string;
  readonly riskClass: RiskClass;
  readonly status: TaskStatus;
}

export type NotRunnableReason =
  'not_found' | 'not_runnable' | 'already_terminal' | 'approval_required';

export type ValidateTaskActivityResult =
  | { readonly runnable: true; readonly task: RunnableTask }
  | {
      readonly runnable: false;
      readonly reason: NotRunnableReason;
      readonly detail: string;
      readonly status?: TaskStatus;
      readonly projectId?: string;
    };

// ─── recordStartActivity ─────────────────────────────────────────────────────

export interface RecordStartActivityInput {
  readonly taskId: string;
  readonly orgId: string;
  /**
   * The **Temporal** run id (`workflowInfo().runId`), not a database id. The API
   * creates the `WorkflowRun` row at start time with `temporalRunId` already set, so
   * this is what lets the worker adopt that row instead of creating a second one.
   */
  readonly workflowRunId: string;
}

export interface RecordStartActivityResult {
  /** The database `WorkflowRun.id`. */
  readonly workflowRunId: string;
  readonly temporalRunId: string;
  /** Status after the activity ran. A terminal status here means: stop, do nothing. */
  readonly taskStatus: TaskStatus;
  readonly started: boolean;
}

// ─── executeAgentActivity ────────────────────────────────────────────────────

export interface ExecuteAgentActivityInput {
  readonly taskId: string;
  readonly orgId: string;
  readonly correlationId: string;
  /**
   * Phase 3 addition, optional so a direct caller (a test, a replay script) keeps
   * working: the database `WorkflowRun.id` this execution belongs to. Without it the
   * activity falls back to the newest run for the task, which is the same row under
   * the one-live-workflow-per-task rule. The workflow always passes it.
   *
   * **Not** the claim identity. That is `executionRunId` below; the two are different id
   * spaces and conflating them would let a database row id stand in for an orchestrator
   * run id.
   */
  readonly workflowRunId?: string;
  /**
   * Phase 6. The attempt `POST /run` reserved and `validateTaskActivity` claimed for this
   * execution. The activity **requires** it in practice: without it there is no
   * reservation to hold, and an execution that holds none is refused
   * (`EXECUTION_CLAIM_REFUSED`) before the runtime is constructed.
   *
   * Optional in the type for the same reason as `RunTaskWorkflowInput.attemptId`: an
   * execution recorded before this field existed replays with `undefined` and must be
   * refused as a claim failure, not fail to deserialize.
   */
  readonly attemptId?: string;
  /**
   * Phase 6. Temporal's run id, consulted **only** when the activity has no execution
   * context — a direct invocation from a test or an operational script. Inside a worker
   * the id is read from `Context.current().info.workflowExecution.runId`, because an
   * input field is a parameter, and a parameter can be forged by anything that can start
   * a workflow.
   *
   * A direct call therefore proves only that the caller knows a run id; it cannot
   * impersonate a different execution, because the claim it must satisfy was written
   * under that same id.
   */
  readonly executionRunId?: string;
}

/** The normalised result, exactly as the port defines it. */
export type ExecuteAgentActivityResult = ExecutionResult;

// ─── persistResultActivity ───────────────────────────────────────────────────

export interface PersistResultActivityInput {
  readonly taskId: string;
  readonly orgId: string;
  readonly result: ExecutionResult;
}

export interface PersistResultActivityResult {
  readonly workflowRunId: string;
  readonly agentRunId: string;
  readonly artifactIds: readonly string[];
  readonly evidenceIds: readonly string[];
}

// ─── emitEventActivity ───────────────────────────────────────────────────────

export interface EmitEventActivityInput {
  readonly event: EventEnvelope;
}

export interface EmitEventActivityResult {
  readonly eventId: string;
  /** `false` when the event already existed — the activity is idempotent, not silent. */
  readonly created: boolean;
}

// ─── completeTaskActivity ────────────────────────────────────────────────────

export interface CompleteTaskActivityInput {
  readonly taskId: string;
  readonly orgId: string;
  readonly status: 'succeeded' | 'failed' | 'cancelled';
  /**
   * Optional, and used only when nothing was executed (validation refused, or the
   * activity path itself failed). §16's minimal shape is preserved; the field exists
   * so that a pre-dispatch failure is recorded in `WorkflowRun.error` instead of
   * needing a fabricated `AgentRun`.
   */
  readonly error?: { readonly code: string; readonly message: string };
}

export interface CompleteTaskActivityResult {
  /** `false` means the task was already terminal, so the caller must not re-emit state. */
  readonly changed: boolean;
  readonly previousStatus: TaskStatus;
  readonly status: TaskStatus;
  /** Needed by the cancellation path, which must emit an event after the write. */
  readonly projectId: string;
}
