import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PrismaClient } from '@intelligenz/database';

import { activities } from '../src/activities';
import { executeAgentActivity } from '../src/activities/execute-agent';
import { executionWorkspaceIdFor } from '../src/activities/ids';
import { claimExecution } from '../src/activities/claim';
import { startAttempt } from '../src/activities/attempts';
import { persistResultActivity } from '../src/activities/persist-result';
import { validateTaskActivity } from '../src/activities/validate-task';
import { computeTaskContentHash } from '../src/approvals/task-binding';
import { runClaimReleasePass } from '../src/claim-release';
import { getWorkerConfig, resetWorkerConfig } from '../src/config';
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
 * The execution trust boundary — Phase 6, AG-602.
 *
 * The independent review of `3aed33d` failed that commit for one reason: the execution
 * claim was **written** by `validateTaskActivity` and never **read** where execution
 * actually starts. Activities are dispatched by name, so any workflow on this worker's
 * task queue can call `executeAgentActivity` directly and skip validation entirely — and
 * the review demonstrated an unapproved HIGH-risk task executing through that path.
 *
 * These tests are that review's reproductions, re-run against the fix, plus the two
 * consequences the review insisted must ship with it:
 *
 *   1. the executor refuses an unapproved task it was called to run directly;
 *   2. the executor refuses an attempt claimed by a different execution;
 *   3. adoption refuses a non-owner;
 *   4. two direct starts with no reservation cannot both run;
 *   5. the legitimate path still works end to end;
 *   6. a claim stranded by a vanished workflow is released, audited, and only then;
 *   7. a retry of the same execution still proceeds.
 *
 * Real PostgreSQL, no mocks. The two Temporal tests are skipped when no server is
 * reachable, which is the same condition the pre-existing suites use; the database-level
 * tests carry the same properties without it.
 */

const databaseUrl = testDatabaseUrl();
const databaseEnabled = databaseUrl !== undefined;

const TEMPORAL_ADDRESS = process.env['TEMPORAL_ADDRESS']?.trim() || 'localhost:7233';
const TEMPORAL_NAMESPACE = process.env['TEMPORAL_NAMESPACE']?.trim() || 'default';
const WORKFLOW_PATH = fileURLToPath(new URL('../src/workflows/run-task.ts', import.meta.url));

let temporalReachable = false;
let temporalReason = `Temporal not reachable at ${TEMPORAL_ADDRESS}`;

if (databaseEnabled) {
  const probe = await probeTcp(TEMPORAL_ADDRESS);
  temporalReachable = probe.ok;
  temporalReason = probe.reason;
}

const enabled = databaseEnabled;
const temporalEnabled = databaseEnabled && temporalReachable;

let client: PrismaClient;
const tenants: TenantFixture[] = [];
let artifactRoot: string;

async function tenant(label: string): Promise<TenantFixture> {
  const created = await createTenant(client, label);
  tenants.push(created);
  return created;
}

interface Reservation {
  readonly orgId: string;
  readonly projectId: string;
  readonly taskId: string;
  /** The database `WorkflowRun.id` — a foreign key, not the claim identity. */
  readonly workflowRunId: string;
  readonly attemptId: string;
}

/**
 * The exact row shape `POST /run` leaves behind, with the approval optional so the
 * review's "HIGH-risk task with **no approval row**" case can be built.
 */
async function reservedTask(
  fixture: TenantFixture,
  label: string,
  options: {
    readonly riskClass?: 'LOW' | 'HIGH';
    readonly goal?: string;
    readonly approval?: boolean;
  } = {},
): Promise<Reservation> {
  const riskClass = options.riskClass ?? 'LOW';
  const goal = options.goal ?? 'Fix the failing test in src/sum.js and prove it passes.';
  const withApproval = options.approval ?? riskClass === 'HIGH';

  const task = await client.task.create({
    data: {
      orgId: fixture.orgId,
      projectId: fixture.projectId,
      workspaceId: fixture.workspaceId,
      title: `${label} ${randomUUID().slice(0, 8)}`,
      goal,
      status: 'ready',
      riskClass,
      acceptanceCriteria: [],
      createdById: fixture.userId,
      idempotencyKey: `boundary-${randomUUID().slice(0, 8)}`,
    },
  });

  const run = await client.workflowRun.create({
    data: {
      orgId: fixture.orgId,
      taskId: task.id,
      workflowId: `task-${task.id}`,
      temporalRunId: `boundary-run-${randomUUID()}`,
      status: 'queued',
    },
  });

  const attempt = await client.executionAttempt.create({
    data: {
      orgId: fixture.orgId,
      taskId: task.id,
      workflowRunId: run.id,
      attemptNumber: 1,
      runtimeId: 'unassigned',
      simulated: true,
      status: 'queued',
    },
  });

  if (withApproval) {
    await client.approvalRequest.create({
      data: {
        orgId: fixture.orgId,
        taskId: task.id,
        riskClass: 'HIGH',
        status: 'APPROVED',
        requestedById: fixture.userId,
        taskContentHash: computeTaskContentHash({
          title: task.title,
          goal: task.goal,
          acceptanceCriteria: task.acceptanceCriteria,
          riskClass: task.derivedRiskClass ?? task.riskClass,
          executionProfile: 'standard',
          sourceRef: null,
          baseCommit: null,
        }),
        riskClassAtApproval: 'HIGH',
        policyVersion: '2026-11-15.1',
        executionProfile: 'standard',
        consumedAt: new Date(),
        consumedByAttemptId: attempt.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
  }

  return {
    orgId: fixture.orgId,
    projectId: fixture.projectId,
    taskId: task.id,
    workflowRunId: run.id,
    attemptId: attempt.id,
  };
}

/** The claim, written by the module production uses. */
async function claimAttempt(reservation: Reservation, executionRunId: string): Promise<void> {
  await claimExecution({
    orgId: reservation.orgId,
    taskId: reservation.taskId,
    projectId: reservation.projectId,
    attemptId: reservation.attemptId,
    workflowRunId: executionRunId,
    correlationId: randomUUID(),
  });
}

function executorInput(reservation: Reservation, executionRunId: string | undefined) {
  return {
    taskId: reservation.taskId,
    orgId: reservation.orgId,
    correlationId: randomUUID(),
    workflowRunId: reservation.workflowRunId,
    attemptId: reservation.attemptId,
    ...(executionRunId === undefined ? {} : { executionRunId }),
  };
}

async function attemptRow(attemptId: string): Promise<{
  status: string;
  claimedByWorkflowRunId: string | null;
  claimedAt: Date | null;
  terminationReason: string | null;
}> {
  return client.executionAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    select: {
      status: true,
      claimedByWorkflowRunId: true,
      claimedAt: true,
      terminationReason: true,
    },
  });
}

/** Nothing a launch would create exists — in the database or on the filesystem. */
async function assertNoExecutionSideEffects(reservation: Reservation): Promise<void> {
  expect(await client.agentRun.count({ where: { orgId: reservation.orgId } })).toBe(0);
  expect(await client.executionWorkspace.count({ where: { orgId: reservation.orgId } })).toBe(0);
  expect(await client.toolInvocation.count({ where: { orgId: reservation.orgId } })).toBe(0);

  const cgroupRoot = getWorkerConfig().resources.cgroupRoot;
  const workspaceId = executionWorkspaceIdFor(reservation.workflowRunId, 1);
  const entries = await readdir(cgroupRoot).catch(() => [] as string[]);

  expect(entries).not.toContain(workspaceId);
}

beforeAll(async () => {
  if (!databaseEnabled) return;

  const database = useTestDatabase();
  client = database.client;
  artifactRoot = `/tmp/intelligenz-boundary-test-${randomUUID().slice(0, 8)}`;

  process.env['DATABASE_URL'] = database.url;
  process.env['ARTIFACT_ROOT'] = artifactRoot;
  process.env['AGENT_RUNTIME'] = 'local-simulated';
  process.env['AGENT_STEP_DELAY_MS'] = '0';
  delete process.env['WORKER_FAULT_INJECT'];
  delete process.env['WORKER_RESOURCE_PROFILE'];
  delete process.env['LOCAL_SIMULATED_OUTCOME'];

  resetWorkerConfig();
  resetAgentRuntime();
});

afterAll(async () => {
  if (!databaseEnabled) return;

  for (const fixture of tenants) await dropTenant(client, fixture);
  await client.$disconnect();
});

if (!enabled) {
  console.warn(
    `[execution-boundary] suite skipped — ${
      databaseEnabled ? temporalReason : 'TEST_DATABASE_URL is not set'
    }`,
  );
}

describe.skipIf(!enabled)('F1 — the launch site reads the claim, not just validation', () => {
  it('refuses the review’s reproduction: an unapproved HIGH task called directly, zero side effects', async () => {
    const fixture = await tenant('f1-unapproved');
    // Exactly the review's probe: HIGH risk, a queued workflow run and a queued attempt,
    // **no approval row**, and a direct call to the executor.
    const reservation = await reservedTask(fixture, 'unapproved-direct', {
      riskClass: 'HIGH',
      approval: false,
    });

    // The precondition the review established: validation refuses this task.
    await expect(
      validateTaskActivity({
        taskId: reservation.taskId,
        orgId: fixture.orgId,
        attemptId: reservation.attemptId,
        workflowRunId: `execution-${randomUUID()}`,
        correlationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ type: 'APPROVAL_REQUIRED', nonRetryable: true });

    // ...and the execution refuses it too, instead of running it the moment validation is
    // bypassed. Before the fix this call returned `status: "succeeded"`.
    await expect(
      executeAgentActivity(executorInput(reservation, `execution-${randomUUID()}`)),
    ).rejects.toMatchObject({ type: 'EXECUTION_CLAIM_REFUSED', nonRetryable: true });

    // Which gate caught it first is the claim, because this run holds none — the review's
    // probe had `claimedByWorkflowRunId: null` too. The approval gate is proved separately
    // in the next test, where a claim *is* held and only the approval moved.
    expect(
      await client.auditEvent.count({
        where: { orgId: fixture.orgId, eventType: 'execution.claim_granted.v1' },
      }),
    ).toBe(0);

    // Nothing that a launch creates exists, and the reservation was not spent.
    await assertNoExecutionSideEffects(reservation);

    const row = await attemptRow(reservation.attemptId);

    expect(row.status).toBe('queued');
    expect(row.claimedByWorkflowRunId).toBeNull();
  }, 30_000);

  it('re-checks the approval at the launch site: a revocation after the claim refuses before any work', async () => {
    const fixture = await tenant('f1-revoked');
    const reservation = await reservedTask(fixture, 'revoked-after-claim', { riskClass: 'HIGH' });
    const execution = `execution-${randomUUID()}`;

    // Validation granted the claim; the grant is then revoked before the executor runs.
    // This is the window the launch-site re-check exists for: validation's verdict is a
    // snapshot, and the agent is launched seconds later.
    await claimAttempt(reservation, execution);

    await client.approvalRequest.updateMany({
      where: { orgId: fixture.orgId, taskId: reservation.taskId },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });

    await expect(executeAgentActivity(executorInput(reservation, execution))).rejects.toMatchObject(
      { type: 'APPROVAL_REVOKED', nonRetryable: true },
    );

    await assertNoExecutionSideEffects(reservation);

    // The claim is untouched: a refusal at the launch site must not spend authority, in
    // either direction.
    const row = await attemptRow(reservation.attemptId);

    expect(row.claimedByWorkflowRunId).toBe(execution);
    expect(row.status).toBe('queued');
  }, 30_000);

  it('refuses when the attempt belongs to a different database run than the one named', async () => {
    const fixture = await tenant('f1-run-mismatch');
    const reservation = await reservedTask(fixture, 'run-mismatch');
    const execution = `execution-${randomUUID()}`;

    await claimAttempt(reservation, execution);

    // A second `WorkflowRun` row for the same task, which is what a forged or stale
    // activity input would name. The claim is genuine; the run is not the attempt's.
    const otherRun = await client.workflowRun.create({
      data: {
        orgId: fixture.orgId,
        taskId: reservation.taskId,
        workflowId: `task-${reservation.taskId}-other`,
        temporalRunId: `boundary-run-${randomUUID()}`,
        status: 'queued',
      },
      select: { id: true },
    });

    await expect(
      executeAgentActivity({
        ...executorInput(reservation, execution),
        workflowRunId: otherRun.id,
      }),
    ).rejects.toMatchObject({ type: 'EXECUTION_CLAIM_REFUSED', nonRetryable: true });

    await assertNoExecutionSideEffects(reservation);
    expect(
      await client.executionAttempt.count({
        where: { orgId: fixture.orgId, taskId: reservation.taskId },
      }),
    ).toBe(1);
  }, 30_000);

  it('refuses when the grant names a different attempt than the one claimed', async () => {
    const fixture = await tenant('f1-wrong-attempt');
    const reservation = await reservedTask(fixture, 'wrong-attempt', { riskClass: 'HIGH' });
    const execution = `execution-${randomUUID()}`;

    await claimAttempt(reservation, execution);

    // The grant is rebound to a second, real attempt of the same task and run — so every
    // check except "the grant names *this* attempt" still passes.
    const other = await client.executionAttempt.create({
      data: {
        orgId: fixture.orgId,
        taskId: reservation.taskId,
        workflowRunId: reservation.workflowRunId,
        attemptNumber: 2,
        runtimeId: 'unassigned',
        simulated: true,
        status: 'queued',
      },
      select: { id: true },
    });

    await client.approvalRequest.updateMany({
      where: { orgId: fixture.orgId, taskId: reservation.taskId },
      data: { consumedByAttemptId: other.id },
    });

    await expect(executeAgentActivity(executorInput(reservation, execution))).rejects.toMatchObject(
      { type: 'APPROVAL_ATTEMPT_MISMATCH', nonRetryable: true },
    );

    await assertNoExecutionSideEffects(reservation);
  }, 30_000);
});

describe.skipIf(!enabled)(
  'F2 — the executor refuses an attempt claimed by another execution',
  () => {
    it('refuses, with zero side effects, and leaves the claim with its owner', async () => {
      const fixture = await tenant('f2-intruder');
      const reservation = await reservedTask(fixture, 'claimed-by-owner');
      const owner = `execution-owner-${randomUUID()}`;

      await claimAttempt(reservation, owner);

      // A different execution calls the executor directly, naming the owner's attempt.
      await expect(
        executeAgentActivity(executorInput(reservation, `execution-intruder-${randomUUID()}`)),
      ).rejects.toMatchObject({ type: 'EXECUTION_ALREADY_CLAIMED', nonRetryable: true });

      await assertNoExecutionSideEffects(reservation);

      const row = await attemptRow(reservation.attemptId);

      expect(row.claimedByWorkflowRunId).toBe(owner);
      expect(row.status).toBe('queued');
    }, 30_000);

    it('refuses adoption by a non-owner, and the owner adopts the same row', async () => {
      const fixture = await tenant('f2-adoption');
      const reservation = await reservedTask(fixture, 'adoption');
      const owner = `execution-owner-${randomUUID()}`;

      await claimAttempt(reservation, owner);

      // The F2 reproduction: execution Y asks `startAttempt` to adopt the row execution X
      // claimed. The CAS includes the claim, so Y is refused rather than silently adopting
      // — and rather than falling through to a second attempt, which would leave X's claim
      // pointing at a row that already ran.
      await expect(
        startAttempt({
          orgId: reservation.orgId,
          taskId: reservation.taskId,
          workflowRunId: reservation.workflowRunId,
          runtimeId: 'local-simulated',
          simulated: true,
          startedAt: new Date(),
          executionRunId: `execution-intruder-${randomUUID()}`,
        }),
      ).rejects.toMatchObject({ type: 'EXECUTION_ATTEMPT_TAKEN', nonRetryable: true });

      const afterIntruder = await attemptRow(reservation.attemptId);

      expect(afterIntruder.status).toBe('queued');
      expect(afterIntruder.claimedByWorkflowRunId).toBe(owner);
      expect(
        await client.executionAttempt.count({
          where: { orgId: fixture.orgId, taskId: reservation.taskId },
        }),
      ).toBe(1);

      // The owner adopts it, and the row keeps naming the owner — the property F2 broke:
      // an attempt could complete while still carrying a different execution's id.
      const adopted = await startAttempt({
        orgId: reservation.orgId,
        taskId: reservation.taskId,
        workflowRunId: reservation.workflowRunId,
        runtimeId: 'local-simulated',
        simulated: true,
        startedAt: new Date(),
        executionRunId: owner,
      });

      expect(adopted.id).toBe(reservation.attemptId);

      const afterOwner = await attemptRow(reservation.attemptId);

      expect(afterOwner.status).toBe('running');
      expect(afterOwner.claimedByWorkflowRunId).toBe(owner);
    }, 30_000);
  },
);

describe.skipIf(!enabled)('F3 — an execution with no reserved attempt does not launch', () => {
  it('refuses two concurrent validates that name no attempt, and creates none', async () => {
    const fixture = await tenant('f3-validate');
    const reservation = await reservedTask(fixture, 'no-attempt');

    // The review's path 3, without Temporal: two executions of one LOW task, no attempt
    // id, concurrently. Before the fix both passed validation and both ran.
    const outcomes = await Promise.allSettled([
      validateTaskActivity({
        taskId: reservation.taskId,
        orgId: fixture.orgId,
        correlationId: randomUUID(),
        workflowRunId: `execution-a-${randomUUID()}`,
      }),
      validateTaskActivity({
        taskId: reservation.taskId,
        orgId: fixture.orgId,
        correlationId: randomUUID(),
        workflowRunId: `execution-b-${randomUUID()}`,
      }),
    ]);

    for (const outcome of outcomes) {
      expect(outcome.status).toBe('rejected');
      expect((outcome as PromiseRejectedResult).reason).toMatchObject({
        type: 'EXECUTION_CLAIM_REFUSED',
        nonRetryable: true,
      });
    }

    // The reservation is untouched, and no execution was authorised.
    const row = await attemptRow(reservation.attemptId);

    expect(row.status).toBe('queued');
    expect(row.claimedByWorkflowRunId).toBeNull();
    await assertNoExecutionSideEffects(reservation);
  }, 30_000);

  it('refuses the executor itself when it names no attempt, before it reads the task', async () => {
    const fixture = await tenant('f3-executor');
    const reservation = await reservedTask(fixture, 'no-attempt-executor');

    await expect(
      executeAgentActivity({
        taskId: reservation.taskId,
        orgId: fixture.orgId,
        correlationId: randomUUID(),
        workflowRunId: reservation.workflowRunId,
        executionRunId: `execution-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ type: 'EXECUTION_CLAIM_REFUSED', nonRetryable: true });

    await assertNoExecutionSideEffects(reservation);
  }, 30_000);
});

describe.skipIf(!temporalEnabled)(
  'F3 — two direct Temporal starts of one task, no attempt id',
  () => {
    it('ends both workflows without an attempt, an AgentRun or a success', async () => {
      const fixture = await tenant('f3-temporal');
      // LOW risk: no approval gate can refuse this, so the only thing that can is the
      // reservation requirement.
      const reservation = await reservedTask(fixture, 'direct-no-attempt', { riskClass: 'LOW' });

      const taskQueue = `intelligenz-boundary-${randomUUID().slice(0, 8)}`;
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

      let results: RunTaskWorkflowResult[];

      try {
        // Two independent executions of the same task, millisecond-adjacent, neither
        // naming an attempt — the review observed two successes 1 ms apart from this.
        const [first, second] = await Promise.all([
          temporal.workflow.start('runTaskWorkflow', {
            taskQueue,
            workflowId: `task-${reservation.taskId}-a`,
            args: [
              { taskId: reservation.taskId, orgId: fixture.orgId, correlationId: randomUUID() },
            ],
          }),
          temporal.workflow.start('runTaskWorkflow', {
            taskQueue,
            workflowId: `task-${reservation.taskId}-b`,
            args: [
              { taskId: reservation.taskId, orgId: fixture.orgId, correlationId: randomUUID() },
            ],
          }),
        ]);

        results = (await worker.runUntil(
          Promise.all([first.result(), second.result()]),
        )) as RunTaskWorkflowResult[];
      } finally {
        await connection.close().catch(() => undefined);
        await nativeConnection.close().catch(() => undefined);
      }

      expect(results.map((result) => result.status)).toEqual(['failed', 'failed']);

      // At most the one reserved attempt exists; no execution created another, none ran.
      expect(
        await client.executionAttempt.count({
          where: { orgId: fixture.orgId, taskId: reservation.taskId },
        }),
      ).toBeLessThanOrEqual(1);

      expect(
        await client.executionAttempt.count({
          where: { orgId: fixture.orgId, taskId: reservation.taskId, status: 'succeeded' },
        }),
      ).toBe(0);

      await assertNoExecutionSideEffects(reservation);
      expect((await attemptRow(reservation.attemptId)).claimedByWorkflowRunId).toBeNull();
    }, 120_000);
  },
);

describe.skipIf(!enabled)('the legitimate path and its retry', () => {
  it('validates → claims → adopts → executes → succeeds, with the claim intact', async () => {
    const fixture = await tenant('legit-path');
    const reservation = await reservedTask(fixture, 'legit', {
      goal: 'Fix the failing test in src/sum.js and prove it passes. [simulate:ok]',
    });
    const execution = `execution-${randomUUID()}`;

    await expect(
      validateTaskActivity({
        taskId: reservation.taskId,
        orgId: fixture.orgId,
        attemptId: reservation.attemptId,
        workflowRunId: execution,
        correlationId: randomUUID(),
      }),
    ).resolves.toMatchObject({ runnable: true });

    const claimedRow = await attemptRow(reservation.attemptId);

    expect(claimedRow.claimedByWorkflowRunId).toBe(execution);
    expect(claimedRow.status).toBe('queued');

    const result = await executeAgentActivity(executorInput(reservation, execution));

    expect(result.status).toBe('succeeded');

    // The workflow's next step, so "one attempt, one AgentRun" is a statement about the
    // whole path rather than about the executor alone.
    const persisted = await persistResultActivity({
      taskId: reservation.taskId,
      orgId: reservation.orgId,
      result,
    });

    expect(persisted.agentRunId).toBeTruthy();

    const row = await attemptRow(reservation.attemptId);

    expect(row.status).toBe('succeeded');
    // The claim survives the run: the row that ran still says who was authorised to.
    expect(row.claimedByWorkflowRunId).toBe(execution);
    expect(row.claimedAt).not.toBeNull();

    // One attempt, one AgentRun.
    expect(
      await client.executionAttempt.count({
        where: { orgId: fixture.orgId, taskId: reservation.taskId },
      }),
    ).toBe(1);
    expect(await client.agentRun.count({ where: { orgId: fixture.orgId } })).toBe(1);

    // Both halves of the authority trail: the grant and the retry that did not happen.
    expect(
      await client.auditEvent.count({
        where: {
          orgId: fixture.orgId,
          aggregateId: reservation.attemptId,
          eventType: 'execution.claim_granted.v1',
        },
      }),
    ).toBe(1);
  }, 30_000);

  it('lets a retry of the same execution proceed, as a second attempt under the same claim', async () => {
    const fixture = await tenant('legit-retry');
    const reservation = await reservedTask(fixture, 'retry', {
      goal: 'Fix the failing test in src/sum.js and prove it passes. [simulate:ok]',
    });
    const execution = `execution-${randomUUID()}`;

    await validateTaskActivity({
      taskId: reservation.taskId,
      orgId: fixture.orgId,
      attemptId: reservation.attemptId,
      workflowRunId: execution,
      correlationId: randomUUID(),
    });

    const first = await executeAgentActivity(executorInput(reservation, execution));

    expect(first.status).toBe('succeeded');

    // A Temporal retry of the *same* execution — same workflow run, same claim, activity
    // re-delivered after the worker died between the final write and the completion
    // report. It must proceed: refusing here would turn "the worker restarted" into "the
    // task can never run", which is the crash-retry property Phase 6 had to preserve.
    const second = await executeAgentActivity(executorInput(reservation, execution));

    expect(second.status).toBe('succeeded');

    const rows = await client.executionAttempt.findMany({
      where: { orgId: fixture.orgId, taskId: reservation.taskId },
      orderBy: { attemptNumber: 'asc' },
      select: { attemptNumber: true, status: true, claimedByWorkflowRunId: true },
    });

    expect(rows).toEqual([
      { attemptNumber: 1, status: 'succeeded', claimedByWorkflowRunId: execution },
      { attemptNumber: 2, status: 'succeeded', claimedByWorkflowRunId: execution },
    ]);
  }, 30_000);
});

describe.skipIf(!enabled)(
  'F4 — a stranded claim is released, and only when the workflow is gone',
  () => {
    const INTERVAL_MS = 1_000;

    /** The pass, with a probe that answers per claim holder and defaults to doubt. */
    function releasePass(
      answers: Readonly<Record<string, 'active' | 'absent' | 'finished' | 'unknown'>>,
    ) {
      return runClaimReleasePass({
        prisma: client,
        probe: {
          execution: async (_taskId, workflowRunId) => answers[workflowRunId] ?? 'unknown',
        },
        intervalMs: INTERVAL_MS,
        // Scoped to this suite's rows through the answers map: anything else is `unknown`
        // and therefore skipped, which is also the behaviour a real doubt produces.
        batchSize: 200,
      });
    }

    /** A reservation claimed by `execution`, old enough to be a candidate. */
    async function strandedAttempt(
      fixture: TenantFixture,
      label: string,
      execution: string,
    ): Promise<Reservation> {
      const reservation = await reservedTask(fixture, label);

      await client.executionAttempt.update({
        where: { id: reservation.attemptId },
        data: {
          claimedByWorkflowRunId: execution,
          // Two intervals plus a margin: inside the grace window a claim is not even looked
          // at, because the workflow holding it may not have reached adoption yet.
          claimedAt: new Date(Date.now() - INTERVAL_MS * 4),
        },
      });

      return reservation;
    }

    it('releases a claim whose workflow run is provably absent, and audits the evidence', async () => {
      const fixture = await tenant('f4-vanished');
      const execution = `execution-vanished-${randomUUID()}`;
      const reservation = await strandedAttempt(fixture, 'vanished', execution);

      const result = await releasePass({ [execution]: 'absent' });

      const action = result.actions.find((entry) => entry.attemptId === reservation.attemptId);

      expect(action).toMatchObject({ outcome: 'released', workflowRunId: execution });

      const row = await attemptRow(reservation.attemptId);

      // The row is terminal, and the claim columns are NULL — the documented meaning of
      // "never claimed", with the release recorded in the audit trail instead of disguised
      // as an unclaimed row carrying a suspicious timestamp.
      expect(row.status).toBe('failed');
      expect(row.claimedByWorkflowRunId).toBeNull();
      expect(row.claimedAt).toBeNull();
      expect(row.terminationReason).toBe('crashed');

      const audits = await client.auditEvent.findMany({
        where: {
          orgId: fixture.orgId,
          aggregateId: reservation.attemptId,
          eventType: 'execution.claim_released.v1',
        },
        select: { payload: true },
      });

      expect(audits).toHaveLength(1);
      expect(audits[0]?.payload).toMatchObject({
        attemptId: reservation.attemptId,
        taskId: reservation.taskId,
        workflowRunId: execution,
        liveness: 'absent',
      });
    }, 30_000);

    it('releases a claim whose workflow finished without adopting, and audits that evidence too', async () => {
      const fixture = await tenant('f4-finished');
      const execution = `execution-finished-${randomUUID()}`;
      const reservation = await strandedAttempt(fixture, 'finished', execution);

      const result = await releasePass({ [execution]: 'finished' });

      expect(
        result.actions.find((entry) => entry.attemptId === reservation.attemptId),
      ).toMatchObject({
        outcome: 'released',
      });

      const audits = await client.auditEvent.findMany({
        where: {
          orgId: fixture.orgId,
          aggregateId: reservation.attemptId,
          eventType: 'execution.claim_released.v1',
        },
        select: { payload: true },
      });

      expect(audits[0]?.payload).toMatchObject({ liveness: 'finished' });
    }, 30_000);

    it('never releases a claim held by a live workflow — the negative control', async () => {
      const fixture = await tenant('f4-live');
      const execution = `execution-live-${randomUUID()}`;
      const reservation = await strandedAttempt(fixture, 'live', execution);

      const result = await releasePass({ [execution]: 'active' });

      expect(
        result.actions.find((entry) => entry.attemptId === reservation.attemptId),
      ).toMatchObject({
        outcome: 'skipped_live',
      });

      // Untouched: a live execution may still adopt, and releasing here would resume work
      // the platform had already authorised.
      const row = await attemptRow(reservation.attemptId);

      expect(row.status).toBe('queued');
      expect(row.claimedByWorkflowRunId).toBe(execution);
      expect(row.claimedAt).not.toBeNull();

      expect(
        await client.auditEvent.count({
          where: {
            orgId: fixture.orgId,
            aggregateId: reservation.attemptId,
            eventType: 'execution.claim_released.v1',
          },
        }),
      ).toBe(0);
    }, 30_000);

    it('never releases on a timer alone: an unanswerable probe is doubt, not absence', async () => {
      const fixture = await tenant('f4-unknown');
      const execution = `execution-unknown-${randomUUID()}`;
      const reservation = await strandedAttempt(fixture, 'unknown', execution);

      // The probe has no answer for this run, which is what an unreachable Temporal looks
      // like. Age is not evidence.
      const result = await releasePass({});

      expect(
        result.actions.find((entry) => entry.attemptId === reservation.attemptId),
      ).toMatchObject({
        outcome: 'skipped_unknown',
      });

      const row = await attemptRow(reservation.attemptId);

      expect(row.status).toBe('queued');
      expect(row.claimedByWorkflowRunId).toBe(execution);
    }, 30_000);

    it('does not look at a claim that is younger than the grace window', async () => {
      const fixture = await tenant('f4-fresh');
      const execution = `execution-fresh-${randomUUID()}`;
      const reservation = await reservedTask(fixture, 'fresh');

      await client.executionAttempt.update({
        where: { id: reservation.attemptId },
        data: { claimedByWorkflowRunId: execution, claimedAt: new Date() },
      });

      const result = await releasePass({ [execution]: 'absent' });

      // Not a candidate at all: `validateTaskActivity` may have claimed it milliseconds ago
      // and the workflow may not have reached `startAttempt` yet.
      expect(
        result.actions.find((entry) => entry.attemptId === reservation.attemptId),
      ).toBeUndefined();

      const row = await attemptRow(reservation.attemptId);

      expect(row.status).toBe('queued');
      expect(row.claimedByWorkflowRunId).toBe(execution);
    }, 30_000);
  },
);

describe('the release path is not reachable from the launch path', () => {
  it('no activity module imports the claim-release module', async () => {
    const directory = fileURLToPath(new URL('../src/activities/', import.meta.url));
    const files = (await readdir(directory)).filter((name) => name.endsWith('.ts'));

    expect(files.length).toBeGreaterThan(5);

    for (const file of files) {
      const source = await readFile(join(directory, file), 'utf8');

      // `claim.ts` may *name* it in a comment; an import is what this looks for.
      expect(source, `${file} must not reach the release path`).not.toMatch(
        /from\s+['"][^'"]*claim-release['"]/,
      );
    }
  });
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
    socket.once('error', (error) =>
      finish(false, `Temporal unreachable at ${address}: ${error.message}`),
    );
  });
}
