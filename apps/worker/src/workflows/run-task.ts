import type { EventEnvelope, TaskStatus } from '@intelligenz/contracts';
import {
  CancellationScope,
  isCancellation,
  log,
  proxyActivities,
  uuid4,
  workflowInfo,
} from '@temporalio/workflow';

import type * as activitiesModule from '../activities';
import { AGENT_ACTOR_ID } from '../shared/actors';
import type {
  RunTaskWorkflowInput,
  RunTaskWorkflowResult,
  ValidateTaskActivityResult,
} from '../shared/contracts';

/**
 * `runTaskWorkflow` — contract §16.
 *
 * ```
 * validateTask ─► recordStart ─► executeAgent ─► persistResult ─► emitEvent ─► complete
 * ```
 *
 * ## This file must stay boring
 *
 * Temporal runs workflow code in a deterministic V8 sandbox. There is no `Date.now()`,
 * no `Math.random()`, no `node:fs`, no Prisma — a violation is a replay error that looks
 * like a random hang and is hard to diagnose (ADR-003). Everything here is a pure
 * decision plus an activity call:
 *
 *   - time comes from `now()`, never the clock;
 *   - ids come from `uuid4()`, which is seeded per run and stable across replay;
 *   - state comes from activity return values, never a database read;
 *   - `import type * as activities` is erased at build time, so the workflow bundle never
 *     sees Prisma or the filesystem.
 *
 * ## The three exits
 *
 * - **succeeded** — the runtime said so, `persistResult` wrote the evidence, and the task
 *   moved to `succeeded`.
 * - **failed** — always explicit. A run that did not succeed can never be recorded as a
 *   success, including when the failure is a Temporal retry exhaustion rather than a
 *   runtime verdict.
 * - **cancelled** — `CancelledFailure` is caught, the terminal state and the audit event
 *   are written in a `nonCancellable` scope (otherwise the cleanup is cancelled too), and
 *   the failure is rethrown so Temporal records the execution as cancelled.
 *
 * The `'cancelled'` member of the return union is reachable without the workflow itself
 * being cancelled: a runtime that aborts on its own returns `status: 'cancelled'`, and a
 * task cancelled between the start request and the first workflow task is detected by
 * validation.
 */

/** Contract §16: 60s per activity, 5m schedule-to-close, three attempts, doubling. */
const taskActivities = proxyActivities<typeof activitiesModule.activities>({
  startToCloseTimeout: '60s',
  scheduleToCloseTimeout: '5m',
  retry: {
    maximumAttempts: 3,
    initialInterval: '1s',
    backoffCoefficient: 2,
  },
});

/**
 * The executor gets its own budget. A real agent run is not a 60-second operation —
 * it clones a repository, thinks, edits, and runs a test suite — and killing it at 60s
 * would make the real adapter unusable while the simulated one stayed comfortable.
 * The *reason* for a run's death must still be recorded, so the adapter's own timeout
 * (55s simulated / `AGENT_TIMEOUT_MS` real) stays below `startToClose`.
 */
const executorActivities = proxyActivities<typeof activitiesModule.activities>({
  startToCloseTimeout: '4m',
  scheduleToCloseTimeout: '10m',
  retry: {
    maximumAttempts: 3,
    initialInterval: '1s',
    backoffCoefficient: 2,
  },
});

export async function runTaskWorkflow(input: RunTaskWorkflowInput): Promise<RunTaskWorkflowResult> {
  const { taskId, orgId, correlationId } = input;

  // `runId` is the Temporal run id. It is what `recordStartActivity` uses to adopt the
  // `WorkflowRun` row the API created, rather than creating a second one.
  const runId = workflowInfo().runId;

  let projectId: string | undefined;

  try {
    const validation = await taskActivities.validateTaskActivity({
      taskId,
      orgId,
      // Phase 5: forwarded verbatim. It is not trusted here — the activity checks it
      // against the grant's `consumedByAttemptId` — but a workflow that dropped it would
      // make every approval-gated run unrefusable-by-omission.
      ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
      // Phase 6: the request the run belongs to, for the claim's audit rows. The claim's
      // *identity* is not taken from here — the activity reads the workflow run id from
      // its own execution context, which a caller cannot forge.
      correlationId,
      // Consulted only if the activity has no execution context (a direct invocation);
      // inside Temporal the context supplies the same value from the server side.
      workflowRunId: runId,
    });

    if (!validation.runnable) {
      projectId = validation.projectId;

      if (validation.reason === 'already_terminal') {
        return {
          status: terminalOutcome(validation.status),
          summary: `No work performed: the task is already ${validation.status ?? 'terminal'}.`,
        };
      }

      return await failBeforeExecution(validation, input, runId);
    }

    const task = validation.task;
    projectId = task.projectId;

    const started = await taskActivities.recordStartActivity({
      taskId,
      orgId,
      workflowRunId: runId,
    });

    if (isTerminal(started.taskStatus)) {
      // A cancellation landed between validation and the start record. The API owns that
      // write; adding a second one here would be a race dressed up as diligence.
      return {
        status: terminalOutcome(started.taskStatus),
        summary: `No work performed: the task became ${started.taskStatus} before execution.`,
      };
    }

    await taskActivities.emitEventActivity({
      event: envelope({
        eventType: 'task.status_changed.v1',
        tenantId: orgId,
        projectId: task.projectId,
        aggregateId: taskId,
        correlationId,
        causationId: null,
        occurredAt: now(),
        // One per run, so a replay of this step cannot add a second transition row.
        idempotencyKey: `task.status_changed.v1:${taskId}:${runId}:running`,
        payload: {
          from: task.status,
          to: 'running',
          cause: 'workflow_started',
          workflowRunId: started.workflowRunId,
          temporalRunId: started.temporalRunId,
        },
      }),
    });

    const result = await executorActivities.executeAgentActivity({
      taskId,
      orgId,
      correlationId,
      // The database run id, not the Temporal one: the attempt's `workflowRunId` is a
      // foreign key, and `recordStartActivity` has already resolved which row this is.
      workflowRunId: started.workflowRunId,
      // Phase 6: the reservation `POST /run` minted. Passed explicitly so a direct
      // start that omitted it is refused at the launch site rather than running without
      // a claim; an old history replays with `undefined` and is refused the same way.
      ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
    });

    await taskActivities.persistResultActivity({ taskId, orgId, result });

    const finalStatus = outcomeOf(result.status);
    const eventType = terminalEventType(finalStatus);

    await taskActivities.emitEventActivity({
      event: envelope({
        eventType,
        tenantId: orgId,
        projectId: task.projectId,
        aggregateId: taskId,
        correlationId,
        causationId: null,
        occurredAt: now(),
        idempotencyKey:
          finalStatus === 'cancelled'
            ? // Task-scoped, not run-scoped: cancellation is a fact about the task, and
              // `POST /cancel` may have written the same fact (see emit-event.ts).
              `task.cancelled.v1:${taskId}`
            : `${eventType}:${taskId}:${runId}`,
        payload: {
          taskId,
          workflowRunId: started.workflowRunId,
          runtimeId: result.runtimeId,
          simulated: result.simulated,
          status: result.status,
          usage: result.usage,
          artifactCount: result.artifacts.length,
          executionEventCount: result.events.length,
          error: result.error ?? null,
        },
      }),
    });

    await taskActivities.completeTaskActivity({ taskId, orgId, status: finalStatus });

    return { status: finalStatus, summary: result.summary };
  } catch (error) {
    if (isCancellation(error)) {
      await recordCancellation(taskId, orgId, correlationId, projectId);

      // Contract §16: rethrow, so Temporal marks the execution cancelled instead of
      // reporting a successful workflow that happened to stop early.
      throw error;
    }

    // An activity that refused has no return value, so the project it belonged to is
    // carried in the failure's details (see `validateTaskActivity`). Without this, a
    // direct-start refusal would end the task with no audit event at all.
    return await recordUnexpectedFailure(error, input, projectId ?? projectIdFromFailure(error));
  }
}

/**
 * A pre-dispatch refusal: nothing ran, so there is no `AgentRun` to write. The status and
 * the error go where they belong — `Task.status` and `WorkflowRun.error` — and the audit
 * event carries the reason.
 *
 * A missing task is handled without any write at all: there is no row to update, and a
 * fabricated "task failed" event for a task that does not exist would be noise in a
 * tenant's history.
 */
async function failBeforeExecution(
  validation: Extract<ValidateTaskActivityResult, { runnable: false }>,
  input: RunTaskWorkflowInput,
  runId: string,
): Promise<RunTaskWorkflowResult> {
  if (validation.reason === 'not_found') {
    return { status: 'failed', summary: validation.detail };
  }

  const code =
    validation.reason === 'approval_required' ? 'APPROVAL_REQUIRED' : 'TASK_NOT_RUNNABLE';

  await taskActivities.completeTaskActivity({
    taskId: input.taskId,
    orgId: input.orgId,
    status: 'failed',
    error: { code, message: validation.detail },
  });

  if (validation.projectId !== undefined) {
    await taskActivities.emitEventActivity({
      event: envelope({
        eventType: 'task.failed.v1',
        tenantId: input.orgId,
        projectId: validation.projectId,
        aggregateId: input.taskId,
        correlationId: input.correlationId,
        causationId: null,
        occurredAt: now(),
        idempotencyKey: `task.failed.v1:${input.taskId}:${runId}`,
        payload: {
          taskId: input.taskId,
          code,
          reason: validation.reason,
          detail: validation.detail,
        },
      }),
    });
  }

  return { status: 'failed', summary: validation.detail };
}

/**
 * Cancellation cleanup. `nonCancellable` is not optional: the scope this code runs in is
 * already cancelled, and an activity started there would be cancelled before it reached
 * the server — leaving the task `running` forever.
 */
async function recordCancellation(
  taskId: string,
  orgId: string,
  correlationId: string,
  knownProjectId: string | undefined,
): Promise<void> {
  try {
    await CancellationScope.nonCancellable(async () => {
      const completion = await taskActivities.completeTaskActivity({
        taskId,
        orgId,
        status: 'cancelled',
      });

      // `changed === false` means the task was already terminal — almost always
      // `POST /cancel`, which wrote `cancelled` *and* `task.cancelled.v1` in one
      // transaction. Emitting again would give one cancellation two audit rows, so the
      // worker confirms rather than duplicates.
      if (!completion.changed) return;

      await taskActivities.emitEventActivity({
        event: envelope({
          eventType: 'task.cancelled.v1',
          tenantId: orgId,
          // The activity has the row, so this works even if validation never returned.
          projectId: knownProjectId ?? completion.projectId,
          aggregateId: taskId,
          correlationId,
          causationId: null,
          occurredAt: now(),
          idempotencyKey: `task.cancelled.v1:${taskId}`,
          payload: {
            taskId,
            from: completion.previousStatus,
            cause: 'workflow_cancelled',
            orchestrator: 'temporal',
          },
        }),
      });
    });
  } catch (cleanupError) {
    // The workflow is being cancelled; a cleanup failure must not mask the cancellation.
    // Recorded so the gap is visible rather than silent.
    log.error('failed to record cancellation', {
      taskId,
      error: describeFailure(cleanupError).message,
    });
  }
}

/**
 * Anything that is not a cancellation: an activity that exhausted its three attempts, or
 * a bug. The task must not be left `running` and must never be recorded as succeeded.
 *
 * No `AgentRun` is written here on purpose. We do not know that the runtime produced this
 * failure, and an `AgentRun` with an invented runtime id would be a fabricated fact.
 */
async function recordUnexpectedFailure(
  error: unknown,
  input: RunTaskWorkflowInput,
  projectId: string | undefined,
): Promise<RunTaskWorkflowResult> {
  const detail = describeFailure(error);
  const runId = workflowInfo().runId;

  try {
    await CancellationScope.nonCancellable(async () => {
      await taskActivities.completeTaskActivity({
        taskId: input.taskId,
        orgId: input.orgId,
        status: 'failed',
        error: detail,
      });

      if (projectId === undefined) return;

      await taskActivities.emitEventActivity({
        event: envelope({
          eventType: 'task.failed.v1',
          tenantId: input.orgId,
          projectId,
          aggregateId: input.taskId,
          correlationId: input.correlationId,
          causationId: null,
          occurredAt: now(),
          idempotencyKey: `task.failed.v1:${input.taskId}:${runId}`,
          payload: {
            taskId: input.taskId,
            code: detail.code,
            message: detail.message,
            cause: 'workflow_error',
          },
        }),
      });
    });
  } catch (cleanupError) {
    // The persistence path failed, so it cannot record its own failure. Say so; do not
    // pretend the task was completed.
    log.error('failed to record workflow failure', {
      taskId: input.taskId,
      error: describeFailure(cleanupError).message,
    });
  }

  return { status: 'failed', summary: `${detail.code}: ${detail.message}` };
}

/**
 * The deterministic clock.
 *
 * `workflow.now()` existed in SDK ≤1.x and was removed; `workflowInfo().unsafe.now()` is
 * its replacement — a replay-safe millisecond timestamp for the current workflow task.
 * It is called `unsafe` because it advances between workflow tasks, so it must never
 * drive branching. Here it only stamps `occurredAt` on audit events, where "when the
 * workflow observed this" is exactly the intended meaning.
 *
 * `Date.now()` would also be patched by the sandbox, but naming the API makes the
 * determinism visible at the call site instead of relying on a patched global.
 */
function now(): Date {
  return new Date(workflowInfo().unsafe.now());
}

interface EnvelopeInput {
  readonly eventType: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly occurredAt: Date;
  readonly idempotencyKey: string;
  readonly payload: Record<string, unknown>;
}

function envelope(input: EnvelopeInput): EventEnvelope {
  return {
    // `uuid4()` is deterministic per run in the Temporal sandbox: a replay produces the
    // same id, which is what makes the insert idempotent instead of duplicating history.
    eventId: uuid4(),
    eventType: input.eventType,
    schemaVersion: 1,
    tenantId: input.tenantId,
    projectId: input.projectId,
    aggregateId: input.aggregateId,
    occurredAt: input.occurredAt.toISOString(),
    actor: { type: 'agent', id: AGENT_ACTOR_ID },
    correlationId: input.correlationId,
    causationId: input.causationId,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
  };
}

function outcomeOf(
  status: 'succeeded' | 'failed' | 'timeout' | 'cancelled',
): RunTaskWorkflowResult['status'] {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'cancelled') return 'cancelled';

  // `timeout` is a failure of the attempt, not a separate terminal state: the task's
  // state machine has no `timed_out` (contract §6).
  return 'failed';
}

function terminalEventType(status: RunTaskWorkflowResult['status']): string {
  if (status === 'succeeded') return 'task.succeeded.v1';
  if (status === 'cancelled') return 'task.cancelled.v1';

  return 'task.failed.v1';
}

function terminalOutcome(status: TaskStatus | undefined): RunTaskWorkflowResult['status'] {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'cancelled') return 'cancelled';

  return 'failed';
}

function isTerminal(status: TaskStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

/**
 * Normalises a workflow-visible error. `ApplicationFailure.type` is the machine-readable
 * code, and it survives the activity boundary — which is why every activity throws typed
 * failures rather than bare errors.
 *
 * It does **not** survive at the top level: Temporal wraps it in `ActivityFailure` (and
 * that in `ChildWorkflowFailure` when nested), so the code lives somewhere down the
 * `cause` chain. Walking it is not defensive coding — it is the difference between an
 * audit row that says `APPROVAL_REQUIRED` and one that says `Error`.
 */
function describeFailure(error: unknown): { code: string; message: string } {
  for (const candidate of errorChain(error)) {
    const type = (candidate as { type?: unknown }).type;

    if (typeof type === 'string' && type.length > 0) {
      return { code: type, message: messageOf(candidate) };
    }
  }

  return { code: 'WORKFLOW_FAILED', message: messageOf(error) };
}

/** The project a refused activity named in its failure details, if it named one. */
function projectIdFromFailure(error: unknown): string | undefined {
  for (const candidate of errorChain(error)) {
    const details = (candidate as { details?: unknown }).details;
    if (!Array.isArray(details)) continue;

    for (const detail of details) {
      if (typeof detail !== 'object' || detail === null) continue;

      const projectId = (detail as { projectId?: unknown }).projectId;
      if (typeof projectId === 'string' && projectId.length > 0) return projectId;
    }
  }

  return undefined;
}

function errorChain(error: unknown, depth = 0): readonly unknown[] {
  if (depth > 6) return [];

  const chain: unknown[] = [error];
  const cause =
    typeof error === 'object' && error !== null ? (error as { cause?: unknown }).cause : undefined;

  if (cause !== undefined && cause !== error) chain.push(...errorChain(cause, depth + 1));

  return chain;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;

  return String(error);
}
