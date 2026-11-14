import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';

import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PrismaClient } from '@intelligenz/database';

import { activities } from '../src/activities';
import { validateTaskActivity } from '../src/activities/validate-task';
import { computeTaskContentHash } from '../src/approvals/task-binding';
import { resetWorkerConfig } from '../src/config';
import { resetAgentRuntime } from '../src/runtime';
import type { RunTaskWorkflowResult } from '../src/shared/contracts';
import {
  createTenant,
  dropTenant,
  testDatabaseUrl,
  useTestDatabase,
  type TenantFixture,
} from './helpers/database';

/**
 * **Audit F2**, end to end: a direct Temporal start must fail for every dead approval.
 *
 * `approval-bypass.test.ts` proves the *missing* approval case. This file proves the
 * cases a status-only check waves through — an `APPROVED` row that is expired, revoked,
 * unbound, or never reserved by the API. Each is a real row a real operator could
 * produce, and each must end the workflow **before** the agent runs.
 *
 * The workflow is started with the Temporal client and no API call at all. That is the
 * threat: the worker's caller is not the API, so the worker's copy of the gate must hold
 * on its own.
 *
 * Skips (with a reason) when Temporal or the test database is unavailable. A silent pass
 * would be worse than no test: this is the path that cannot be faked.
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
});

afterAll(async () => {
  if (client !== undefined) await client.$disconnect();
});

if (!enabled) {
  console.warn(
    `[approval-direct-start] suite skipped — ${
      databaseEnabled ? temporalReason : 'TEST_DATABASE_URL is not set'
    }`,
  );
}

/** One dead-approval shape per row: what the operator did, and the code the worker owes them. */
const SCENARIOS = [
  {
    label: 'expired',
    code: 'APPROVAL_EXPIRED',
    approval: { consumedAt: () => new Date(), expiresAt: () => new Date(Date.now() - 1_000) },
  },
  {
    label: 'never reserved by the API',
    code: 'APPROVAL_NOT_RESERVED',
    approval: { consumedAt: () => null, expiresAt: () => new Date(Date.now() + 3_600_000) },
  },
  {
    label: 'revoked',
    code: 'APPROVAL_REVOKED',
    approval: {
      consumedAt: () => new Date(),
      expiresAt: () => new Date(Date.now() + 3_600_000),
      revokedAt: () => new Date(),
    },
  },
  {
    label: 'unbound (no content hash)',
    code: 'APPROVAL_UNBOUND',
    approval: { hash: () => null, consumedAt: () => new Date(), expiresAt: () => new Date(Date.now() + 3_600_000) },
  },
] as const;

describe.skipIf(!enabled)('a direct workflow start is refused for a dead approval', () => {
  for (const scenario of SCENARIOS) {
    it(`refuses an ${scenario.label} approval and never invokes the agent`, async () => {
      if (client === undefined) throw new Error('suite not initialised');

      const tenant: TenantFixture = await createTenant(client, `direct-${scenario.label.replace(/\W+/g, '-')}`);

      try {
        const task = await client.task.create({
          data: {
            orgId: tenant.orgId,
            projectId: tenant.projectId,
            workspaceId: tenant.workspaceId,
            title: `HIGH task with an ${scenario.label} approval`,
            goal: 'Fix the failing test in src/sum.js and prove it passes.',
            status: 'ready',
            riskClass: 'HIGH',
            acceptanceCriteria: [],
            createdById: tenant.userId,
            idempotencyKey: `direct-${randomUUID().slice(0, 8)}`,
          },
        });

        const hash = computeTaskContentHash({
          title: task.title,
          goal: task.goal,
          acceptanceCriteria: task.acceptanceCriteria,
          riskClass: task.derivedRiskClass ?? task.riskClass,
          executionProfile: 'standard',
          sourceRef: null,
          baseCommit: null,
        });

        // Materialised once: a `new Date()` per call would make the assertions below
        // compare different milliseconds and fail for a reason unrelated to the gate.
        const approval = scenario.approval as {
          readonly hash?: () => string | null;
          readonly consumedAt: () => Date | null;
          readonly expiresAt: () => Date | null;
          readonly revokedAt?: () => Date | null;
        };

        const consumedAt = approval.consumedAt();
        const expiresAt = approval.expiresAt();
        const revokedAt = approval.revokedAt?.() ?? null;
        const taskContentHash = approval.hash === undefined ? hash : approval.hash();

        await client.approvalRequest.create({
          data: {
            orgId: tenant.orgId,
            taskId: task.id,
            riskClass: 'HIGH',
            status: 'APPROVED',
            requestedById: tenant.userId,
            taskContentHash,
            riskClassAtApproval: 'HIGH',
            policyVersion: '2026-11-14.1',
            executionProfile: 'standard',
            consumedAt,
            expiresAt,
            revokedAt,
          },
        });

        // (1) The activity itself refuses, with the specific code — not a generic
        // `APPROVAL_REQUIRED` that would make four different incidents look alike.
        await expect(
          validateTaskActivity({ taskId: task.id, orgId: tenant.orgId }),
        ).rejects.toMatchObject({ type: scenario.code });

        const taskQueue = `intelligenz-direct-${randomUUID().slice(0, 8)}`;

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
            workflowId: `task-${task.id}`,
            args: [
              {
                taskId: task.id,
                orgId: tenant.orgId,
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
        expect(await client.agentRun.count({ where: { orgId: tenant.orgId } })).toBe(0);
        expect(await client.executionAttempt.count({ where: { orgId: tenant.orgId } })).toBe(0);
        expect(await client.executionWorkspace.count({ where: { orgId: tenant.orgId } })).toBe(0);

        const row = await client.task.findUniqueOrThrow({ where: { id: task.id } });
        expect(row.status).toBe('ready');

        // (4) The refusal is on the record, carrying the specific code.
        const audits = await client.auditEvent.findMany({
          where: { orgId: tenant.orgId, aggregateId: task.id, eventType: 'task.failed.v1' },
        });

        expect(audits.length).toBeGreaterThan(0);
        expect(audits[0]?.payload).toMatchObject({ code: scenario.code });

        // (5) The worker did not spend the grant. Consumption belongs to the API.
        const approvalRow = await client.approvalRequest.findFirstOrThrow({
          where: { orgId: tenant.orgId, taskId: task.id },
        });

        expect(approvalRow.consumedAt?.getTime() ?? null).toBe(consumedAt?.getTime() ?? null);
      } finally {
        await dropTenant(client, tenant);
      }
    }, 120_000);
  }
});

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
