import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';

import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PrismaClient } from '@intelligenz/database';

import { activities } from '../src/activities';
import { finalizeAttempt, startAttempt } from '../src/activities/attempts';
import { claimExecution } from '../src/activities/claim';
import { decideAttemptBinding } from '../src/approvals/authorisation';
import { validateTaskActivity } from '../src/activities/validate-task';
import { computeTaskContentHash } from '../src/approvals/task-binding';
import { resetWorkerConfig } from '../src/config';
import { resetAgentRuntime } from '../src/runtime';
import type { RunTaskWorkflowResult } from '../src/shared/contracts';
import {
  createExecutionHarness,
  type ExecutionHarness,
} from './helpers/execution-harness';
import {
  createTenant,
  dropTenant,
  testDatabaseUrl,
  useTestDatabase,
  type TenantFixture,
} from './helpers/database';

/**
 * **Phase 5 (BE-501)** — the grant names an attempt, and the worker checks it.
 *
 * Phase 4's worker gate proved that *a* reservation had happened (`consumedAt` non-null).
 * It could not prove that **this** run made it, so a second execution holding a task id
 * could present the same live grant and proceed. These tests are the other half of the
 * fix: `POST /run` writes `consumedByAttemptId` in the same transaction it creates the
 * attempt, and this activity refuses anything that cannot show it holds that reservation.
 *
 * Three properties are asserted for every refusal:
 *
 *   1. the activity throws with a specific code (an exception, not a `runnable: false`
 *      result the workflow could ignore);
 *   2. **no `AgentRun` and no `ExecutionWorkspace` exist afterwards** — nothing ran;
 *   3. the reservation the run named is untouched, so the legitimate holder can still use
 *      it (a refused forger must not be able to burn somebody else's grant).
 *
 * The last test starts the workflow through Temporal with **no attempt id at all** — the
 * direct-start threat — and proves the workflow ends without an agent, which is the only
 * proof that matters: the worker's caller is not the API.
 *
 * The database is real (`TEST_DATABASE_URL`, `*_test` only) and these tests never
 * truncate: each suite owns a randomly-suffixed tenant and removes only that tenant.
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

const enabled = databaseEnabled;
const temporalEnabled = databaseEnabled && temporalReachable;

let tenant: TenantFixture | undefined;
let client: PrismaClient | undefined;
let harness: ExecutionHarness | undefined;

const GOAL = 'Fix the failing test in src/sum.js and prove it passes.';

beforeAll(async () => {
  if (!databaseEnabled) return;

  const database = useTestDatabase();
  client = database.client;

  process.env['AGENT_RUNTIME'] = process.env['AGENT_RUNTIME'] ?? 'local-simulated';
  process.env['ARTIFACT_ROOT'] = process.env['ARTIFACT_ROOT'] ?? '/tmp/intelligenz-worker-binding';

  resetWorkerConfig();
  resetAgentRuntime();

  tenant = await createTenant(client, 'attempt-binding');

  if (temporalReachable) harness = await createExecutionHarness();
});

afterAll(async () => {
  await harness?.close();

  if (client !== undefined && tenant !== undefined) {
    await dropTenant(client, tenant);
    await client.$disconnect();
  }
});

if (!databaseEnabled) {
  console.warn('[approval-attempt-binding] suite skipped — TEST_DATABASE_URL is not set');
}

function fixture(): { prisma: PrismaClient; tenant: TenantFixture } {
  if (client === undefined || tenant === undefined) throw new Error('suite not initialised');

  return { prisma: client, tenant };
}

interface Reservation {
  readonly taskId: string;
  readonly workflowRunId: string;
  readonly attemptId: string;
}

/**
 * The exact shape `POST /run` leaves behind: task `ready`, a queued `WorkflowRun`, a
 * `queued` attempt, and an `APPROVED` grant consumed by that attempt.
 */
async function reservedTask(label: string): Promise<Reservation> {
  const { prisma, tenant: owned } = fixture();

  const task = await prisma.task.create({
    data: {
      orgId: owned.orgId,
      projectId: owned.projectId,
      workspaceId: owned.workspaceId,
      title: `${label} ${randomUUID().slice(0, 8)}`,
      goal: GOAL,
      status: 'ready',
      riskClass: 'HIGH',
      acceptanceCriteria: [],
      createdById: owned.userId,
      idempotencyKey: `binding-${randomUUID().slice(0, 8)}`,
    },
  });

  const run = await prisma.workflowRun.create({
    data: {
      orgId: owned.orgId,
      taskId: task.id,
      workflowId: `task-${task.id}`,
      temporalRunId: `binding-run-${randomUUID()}`,
      status: 'queued',
    },
  });

  const attempt = await prisma.executionAttempt.create({
    data: {
      orgId: owned.orgId,
      taskId: task.id,
      workflowRunId: run.id,
      attemptNumber: 1,
      runtimeId: 'unassigned',
      simulated: true,
      status: 'queued',
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

  await prisma.approvalRequest.create({
    data: {
      orgId: owned.orgId,
      taskId: task.id,
      riskClass: 'HIGH',
      status: 'APPROVED',
      requestedById: owned.userId,
      taskContentHash: hash,
      riskClassAtApproval: 'HIGH',
      policyVersion: '2026-11-14.1',
      executionProfile: 'standard',
      consumedAt: new Date(),
      consumedByAttemptId: attempt.id,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });

  return { taskId: task.id, workflowRunId: run.id, attemptId: attempt.id };
}

/**
 * A direct call to validation.
 *
 * Since AG-603 this shape reaches a **refusal that happens before the claim** only: the
 * activity takes its execution identity from its own context and there is no input field
 * that stands in for it any more. Every refusal below is decided by the approval gate,
 * which runs first — that ordering is part of what these tests assert.
 *
 * The accepting case needs a real execution and is gated on a reachable server at the end
 * of the suite.
 */
function validate(taskId: string, attemptId?: string): Promise<unknown> {
  const { tenant: owned } = fixture();

  return validateTaskActivity({
    taskId,
    orgId: owned.orgId,
    ...(attemptId === undefined ? {} : { attemptId }),
  });
}

/** Nothing ran, and the reservation is still available to whoever holds it. */
async function assertNothingRan(reservation: Reservation): Promise<void> {
  const { prisma, tenant: owned } = fixture();

  expect(
    await prisma.agentRun.count({
      where: { orgId: owned.orgId, workflowRun: { taskId: reservation.taskId } },
    }),
  ).toBe(0);
  expect(
    await prisma.executionWorkspace.count({
      where: { orgId: owned.orgId, taskId: reservation.taskId },
    }),
  ).toBe(0);

  const attempt = await prisma.executionAttempt.findUniqueOrThrow({
    where: { id: reservation.attemptId },
    select: { status: true },
  });

  expect(attempt.status).toBe('queued');
}

describe('decideAttemptBinding (pure)', () => {
  const base = { approvalId: 'approval-1', consumedByAttemptId: 'attempt-1' } as const;

  it('accepts the attempt the grant names, while it is still queued', () => {
    expect(
      decideAttemptBinding({
        ...base,
        attemptId: 'attempt-1',
        attemptStatus: 'queued',
      }),
    ).toBeNull();
  });

  it('refuses a different attempt with APPROVAL_ATTEMPT_MISMATCH', () => {
    const refusal = decideAttemptBinding({
      ...base,
      attemptId: 'attempt-2',
      attemptStatus: 'queued',
    });

    expect(refusal?.code).toBe('APPROVAL_ATTEMPT_MISMATCH');
  });

  it('refuses an attempt that does not exist in this task', () => {
    const refusal = decideAttemptBinding({ ...base, attemptId: 'attempt-2', attemptStatus: null });

    expect(refusal?.code).toBe('APPROVAL_ATTEMPT_MISMATCH');
  });

  it('refuses a grant that was never bound to an attempt, even when the right id is offered', () => {
    const refusal = decideAttemptBinding({
      approvalId: 'approval-1',
      consumedByAttemptId: null,
      attemptId: 'attempt-1',
      attemptStatus: 'queued',
    });

    expect(refusal?.code).toBe('APPROVAL_NOT_RESERVED');
  });

  it('refuses a run that names no attempt', () => {
    const refusal = decideAttemptBinding({
      ...base,
      attemptId: undefined,
      attemptStatus: undefined,
    });

    expect(refusal?.code).toBe('APPROVAL_NOT_RESERVED');
  });

  it('refuses an attempt whose reservation has already been taken', () => {
    const refusal = decideAttemptBinding({
      ...base,
      attemptId: 'attempt-1',
      attemptStatus: 'running',
    });

    expect(refusal?.code).toBe('APPROVAL_ATTEMPT_MISMATCH');
  });
});

describe.skipIf(!enabled)('validateTaskActivity attempt binding', () => {

  it('refuses attempt substitution with APPROVAL_ATTEMPT_MISMATCH and never runs the agent', async () => {
    const reservation = await reservedTask('substituted');

    await expect(validate(reservation.taskId, randomUUID())).rejects.toMatchObject({
      type: 'APPROVAL_ATTEMPT_MISMATCH',
    });

    await assertNothingRan(reservation);
  });

  it('refuses a direct start that names no attempt, even with a live reserved grant', async () => {
    const reservation = await reservedTask('no-attempt-id');

    // This is the direct-Temporal-start shape: a perfect grant, reserved by somebody, and
    // no way for this caller to prove it is that somebody.
    await expect(validate(reservation.taskId)).rejects.toMatchObject({
      type: 'APPROVAL_NOT_RESERVED',
    });

    await assertNothingRan(reservation);
  });

  it('refuses a grant that was reserved twice — the second attempt is not the holder', async () => {
    const reservation = await reservedTask('second-attempt');

    const { prisma, tenant: owned } = fixture();

    const second = await prisma.executionAttempt.create({
      data: {
        orgId: owned.orgId,
        taskId: reservation.taskId,
        workflowRunId: reservation.workflowRunId,
        attemptNumber: 2,
        runtimeId: 'unassigned',
        simulated: true,
        status: 'queued',
      },
      select: { id: true },
    });

    await expect(validate(reservation.taskId, second.id)).rejects.toMatchObject({
      type: 'APPROVAL_ATTEMPT_MISMATCH',
    });

    await assertNothingRan(reservation);
  });

  it('refuses a legacy grant consumed with no attempt link', async () => {
    const reservation = await reservedTask('legacy');

    const { prisma, tenant: owned } = fixture();

    // The Phase 4 row: `consumedAt` set, `consumedByAttemptId` NULL.
    await prisma.approvalRequest.updateMany({
      where: { orgId: owned.orgId, taskId: reservation.taskId },
      data: { consumedByAttemptId: null },
    });

    await expect(validate(reservation.taskId, reservation.attemptId)).rejects.toMatchObject({
      type: 'APPROVAL_NOT_RESERVED',
    });

    await assertNothingRan(reservation);
  });

  it('refuses content that changed after the reservation with APPROVAL_STALE', async () => {
    const reservation = await reservedTask('changed');

    const { prisma } = fixture();

    await prisma.task.update({
      where: { id: reservation.taskId },
      data: { goal: `${GOAL} Then deploy it.` },
    });

    await expect(validate(reservation.taskId, reservation.attemptId)).rejects.toMatchObject({
      type: 'APPROVAL_STALE',
    });

    await assertNothingRan(reservation);
  });

  it('refuses a grant an operator revoked after it was reserved', async () => {
    const reservation = await reservedTask('revoked-after');

    const { prisma, tenant: owned } = fixture();

    await prisma.approvalRequest.updateMany({
      where: { orgId: owned.orgId, taskId: reservation.taskId },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });

    await expect(validate(reservation.taskId, reservation.attemptId)).rejects.toMatchObject({
      type: 'APPROVAL_REVOKED',
    });

    await assertNothingRan(reservation);
  });
});

describe.skipIf(!enabled)('startAttempt adopts the reservation', () => {
  /**
   * The row `POST /run` reserved, claimed by the execution that is about to start it.
   *
   * Adoption is conditional on the claim (Phase 6, F2), so a test that wants to exercise
   * adoption must first write the claim — through `claimExecution`, the same writer
   * validation uses, not by hand.
   */
  async function claim(reservation: Reservation, workflowRunId: string): Promise<void> {
    const { prisma, tenant: owned } = fixture();

    await claimExecution({
      orgId: owned.orgId,
      taskId: reservation.taskId,
      projectId: owned.projectId,
      attemptId: reservation.attemptId,
      workflowRunId,
      correlationId: randomUUID(),
    });

    // Referenced so the fixture's client is the one the claim wrote through; a second
    // client would make the assertion below a different connection's view.
    void prisma;
  }

  it('claims the queued attempt instead of inserting a second one', async () => {
    const reservation = await reservedTask('adopt');
    const execution = `execution-${randomUUID()}`;

    const { prisma, tenant: owned } = fixture();

    await claim(reservation, execution);

    const attempt = await startAttempt({
      orgId: owned.orgId,
      taskId: reservation.taskId,
      workflowRunId: reservation.workflowRunId,
      runtimeId: 'local-simulated',
      simulated: true,
      startedAt: new Date(),
      executionRunId: execution,
    });

    expect(attempt.id).toBe(reservation.attemptId);
    expect(attempt.attemptNumber).toBe(1);

    const rows = await prisma.executionAttempt.findMany({
      where: { workflowRunId: reservation.workflowRunId },
      select: { id: true, status: true, runtimeId: true },
    });

    // One row, adopted: the `unassigned` placeholder is replaced by the adapter that ran.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('running');
    expect(rows[0]?.runtimeId).toBe('local-simulated');
  });

  it('gives a run with no reservation its own attempt #1, leaving the other run alone', async () => {
    const reservation = await reservedTask('other-run');

    const { prisma, tenant: owned } = fixture();

    // A second workflow run for the same task, with no reservation of its own. The first
    // run's attempt is *unclaimed* here, which is the weaker case: even then the second
    // run must not borrow it, because the CAS also requires `workflowRunId` to match.
    const otherRun = await prisma.workflowRun.create({
      data: {
        orgId: owned.orgId,
        taskId: reservation.taskId,
        workflowId: `task-${reservation.taskId}-other`,
        temporalRunId: `binding-run-${randomUUID()}`,
        status: 'queued',
      },
      select: { id: true },
    });

    const attempt = await startAttempt({
      orgId: owned.orgId,
      taskId: reservation.taskId,
      workflowRunId: otherRun.id,
      runtimeId: 'local-simulated',
      simulated: true,
      startedAt: new Date(),
      executionRunId: `execution-${randomUUID()}`,
    });

    expect(attempt.attemptNumber).toBe(1);
    expect(attempt.id).not.toBe(reservation.attemptId);

    const reserved = await prisma.executionAttempt.findUniqueOrThrow({
      where: { id: reservation.attemptId },
      select: { status: true },
    });

    expect(reserved.status).toBe('queued');
  });

  it('allocates attempt #2 after attempt #1 was finalized, so a retry keeps its history', async () => {
    const reservation = await reservedTask('retry-history');
    const execution = `execution-${randomUUID()}`;

    const { prisma, tenant: owned } = fixture();

    await claim(reservation, execution);

    const first = await startAttempt({
      orgId: owned.orgId,
      taskId: reservation.taskId,
      workflowRunId: reservation.workflowRunId,
      runtimeId: 'local-simulated',
      simulated: true,
      startedAt: new Date(),
      executionRunId: execution,
    });

    await finalizeAttempt({
      orgId: owned.orgId,
      attemptId: first.id,
      status: 'failed',
      simulated: true,
    });

    const second = await startAttempt({
      orgId: owned.orgId,
      taskId: reservation.taskId,
      workflowRunId: reservation.workflowRunId,
      runtimeId: 'local-simulated',
      simulated: true,
      startedAt: new Date(),
      executionRunId: execution,
    });

    expect([first.attemptNumber, second.attemptNumber]).toEqual([1, 2]);

    const rows = await prisma.executionAttempt.findMany({
      where: { workflowRunId: reservation.workflowRunId },
      orderBy: { attemptNumber: 'asc' },
      select: { attemptNumber: true, status: true, claimedByWorkflowRunId: true },
    });

    expect(rows).toEqual([
      { attemptNumber: 1, status: 'failed', claimedByWorkflowRunId: execution },
      // The retry's new attempt carries the same claim: the row that ran is attributable
      // to the authority that allowed it, which is the whole point of the column.
      { attemptNumber: 2, status: 'running', claimedByWorkflowRunId: execution },
    ]);
  });
});

describe.skipIf(!temporalEnabled)('a direct Temporal start with no attempt id', () => {
  it('ends the workflow without invoking the agent', async () => {
    const reservation = await reservedTask('temporal-direct');
    const { prisma, tenant: owned } = fixture();

    const taskQueue = `intelligenz-binding-test-${randomUUID().slice(0, 8)}`;

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
      // No API, no attempt id. The grant is live and reserved — by someone else.
      //
      // The **canonical** id, because that is the shape the refusal path can still record:
      // since AG-604 the audit event is authority-checked too, so a run started under an id
      // that is not this task's own may not write `task.failed.v1` for it (asserted in
      // `execution-boundary.test.ts`, "refuses the refusal event from a workflow that is not
      // this task's execution"). AG-603 already refused such a run's *terminal* write; this
      // fixture now matches the id production uses and the refusal stays visible.
      const handle = await temporal.workflow.start('runTaskWorkflow', {
        taskQueue,
        workflowId: `task-${reservation.taskId}`,
        args: [
          {
            taskId: reservation.taskId,
            orgId: owned.orgId,
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

    await assertNothingRan(reservation);

    // No second WorkflowRun was adopted for the stray start: `recordStartActivity` never
    // ran, because validation refused before it.
    expect(
      await prisma.workflowRun.count({ where: { orgId: owned.orgId, taskId: reservation.taskId } }),
    ).toBe(1);

    const audits = await prisma.auditEvent.findMany({
      where: {
        orgId: owned.orgId,
        aggregateId: reservation.taskId,
        eventType: 'task.failed.v1',
      },
    });

    expect(audits.length).toBeGreaterThan(0);
    expect(audits[0]?.payload).toMatchObject({ code: 'APPROVAL_NOT_RESERVED' });
  }, 120_000);
});

if (!temporalEnabled) {
  console.warn(
    `[approval-attempt-binding] Temporal test skipped — ${
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
    socket.once('error', (error) =>
      finish(false, `Temporal unreachable at ${address}: ${error.message}`),
    );
  });
}

/**
 * The accepting case, and only that.
 *
 * It needs an execution identity the server mints, so it is gated on a reachable server
 * rather than being handed one: a supplied identity is the AG-603 defect. Skipping here is
 * visible in the run summary; the refusals above are not gated on Temporal at all, because
 * every one of them is decided before the claim.
 */
describe.skipIf(!temporalEnabled)('validateTaskActivity attempt binding — the accepting case', () => {
  it('accepts the reservation holder, and the claim names that execution', async () => {
    if (harness === undefined) throw new Error('suite not initialised');

    const { tenant: owned } = fixture();
    const reservation = await reservedTask('holder');
    const session = await harness.session();

    try {
      const runnable = await session.call({
        op: 'validate',
        input: {
          taskId: reservation.taskId,
          orgId: owned.orgId,
          attemptId: reservation.attemptId,
          correlationId: randomUUID(),
        },
      });

      expect(runnable).toMatchObject({ runnable: true });

      // The claim names this execution — the run id the server minted for it. Nothing in
      // the input could have named a different one, which is the property AG-603 restored.
      const { prisma } = fixture();

      const claimed = await prisma.executionAttempt.findUniqueOrThrow({
        where: { id: reservation.attemptId },
        select: { claimedByWorkflowRunId: true },
      });

      expect(claimed.claimedByWorkflowRunId).toBe(session.runId);
    } finally {
      await session.stop();
    }
  }, 60_000);
});
