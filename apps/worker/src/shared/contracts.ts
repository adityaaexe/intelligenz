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
   * Phase 3 addition, optional so a replay of an older execution keeps working: the
   * database `WorkflowRun.id` this execution belongs to. Without it the activity falls
   * back to the newest run for the task, which is the same row under the
   * one-live-workflow-per-task rule. The workflow always passes it.
   *
   * **Not** the claim identity. That one is not an input at all: it is the Temporal run id
   * the activity reads from its own execution context (`executionIdentity`), and the two
   * are different id spaces — conflating them would let a database row id stand in for an
   * orchestrator run id.
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
}

/** The normalised result, exactly as the port defines it. */
export type ExecuteAgentActivityResult = ExecutionResult;

// ─── persistResultActivity ───────────────────────────────────────────────────

export interface PersistResultActivityInput {
  readonly taskId: string;
  readonly orgId: string;
  readonly result: ExecutionResult;
  /**
   * Phase 6 re-review N4. The attempt this execution holds. `persistResultActivity` is
   * only ever reached **after** a run, so a claim necessarily exists and the activity
   * requires it (`requireExecutionClaim`) before the first write: a `Temporal` caller that
   * dispatches the activity by name can no longer write an `AgentRun` and terminal state
   * for a task that never executed.
   *
   * Optional in the type, refused at runtime when absent, for the same replay reason as
   * `RunTaskWorkflowInput.attemptId`.
   */
  readonly attemptId?: string;
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
  /**
   * Phase 6 re-review N4. The attempt this execution holds, passed whenever one was
   * claimed. Present ⇒ `requireExecutionClaim` decides, and only the holder may write.
   * Absent ⇒ the pre-dispatch arm of `requireCompletionAuthority` decides (this execution
   * must be `task-<taskId>` and nothing else may hold the task), which is the state a
   * refused-before-dispatch run is legitimately in. See `activities/claim.ts`.
   */
  readonly attemptId?: string;
  /**
   * Phase 6. The database `WorkflowRun.id` this execution believes it owns. When present
   * it is cross-checked against the attempt's foreign key by `requireExecutionClaim`; the
   * two ids live in different spaces and conflating them would let a database row id
   * stand in for an orchestrator run id.
   */
  readonly workflowRunId?: string;
}

export interface CompleteTaskActivityResult {
  /** `false` means the task was already terminal, so the caller must not re-emit state. */
  readonly changed: boolean;
  readonly previousStatus: TaskStatus;
  readonly status: TaskStatus;
  /** Needed by the cancellation path, which must emit an event after the write. */
  readonly projectId: string;
  /**
   * Phase 6 re-review N4: which control authorised this terminal write.
   *
   * `execution-claim` — the named attempt was claimed by this execution.
   * `pre-dispatch` — nothing was authorised yet (validation refused before claiming), and
   * this execution is the task's own (`task-<taskId>`) with nothing else holding it.
   *
   * Reported rather than inferred so the difference is visible at the call site instead of
   * having to be reconstructed from whether an attempt happened to carry a claim.
   */
  readonly authority: 'execution-claim' | 'pre-dispatch';
}
