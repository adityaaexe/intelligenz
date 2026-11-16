import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PrismaClient } from '@intelligenz/database';
import type { WorkflowHandle } from '@temporalio/client';
import type { Workflow } from '@temporalio/workflow';

import {
  finishProgrammeActivity,
  loadProgrammeActivity,
  recordProgrammeCheckpointActivity,
  reserveProgrammeTaskActivity,
} from '../src/activities/programme';
import type { ProgrammeProbeStep } from './fixtures/programme-probe.workflow';
import {
  createTenant,
  dropAllTenants,
  dropResidualTenants,
  testDatabaseUrl,
  useTestDatabase,
  type TenantFixture,
} from './helpers/database';
import {
  createExecutionHarness,
  temporalReachable,
  type ExecutionHarness,
} from './helpers/execution-harness';

/**
 * The programme activities refuse a caller that is not the programme's own workflow.
 *
 * These four activities are registered on the worker's task queue and dispatched by name,
 * exactly like the task activities. The difference is what they can do: `reserve…` mints an
 * `ExecutionAttempt`, which is the reservation that authorises one execution. Before
 * Phase 8.6 that reservation had exactly one minter (`POST /run`); a new minter without a
 * check would let any workflow on the queue reserve arbitrary tasks — the duplicate-
 * execution hole Phase 6 spent four review rounds closing, reopened from the side.
 *
 * The check is `requireProgrammeAuthority`: the caller's **workflow id**, read from
 * Temporal's activity context (never from the input), must be exactly
 * `programme-<programmeId>`. There are two halves, and they need different infrastructure:
 *
 *   1. **no identity at all** — refused before the database is touched. Proved below with
 *      no database and no server: `db()` is never called, so there is nothing to point at.
 *   2. **a real execution under the wrong id** — `task-<taskId>`, the id a task execution
 *      runs under. Refused by the same comparison, and proved against a real Temporal
 *      server and a real tenant, where "nothing was read or written" can be counted.
 *
 * The positive half — a real `programme-<id>` execution reserves and records — is proved
 * end-to-end by `programme-execution.test.ts`.
 */

const PROGRAMME_ID = '2a4d6f8b-1c3e-4a5b-9d7e-8f0a1b2c3d4e';
const ORG_ID = '6f1d2c3b-4a59-4687-9a0b-1c2d3e4f5a6b';
const TASK_ID = '9d0e5c1a-1f2b-4c3d-8e4f-5a6b7c8d9e0f';

const refusal = { type: 'PROGRAMME_IDENTITY_UNAVAILABLE', nonRetryable: true } as const;

describe('programme activities refuse a call with no execution identity', () => {
  it('loadProgrammeActivity', async () => {
    await expect(
      loadProgrammeActivity({ programmeId: PROGRAMME_ID, orgId: ORG_ID }),
    ).rejects.toMatchObject(refusal);
  });

  it('reserveProgrammeTaskActivity — the one that mints an execution attempt', async () => {
    await expect(
      reserveProgrammeTaskActivity({
        programmeId: PROGRAMME_ID,
        orgId: ORG_ID,
        taskId: TASK_ID,
        attemptNumber: 1,
        correlationId: '0b9f2a1c-3d4e-4f50-8a9b-1c2d3e4f5a6b',
      }),
    ).rejects.toMatchObject(refusal);
  });

  it('recordProgrammeCheckpointActivity', async () => {
    await expect(
      recordProgrammeCheckpointActivity({
        programmeId: PROGRAMME_ID,
        orgId: ORG_ID,
        sequence: 1,
        taskId: TASK_ID,
        outcome: 'succeeded',
        evidence: null,
      }),
    ).rejects.toMatchObject(refusal);
  });

  it('finishProgrammeActivity', async () => {
    await expect(
      finishProgrammeActivity({
        programmeId: PROGRAMME_ID,
        orgId: ORG_ID,
        status: 'succeeded',
        reason: 'test',
      }),
    ).rejects.toMatchObject(refusal);
  });
});

// ─── The wrong-identity half, against a real execution ──────────────────────

const databaseUrl = testDatabaseUrl();
const temporalEnabled = databaseUrl !== undefined && (await temporalReachable());
const enabled = temporalEnabled;

const PROBE_BUNDLE = fileURLToPath(
  new URL('./fixtures/programme-bundle.workflow.ts', import.meta.url),
);

/**
 * The probe's update and signal names, as strings: importing the fixture as a value would
 * pull `@temporalio/workflow` into the test process, which is what the harness avoids.
 */
const PROGRAMME_PROBE_UPDATE = 'runProgrammeSteps';
const PROGRAMME_PROBE_FINISH = 'finishProgrammeProbe';

const tenants: TenantFixture[] = [];

let client: PrismaClient;
let harness: ExecutionHarness | undefined;

beforeAll(async () => {
  if (!databaseUrl) return;

  const database = useTestDatabase();
  client = database.client;

  process.env['DATABASE_URL'] = database.url;
  process.env['ARTIFACT_ROOT'] = `/tmp/intelligenz-authority-test-${randomUUID().slice(0, 8)}`;
  process.env['AGENT_RUNTIME'] = 'local-simulated';
  delete process.env['WORKER_FAULT_INJECT'];
  delete process.env['WORKER_RESOURCE_PROFILE'];

  await dropResidualTenants(client, 'programme-authority-');

  if (temporalEnabled) {
    harness = await createExecutionHarness({ workflowsPath: PROBE_BUNDLE });
  }
}, 90_000);

afterAll(async () => {
  if (!databaseUrl) return;

  await harness?.close();
  await dropAllTenants(client, tenants);
  await client.$disconnect();
});

describe.skipIf(!enabled)('programme activities refuse a caller running under a task id', () => {
  it('refuses every one of the four with PROGRAMME_AUTHORITY_REFUSED and writes no row', async () => {
    if (harness === undefined) {
      throw new Error('the execution harness was not created; Temporal is not reachable.');
    }

    const execution = harness;
    const fixture = await createTenant(client, 'programme-authority');
    tenants.push(fixture);

    const task = await client.task.create({
      data: {
        orgId: fixture.orgId,
        projectId: fixture.projectId,
        workspaceId: fixture.workspaceId,
        title: 'Authority probe',
        goal: 'Nothing may be reserved for this task by a caller that is not its programme.',
        status: 'ready',
        riskClass: 'LOW',
        acceptanceCriteria: ['This task must not gain an attempt.'],
        createdById: fixture.userId,
        idempotencyKey: `authority-${randomUUID()}`,
      },
      select: { id: true },
    });

    const programme = await client.programme.create({
      data: {
        orgId: fixture.orgId,
        projectId: fixture.projectId,
        objective: 'A programme no foreign execution may schedule.',
        idempotencyKey: `authority-${randomUUID()}`,
        tasks: {
          create: [{ orgId: fixture.orgId, taskId: task.id, dependsOn: [] }],
        },
      },
      select: { id: true, status: true },
    });

    const readState = async (): Promise<Record<string, number | string>> => ({
      workflowRuns: await client.workflowRun.count({ where: { orgId: fixture.orgId } }),
      attempts: await client.executionAttempt.count({ where: { orgId: fixture.orgId } }),
      checkpoints: await client.programmeCheckpoint.count({ where: { orgId: fixture.orgId } }),
      programmeStatus: (
        await client.programme.findUniqueOrThrow({
          where: { id: programme.id },
          select: { status: true },
        })
      ).status,
      taskStatus: (
        await client.task.findUniqueOrThrow({
          where: { id: task.id },
          select: { status: true },
        })
      ).status,
      nodeStatus: (
        await client.programmeTask.findFirstOrThrow({
          where: { programmeId: programme.id, taskId: task.id },
          select: { status: true },
        })
      ).status,
    });

    const before = await readState();
    const input = {
      programmeId: programme.id,
      orgId: fixture.orgId,
      taskId: task.id,
      attemptNumber: 1,
      correlationId: randomUUID(),
    };

    // A real execution — under the id a **task** runs under, which is exactly what the
    // guard must refuse. No input field carries the identity: it comes from the server.
    const handle: WorkflowHandle<Workflow> = await execution.start('programmeProbe', {
      workflowId: `task-${task.id}`,
      args: [],
      workflowRunTimeout: '10m',
    });

    try {
      const results = (await handle.executeUpdate<
        readonly unknown[],
        [readonly ProgrammeProbeStep[]]
      >(PROGRAMME_PROBE_UPDATE, {
        args: [
          [
            { op: 'load', input, captureFailure: true },
            { op: 'reserve', input, captureFailure: true },
            {
              op: 'checkpoint',
              input: { ...input, sequence: 1, outcome: 'succeeded', evidence: null },
              captureFailure: true,
            },
            {
              op: 'finish',
              input: {
                programmeId: programme.id,
                orgId: fixture.orgId,
                status: 'succeeded',
                reason: 'x',
              },
              captureFailure: true,
            },
          ] as readonly ProgrammeProbeStep[],
        ],
      })) as { failed: boolean; type: string; message: string }[];

      expect(results).toHaveLength(4);

      for (const [index, result] of results.entries()) {
        expect(result.failed, `step ${String(index)} must be refused`).toBe(true);
        // The refusal, not `PROGRAMME_NOT_FOUND` or a Prisma error: the check runs before
        // `db()` is called, so a caller with the wrong identity cannot even ask whether the
        // programme exists.
        expect(result.type, `step ${String(index)} refusal code`).toBe(
          'PROGRAMME_AUTHORITY_REFUSED',
        );
        expect(result.message).toContain(`programme-${programme.id}`);
      }
    } finally {
      await handle.signal(PROGRAMME_PROBE_FINISH).catch(() => undefined);
      await handle.result().catch(() => undefined);
    }

    // Not one row moved: no run, no attempt, no checkpoint, no status.
    expect(await readState()).toEqual(before);
  }, 180_000);
});
