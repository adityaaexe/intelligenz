import { beforeEach, describe, expect, it, vi } from 'vitest';

// Type-only: erased at runtime, so it does not defeat the `vi.mock` factory below.
import type * as TemporalClientModule from '@temporalio/client';

/**
 * Unit test for the **start options** the API sends to Temporal.
 *
 * This is an options assertion, not a live Temporal execution: `@temporalio/client` is
 * mocked so the call can be inspected without a server, a worker, or a database. What it
 * proves is that the API asks for the reuse policy that makes a retry possible at all —
 * the behaviour of that policy (a closed *failed* run may be replaced, a *running* one may
 * not) is Temporal's, and is verified against the running server outside this suite.
 */

const temporalMock = vi.hoisted(() => ({ start: vi.fn() }));

vi.mock('@temporalio/client', async (importOriginal) => {
  const actual = await importOriginal<typeof TemporalClientModule>();

  class Client {
    readonly workflow = { start: temporalMock.start };
  }

  return {
    ...actual,
    Client,
    Connection: { lazy: () => ({ close: () => Promise.resolve() }) },
  };
});

import { WorkflowExecutionAlreadyStartedError, WorkflowIdReusePolicy } from '@temporalio/client';

import type { AppConfig } from '../src/config/app-config';
import {
  OrchestratorService,
  WORKFLOW_ID_PREFIX,
  WORKFLOW_ID_REUSE_POLICY,
  WORKFLOW_RUN_TIMEOUT,
  WORKFLOW_TYPE,
  type RunTaskWorkflowInput,
} from '../src/orchestrator/orchestrator.service';

const TASK_ID = '9d0e5c1a-1f2b-4c3d-8e4f-5a6b7c8d9e0f';

const config: AppConfig = {
  nodeEnv: 'test',
  port: 4100,
  host: '127.0.0.1',
  // Never connected: the client is mocked, and no query runs in this suite.
  databaseUrl: 'postgresql://unused/unused',
  jwtSecret: 'test-secret',
  jwtTtlSeconds: 60,
  logLevel: 'silent',
  corsOrigins: [],
  temporal: { address: 'localhost:7233', namespace: 'default', taskQueue: 'intelligenz-tasks' },
  readinessTimeoutMs: 2_000,
};

const input: RunTaskWorkflowInput = {
  taskId: TASK_ID,
  orgId: '6f1d2c3b-4a59-4687-9a0b-1c2d3e4f5a6b',
  correlationId: '7a2e3d4c-5b60-4798-8b1c-2d3e4f5a6b7c',
};

/** The options object the service handed to `client.workflow.start`. */
function capturedOptions(): Record<string, unknown> {
  const call = temporalMock.start.mock.calls.at(-1);
  if (call === undefined) throw new Error('client.workflow.start was never called');

  const [workflowType, options] = call as [string, Record<string, unknown>];

  expect(workflowType).toBe(WORKFLOW_TYPE);

  return options;
}

describe('OrchestratorService.startTaskWorkflow — retry after a closed run', () => {
  beforeEach(() => {
    temporalMock.start.mockReset();
    temporalMock.start.mockResolvedValue({
      workflowId: `${WORKFLOW_ID_PREFIX}${TASK_ID}`,
      firstExecutionRunId: 'temporal-run-1',
    });
  });

  it('asks Temporal to allow reuse only for a failed/cancelled/terminated run', async () => {
    const service = new OrchestratorService(config);

    await service.startTaskWorkflow(input);

    const options = capturedOptions();

    expect(options['workflowIdReusePolicy']).toBe(
      WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
    );

    // The two policies this deliberately is *not*:
    //   - `REJECT_DUPLICATE` burned `task-<id>` forever once any run closed, which made
    //     retrying a failed task impossible (the reported bug);
    //   - `ALLOW_DUPLICATE` would let a second execution start while one is still open.
    expect(options['workflowIdReusePolicy']).not.toBe(WorkflowIdReusePolicy.REJECT_DUPLICATE);
    expect(options['workflowIdReusePolicy']).not.toBe(WorkflowIdReusePolicy.ALLOW_DUPLICATE);

    // Exported constant and the option must not drift apart.
    expect(WORKFLOW_ID_REUSE_POLICY).toBe(WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY);
  });

  it('sets the §16 workflow run timeout and keeps the deterministic workflow id', async () => {
    const service = new OrchestratorService(config);

    const started = await service.startTaskWorkflow(input);
    const options = capturedOptions();

    expect(options['workflowRunTimeout']).toBe(WORKFLOW_RUN_TIMEOUT);
    expect(WORKFLOW_RUN_TIMEOUT).toBe('10m');
    expect(options['workflowId']).toBe(`task-${TASK_ID}`);
    // The id format is part of contract §16 and of every run already in the database.
    expect(started.workflowId).toBe(`${WORKFLOW_ID_PREFIX}${TASK_ID}`);
    expect(options['taskQueue']).toBe('intelligenz-tasks');
  });

  it('still surfaces a running duplicate as the typed already-started error', async () => {
    temporalMock.start.mockRejectedValue(
      new WorkflowExecutionAlreadyStartedError(
        'Workflow execution already started',
        `task-${TASK_ID}`,
        WORKFLOW_TYPE,
      ),
    );

    const service = new OrchestratorService(config);

    // A running duplicate must not be disguised as an outage (503) or as success: the
    // task service turns this exact error into `409 WORKFLOW_ALREADY_RUNNING`.
    await expect(service.startTaskWorkflow(input)).rejects.toBeInstanceOf(
      WorkflowExecutionAlreadyStartedError,
    );
  });
});
