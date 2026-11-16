import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdReusePolicy,
  WorkflowNotFoundError,
  defaultGrpcRetryOptions,
  makeGrpcRetryInterceptor,
} from '@temporalio/client';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';

import { APP_CONFIG, type AppConfig, type TemporalConfig } from '../config/app-config';

/**
 * Temporal is the only orchestrator (contract §9, §16).
 *
 * ## Literals are copied, not composed
 *
 * `runTaskWorkflow` and the `intelligenz-tasks` queue appear in both this app and
 * `apps/worker`. A shared constant would need a package that both can import
 * without dragging Prisma into a worker's workflow bundle; instead the literals are
 * declared here and in §16, and the constants below name them so a drift is a
 * one-line diff.
 *
 * ## Failure is typed, never silent
 *
 * Starting a workflow has three outcomes:
 *   - started (`202`) — a `WorkflowRun` row exists and Temporal owns the execution;
 *   - already running (`409`) — an execution with the deterministic workflow id is
 *     still open, so Temporal refuses the duplicate;
 *   - unreachable (`503 ORCHESTRATOR_UNAVAILABLE`) — the task must not be left
 *     `running`, because nothing is running it.
 *
 * ## A closed run must not burn the workflow id
 *
 * The workflow id is `task-<taskId>` and it is never reused for a *successful* run.
 * But a run that closed as failed, cancelled or terminated is exactly the case the user
 * retries, and `REJECT_DUPLICATE` made that retry impossible: the id stayed reserved
 * forever, so every later `POST /run` was answered `409` with nothing running.
 * `ALLOW_DUPLICATE_FAILED_ONLY` keeps the guard that matters — a duplicate of a *running*
 * execution is still rejected — while letting a retry after a failed run start again.
 */

export const WORKFLOW_TYPE = 'runTaskWorkflow';
export const WORKFLOW_ID_PREFIX = 'task-';

/**
 * Phase 8.6: the parent workflow. Its id space is separate from `task-` because the
 * programme activities refuse to run under anything but `programme-<programmeId>` — a task
 * execution must never be able to mint a reservation or write a checkpoint.
 *
 * The worker declares the same literals (`apps/worker/src/config.ts`); see the note on
 * `WORKFLOW_TYPE` above for why they are copied rather than shared.
 */
export const PROGRAMME_WORKFLOW_TYPE = 'runProgrammeWorkflow';
export const PROGRAMME_WORKFLOW_ID_PREFIX = 'programme-';

/**
 * A programme outlives any single task by construction: it waits for chains of 10-minute
 * runs. The soft deadline the API passes is shorter (6h), so the workflow reports
 * `timed_out` before Temporal kills the execution.
 */
export const PROGRAMME_WORKFLOW_RUN_TIMEOUT = '8h';

/**
 * The two budgets, as literals. `workflowRunTimeout` accepts an `ms`-formatted string
 * (`Duration` in `@temporalio/common`, which this package does not depend on directly), so
 * the accepted set is spelled from the constants rather than widening to `string` and
 * casting at the call site.
 */
type WorkflowRunTimeout = typeof WORKFLOW_RUN_TIMEOUT | typeof PROGRAMME_WORKFLOW_RUN_TIMEOUT;

/**
 * Contract §16: `runTimeout: '10m'`. Declared as a named literal because the worker's
 * client wrapper sets the same value and a drift must be a one-line diff.
 */
export const WORKFLOW_RUN_TIMEOUT = '10m';

/**
 * The policy the start uses. Exported so a test asserts the *service's* value rather
 * than re-declaring the enum and accidentally asserting its own copy.
 *
 * `ALLOW_DUPLICATE_FAILED_ONLY` is the narrowest policy that permits a retry: a closed
 * failed/cancelled/terminated execution may be replaced, a running one may not.
 */
export const WORKFLOW_ID_REUSE_POLICY = WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY;

/** Contract §16 signature, extended in Phase 5. The API and the worker must agree. */
export interface RunTaskWorkflowInput {
  readonly taskId: string;
  readonly orgId: string;
  readonly correlationId: string;
  /**
   * The `ExecutionAttempt` the API reserved for this start, in the same transaction that
   * consumed the approval. Required, not optional: the workflow's first activity refuses
   * a run that cannot name the attempt its grant is bound to, so an API start without one
   * would be a start that is guaranteed to be refused.
   */
  readonly attemptId: string;
}

export interface StartedWorkflow {
  readonly workflowId: string;
  readonly runId: string;
}

/**
 * The parent workflow's input. `deadlineAt` is an ISO timestamp computed by the API so the
 * workflow's deadline is a property of the submission, not of whichever worker replays it.
 */
export interface StartProgrammeWorkflowInput {
  readonly programmeId: string;
  readonly orgId: string;
  readonly deadlineAt: string;
  readonly maxConcurrent?: number;
}

export type ProbeResult =
  | { readonly ok: true; readonly latencyMs: number }
  | { readonly ok: false; readonly latencyMs: number; readonly detail: string };

export type CancelResult = 'cancelled' | 'not_found';

/** gRPC status codes that mean "the orchestrator cannot take work right now". */
const GRPC_CANCELLED = 1;
const GRPC_DEADLINE_EXCEEDED = 4;
const GRPC_NOT_FOUND = 5;
const GRPC_UNAVAILABLE = 14;

export class OrchestratorUnavailableError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'OrchestratorUnavailableError';
  }
}

/**
 * A duplicate start is not an outage. Exported as a predicate so callers do not have
 * to import Temporal's error class — the task service should not need to know which
 * engine implements the orchestrator.
 */
export function isWorkflowAlreadyStartedError(error: unknown): boolean {
  return error instanceof WorkflowExecutionAlreadyStartedError;
}

@Injectable()
export class OrchestratorService implements OnApplicationShutdown {
  private client?: Client;
  private connection?: Connection;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * A getter, not a field initializer: with `useDefineForClassFields` a field
   * initializer runs before the constructor body assigns parameter properties, so
   * `private readonly temporal = this.config.temporal` would read `undefined`.
   */
  private get temporal(): TemporalConfig {
    return this.config.temporal;
  }

  /**
   * The connection's gRPC retry policy, passed explicitly instead of inherited.
   *
   * With `rpcMaxAttempts: 10` (the default) this is byte-for-byte the policy
   * `Connection.lazy()` would have installed on its own: `defaultGrpcRetryOptions()`
   * with no arguments and with `{ maxAttempts: 10 }` produce the same backoff.
   *
   * The reason to own it is `rpcMaxAttempts: 1`. The retry interceptor schedules a
   * `setTimeout` per failed attempt, and that timer is not owned by the channel —
   * `Connection.close()` does not cancel it. A timer that fires after the channel is
   * shut down throws from the timer callback, where nothing can catch it. An app that
   * is deliberately pointed at an unreachable orchestrator asserts a `503`; retrying
   * the abandoned call only buys a pending timer after the answer was decided.
   */
  private get grpcInterceptors() {
    return [
      makeGrpcRetryInterceptor(
        defaultGrpcRetryOptions({ maxAttempts: this.temporal.rpcMaxAttempts }),
      ),
    ];
  }

  /**
   * A lazy connection opens its channel on the first RPC instead of at boot. That
   * is deliberate: the API must start (and serve `/health`, which reports the
   * dependency as down) even when Temporal is not running.
   */
  private getClient(): Client {
    if (this.client !== undefined) return this.client;

    this.connection = Connection.lazy({
      address: this.temporal.address,
      connectTimeout: this.config.readinessTimeoutMs,
      interceptors: this.grpcInterceptors,
    });

    this.client = new Client({
      connection: this.connection,
      namespace: this.temporal.namespace,
    });

    return this.client;
  }

  async startTaskWorkflow(input: RunTaskWorkflowInput): Promise<StartedWorkflow> {
    const workflowId = `${WORKFLOW_ID_PREFIX}${input.taskId}`;

    return this.start(WORKFLOW_TYPE, workflowId, [input], WORKFLOW_RUN_TIMEOUT);
  }

  /**
   * Starts the Phase 8.6 parent workflow. Same id space discipline as a task: the id is
   * derived from the aggregate, so a duplicate submission is refused by Temporal rather
   * than becoming a second scheduler for one programme.
   */
  async startProgrammeWorkflow(input: StartProgrammeWorkflowInput): Promise<StartedWorkflow> {
    const workflowId = `${PROGRAMME_WORKFLOW_ID_PREFIX}${input.programmeId}`;

    return this.start(
      PROGRAMME_WORKFLOW_TYPE,
      workflowId,
      [input],
      PROGRAMME_WORKFLOW_RUN_TIMEOUT,
      // A retry after a start that failed on the server side may replace a closed failed
      // execution, but never a running one.
      WORKFLOW_ID_REUSE_POLICY,
    );
  }

  /**
   * The one place a workflow start is turned into a typed outcome.
   *
   * The two callers differ only in type, id and budget — duplicating this block would mean
   * two mappings from gRPC status to `OrchestratorUnavailableError`, and the one that
   * drifted would report an outage as a 500 or a bug as a 503.
   */
  private async start(
    type: string,
    workflowId: string,
    args: readonly unknown[],
    workflowRunTimeout: WorkflowRunTimeout,
    reusePolicy: WorkflowIdReusePolicy = WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
  ): Promise<StartedWorkflow> {
    const client = this.getClient();

    try {
      const handle = await withTimeout(
        client.workflow.start(type, {
          taskQueue: this.temporal.taskQueue,
          workflowId,
          // Contract §16, amended by this unit: reuse is permitted only when the
          // previous execution closed as failed/cancelled/terminated. A *running*
          // duplicate is still rejected by Temporal, so a retried POST cannot fork
          // two executions — but a retry after a failure can actually run.
          workflowIdReusePolicy: reusePolicy,
          // Contract §16 timeout table. Without it a stuck run has no ceiling; the
          // worker's client wrapper already sets it, and the two must agree.
          workflowRunTimeout,
          args: [...args],
        }),
        this.config.readinessTimeoutMs * 2,
      );

      return { workflowId: handle.workflowId, runId: handle.firstExecutionRunId };
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) throw error;

      const status = grpcStatus(error);

      if (
        status === GRPC_UNAVAILABLE ||
        status === GRPC_DEADLINE_EXCEEDED ||
        status === GRPC_CANCELLED ||
        error instanceof TimeoutError
      ) {
        throw new OrchestratorUnavailableError(
          `Temporal at ${this.temporal.address} did not accept the workflow start.`,
          error,
        );
      }

      // Anything else is a real bug (a bad argument, a serialization failure). It
      // must surface as a 500 with a logged stack, not be disguised as an outage.
      throw error;
    }
  }

  /**
   * Requests cancellation. `not_found` means Temporal has no execution with that id —
   * which is a safe state to treat as "nothing is running", not an error.
   *
   * The SDK converts a gRPC `NOT_FOUND` into `WorkflowNotFoundError` **before** this
   * catches anything (`WorkflowClient.rethrowGrpcError`), so the status check has to name
   * that class as well: without it a cancellation of a missing execution fell through to a
   * 500, and the caller never saw the one answer that says "there was nothing to cancel".
   */
  async cancelTaskWorkflow(workflowId: string): Promise<CancelResult> {
    const client = this.getClient();

    try {
      await withTimeout(
        client.workflow.getHandle(workflowId).cancel(),
        this.config.readinessTimeoutMs * 2,
      );

      return 'cancelled';
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) return 'not_found';

      const status = grpcStatus(error);

      if (status === GRPC_NOT_FOUND) return 'not_found';

      if (status === GRPC_UNAVAILABLE || status === GRPC_DEADLINE_EXCEEDED || status === GRPC_CANCELLED || error instanceof TimeoutError) {
        throw new OrchestratorUnavailableError(
          `Temporal at ${this.temporal.address} did not accept the cancellation.`,
          error,
        );
      }

      throw error;
    }
  }

  /**
   * Readiness probe.
   *
   * A fresh connection per probe, closed immediately: `Connection.ensureConnected`
   * memoises its *first* result, so a connection that failed once while Temporal
   * was down would keep reporting down after Temporal recovered. Channel creation
   * is cheap compared to being permanently wrong about readiness.
   *
   * It carries the same retry policy as the client, for the same reason: this
   * connection is closed milliseconds after it is used, and a retry timer outliving
   * that close throws from the timer callback instead of rejecting a promise.
   */
  async probe(): Promise<ProbeResult> {
    const startedAt = Date.now();
    const connection = Connection.lazy({
      address: this.temporal.address,
      connectTimeout: this.config.readinessTimeoutMs,
      interceptors: this.grpcInterceptors,
    });

    try {
      await withTimeout(connection.ensureConnected(), this.config.readinessTimeoutMs);
      // `ensureConnected` already proves the channel and calls getSystemInfo; the
      // extra call keeps the probe honest if that behaviour ever changes.
      await withTimeout(connection.workflowService.getSystemInfo({}), this.config.readinessTimeoutMs);

      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        detail: describeProbeFailure(error),
      };
    } finally {
      void connection.close().catch(() => undefined);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.connection?.close();
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Bounds an RPC. `client.workflow.start` has no default deadline; without this a
 * half-open connection would hold a request open until the socket gives up.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutError(`Operation exceeded ${timeoutMs}ms.`)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * gRPC errors arrive either directly (`code` on the error) or wrapped in a
 * `ServiceError` (`cause.code`). Both are checked; anything else returns undefined
 * so the caller rethrows instead of guessing.
 */
function grpcStatus(error: unknown, depth = 0): number | undefined {
  if (typeof error !== 'object' || error === null || depth > 3) return undefined;

  const code = (error as { code?: unknown }).code;
  if (typeof code === 'number') return code;

  return grpcStatus((error as { cause?: unknown }).cause, depth + 1);
}

/** A readiness detail is a classification, never a raw driver message. */
function describeProbeFailure(error: unknown): string {
  if (error instanceof TimeoutError) return 'timeout';

  // `Connection.ensureConnected` throws a bare `Error('Failed to connect before the
  // deadline')` when the server is not listening — no gRPC status to read. The
  // pattern is SDK-generated, not user input, so matching it adds no injection risk.
  if (error instanceof Error && /deadline|timed? ?out/i.test(error.message)) return 'timeout';

  switch (grpcStatus(error)) {
    case GRPC_UNAVAILABLE:
      return 'unavailable';
    case GRPC_DEADLINE_EXCEEDED:
      return 'deadline_exceeded';
    case GRPC_NOT_FOUND:
      return 'not_found';
    default:
      return 'error';
  }
}
