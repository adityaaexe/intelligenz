import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cancellationSignal } from '@temporalio/activity';
import {
  ExecutionRequest,
  ExecutionResult,
  RuntimeResultError,
  missingCapabilities,
  toExecutionError,
} from '@intelligenz/agent-runtime';

import { getWorkerConfig } from '../config';
import { getAgentRuntime } from '../runtime';
import type {
  ExecuteAgentActivityInput,
  ExecuteAgentActivityResult,
} from '../shared/contracts';
import { db, nonRetryable, retryable } from './support';

/**
 * `executeAgentActivity` — contract §16.
 *
 * **The only place the runtime is touched.** The workflow calls this activity by name
 * and knows nothing about adapters, capabilities, abort signals or vendor quirks. A
 * real runtime arrives by changing `src/runtime.ts`, not this activity's contract.
 *
 * ## Three things this activity owns
 *
 * 1. **The capability gate** (ADR-006). Checked before any work, so a task that needs a
 *    shell is refused up front rather than half-finished and misleadingly artefacted.
 * 2. **Cancellation plumbing.** Temporal's `cancellationSignal()` is chained into the
 *    `AbortSignal` the port requires, and `runtime.cancel(taskId)` is called on it — the
 *    port's `cancel` argument is `taskId` precisely because `execute` returns no handle
 *    (contract §15 A4).
 * 3. **Normalisation.** A thrown `retryable` error becomes a Temporal retry; a
 *    non-retryable one becomes a `failed` result the workflow can persist as an outcome.
 *    A task that fails is not an infrastructure error, and retrying it is waste.
 *
 * ## Fault injection (dev only)
 *
 * `WORKER_FAULT_INJECT=execute-once` makes the **first** attempt throw a retryable
 * error. The "first" is claimed with an exclusive marker file under
 * `<ARTIFACT_ROOT>/.fault-injection/`, so it survives an activity retry in another
 * process and can never fire twice. It exists to prove that Temporal retried; it is
 * inert unless the variable is set.
 */

/** Kept under the activity's 60s `startToCloseTimeout` so the reason is not lost. */
const MAX_AGENT_TIMEOUT_MS = 55_000;

export async function executeAgentActivity(
  input: ExecuteAgentActivityInput,
): Promise<ExecuteAgentActivityResult> {
  const config = getWorkerConfig();
  const runtime = getAgentRuntime(config);

  const task = await db().task.findFirst({
    // Tenant scoping.
    where: { id: input.taskId, orgId: input.orgId },
    select: { id: true, goal: true, riskClass: true, status: true, projectId: true },
  });

  if (task === null) {
    throw nonRetryable('TASK_NOT_FOUND', `Task ${input.taskId} does not exist in this org.`);
  }

  if (task.status === 'cancelled') {
    // A cancellation that reached the database before this activity was scheduled.
    return {
      status: 'cancelled',
      summary: 'Cancelled before execution started.',
      artifacts: [],
      events: [],
      usage: {},
      error: {
        code: 'RUNTIME_CANCELLED',
        message: 'The task was cancelled before execution started.',
        retryable: false,
      },
      runtimeId: runtime.id,
      simulated: true,
    };
  }

  const capabilities = await runtime.capabilities();
  const missing = missingCapabilities(capabilities, requiredActionsFor());

  if (missing.length > 0) {
    throw nonRetryable(
      'RUNTIME_CAPABILITY_MISSING',
      `Runtime "${runtime.id}" cannot satisfy this task: missing ${missing.join(', ')}.`,
    );
  }

  if (config.faultInjection.failExecuteOnce) {
    const claimed = await claimOnceMarker(config.artifactRoot, `execute-${input.taskId}`);

    if (claimed) {
      throw retryable(
        'INJECTED_TRANSIENT_FAILURE',
        `Injected first-attempt failure for task ${input.taskId} (WORKER_FAULT_INJECT=execute-once).`,
      );
    }
  }

  const timeoutMs = Math.min(config.runtime.timeoutMs, MAX_AGENT_TIMEOUT_MS);
  const request = ExecutionRequest.parse({
    taskId: task.id,
    goal: task.goal,
    // The caller owns the tenant-scoped layout; the runtime only writes inside it.
    allowedPaths: [join(config.artifactRoot, safeSegment(input.orgId), safeSegment(task.id))],
    allowedActions: [],
    riskClass: task.riskClass,
    timeoutMs,
    // Contract §15 A7: recorded, never enforced.
    budgetUsd: config.runtime.budgetUsd,
    correlationId: input.correlationId,
  });

  const controller = new AbortController();
  const activityCancellation = cancellationSignal();

  const abort = (): void => {
    controller.abort(activityCancellation.reason);
    // Converges on the port's own cancel path, so an adapter that tracks executions by
    // task id cleans up exactly as it would for a direct `cancel()` call.
    void runtime.cancel(task.id);
  };

  if (activityCancellation.aborted) abort();
  else activityCancellation.addEventListener('abort', abort, { once: true });

  try {
    const raw = await runtime.execute(request, controller.signal);
    const parsed = ExecutionResult.safeParse(raw);

    if (!parsed.success) {
      throw new RuntimeResultError(runtime.id, parsed.error.message);
    }

    return parsed.data;
  } catch (error) {
    const normalised = toExecutionError(error);

    if (normalised.retryable) {
      // Let Temporal own the retry decision: maximumAttempts 3, exponential backoff.
      throw retryable(normalised.code, normalised.message);
    }

    // Deterministic rejection: the task failed, and that is data to persist, not an
    // exception to retry.
    return {
      status: 'failed',
      summary: `Execution failed before it could start: ${normalised.message}`,
      artifacts: [],
      events: [],
      usage: {},
      error: normalised,
      runtimeId: runtime.id,
      simulated: true,
    };
  } finally {
    activityCancellation.removeEventListener('abort', abort);
  }
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
