import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cancellationSignal } from '@temporalio/activity';
import {
  ExecutionRequest,
  ExecutionResult,
  LOCAL_SIMULATED_ID,
  RuntimeResultError,
  missingCapabilities,
  toExecutionError,
} from '@intelligenz/agent-runtime';

import { getWorkerConfig } from '../config';
import { getAgentRuntime, runtimeRequiresWorkspace } from '../runtime';
import type {
  ExecuteAgentActivityInput,
  ExecuteAgentActivityResult,
} from '../shared/contracts';
import { materializeArtifacts } from './artifacts';
import {
  RUN_STATUS,
  finalizeAttempt,
  resolveWorkflowRun,
  startAttempt,
} from './attempts';
import { executionWorkspaceIdFor } from './ids';
import { db, nonRetryable, retryable } from './support';
import {
  leaseWorkspace,
  markExecuting,
  markPreserving,
  releaseWorkspace,
  workspaceArtifactsDirectory,
  type WorkspaceLease,
  type WorkspaceOutcome,
} from './workspace';

/**
 * `executeAgentActivity` — contract §16.
 *
 * **The only place the runtime is touched.** The workflow calls this activity by name
 * and knows nothing about adapters, capabilities, abort signals or vendor quirks. A
 * real runtime arrives by changing `AGENT_RUNTIME`, not this activity's contract.
 *
 * ## What this activity owns (Phase 3)
 *
 * 1. **Runtime selection** — `local-simulated` unless the deployment opted in.
 * 2. **Attempt identity** — one `ExecutionAttempt` per invocation, numbered per
 *    workflow run. A retry is a new attempt, never a silent second run under the
 *    first one's id.
 * 3. **Workspace lifecycle** — for adapters that need a filesystem: request,
 *    provision, execute, preserve, complete. The checkout is disposed; the artifacts
 *    are not.
 * 4. **The capability gate** (ADR-006) — checked before any work, so a task that
 *    needs a shell is refused up front rather than half-finished.
 * 5. **Cancellation plumbing** — Temporal's `cancellationSignal()` is chained into
 *    the `AbortSignal` the port requires, and `runtime.cancel(taskId)` converges on
 *    the same path. The adapter kills its process group; this activity records the
 *    workspace as `cancelled`.
 * 6. **Normalisation** — a thrown `retryable` error becomes a Temporal retry; a
 *    non-retryable one becomes a `failed` result the workflow can persist as an
 *    outcome.
 *
 * ## Ordering that matters
 *
 * The attempt row is written **before** provisioning. A workspace that failed to
 * provision must still be attributable to an attempt; the alternative is a failure
 * with no row, which is the same gap Phase 2 had.
 *
 * ## Fault injection (dev only)
 *
 * `WORKER_FAULT_INJECT=execute-once` makes the **first** attempt throw a retryable
 * error. The "first" is claimed with an exclusive marker file under
 * `<ARTIFACT_ROOT>/.fault-injection/`, so it survives an activity retry in another
 * process and can never fire twice. It exists to prove that Temporal retried; it is
 * inert unless the variable is set.
 */

/**
 * Kept under the executor activity's 4m `startToCloseTimeout` so the adapter's own
 * timeout is what reports the reason. The default `AGENT_TIMEOUT_MS` is 50s — plenty
 * for the simulated adapter, and an operator running a real agent raises it.
 */
const MAX_AGENT_TIMEOUT_MS = 230_000;

export async function executeAgentActivity(
  input: ExecuteAgentActivityInput,
): Promise<ExecuteAgentActivityResult> {
  const config = getWorkerConfig();
  const runtime = getAgentRuntime(config);
  const simulatedAdapter = runtime.id === LOCAL_SIMULATED_ID;

  const task = await db().task.findFirst({
    // Tenant scoping.
    where: { id: input.taskId, orgId: input.orgId },
    select: { id: true, goal: true, riskClass: true, status: true, projectId: true },
  });

  if (task === null) {
    throw nonRetryable('TASK_NOT_FOUND', `Task ${input.taskId} does not exist in this org.`);
  }

  const workflowRun = await resolveWorkflowRun({
    orgId: input.orgId,
    taskId: input.taskId,
    workflowRunId: input.workflowRunId,
  });

  const attempt = await startAttempt({
    orgId: input.orgId,
    taskId: input.taskId,
    workflowRunId: workflowRun.id,
    runtimeId: runtime.id,
    // Provisional. A result replaces this with the adapter's own report; a thrown
    // error has no result, and then the adapter's nature is the only honest value.
    simulated: simulatedAdapter,
    startedAt: new Date(),
  });

  let lease: WorkspaceLease | undefined;
  let workspaceOutcome: WorkspaceOutcome | undefined;
  let attemptFinalized = false;
  let attemptError: unknown;

  async function finalize(
    status: ExecutionResult['status'],
    simulated: boolean,
    error?: ExecutionResult['error'],
  ): Promise<void> {
    if (attemptFinalized) return;
    attemptFinalized = true;

    await finalizeAttempt({
      orgId: input.orgId,
      attemptId: attempt.id,
      status: RUN_STATUS[status],
      simulated,
      ...(error === undefined ? {} : { error }),
    });
  }

  if (task.status === 'cancelled') {
    // A cancellation that reached the database before this activity was scheduled.
    const result = bannerResult(runtime.id, {
      status: 'cancelled',
      summary: 'Cancelled before execution started.',
      error: {
        code: 'RUNTIME_CANCELLED',
        message: 'The task was cancelled before execution started.',
        retryable: false,
      },
      simulated: simulatedAdapter,
    });

    await finalize('cancelled', simulatedAdapter, result.error);

    return result;
  }

  const capabilities = await runtime.capabilities();
  const missing = missingCapabilities(capabilities, requiredActionsFor());

  if (missing.length > 0) {
    const error = {
      code: 'RUNTIME_CAPABILITY_MISSING',
      message: `Runtime "${runtime.id}" cannot satisfy this task: missing ${missing.join(', ')}.`,
      retryable: false,
    };

    await finalize('failed', simulatedAdapter, error);
    throw nonRetryable(error.code, error.message);
  }

  if (config.faultInjection.failExecuteOnce) {
    const claimed = await claimOnceMarker(config.artifactRoot, `execute-${input.taskId}`);

    if (claimed) {
      const error = {
        code: 'INJECTED_TRANSIENT_FAILURE',
        message: `Injected first-attempt failure for task ${input.taskId} (WORKER_FAULT_INJECT=execute-once).`,
        retryable: true,
      };

      await finalize('failed', simulatedAdapter, error);
      throw retryable(error.code, error.message);
    }
  }

  const controller = new AbortController();
  // `cancellationSignal()` throws outside an activity context (a direct call from a
  // test or an operational script). An absent context means there is nothing to
  // cancel, not that cancellation is unsupported: inside a worker the context always
  // exists, and this is the only place the signal is read.
  const activityCancellation = safeCancellationSignal();

  const abort = (): void => {
    controller.abort(activityCancellation.reason);
    // Converges on the port's own cancel path, so an adapter that tracks executions by
    // task id cleans up exactly as it would for a direct `cancel()` call.
    void runtime.cancel(task.id);
  };

  if (activityCancellation.aborted) abort();
  else activityCancellation.addEventListener('abort', abort, { once: true });

  try {
    if (runtimeRequiresWorkspace(runtime.id)) {
      const leased = await leaseWorkspace({
        orgId: input.orgId,
        taskId: input.taskId,
        workflowRunId: workflowRun.id,
        attemptNumber: attempt.attemptNumber,
        workspaceId: executionWorkspaceIdFor(workflowRun.id, attempt.attemptNumber),
        config,
      });

      if (!leased.ok) {
        const error = {
          code: 'WORKSPACE_PROVISION_FAILED',
          message: `Workspace provisioning failed at "${leased.failure.stage}": ${leased.failure.message}`,
          retryable: false,
        };

        // No `AgentRun` is written for this: nothing executed, and a row claiming a
        // model produced a result would be the lie ADR-006 forbids. The attempt and
        // the workspace row carry the reason instead.
        await finalize('failed', simulatedAdapter, error);
        throw nonRetryable(error.code, error.message);
      }

      lease = leased.lease;
      await markExecuting(lease, input.orgId);
    }

    const timeoutMs = Math.min(config.runtime.timeoutMs, MAX_AGENT_TIMEOUT_MS);
    const request = ExecutionRequest.parse({
      taskId: task.id,
      goal: task.goal,
      // The caller owns the layout. A real run is confined to its lease; a simulated
      // one writes into the tenant-scoped artifact directory (Phase 2 behaviour).
      allowedPaths:
        lease === undefined
          ? [join(config.artifactRoot, safeSegment(input.orgId), safeSegment(task.id))]
          : [join(lease.handle.rootPath, 'repo')],
      allowedActions: [],
      riskClass: task.riskClass,
      timeoutMs,
      // Contract §15 A7: recorded, never enforced by the port. The adapter's own
      // `maxUsd` is a separate, real cap.
      budgetUsd: config.runtime.budgetUsd,
      correlationId: input.correlationId,
      ...(lease === undefined ? {} : { workspaceRoot: lease.handle.rootPath }),
    });

    const raw = await runtime.execute(request, controller.signal);
    const parsed = ExecutionResult.safeParse(raw);

    if (!parsed.success) {
      throw new RuntimeResultError(runtime.id, parsed.error.message);
    }

    // ADR-006's flag must not be forgeable at the seam. A simulated adapter claiming a
    // real run is the one combination that would relabel history as work that never
    // happened; the persistence layer rejects it too, and this is the cheaper refusal.
    if (parsed.data.runtimeId === LOCAL_SIMULATED_ID && parsed.data.simulated === false) {
      const error = {
        code: 'SIMULATED_FLAG_INCONSISTENT',
        message: 'A local-simulated result reported simulated=false.',
        retryable: false,
      };

      await finalize('failed', true, error);
      throw nonRetryable(error.code, error.message);
    }

    let result: ExecutionResult = parsed.data;

    if (lease !== undefined) {
      // `preserving` is entered before any byte is copied: a crash here must leave the
      // workspace in a state that says "evidence may be mid-write", not `executing`.
      await markPreserving(lease, input.orgId);

      const materialized = await materializeArtifacts({
        artifactsDirectory: workspaceArtifactsDirectory(lease.handle),
        artifacts: result.artifacts,
      });

      result = {
        ...result,
        artifacts: materialized.artifacts,
        providerMeta: {
          ...result.providerMeta,
          workspaceId: lease.id,
          ...(materialized.missing.length === 0
            ? {}
            : { artifactMissing: materialized.missing }),
          ...(materialized.transcriptPath === null ? { transcriptMissing: true } : {}),
        },
      };
    }

    await finalize(result.status, result.simulated, result.error);
    workspaceOutcome =
      result.status === 'succeeded'
        ? 'completed'
        : result.status === 'cancelled'
          ? 'cancelled'
          : 'failed';

    return result;
  } catch (error) {
    attemptError = error;
    const normalised = toExecutionError(error);

    await finalize('failed', simulatedAdapter, normalised);
    workspaceOutcome = 'failed';

    if (normalised.retryable) {
      // Let Temporal own the retry decision: maximumAttempts 3, exponential backoff.
      throw retryable(normalised.code, normalised.message);
    }

    // Deterministic rejection: the task failed, and that is data to persist, not an
    // exception to retry.
    return bannerResult(runtime.id, {
      status: 'failed',
      summary: `Execution failed before it could start: ${normalised.message}`,
      error: normalised,
      simulated: simulatedAdapter,
    });
  } finally {
    activityCancellation.removeEventListener('abort', abort);

    if (lease !== undefined) {
      try {
        await releaseWorkspace({
          lease,
          orgId: input.orgId,
          outcome: workspaceOutcome ?? 'failed',
          ...(attemptError === undefined ? {} : { error: attemptError }),
        });
      } catch {
        // The run's outcome is already decided and persisted; a cleanup failure must
        // not replace it. The workspace row keeps its terminal state, and the
        // manager's own error (a leaked exception here) is the operator's clue that a
        // directory may need attention.
      }
    }
  }
}

function safeCancellationSignal(): AbortSignal {
  try {
    return cancellationSignal();
  } catch {
    return new AbortController().signal;
  }
}

/** A result the platform produced, not the adapter: no artifacts, no usage. */function bannerResult(
  runtimeId: string,
  input: {
    readonly status: ExecutionResult['status'];
    readonly summary: string;
    readonly error: ExecutionResult['error'];
    readonly simulated: boolean;
  },
): ExecutionResult {
  return {
    status: input.status,
    summary: input.summary,
    artifacts: [],
    events: [],
    usage: {},
    error: input.error,
    runtimeId,
    simulated: input.simulated,
  };
}

/**
 * Capability requirements per task.
 *
 * The schema has no `requiredCapabilities` column, so this returns nothing today and
 * the gate is a hook rather than a filter. That is a schema gap, not a design choice:
 * inventing requirements from the goal's prose would be guessing. Recorded as a
 * follow-up. The check itself is live — the moment a caller supplies actions, a runtime
 * that cannot satisfy them is refused before any work starts.
 */
function requiredActionsFor(_task?: unknown): string[] {
  return [];
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw nonRetryable('INVALID_PATH_SEGMENT', `Refusing to build an artifact path from "${value}".`);
  }

  return value;
}

/**
 * Claims a one-shot marker. `flag: 'wx'` is the primitive: it fails with `EEXIST` for
 * every caller after the first, across processes, without a lock.
 */
async function claimOnceMarker(root: string, name: string): Promise<boolean> {
  const directory = join(root, '.fault-injection');
  await mkdir(directory, { recursive: true });

  try {
    await writeFile(join(directory, name), new Date().toISOString(), { flag: 'wx' });

    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') return false;

    throw error;
  }
}
