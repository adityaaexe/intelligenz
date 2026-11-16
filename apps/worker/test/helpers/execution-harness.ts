import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Client, Connection, WorkflowFailedError, WorkflowIdReusePolicy, WorkflowNotFoundError } from '@temporalio/client';
import type { WorkflowHandle } from '@temporalio/client';
import type { Workflow } from '@temporalio/workflow';
import { NativeConnection, Worker } from '@temporalio/worker';

import { activities } from '../../src/activities';
import type { ProbeStep } from '../fixtures/probe.workflow';

/**
 * The names, not the workflow-side definitions: `defineUpdate`/`defineSignal` are workflow
 * APIs and importing them into the test process would drag the sandbox in. The strings are
 * the contract, and a typo fails the first update rather than silently passing.
 */
const runStepsUpdateName = 'runSteps';
const finishSignalName = 'finish';

/** gRPC `NOT_FOUND`. The API maps the same code to `not_found` for a cancellation. */
const GRPC_NOT_FOUND = 5;

/**
 * Run activities inside a **real workflow execution** — Phase 6, AG-603.
 *
 * ## What this replaces, and why it had to
 *
 * These tests used to call `validateTaskActivity`, `executeAgentActivity`,
 * `persistResultActivity` and `completeTaskActivity` as ordinary functions and hand them
 * the execution identity (`executionRunId`, and the `workflowRunId` that
 * `executionIdentity` fell back to). The re-review demonstrated what that fallback meant:
 * a standalone activity supplying a victim's run id satisfied the launch-site claim, ran
 * attempt 2 under the victim's claim concurrently with attempt 1, and — where the victim
 * had not adopted yet — spent the reservation the legitimate execution needed.
 *
 * The fallback is gone, so this helper supplies **nothing**. Every identity these tests
 * observe is minted by the Temporal server for the workflow this helper starts and is read
 * back from `handle.firstExecutionRunId`. It is never sent, so no test can send a different
 * one. `test/execution-identity.test.ts` proves the negative: the standalone shape the
 * reviewer used is now refused with zero side effects, whatever it puts in the input.
 *
 * ## Shape
 *
 * ```ts
 * const harness = await createExecutionHarness();
 * const session = await harness.session();       // a workflow, RUNNING, no steps yet
 * await claimUnder(session.runId);               // arrange state under the server's id
 * const [validated] = await session.run([{ op: 'validate', input }]);
 * await harness.close();
 * ```
 *
 * `run` may be called repeatedly: each call is a workflow **update**, so the results come
 * back to the caller and a test can interleave database assertions with steps of one
 * execution. That is what makes "claim, launch, assert, retry" expressible without two
 * identities.
 */

const PROBE_WORKFLOW_PATH = fileURLToPath(
  new URL('../fixtures/probe.workflow.ts', import.meta.url),
);

export interface ExecutionSession {
  /** The Temporal run id of this session — the identity every activity in it will see. */
  readonly runId: string;
  /** Signals the steps and returns their results. Once per session. */
  run<T = unknown>(steps: readonly ProbeStep[]): Promise<readonly T[]>;
  /** Convenience for a single-step session. */
  call<T = unknown>(step: ProbeStep): Promise<T>;
  /** Ends the execution without running anything — used to prove "this run is live/gone". */
  stop(): Promise<void>;
}

export interface SessionOptions {
  /**
   * The workflow id to start under.
   *
   * Defaults to a random `probe-<uuid>`, which is the right shape for every test whose
   * subject is the **claim**: a claim check reads the run id, and a rogue workflow's id is
   * irrelevant to it. The pre-dispatch completion arm is different — its control *is* the
   * derived `task-<taskId>` id (see `requireCompletionAuthority`), so a test of that arm
   * has to start under the id production uses.
   */
  readonly workflowId?: string;
}

export interface ExecutionHarness {
  /** The task queue the probe worker polls — the same queue a standalone activity needs. */
  readonly taskQueue: string;
  session(options?: SessionOptions): Promise<ExecutionSession>;
  /**
   * Starts an arbitrary workflow on this harness's queue.
   *
   * The probe session above exists to run **activities** under a real execution identity.
   * A test that needs a real *workflow* — Phase 8.6's `runProgrammeWorkflow` — starts it
   * here, against the same worker and the same production activity registry. The workflow
   * is only startable if the harness bundled it (`workflowsPath`).
   */
  start(
    workflowType: string,
    options: StartWorkflowOptions,
  ): Promise<WorkflowHandle<Workflow>>;
  /**
   * Dispatches an activity **outside any workflow** — the reviewer's N1 reproduction.
   *
   * `Client.activity` starts a standalone activity: it is a real activity task, executed
   * by the real worker, with a real activity context and **no workflow execution**. Before
   * AG-603 the identity was read from the input on that path; this is the call shape that
   * proved it.
   */
  executeStandalone<T = unknown>(activity: string, args: readonly unknown[]): Promise<T>;
  /**
   * Requests cancellation of one execution **by workflow id** — the exact RPC
   * `POST /cancel` issues (`OrchestratorService.cancelTaskWorkflow`).
   *
   * `not_found` is a return value, not a throw, because the API's behaviour on it is the
   * subject of a test: Temporal having no execution under that id is a fact the caller has
   * to act on, and after the Phase 8.6 fix the API refuses rather than writing `cancelled`.
   */
  cancelWorkflow(workflowId: string): Promise<'cancelled' | 'not_found'>;
  /**
   * Temporal's own view of one execution, or `null` when it has none.
   *
   * The re-probe an operator performs from a task id. It is also how a test proves the
   * child a programme started really reached a terminal state instead of running on.
   */
  describeWorkflow(
    workflowId: string,
  ): Promise<{ readonly status: string; readonly runId: string } | null>;
  close(): Promise<void>;
}

export interface StartWorkflowOptions {
  readonly workflowId?: string;
  readonly args?: readonly unknown[];
  /**
   * The workflow's run budget. Typed from the client's own option so the helper cannot
   * accept a string Temporal would reject (`Duration` is an `ms`-formatted literal).
   */
  readonly workflowRunTimeout?: Parameters<Client['workflow']['start']>[1]['workflowRunTimeout'];
}

export interface ExecutionHarnessOptions {
  readonly address?: string;
  readonly namespace?: string;
  /**
   * The workflows **module** the worker bundles. Defaults to the activity probe, which
   * registers no production workflow. A suite that starts a real workflow passes
   * `fileURLToPath(new URL('../src/workflows/index.ts', import.meta.url))`.
   */
  readonly workflowsPath?: string;
}

export async function createExecutionHarness(
  options: ExecutionHarnessOptions = {},
): Promise<ExecutionHarness> {
  const address = options.address ?? process.env['TEMPORAL_ADDRESS']?.trim() ?? 'localhost:7233';
  const namespace = options.namespace ?? process.env['TEMPORAL_NAMESPACE']?.trim() ?? 'default';
  const taskQueue = `intelligenz-probe-${randomUUID().slice(0, 8)}`;

  const nativeConnection = await NativeConnection.connect({ address });

  // The **production** activity registry, not a subset: a probe that registered copies of
  // the activities would be testing the harness rather than the worker.
  const worker = await Worker.create({
    connection: nativeConnection,
    namespace,
    taskQueue,
    workflowsPath: options.workflowsPath ?? PROBE_WORKFLOW_PATH,
    activities,
  });

  // `run()` never resolves while the worker is healthy; it rejects if the worker dies. The
  // rejection is captured so a failing worker surfaces as a failed test rather than as a
  // hang on `result()`.
  let workerFailure: unknown;
  const running = worker.run().catch((error: unknown) => {
    workerFailure = error;
  });

  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });

  return {
    taskQueue,

    /**
     * Starts a workflow on this worker and returns its handle.
     *
     * Deliberately does not await the result: the caller decides when to join, and the
     * programme suite must be able to assert against the database *while* the parent is
     * still running if it ever needs to.
     */
    async start(
      workflowType: string,
      startOptions: StartWorkflowOptions,
    ): Promise<WorkflowHandle<Workflow>> {
      if (workerFailure !== undefined) {
        throw new Error(`probe worker died before the start: ${String(workerFailure)}`);
      }

      return client.workflow.start(workflowType, {
        taskQueue,
        workflowId: startOptions.workflowId ?? `probe-${randomUUID()}`,
        args: [...(startOptions.args ?? [])],
        ...(startOptions.workflowRunTimeout === undefined
          ? {}
          : { workflowRunTimeout: startOptions.workflowRunTimeout }),
      });
    },

    async session(options: SessionOptions = {}): Promise<ExecutionSession> {
      if (workerFailure !== undefined) {
        throw new Error(`probe worker died before the session started: ${String(workerFailure)}`);
      }

      const handle = await client.workflow.start('probeExecution', {
        taskQueue,
        workflowId: options.workflowId ?? `probe-${randomUUID()}`,
        // Production starts `task-<taskId>` with REJECT_DUPLICATE. A test that starts under
        // that id is asserting the same uniqueness, so it must not silently create a
        // second run beside a live one.
        ...(options.workflowId === undefined
          ? {}
          : { workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE }),
        // The workflow takes no arguments: nothing a test supplies can influence the run id
        // the server mints, which is the whole point of the seam this replaces.
        args: [],
      });

      const runId = handle.firstExecutionRunId;
      let stopped = false;

      const run = async <T>(steps: readonly ProbeStep[]): Promise<readonly T[]> => {
        if (stopped) {
          throw new Error('probe session has already been stopped; start a new session.');
        }

        try {
          // An update, so the results come back to the caller: a test can claim, launch,
          // assert, and launch again inside one execution (one identity).
          return await handle.executeUpdate<readonly T[], [readonly ProbeStep[]]>(
            runStepsUpdateName,
            { args: [steps] },
          );
        } catch (error) {
          throw unwrapActivityFailure(error);
        }
      };

      return {
        runId,
        run,
        async call<T>(step: ProbeStep): Promise<T> {
          const [only] = await run<T>([step]);
          return only as T;
        },
        async stop(): Promise<void> {
          stopped = true;

          // `finishSignal`, then join the result. `terminate` is the fallback for a session
          // that cannot make progress — a test failing mid-step should not leak a workflow
          // that keeps a worker busy for the rest of the file.
          await handle.signal(finishSignalName).catch(() => undefined);
          await withDeadline(handle.result(), 10_000).catch(async () => {
            await handle.terminate('probe session stopped by the test').catch(() => undefined);
          });
        },
      };
    },

    async executeStandalone<T>(activity: string, args: readonly unknown[]): Promise<T> {
      if (workerFailure !== undefined) {
        throw new Error(`probe worker died before the standalone call: ${String(workerFailure)}`);
      }

      try {
        return await client.activity.execute<T>(activity, {
          // Unique per call: an activity id is a business key and a duplicate id would be
          // rejected rather than dispatched, which would make the refusal look like the fix.
          id: `standalone-${activity}-${randomUUID()}`,
          taskQueue,
          args: [...args],
          startToCloseTimeout: '30s',
          // One attempt: the refusal must be observed as one refusal.
          retry: { maximumAttempts: 1 },
        });
      } catch (error) {
        throw unwrapActivityFailure(error);
      }
    },

    /**
     * `workflow.getHandle(id).cancel()` — the RPC the API performs.
     *
     * `not_found` is a return value rather than an error because "Temporal has no execution
     * under this id" is a state the caller must act on, exactly as
     * `OrchestratorService.cancelTaskWorkflow` treats it. The SDK converts a gRPC
     * `NOT_FOUND` into `WorkflowNotFoundError`, so both shapes are recognised here.
     */
    async cancelWorkflow(workflowId: string): Promise<'cancelled' | 'not_found'> {
      try {
        await client.workflow.getHandle(workflowId).cancel();
        return 'cancelled';
      } catch (error) {
        if (error instanceof WorkflowNotFoundError) return 'not_found';
        if ((error as { code?: unknown }).code === GRPC_NOT_FOUND) return 'not_found';

        throw error;
      }
    },

    /**
     * Temporal's own view of one execution — the re-probe an operator performs from a task
     * id, and the proof that a cancelled child reached a terminal state.
     */
    async describeWorkflow(
      workflowId: string,
    ): Promise<{ readonly status: string; readonly runId: string } | null> {
      try {
        const description = await client.workflow.getHandle(workflowId).describe();

        return { status: description.status.name, runId: description.runId };
      } catch (error) {
        if (error instanceof WorkflowNotFoundError) return null;
        if ((error as { code?: unknown }).code === GRPC_NOT_FOUND) return null;

        throw error;
      }
    },

    /**
     * Release everything. **Does not throw**, on purpose.
     *
     * This runs in `afterAll`, before the tenant fixtures are dropped. A close that threw
     * would skip the cleanup and leave a tenant in the shared test database — which is
     * exactly what happened once, and `packages/database`'s seed test counts rows globally,
     * so eight orphaned tenants turned an unrelated suite red. Cleanup is the last thing
     * that may fail a test.
     */
    async close(): Promise<void> {
      try {
        await connection.close().catch(() => undefined);
        // `shutdown()` is synchronous in SDK 1.25 (it requests the shutdown); `run()`
        // resolves once the worker has actually drained, so the await below is the join.
        worker.shutdown();
        await running.catch(() => undefined);
        await nativeConnection.close().catch(() => undefined);
      } catch {
        // Nothing left to do: the handles above are the whole of this harness's holdings.
      }
    },
  };
}

/**
 * The `ApplicationFailure` the activity threw, not Temporal's wrapper.
 *
 * A refusal through a workflow arrives as `WorkflowFailedError` → `ActivityFailure` →
 * `ApplicationFailure`. Assertions are about `type` and `nonRetryable`, which live on the
 * innermost one; returning the wrapper would turn every `{ type: 'EXECUTION_CLAIM_REFUSED' }`
 * assertion into a test of Temporal's error plumbing.
 */
function unwrapActivityFailure(error: unknown): unknown {
  let best: unknown;
  let candidate: unknown = error;

  for (let depth = 0; depth < 8 && candidate !== undefined; depth += 1) {
    if (isApplicationFailureLike(candidate)) best = candidate;

    const cause = (candidate as { cause?: unknown }).cause;
    if (cause === candidate) break;
    candidate = cause;
  }

  if (best !== undefined) return best;

  // A workflow that failed for its own reason (a cancellation, a determinism error) has no
  // activity failure in the chain: pass it through unchanged so the failure is visible.
  if (error instanceof WorkflowFailedError && error.cause !== undefined) return error.cause;

  return error;
}

/**
 * An `ApplicationFailure` by shape.
 *
 * `@temporalio/common` is not a dependency of this package (pnpm's isolated store), and
 * `@temporalio/client` does not re-export the guard. The shape is stable and unambiguous:
 * every `TemporalFailure` wrapper (`ActivityFailure`, `WorkflowFailedError`) leaves `type`
 * undefined, while `ApplicationFailure` carries the activity's own code in it — which is
 * the value every assertion in these suites is about.
 */
function isApplicationFailureLike(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;

  const candidate = value as { name?: unknown; type?: unknown };

  return candidate.name === 'ApplicationFailure' && typeof candidate.type === 'string';
}

/** A deadline for cleanup paths, so a wedged session fails instead of hanging the suite. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      timer.unref();
    }),
  ]);
}

/**
 * Whether a Temporal server is answering.
 *
 * The suites that need a real execution identity gate on this instead of failing: without a
 * server there is no identity to obtain, and the alternative — a test seam that supplies
 * one — is the defect AG-603 removed. `temporalEnabled === false` must therefore be a
 * *skip*, visible in the run summary, never a silent pass.
 */
export async function temporalReachable(): Promise<boolean> {
  const address = process.env['TEMPORAL_ADDRESS']?.trim() || 'localhost:7233';
  const [host, rawPort] = address.split(':');
  const port = Number.parseInt(rawPort ?? '7233', 10);

  const { connect } = await import('node:net');

  return new Promise((resolve) => {
    const socket = connect({ host: host ?? 'localhost', port });

    const finish = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(1_500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}
