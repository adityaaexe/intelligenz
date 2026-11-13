import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';

import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PrismaClient } from '@intelligenz/database';

import { activities } from '../src/activities';
import { validateTaskActivity } from '../src/activities/validate-task';
import { resetWorkerConfig } from '../src/config';
import { resetAgentRuntime } from '../src/runtime';
import type { RunTaskWorkflowResult } from '../src/shared/contracts';
import {
  createTask,
  createTenant,
  dropTenant,
  testDatabaseUrl,
  useTestDatabase,
  type TenantFixture,
} from './helpers/database';

/**
 * Approval enforcement, path 3: **a direct Temporal start**.
 *
 * The API checks the approval gate on `POST /run`, and `PATCH` cannot perform
 * `ready → queued` at all. Both are HTTP-layer guarantees; neither means anything if a
 * caller with a Temporal address can start `runTaskWorkflow` themselves. This test does
 * exactly that — no API, no `POST /run`, no `WorkflowRun` row — and proves the worker
 * refuses:
 *
 *   1. `validateTaskActivity` throws `APPROVAL_REQUIRED` (the refusal is exceptional,
 *      so it cannot be mistaken for "nothing to do");
 *   2. the workflow ends with a `failed` outcome and writes a `task.failed.v1` audit
 *      event carrying the same code;
 *   3. **no `AgentRun`, `ExecutionAttempt` or `ExecutionWorkspace` row is created** —
 *      the agent never ran, and the database says so.
 *
 * The task itself stays `ready`: a stray workflow start must not burn a user's task.
 * That matches the API path, where a refused `POST /run` also leaves the task `ready`.
 *
 * Skips (with a reason) when Temporal or the test database is unavailable. A silent
 * pass would be worse than no test — this is the path that cannot be faked.
 */

const WORKFLOW_PATH = fileURLToPath(new URL('../src/workflows/run-task.ts', import.meta.url));

const databaseUrl = testDatabaseUrl();
const databaseEnabled = databaseUrl !== undefined;

const TEMPORAL_ADDRESS = process.env['TEMPORAL_ADDRESS']?.trim() || 'localhost:7233';
const TEMPORAL_NAMESPACE = process.env['TEMPORAL_NAMESPACE']?.trim() || 'default';

let temporalReachable = false;
let temporalReason = `Temporal not reachable at ${TEMPORAL_ADDRESS}`;

if (databaseEnabled) {
  const probe = await probeTcp(TEMPORAL_ADDRESS);

  temporalReachable = probe.ok;
  temporalReason = probe.reason;
}

const enabled = databaseEnabled && temporalReachable;

let suiteTenant: TenantFixture | undefined;
let client: PrismaClient | undefined;

beforeAll(async () => {
  if (!databaseEnabled) return;

  const database = useTestDatabase();
  client = database.client;

  process.env['DATABASE_URL'] = database.url;
  process.env['ARTIFACT_ROOT'] = process.env['ARTIFACT_ROOT'] ?? '/tmp/intelligenz-worker-approval';
  process.env['AGENT_RUNTIME'] = 'local-simulated';

  resetWorkerConfig();
  resetAgentRuntime();

  suiteTenant = await createTenant(client, 'approval-bypass');
});

afterAll(async () => {
  if (client !== undefined && suiteTenant !== undefined) {
    await dropTenant(client, suiteTenant);
    await client.$disconnect();
  }
});

describe.skipIf(!enabled)('approval enforcement on a direct workflow start', () => {
  it('refuses a HIGH task with no approval and never invokes the agent', async () => {
    if (client === undefined || suiteTenant === undefined) throw new Error('suite not initialised');

    const task = await createTask(client, suiteTenant, {
      title: 'CRITICAL change with no approval',
      status: 'ready',
      riskClass: 'HIGH',
    });

    // A PENDING request exists — the state a HIGH task is created in. PENDING is not
    // APPROVED, and the gate must not accept it.
    await client.approvalRequest.create({
      data: {
        orgId: suiteTenant.orgId,
        taskId: task.taskId,
        riskClass: 'HIGH',
        status: 'PENDING',
        requestedById: suiteTenant.userId,
      },
    });

    // (1) The activity itself throws, with a machine-readable type.
    await expect(
      validateTaskActivity({ taskId: task.taskId, orgId: suiteTenant.orgId }),
    ).rejects.toMatchObject({ type: 'APPROVAL_REQUIRED' });

    const taskQueue = `intelligenz-approval-test-${randomUUID().slice(0, 8)}`;

    const nativeConnection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS });
    const worker = await Worker.create({
      connection: nativeConnection,
      namespace: TEMPORAL_NAMESPACE,
      taskQueue,
      workflowsPath: WORKFLOW_PATH,
      activities,
    });

    const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
    const temporal = new Client({ connection, namespace: TEMPORAL_NAMESPACE });

    let result: RunTaskWorkflowResult;

    try {
      // (2) Start the workflow directly: no API, no `POST /run`, no `WorkflowRun`.
      const handle = await temporal.workflow.start('runTaskWorkflow', {
        taskQueue,
        workflowId: `task-${task.taskId}`,
        args: [
          {
            taskId: task.taskId,
            orgId: suiteTenant.orgId,
            // The envelope validates `correlationId` as a UUID; a free-form label here
            // would make the audit write fail for a reason unrelated to the refusal.
            correlationId: randomUUID(),
          },
        ],
      });

      result = (await worker.runUntil(handle.result())) as RunTaskWorkflowResult;
    } finally {
      await connection.close().catch(() => undefined);
      await nativeConnection.close().catch(() => undefined);
    }

    expect(result.status).toBe('failed');

    // (3) Nothing ran. Not "nothing succeeded" — nothing was created.
    expect(await client.agentRun.count({ where: { orgId: suiteTenant.orgId } })).toBe(0);
    expect(await client.executionAttempt.count({ where: { orgId: suiteTenant.orgId } })).toBe(0);
    expect(await client.executionWorkspace.count({ where: { orgId: suiteTenant.orgId } })).toBe(0);

    const row = await client.task.findUniqueOrThrow({ where: { id: task.taskId } });
    expect(row.status).toBe('ready');

    // The refusal is recorded, not silent: the workflow recovered the project from the
    // activity's failure details and wrote the audit event anyway.
    const audits = await client.auditEvent.findMany({
      where: { orgId: suiteTenant.orgId, aggregateId: task.taskId, eventType: 'task.failed.v1' },
    });

    expect(audits.length).toBeGreaterThan(0);
    expect(audits[0]?.payload).toMatchObject({ code: 'APPROVAL_REQUIRED' });
  }, 120_000);
});

if (!enabled) {
  console.warn(
    `[approval-bypass] suite skipped — ${
      databaseEnabled ? temporalReason : 'TEST_DATABASE_URL is not set'
    }`,
  );
}

function probeTcp(address: string): Promise<{ ok: boolean; reason: string }> {
  const [host, rawPort] = address.split(':');
  const port = Number.parseInt(rawPort ?? '7233', 10);

  return new Promise((resolve) => {
    const socket = connect({ host: host ?? 'localhost', port });

    const finish = (ok: boolean, reason: string): void => {
      socket.destroy();
      resolve({ ok, reason });
    };

    socket.setTimeout(1_500);
    socket.once('connect', () => finish(true, `Temporal reachable at ${address}`));
    socket.once('timeout', () => finish(false, `Temporal timed out at ${address}`));
    socket.once('error', (error) => finish(false, `Temporal unreachable at ${address}: ${error.message}`));
  });
}
