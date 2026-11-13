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

/** Contract §16, verbatim. */
export interface RunTaskWorkflowInput {
  readonly taskId: string;
  readonly orgId: string;
  readonly correlationId: string;
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
  | 'not_found'
  | 'not_runnable'
  | 'already_terminal'
  | 'approval_required';

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
