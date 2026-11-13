import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdReusePolicy,
} from '@temporalio/client';

import { WORKFLOW_ID_PREFIX, WORKFLOW_TYPE } from './config';
import type { RunTaskWorkflowInput, RunTaskWorkflowResult } from './shared/contracts';
import type { runTaskWorkflow } from './workflows/run-task';

/**
 * A thin `TemporalClient` wrapper, reusable by the API.
 *
 * The API already has its own orchestrator service (it must answer `/health/ready` and
 * map gRPC codes to `503 ORCHESTRATOR_UNAVAILABLE`), so this is not a replacement for it.
 * It exists because the worker's tests and operational scripts need the same two calls,
 * and because the literals that matter — workflow type, id prefix, reuse policy, run
 * timeout — should be stated once in a place that is not a controller.
 *
 * ## The two decisions encoded here
 *
 * 1. **`workflowId: task-<taskId>` with `REJECT_DUPLICATE`.** Temporal, not application
 *    code, is what makes a duplicate start impossible. A retried `POST /run` cannot fork
 *    two executions.
 * 2. **`workflowRunTimeout: 10m`.** Contract §16. The API's own start does not set it
 *    (out of this unit's scope); without it, a stuck run has no ceiling.
 */

export interface TemporalTaskClientOptions {
  readonly address?: string;
  readonly namespace?: string;
  readonly taskQueue?: string;
}

export interface StartedTaskWorkflow {
  readonly workflowId: string;
  readonly runId: string;
  /** `true` when Temporal rejected a second start for the same task id. */
  readonly alreadyStarted: boolean;
}

export type CancelOutcome = 'cancelled' | 'not_found';

/** gRPC status code for "no such execution". */
const GRPC_NOT_FOUND = 5;

export const DEFAULT_TEMPORAL_ADDRESS = 'localhost:7233';
export const DEFAULT_NAMESPACE = 'default';
export const DEFAULT_TASK_QUEUE = 'intelligenz-tasks';

export class TemporalTaskClient {
  readonly #client: Client;
  readonly #connection: Connection;
  readonly #taskQueue: string;

  private constructor(client: Client, connection: Connection, taskQueue: string) {
    this.#client = client;
    this.#connection = connection;
    this.#taskQueue = taskQueue;
  }

  static async connect(options: TemporalTaskClientOptions = {}): Promise<TemporalTaskClient> {
    const connection = await Connection.connect({
      address: options.address ?? DEFAULT_TEMPORAL_ADDRESS,
    });

    const client = new Client({
      connection,
      namespace: options.namespace ?? DEFAULT_NAMESPACE,
    });

    return new TemporalTaskClient(client, connection, options.taskQueue ?? DEFAULT_TASK_QUEUE);
  }

  async startRunTask(input: RunTaskWorkflowInput): Promise<StartedTaskWorkflow> {
    const workflowId = `${WORKFLOW_ID_PREFIX}${input.taskId}`;

    try {
      const handle = await this.#client.workflow.start(WORKFLOW_TYPE, {
        taskQueue: this.#taskQueue,
        workflowId,
        workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
        workflowRunTimeout: '10m',
        args: [input],
      });

      return { workflowId, runId: handle.firstExecutionRunId, alreadyStarted: false };
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) {
        return { workflowId, runId: '', alreadyStarted: true };
      }

      throw error;
    }
  }

  /**
   * Requests cancellation. `not_found` is a state, not an error: there was no execution
   * to cancel, so nothing is running, which is what the caller wanted.
   */
  async cancelRunTask(taskId: string): Promise<CancelOutcome> {
    try {
      await this.#client.workflow.getHandle(`${WORKFLOW_ID_PREFIX}${taskId}`).cancel();

      return 'cancelled';
    } catch (error) {
      if (grpcStatus(error) === GRPC_NOT_FOUND) return 'not_found';

      throw error;
    }
  }

  /** Resolves when the workflow finishes. Rejects if it fails or is cancelled. */
  async waitForRunTask(taskId: string): Promise<RunTaskWorkflowResult> {
    const handle = this.#client.workflow.getHandle<typeof runTaskWorkflow>(
      `${WORKFLOW_ID_PREFIX}${taskId}`,
    );

    return handle.result();
  }

  async describeRunTask(
    taskId: string,
  ): Promise<{ workflowId: string; runId: string; status: string }> {
    const description = await this.#client.workflow
      .getHandle(`${WORKFLOW_ID_PREFIX}${taskId}`)
      .describe();

    return {
      workflowId: description.workflowId,
      runId: description.runId,
      status: description.status.name,
    };
  }

  async close(): Promise<void> {
    await this.#connection.close();
  }
}

function grpcStatus(error: unknown, depth = 0): number | undefined {
  if (typeof error !== 'object' || error === null || depth > 3) return undefined;

  const code = (error as { code?: unknown }).code;
  if (typeof code === 'number') return code;

  return grpcStatus((error as { cause?: unknown }).cause, depth + 1);
}
