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
import { executionWorkspaceIdFor } from '../src/activities/ids';
import { claimExecution } from '../src/activities/claim';
import { startAttempt } from '../src/activities/attempts';
import { computeTaskContentHash } from '../src/approvals/task-binding';
import { runClaimReleasePass } from '../src/claim-release';
import { getWorkerConfig, resetWorkerConfig } from '../src/config';
import { createTemporalProbe } from '../src/reaper';
import { resetAgentRuntime } from '../src/runtime';
import { AGENT_ACTOR_ID } from '../src/shared/actors';
import type { RunTaskWorkflowResult } from '../src/shared/contracts';
import {
  createExecutionHarness,
  type ExecutionHarness,
  type ExecutionSession,
} from './helpers/execution-harness';
import {
  createTenant,
  dropTenant,
  testDatabaseUrl,
  useTestDatabase,
  type TenantFixture,
} from './helpers/database';

/**
 * The execution trust boundary — Phase 6, AG-602 / AG-603.
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
 *   1. the executor refuses a task it was called to run with no claim, and writes nothing;
 *   2. the executor refuses an attempt claimed by a different execution;
 *   3. adoption refuses a non-owner;
 *   4. two executions with no reservation cannot both run;
 *   5. the legitimate path still works end to end;
 *   6. a claim stranded by a vanished workflow is released, and only then;
 *   7. a retry of the same execution still proceeds;
 *   8. a terminal write is authority-checked (`requireCompletionAuthority`).
 *
 * ## AG-603: how the identity is obtained
 *
 * Until AG-603 these tests called the activities as plain functions and **supplied** the
 * execution identity in the input, because `executionIdentity` fell back to it when there
 * was no activity context. The re-review broke that fallback with a real standalone
 * activity, which is why every execution below now runs inside a real workflow via
 * `helpers/execution-harness`: the identity is the run id the Temporal server minted, and
 * no test passes one in. The database-level tests still run without a server; the ones
 * whose subject *is* dispatch need one and say so with `skipIf(!temporalEnabled)`.
 *
 * Real PostgreSQL, no mocks.
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
let harness: ExecutionHarness | undefined;
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
    /**
     * `ready` is what the fixtures use for validation-shaped tests; `queued` is what
     * `POST /run` actually leaves behind, and the only non-terminal status a terminal
     * write can move (`completeTask`'s guard admits queued/running/verifying).
     */
    readonly status?: 'ready' | 'queued';
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
      status: options.status ?? 'ready',
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

/**
 * The executor's input.
 *
 * There is no `executionRunId` field any more: the activity reads its identity from the
 * activity context, and the field that used to stand in for it was the N1 defect. The
 * workflow run id this execution must hold is arranged in the database **under the
 * session's run id**, which is the server's value and not this function's.
 */
function executorInput(reservation: Reservation) {
  return {
    taskId: reservation.taskId,
    orgId: reservation.orgId,
    correlationId: randomUUID(),
    workflowRunId: reservation.workflowRunId,
    attemptId: reservation.attemptId,
  };
}

/** A session whose run id already holds the claim — the legitimate launch shape. */
async function claimedSession(reservation: Reservation): Promise<ExecutionSession> {
  if (harness === undefined) throw new Error('suite not initialised');

  const session = await harness.session();
  await claimAttempt(reservation, session.runId);

  return session;
}

async function attemptRow(attemptId: string): Promise<{
  status: string;
  claimedByWorkflowId: string | null;
  claimedByWorkflowRunId: string | null;
  claimedAt: Date | null;
  terminationReason: string | null;
}> {
  return client.executionAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    select: {
      status: true,
      claimedByWorkflowId: true,
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

  // Only when a server is reachable: the tests whose subject is *dispatch* need a real
  // execution identity. The decision-level tests below do not, and still run without one.
  if (temporalReachable) harness = await createExecutionHarness();
});

afterAll(async () => {
  if (!databaseEnabled) return;

  await harness?.close();
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

describe.skipIf(!temporalEnabled)(
  'F1 — the launch site reads the claim, not just validation',
  () => {
    it('refuses the review’s reproduction: a HIGH task with no claim, called by name, zero side effects', async () => {
      if (harness === undefined) throw new Error('suite not initialised');

      const fixture = await tenant('f1-unapproved');
      // Exactly the review's probe: HIGH risk, a queued workflow run and a queued attempt,
      // **no approval row and no claim**, and a real execution calling the executor by name
      // without ever calling validation.
      const reservation = await reservedTask(fixture, 'unapproved-direct', {
        riskClass: 'HIGH',
        approval: false,
      });

      // ...and the execution refuses it too, instead of running it the moment validation is
      // bypassed. Before the fix this call returned `status: "succeeded"`.
      const session = await harness.session();

      try {
        await expect(
          session.call({ op: 'execute', input: executorInput(reservation) }),
        ).rejects.toMatchObject({ type: 'EXECUTION_CLAIM_REFUSED', nonRetryable: true });
      } finally {
        await session.stop();
      }

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
    }, 60_000);

    it('re-checks the approval at the launch site: a revocation after the claim refuses before any work', async () => {
      if (harness === undefined) throw new Error('suite not initialised');

      const fixture = await tenant('f1-revoked');
      const reservation = await reservedTask(fixture, 'revoked-after-claim', { riskClass: 'HIGH' });

      // A real execution holds the claim; the grant is then revoked before the executor runs.
      // This is the window the launch-site re-check exists for: validation's verdict is a
      // snapshot, and the agent is launched seconds later.
      const session = await claimedSession(reservation);

      try {
        await client.approvalRequest.updateMany({
          where: { orgId: fixture.orgId, taskId: reservation.taskId },
          data: { status: 'REVOKED', revokedAt: new Date() },
        });

        await expect(
          session.call({ op: 'execute', input: executorInput(reservation) }),
        ).rejects.toMatchObject({ type: 'APPROVAL_REVOKED', nonRetryable: true });
      } finally {
        await session.stop();
      }

      await assertNoExecutionSideEffects(reservation);

      // The claim is untouched: a refusal at the launch site must not spend authority, in
      // either direction.
      const row = await attemptRow(reservation.attemptId);

      expect(row.claimedByWorkflowRunId).toBe(session.runId);
      expect(row.status).toBe('queued');
    }, 60_000);

    it('refuses when the attempt belongs to a different database run than the one named', async () => {
      if (harness === undefined) throw new Error('suite not initialised');

      const fixture = await tenant('f1-run-mismatch');
      const reservation = await reservedTask(fixture, 'run-mismatch');
      const session = await claimedSession(reservation);

      try {
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
          session.call({
            op: 'execute',
            input: { ...executorInput(reservation), workflowRunId: otherRun.id },
          }),
        ).rejects.toMatchObject({ type: 'EXECUTION_CLAIM_REFUSED', nonRetryable: true });
      } finally {
        await session.stop();
      }

      await assertNoExecutionSideEffects(reservation);
      expect(
        await client.executionAttempt.count({
          where: { orgId: fixture.orgId, taskId: reservation.taskId },
        }),
      ).toBe(1);
    }, 60_000);

    it('refuses when the grant names a different attempt than the one claimed', async () => {
      if (harness === undefined) throw new Error('suite not initialised');

      const fixture = await tenant('f1-wrong-attempt');
      const reservation = await reservedTask(fixture, 'wrong-attempt', { riskClass: 'HIGH' });
      const session = await claimedSession(reservation);

      try {
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

        await expect(
          session.call({ op: 'execute', input: executorInput(reservation) }),
        ).rejects.toMatchObject({ type: 'APPROVAL_ATTEMPT_MISMATCH', nonRetryable: true });
      } finally {
        await session.stop();
      }

      await assertNoExecutionSideEffects(reservation);
    }, 60_000);
  },
);

describe.skipIf(!temporalEnabled)(
  'F2 — the executor refuses an attempt claimed by another execution',
  () => {
    it('refuses, with zero side effects, and leaves the claim with its owner', async () => {
      if (harness === undefined) throw new Error('suite not initialised');

      const fixture = await tenant('f2-intruder');
      const reservation = await reservedTask(fixture, 'claimed-by-owner');
      const owner = `execution-owner-${randomUUID()}`;

      await claimAttempt(reservation, owner);

      // A different execution — a real one, with its own server-minted run id — calls the
      // executor and names the owner's attempt.
      const intruder = await harness.session();

      try {
        await expect(
          intruder.call({ op: 'execute', input: executorInput(reservation) }),
        ).rejects.toMatchObject({ type: 'EXECUTION_ALREADY_CLAIMED', nonRetryable: true });
      } finally {
        await intruder.stop();
      }

      await assertNoExecutionSideEffects(reservation);

      const row = await attemptRow(reservation.attemptId);

      expect(row.claimedByWorkflowRunId).toBe(owner);
      expect(row.status).toBe('queued');
    }, 60_000);

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

describe.skipIf(!temporalEnabled)(
  'F3 — an execution with no reserved attempt does not launch',
  () => {
    it('refuses two concurrent validations that name no attempt, and creates none', async () => {
      if (harness === undefined) throw new Error('suite not initialised');

      const fixture = await tenant('f3-validate');
      const reservation = await reservedTask(fixture, 'no-attempt');

      // The review's path 3: two executions of one LOW task, no attempt id, concurrently.
      // Before the fix both passed validation and both ran. Each session is a real workflow
      // run, so "two executions" is literal — two distinct server-minted identities.
      const [first, second] = await Promise.all([harness.session(), harness.session()]);

      const outcomes = await Promise.allSettled([
        first.call({
          op: 'validate',
          input: { taskId: reservation.taskId, orgId: fixture.orgId, correlationId: randomUUID() },
        }),
        second.call({
          op: 'validate',
          input: { taskId: reservation.taskId, orgId: fixture.orgId, correlationId: randomUUID() },
        }),
      ]);

      await first.stop();
      await second.stop();

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
    }, 90_000);

    it('refuses the executor itself when it names no attempt, before it reads the task', async () => {
      if (harness === undefined) throw new Error('suite not initialised');

      const fixture = await tenant('f3-executor');
      const reservation = await reservedTask(fixture, 'no-attempt-executor');
      const session = await harness.session();

      try {
        await expect(
          session.call({
            op: 'execute',
            input: {
              taskId: reservation.taskId,
              orgId: fixture.orgId,
              correlationId: randomUUID(),
              workflowRunId: reservation.workflowRunId,
            },
          }),
        ).rejects.toMatchObject({ type: 'EXECUTION_CLAIM_REFUSED', nonRetryable: true });
      } finally {
        await session.stop();
      }

      await assertNoExecutionSideEffects(reservation);
    }, 60_000);
  },
);

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

describe.skipIf(!temporalEnabled)('the legitimate path and its retry', () => {
  it('validates → claims → adopts → executes → persists → succeeds, with the claim intact', async () => {
    if (harness === undefined) throw new Error('suite not initialised');

    const fixture = await tenant('legit-path');
    const reservation = await reservedTask(fixture, 'legit', {
      goal: 'Fix the failing test in src/sum.js and prove it passes. [simulate:ok]',
      status: 'queued',
    });

    // One workflow run, four activities — the order production uses, including the two
    // that now check authority for themselves (`persistResultActivity` and
    // `completeTaskActivity`). The result that `persist` writes is the one `execute`
    // returned, attached by the workflow, exactly as `runTaskWorkflow` does.
    const session = await harness.session();

    try {
      const [validated, result, wrote, completed] = await session.run<Record<string, unknown>>([
        {
          op: 'validate',
          input: {
            taskId: reservation.taskId,
            orgId: fixture.orgId,
            attemptId: reservation.attemptId,
            correlationId: randomUUID(),
          },
        },
        { op: 'execute', input: executorInput(reservation) },
        {
          op: 'persist',
          input: {
            taskId: reservation.taskId,
            orgId: fixture.orgId,
            attemptId: reservation.attemptId,
          },
          attachPreviousAs: 'result',
        },
        {
          op: 'complete',
          input: {
            taskId: reservation.taskId,
            orgId: fixture.orgId,
            status: 'succeeded',
            attemptId: reservation.attemptId,
            workflowRunId: reservation.workflowRunId,
          },
        },
      ]);

      expect(validated).toMatchObject({ runnable: true });
      expect(result).toMatchObject({ status: 'succeeded' });
      expect(wrote?.['agentRunId']).toBeTruthy();
      // The terminal write reports which control authorised it: the claim, not the
      // pre-dispatch arm — this execution held the reservation it ran.
      expect(completed).toMatchObject({
        changed: true,
        status: 'succeeded',
        authority: 'execution-claim',
      });

      const row = await attemptRow(reservation.attemptId);

      expect(row.status).toBe('succeeded');
      // The claim survives the run: the row that ran still says who was authorised to.
      expect(row.claimedByWorkflowRunId).toBe(session.runId);
      expect(row.claimedAt).not.toBeNull();

      // One attempt, one AgentRun.
      expect(
        await client.executionAttempt.count({
          where: { orgId: fixture.orgId, taskId: reservation.taskId },
        }),
      ).toBe(1);
      expect(await client.agentRun.count({ where: { orgId: fixture.orgId } })).toBe(1);

      // The terminal write is the execution's, and it is on the record.
      const task = await client.task.findUniqueOrThrow({
        where: { id: reservation.taskId },
        select: { status: true },
      });

      expect(task.status).toBe('succeeded');

      expect(
        await client.auditEvent.count({
          where: {
            orgId: fixture.orgId,
            aggregateId: reservation.attemptId,
            eventType: 'execution.claim_granted.v1',
          },
        }),
      ).toBe(1);
    } finally {
      await session.stop();
    }
  }, 90_000);

  it('lets a retry of the same execution proceed, as a second attempt under the same claim', async () => {
    if (harness === undefined) throw new Error('suite not initialised');

    const fixture = await tenant('legit-retry');
    const reservation = await reservedTask(fixture, 'retry', {
      goal: 'Fix the failing test in src/sum.js and prove it passes. [simulate:ok]',
      status: 'queued',
    });

    const session = await harness.session();

    try {
      const [, first, second] = await session.run<Record<string, unknown>>([
        {
          op: 'validate',
          input: {
            taskId: reservation.taskId,
            orgId: fixture.orgId,
            attemptId: reservation.attemptId,
            correlationId: randomUUID(),
          },
        },
        // A Temporal retry of the *same* execution — same workflow run, same claim,
        // activity re-delivered after the worker died between the final write and the
        // completion report. It must proceed: refusing here would turn "the worker
        // restarted" into "the task can never run", which is the crash-retry property
        // Phase 6 had to preserve.
        { op: 'execute', input: executorInput(reservation) },
        { op: 'execute', input: executorInput(reservation) },
      ]);

      expect(first).toMatchObject({ status: 'succeeded' });
      expect(second).toMatchObject({ status: 'succeeded' });
    } finally {
      await session.stop();
    }

    const rows = await client.executionAttempt.findMany({
      where: { orgId: fixture.orgId, taskId: reservation.taskId },
      orderBy: { attemptNumber: 'asc' },
      select: { attemptNumber: true, status: true, claimedByWorkflowRunId: true },
    });

    expect(rows).toEqual([
      { attemptNumber: 1, status: 'succeeded', claimedByWorkflowRunId: session.runId },
      { attemptNumber: 2, status: 'succeeded', claimedByWorkflowRunId: session.runId },
    ]);
  }, 90_000);
});

/**
 * N13 — the writer half of N7, driven by the shipped validation path.
 *
 * Every N7 assertion above follows a claim a test wrote by hand (`holdClaim`), so deleting
 * the line in `claimForExecution` that records `claimedByWorkflowId` left the suite green
 * (51/51): the failure it would hide is a claim with a NULL workflow id, which is
 * unreleasable by design — and, before N12, able to starve the release pass. The claim here
 * is created by `validateTaskActivity` inside a real workflow, and the assertion is that
 * both ids are the ones the Temporal server put in the activity context.
 *
 * The workflow id is deliberately **not** `task-<taskId>`: a value read back here cannot
 * have been derived from the task, so the test is about the context, not a convention.
 */
describe.skipIf(!temporalEnabled)('N13 — validation records the execution that claimed', () => {
  it('writes both ids from the activity context when validation grants the claim', async () => {
    if (harness === undefined) throw new Error('suite not initialised');

    const fixture = await tenant('n13-writer');
    const reservation = await reservedTask(fixture, 'n13-writer');
    const workflowId = `probe-${randomUUID()}`;
    const session = await harness.session({ workflowId });

    try {
      const validated = await session.call<Record<string, unknown>>({
        op: 'validate',
        input: {
          taskId: reservation.taskId,
          orgId: fixture.orgId,
          attemptId: reservation.attemptId,
          correlationId: randomUUID(),
        },
      });

      expect(validated).toMatchObject({ runnable: true });
    } finally {
      await session.stop();
    }

    const row = await attemptRow(reservation.attemptId);

    // Both from context: the run id the server minted for this execution, and the workflow
    // id it was started under. Remove the writer at `validate-task.ts:259` and the first
    // of these is `null` while this test fails.
    expect(row.claimedByWorkflowId).toBe(workflowId);
    expect(row.claimedByWorkflowRunId).toBe(session.runId);
    expect(row.claimedAt).not.toBeNull();
  }, 60_000);
});

/**
 * N4 — a terminal write is authority-checked, from the re-review's addendum.
 *
 * `persistResultActivity` and `completeTaskActivity` are registered activities, so they are
 * dispatched by name and reachable by any workflow on the task queue. Before AG-603 neither
 * read a claim: a Temporal caller could write an `AgentRun`, the attempt link and terminal
 * state for a task that never executed. These are the by-name dispatch tests — every call
 * below is a real activity task dispatched by a workflow, not a function call.
 */
describe.skipIf(!temporalEnabled)('N4 — persistence and completion require authority', () => {
  it('refuses persistence from an execution that holds no claim, and writes no AgentRun', async () => {
    if (harness === undefined) throw new Error('suite not initialised');

    const fixture = await tenant('n4-persist-no-claim');
    const reservation = await reservedTask(fixture, 'persist-no-claim');
    const session = await harness.session();

    try {
      await expect(
        session.call({
          op: 'persist',
          input: {
            taskId: reservation.taskId,
            orgId: fixture.orgId,
            attemptId: reservation.attemptId,
            result: {
              status: 'succeeded',
              summary: 'fabricated by a workflow that never ran anything',
              artifacts: [],
              events: [],
              usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0, wallClockMs: 0 },
              runtimeId: 'local-simulated',
              simulated: true,
            },
          },
        }),
      ).rejects.toMatchObject({ type: 'EXECUTION_CLAIM_REFUSED', nonRetryable: true });
    } finally {
      await session.stop();
    }

    expect(await client.agentRun.count({ where: { orgId: fixture.orgId } })).toBe(0);
    expect((await attemptRow(reservation.attemptId)).status).toBe('queued');
  }, 60_000);

  it('refuses completion for an attempt another execution holds', async () => {
    if (harness === undefined) throw new Error('suite not initialised');

    const fixture = await tenant('n4-complete-foreign');
    const reservation = await reservedTask(fixture, 'complete-foreign');

    // The attempt is claimed by somebody else, so no arm of the completion authority can
    // succeed: a claim exists and it is not the caller's.
    await claimAttempt(reservation, `execution-owner-${randomUUID()}`);

    const session = await harness.session();

    try {
      await expect(
        session.call({
          op: 'complete',
          input: {
            taskId: reservation.taskId,
            orgId: fixture.orgId,
            status: 'failed',
            attemptId: reservation.attemptId,
          },
        }),
      ).rejects.toMatchObject({ type: 'EXECUTION_ALREADY_CLAIMED', nonRetryable: true });
    } finally {
      await session.stop();
    }

    const task = await client.task.findUniqueOrThrow({
      where: { id: reservation.taskId },
      select: { status: true },
    });

    expect(task.status).toBe('ready');
  }, 60_000);

  it('refuses a pre-dispatch completion from a workflow that is not this task’s execution', async () => {
    if (harness === undefined) throw new Error('suite not initialised');

    const fixture = await tenant('n4-complete-rogue');
    // `queued`, so the write would actually land if the arm admitted it. A `ready` task
    // cannot be completed (`completeTask`'s guard is queued/running/verifying), so the
    // refusal would be the only observable outcome even with the workflow-id check removed
    // — the test would pass for the wrong reason (N4 review note).
    const reservation = await reservedTask(fixture, 'complete-rogue', { status: 'queued' });

    // No claim anywhere, so the pre-dispatch arm applies — and it requires the caller to be
    // `task-<taskId>`. This session's id is a random `probe-…`, which is what a rogue
    // workflow looks like: it knows the task id and nothing else.
    const session = await harness.session();

    try {
      await expect(
        session.call({
          op: 'complete',
          input: { taskId: reservation.taskId, orgId: fixture.orgId, status: 'failed' },
        }),
      ).rejects.toMatchObject({ type: 'EXECUTION_CLAIM_REFUSED', nonRetryable: true });
    } finally {
      await session.stop();
    }

    const task = await client.task.findUniqueOrThrow({
      where: { id: reservation.taskId },
      select: { status: true },
    });

    expect(task.status).toBe('queued');
  }, 60_000);

  it('allows the pre-dispatch arm for the task’s own execution, so a refusal is still recorded', async () => {
    if (harness === undefined) throw new Error('suite not initialised');

    const fixture = await tenant('n4-complete-owner');
    const reservation = await reservedTask(fixture, 'complete-owner', { status: 'queued' });

    // The shape `runTaskWorkflow` is in when validation refuses before claiming: no claim,
    // the task's own workflow id, nothing else running. The write must succeed, or an
    // refused approval would leave the task `queued` for ever.
    const session = await harness.session({ workflowId: `task-${reservation.taskId}` });

    try {
      const completion = await session.call<Record<string, unknown>>({
        op: 'complete',
        input: {
          taskId: reservation.taskId,
          orgId: fixture.orgId,
          status: 'failed',
          error: { code: 'APPROVAL_REQUIRED', message: 'refused before dispatch' },
          attemptId: reservation.attemptId,
        },
      });

      // Authorised by the pre-dispatch arm, and it says so: no claim existed, and this is
      // the task's own execution.
      expect(completion).toMatchObject({
        changed: true,
        status: 'failed',
        authority: 'pre-dispatch',
      });
    } finally {
      await session.stop();
    }

    const task = await client.task.findUniqueOrThrow({
      where: { id: reservation.taskId },
      select: { status: true },
    });

    expect(task.status).toBe('failed');

    // The attempt was not spent: a refusal records a dead task, not a dead reservation.
    expect((await attemptRow(reservation.attemptId)).claimedByWorkflowRunId).toBeNull();
  }, 60_000);
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
          // Keyed by run id, and the workflow id is asserted where it matters: this stub's
          // subject is the *decision* the pass makes, and the exact-pair question is
          // proved against the shipped probe below (N7).
          execution: async (_workflowId, workflowRunId) => answers[workflowRunId] ?? 'unknown',
        },
        intervalMs: INTERVAL_MS,
        // Scoped to this suite's rows through the answers map: anything else is `unknown`
        // and therefore skipped, which is also the behaviour a real doubt produces.
        batchSize: 200,
      });
    }

    /**
     * A reservation whose claim records **both** ids, the way `validateTaskActivity` does.
     *
     * The pair is the point of N7: a claim is identified by the workflow id *and* the run
     * id, because that is what `describeWorkflowExecution` is keyed by. A fixture that
     * wrote only the run id would describe a row production cannot produce any more.
     */
    async function strandedAttempt(
      fixture: TenantFixture,
      label: string,
      holder: { readonly workflowId: string; readonly runId: string },
    ): Promise<Reservation> {
      const reservation = await reservedTask(fixture, label);

      await client.executionAttempt.update({
        where: { id: reservation.attemptId },
        data: {
          claimedByWorkflowId: holder.workflowId,
          claimedByWorkflowRunId: holder.runId,
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
      const workflowId = `task-vanished-${randomUUID()}`;
      const reservation = await strandedAttempt(fixture, 'vanished', {
        workflowId,
        runId: execution,
      });

      const result = await releasePass({ [execution]: 'absent' });

      const action = result.actions.find((entry) => entry.attemptId === reservation.attemptId);

      expect(action).toMatchObject({
        outcome: 'released',
        workflowId,
        workflowRunId: execution,
      });

      const row = await attemptRow(reservation.attemptId);

      // The row is terminal, and the claim columns are NULL — the documented meaning of
      // "never claimed", with the release recorded in the audit trail instead of disguised
      // as an unclaimed row carrying a suspicious timestamp.
      expect(row.status).toBe('failed');
      expect(row.claimedByWorkflowId).toBeNull();
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
        // Both ids, so an operator can re-run the exact question the pass asked.
        workflowId,
        workflowRunId: execution,
        liveness: 'absent',
      });
    }, 30_000);

    it('releases a claim whose workflow finished without adopting, and audits that evidence too', async () => {
      const fixture = await tenant('f4-finished');
      const execution = `execution-finished-${randomUUID()}`;
      const reservation = await strandedAttempt(fixture, 'finished', {
        workflowId: `task-finished-${randomUUID()}`,
        runId: execution,
      });

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
      const reservation = await strandedAttempt(fixture, 'live', {
        workflowId: `task-live-${randomUUID()}`,
        runId: execution,
      });

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
      expect(row.claimedByWorkflowId).toMatch(/^task-live-/);
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
      const reservation = await strandedAttempt(fixture, 'unknown', {
        workflowId: `task-unknown-${randomUUID()}`,
        runId: execution,
      });

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

    /**
     * N12 — an unreleasable claim must not consume a batch slot.
     *
     * The pass takes the **oldest** `batchSize` candidates. A claim with no recorded
     * workflow id can never be released (N7: there is no exact pair to ask about), so with
     * `batchSize` of them present and older than everything else they filled every slot and
     * a genuine candidate was never scanned — silently, because the only visible outcome
     * was `skipped_unknown`. The reviewer's reproduction: ten legacy claims with
     * `batchSize` 5; five is already enough to fill the batch, so the real candidate is
     * never reached. The candidate query now excludes them.
     */
    it('does not let claims with no workflow id starve a releasable claim out of the batch', async () => {
      const fixture = await tenant('f4-starvation');
      const batchSize = 5;

      // Older than every row this suite — or a concurrent one — writes. Without the
      // predicate these five are the first five candidates and the releasable row below is
      // never read at all.
      const legacy: Reservation[] = [];

      for (let index = 0; index < batchSize; index += 1) {
        const reservation = await reservedTask(fixture, `starve-legacy-${index}`);

        await client.executionAttempt.update({
          where: { id: reservation.attemptId },
          data: {
            claimedByWorkflowId: null,
            claimedByWorkflowRunId: `execution-legacy-${randomUUID()}`,
            claimedAt: new Date('2000-01-01T00:00:00.000Z'),
          },
        });

        legacy.push(reservation);
      }

      // One day newer, so the ordering is unambiguous: with the legacy rows excluded this
      // is the first releasable candidate in the table.
      const genuineExecution = `execution-starvation-${randomUUID()}`;
      const genuineWorkflowId = `task-starvation-${randomUUID()}`;
      const genuine = await reservedTask(fixture, 'starve-genuine');

      await client.executionAttempt.update({
        where: { id: genuine.attemptId },
        data: {
          claimedByWorkflowId: genuineWorkflowId,
          claimedByWorkflowRunId: genuineExecution,
          claimedAt: new Date('2000-01-02T00:00:00.000Z'),
        },
      });

      const result = await runClaimReleasePass({
        prisma: client,
        probe: {
          execution: async (_workflowId, workflowRunId) =>
            workflowRunId === genuineExecution ? 'absent' : 'unknown',
        },
        intervalMs: INTERVAL_MS,
        batchSize,
      });

      const action = result.actions.find((entry) => entry.attemptId === genuine.attemptId);

      expect(action).toMatchObject({
        outcome: 'released',
        workflowId: genuineWorkflowId,
        workflowRunId: genuineExecution,
      });

      const released = await attemptRow(genuine.attemptId);

      expect(released.status).toBe('failed');
      expect(released.claimedByWorkflowId).toBeNull();
      expect(released.claimedByWorkflowRunId).toBeNull();

      // And no legacy row was selected, changed, or released. They remain stranded — the
      // documented fail-closed cost — but they no longer cost every other claim its release.
      for (const reservation of legacy) {
        const row = await attemptRow(reservation.attemptId);

        expect(row.status).toBe('queued');
        expect(row.claimedByWorkflowId).toBeNull();
        expect(row.claimedByWorkflowRunId).not.toBeNull();

        expect(
          result.actions.find((entry) => entry.attemptId === reservation.attemptId),
        ).toBeUndefined();
      }

      expect(
        await client.auditEvent.count({
          where: {
            orgId: fixture.orgId,
            eventType: 'execution.claim_released.v1',
            aggregateId: { in: legacy.map((reservation) => reservation.attemptId) },
          },
        }),
      ).toBe(0);
    }, 60_000);

    it('does not look at a claim that is younger than the grace window', async () => {
      const fixture = await tenant('f4-fresh');
      const execution = `execution-fresh-${randomUUID()}`;
      const reservation = await reservedTask(fixture, 'fresh');

      await client.executionAttempt.update({
        where: { id: reservation.attemptId },
        data: {
          claimedByWorkflowId: `task-fresh-${randomUUID()}`,
          claimedByWorkflowRunId: execution,
          claimedAt: new Date(),
        },
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

    /**
     * N2 and N7 — the answers, end to end, from the **shipped** probe.
     *
     * The five tests above inject a stub probe, so the shipped `createTemporalProbe` had no
     * coverage at all — which is how the re-review found that `absent` was unreachable: the
     * SDK converts gRPC `NOT_FOUND` into `WorkflowNotFoundError`, which carries no `code`,
     * so the classifier answered `unknown` and the release could only ever fire for a
     * *terminal* run. The tests below run the real probe against the real server.
     *
     * The answers are scoped to this test's own run ids on purpose: `runClaimReleasePass`
     * scans the whole table, other suites in this package run concurrently against the same
     * database, and a real probe answering `absent` for a stranger's claim would release it
     * underneath that test. Scoping changes which rows this pass can act on, not how any row
     * it does act on is classified.
     */
    function scopedRealProbe(owned: ReadonlySet<string>) {
      const probe = createTemporalProbe({
        address: TEMPORAL_ADDRESS,
        namespace: TEMPORAL_NAMESPACE,
      });

      return {
        probe: {
          // The **pair**, as recorded. A run id outside this test's set is a stranger's row.
          execution: async (workflowId: string, workflowRunId: string) =>
            owned.has(workflowRunId) ? probe.execution(workflowId, workflowRunId) : 'unknown',
        },
        close: () => probe.close(),
      };
    }

    /** One release pass with the real probe, scoped to `owned`. */
    async function realPass(owned: ReadonlySet<string>) {
      const { probe, close } = scopedRealProbe(owned);

      try {
        return await runClaimReleasePass({
          prisma: client,
          probe,
          intervalMs: INTERVAL_MS,
          batchSize: 200,
        });
      } finally {
        await close();
      }
    }

    /**
     * The claim a stranded attempt holds, written the way `validateTaskActivity` writes it.
     *
     * Read from the catalogue first, because the workflow-id column is the fix this file
     * tests: on a checkout that predates it (the commit N7 was found in) the state below
     * cannot be expressed at all, and the N7 test must still be *runnable* there — it fails
     * because that commit probes a derived `task-<taskId>` and releases a live claim, which
     * is the defect, not because the fixture could not be written.
     */
    async function claimRecordsWorkflowId(): Promise<boolean> {
      const rows = await client.$queryRaw<Array<{ present: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'ExecutionAttempt'
             AND column_name = 'claimedByWorkflowId'
        ) AS present`;

      return rows[0]?.present === true;
    }

    async function holdClaim(
      attemptId: string,
      holder: { readonly workflowId: string | null; readonly runId: string },
    ): Promise<void> {
      const recordsWorkflowId = await claimRecordsWorkflowId();

      await client.executionAttempt.update({
        where: { id: attemptId },
        data: {
          claimedByWorkflowRunId: holder.runId,
          claimedAt: new Date(Date.now() - INTERVAL_MS * 4),
          ...(recordsWorkflowId ? { claimedByWorkflowId: holder.workflowId } : {}),
        },
      });
    }

    // N2 and N7 need the shipped probe against a real server; without one these skip,
    // visibly.
    describe.skipIf(!temporalEnabled)('N2 / N7 — the shipped probe against a real server', () => {
      it('releases a claim whose recorded execution the server has never heard of', async () => {
        const fixture = await tenant('n2-absent');
        // A **UUID**, because that is what a run id is. The server answers a malformed run id
        // with gRPC 3 (invalid argument) rather than NOT_FOUND, and that is a different fact:
        // the id is wrong, not the execution missing. `absent-run-is-malformed` below keeps
        // that distinction honest.
        const execution = randomUUID();
        const reservation = await reservedTask(fixture, 'absent-run');
        // The canonical workflow id, which is what a claim that outlived its execution's
        // retention actually records. The pair does not exist → `absent` → release.
        await holdClaim(reservation.attemptId, {
          workflowId: `task-${reservation.taskId}`,
          runId: execution,
        });

        const result = await realPass(new Set([execution]));

        expect(
          result.actions.find((entry) => entry.attemptId === reservation.attemptId),
        ).toMatchObject({ outcome: 'released', workflowRunId: execution });

        // Before AG-603 this row stayed `queued` and claimed for ever: the only outcome the
        // pass could produce for a deleted or aged-out run was `skipped_unknown`.
        const row = await attemptRow(reservation.attemptId);

        expect(row.status).toBe('failed');
        expect(row.claimedByWorkflowId).toBeNull();
        expect(row.claimedByWorkflowRunId).toBeNull();

        const audits = await client.auditEvent.findMany({
          where: {
            orgId: fixture.orgId,
            aggregateId: reservation.attemptId,
            eventType: 'execution.claim_released.v1',
          },
          select: { payload: true },
        });

        expect(audits[0]?.payload).toMatchObject({ liveness: 'absent' });
      }, 60_000);

      it('does not release a claim whose run id the server rejected as malformed', async () => {
        const fixture = await tenant('n2-malformed');
        // Not a UUID, so `describeWorkflowExecution` answers INVALID_ARGUMENT (gRPC 3), not
        // NOT_FOUND. That is not evidence that the execution is gone — it is evidence that
        // the claim is nonsense — and the pass must still skip. This is the negative control
        // for the classifier: fail-closed survives the N2 fix.
        const execution = `execution-malformed-${randomUUID()}`;
        const reservation = await reservedTask(fixture, 'malformed-run');
        await holdClaim(reservation.attemptId, {
          workflowId: `task-${reservation.taskId}`,
          runId: execution,
        });

        const result = await realPass(new Set([execution]));

        expect(
          result.actions.find((entry) => entry.attemptId === reservation.attemptId),
        ).toMatchObject({ outcome: 'skipped_unknown' });

        const row = await attemptRow(reservation.attemptId);

        expect(row.status).toBe('queued');
        expect(row.claimedByWorkflowRunId).toBe(execution);
      }, 60_000);

      it('does not release a claim held by a live run under the canonical workflow id', async () => {
        if (harness === undefined) throw new Error('suite not initialised');

        const fixture = await tenant('n2-live');
        const reservation = await reservedTask(fixture, 'live-run');

        // A real, running execution started under the id the orchestrator derives for this
        // task (`task-<taskId>`). The session is started and never given steps, so it stays
        // in `probeExecution`'s `condition` — a live workflow, not a guess.
        const live = await harness.session({ workflowId: `task-${reservation.taskId}` });

        await holdClaim(reservation.attemptId, {
          workflowId: `task-${reservation.taskId}`,
          runId: live.runId,
        });

        try {
          const result = await realPass(new Set([live.runId]));

          expect(
            result.actions.find((entry) => entry.attemptId === reservation.attemptId),
          ).toMatchObject({ outcome: 'skipped_live' });
        } finally {
          await live.stop();
        }

        const row = await attemptRow(reservation.attemptId);

        expect(row.status).toBe('queued');
        expect(row.claimedByWorkflowId).toBe(`task-${reservation.taskId}`);
        expect(row.claimedByWorkflowRunId).toBe(live.runId);

        expect(
          await client.auditEvent.count({
            where: {
              orgId: fixture.orgId,
              aggregateId: reservation.attemptId,
              eventType: 'execution.claim_released.v1',
            },
          }),
        ).toBe(0);
      }, 60_000);

      /**
       * N7 — the reviewer's §G reproduction, against the shipped probe.
       *
       * The claim's holder is a **live** execution started under a workflow id that is not
       * `task-<taskId>`. Before AG-604 the probe asked the server about
       * `task-<taskId>` + this run id; the server has no such run under that id and answers
       * NOT_FOUND; the N2 classifier — correctly — mapped that to `absent`; and the pass
       * released a claim whose execution was `RUNNING`. The run's next terminal write was
       * then refused `EXECUTION_CLAIM_REFUSED`, so it could not record its result: a
       * fail-open release, produced by a correct fix to a fail-closed bug.
       *
       * The fix is not a weaker classifier. It is that the claim records the workflow id it
       * was granted under, and the probe asks about **that pair**. This test is the §G
       * reproduction; it fails on the commit before the fix.
       */
      it('does not release a claim held by a live execution whose workflow id is not task-<taskId>', async () => {
        if (harness === undefined) throw new Error('suite not initialised');

        const fixture = await tenant('n7-live-foreign-id');
        const reservation = await reservedTask(fixture, 'n7-live-foreign');

        // The shape any non-orchestrator start produces: a back-office workflow, a replay,
        // another workflow type on the queue, or this harness. Live, and not `task-<id>`.
        const workflowId = `probe-${randomUUID()}`;
        const live = await harness.session({ workflowId });

        await holdClaim(reservation.attemptId, { workflowId, runId: live.runId });

        try {
          const result = await realPass(new Set([live.runId]));

          expect(
            result.actions.find((entry) => entry.attemptId === reservation.attemptId),
          ).toMatchObject({ outcome: 'skipped_live', workflowId, workflowRunId: live.runId });
        } finally {
          await live.stop();
        }

        // The claim is intact and the attempt is untouched. This is the whole assertion: a
        // live execution may still adopt, and its authority to finish is not taken away.
        const row = await attemptRow(reservation.attemptId);

        expect(row.status).toBe('queued');
        expect(row.claimedByWorkflowId).toBe(workflowId);
        expect(row.claimedByWorkflowRunId).toBe(live.runId);
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
      }, 60_000);

      it('releases a claim whose recorded execution has finished, and audits the pair', async () => {
        if (harness === undefined) throw new Error('suite not initialised');

        const fixture = await tenant('n7-finished');
        const reservation = await reservedTask(fixture, 'n7-finished-run');

        // A real execution, started under the canonical id, that ends without adopting.
        const workflowId = `task-${reservation.taskId}`;
        const finished = await harness.session({ workflowId });
        await finished.stop();

        await holdClaim(reservation.attemptId, { workflowId, runId: finished.runId });

        const result = await realPass(new Set([finished.runId]));

        expect(
          result.actions.find((entry) => entry.attemptId === reservation.attemptId),
        ).toMatchObject({ outcome: 'released', workflowId, workflowRunId: finished.runId });

        const row = await attemptRow(reservation.attemptId);

        expect(row.status).toBe('failed');
        expect(row.terminationReason).toBe('crashed');
        expect(row.claimedByWorkflowId).toBeNull();
        expect(row.claimedByWorkflowRunId).toBeNull();

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
          workflowId,
          workflowRunId: finished.runId,
          liveness: 'finished',
        });
      }, 60_000);

      it('never selects a claim that records no workflow id, and never guesses one for it', async () => {
        // The pre-migration shape: `claimedByWorkflowRunId` set, `claimedByWorkflowId` NULL.
        // Nothing may derive `task-<taskId>` for it — that guess is what N7 released a live
        // claim with — and doubt is not evidence, so it is not a candidate at all (N12) and
        // is never released. It stays stranded, which is the documented cost of the
        // fail-closed answer. The loop's `workflowId === null` skip is retained for a row
        // whose column is cleared between the SELECT and the loop; the predicate is the
        // optimisation, the skip is the control.
        const fixture = await tenant('n7-legacy');
        const execution = randomUUID();
        const reservation = await reservedTask(fixture, 'n7-legacy-run');

        await client.executionAttempt.update({
          where: { id: reservation.attemptId },
          data: {
            claimedByWorkflowId: null,
            claimedByWorkflowRunId: execution,
            claimedAt: new Date(Date.now() - INTERVAL_MS * 4),
          },
        });

        const asked: string[] = [];
        const result = await runClaimReleasePass({
          prisma: client,
          probe: {
            execution: async (workflowId, workflowRunId) => {
              asked.push(`${workflowId}/${workflowRunId}`);
              return 'absent';
            },
          },
          intervalMs: INTERVAL_MS,
          batchSize: 200,
        });

        // Not scanned, so not even reported as `skipped_unknown`: an unreleasable row must
        // not consume attention or a batch slot.
        expect(
          result.actions.find((entry) => entry.attemptId === reservation.attemptId),
        ).toBeUndefined();

        // The probe was never asked about this claim: a NULL workflow id cannot form the
        // pair `describeWorkflowExecution` is keyed by. (`asked` may hold other suites' rows
        // — every pass scans the table.)
        expect(asked.some((entry) => entry.endsWith(`/${execution}`))).toBe(false);

        const row = await attemptRow(reservation.attemptId);

        expect(row.status).toBe('queued');
        expect(row.claimedByWorkflowId).toBeNull();
        expect(row.claimedByWorkflowRunId).toBe(execution);

        expect(
          await client.auditEvent.count({
            where: {
              orgId: fixture.orgId,
              aggregateId: reservation.attemptId,
              eventType: 'execution.claim_released.v1',
            },
          }),
        ).toBe(0);
      }, 60_000);
    });
  },
);

describe.skipIf(!temporalEnabled)('N8 — the pre-dispatch arm may only record a refusal', () => {
  it('refuses `succeeded` for a task with no attempts and no AgentRun', async () => {
    if (harness === undefined) throw new Error('suite not initialised');

    const fixture = await tenant('n8-succeeded');
    // `queued`, which is the state `POST /run` leaves behind and the only non-terminal state
    // `completeTask` will write. A `ready` fixture would make this test blind: the write
    // would be a no-op for a reason unrelated to authority, and the refusal would appear to
    // hold even if the arm let `succeeded` through.
    const reservation = await reservedTask(fixture, 'n8-succeeded', { status: 'queued' });

    // No claim anywhere, and the caller *is* this task's own execution — so the only thing
    // that can refuse the write is the status itself.
    const session = await harness.session({ workflowId: `task-${reservation.taskId}` });

    try {
      await expect(
        session.call({
          op: 'complete',
          input: { taskId: reservation.taskId, orgId: fixture.orgId, status: 'succeeded' },
        }),
      ).rejects.toMatchObject({ type: 'EXECUTION_CLAIM_REFUSED', nonRetryable: true });
    } finally {
      await session.stop();
    }

    // Nothing was written. A task that never executed cannot be a success, and the run that
    // would have carried the success did not move either.
    const task = await client.task.findUniqueOrThrow({
      where: { id: reservation.taskId },
      select: { status: true },
    });

    expect(task.status).toBe('queued');

    const run = await client.workflowRun.findUniqueOrThrow({
      where: { id: reservation.workflowRunId },
      select: { status: true, error: true, finishedAt: true },
    });

    expect(run.status).toBe('queued');
    expect(run.error).toBeNull();
    expect(run.finishedAt).toBeNull();

    expect(await client.agentRun.count({ where: { orgId: fixture.orgId } })).toBe(0);
    expect((await attemptRow(reservation.attemptId)).status).toBe('queued');
  }, 60_000);
});

/**
 * N4, the class rather than the instance — Phase 6, AG-604.
 *
 * `persistResultActivity` and `completeTaskActivity` were authority-checked in AG-603, but
 * `emitEventActivity` and `recordStartActivity` were still dispatchable by name with no
 * authority at all: the reviewer wrote a valid `task.succeeded.v1` and moved a task
 * `queued → running` from **standalone** activities. AG-604 makes the event the durable
 * record of a refused run, which raises what forging it is worth, so both now go through
 * the same two arms as completion.
 *
 * Every test below is the reviewer's shape: dispatch by name, from an execution that is
 * not entitled to the write, and assert that nothing was written.
 */
describe.skipIf(!temporalEnabled)(
  'N4 residual — the event writer and the start record require authority',
  () => {
    /** A well-formed envelope, since a malformed one would fail for the wrong reason. */
    function taskEvent(
      reservation: Reservation,
      eventType: string,
      idempotencyKey: string,
    ): Record<string, unknown> {
      return {
        eventId: randomUUID(),
        eventType,
        schemaVersion: 1,
        tenantId: reservation.orgId,
        projectId: reservation.projectId,
        aggregateId: reservation.taskId,
        occurredAt: new Date().toISOString(),
        actor: { type: 'agent', id: AGENT_ACTOR_ID },
        correlationId: randomUUID(),
        causationId: null,
        idempotencyKey,
        payload: { taskId: reservation.taskId },
      };
    }

    async function auditsFor(reservation: Reservation, eventType: string): Promise<number> {
      return client.auditEvent.count({
        where: { orgId: reservation.orgId, aggregateId: reservation.taskId, eventType },
      });
    }

    it('refuses a `task.succeeded.v1` written by a standalone activity', async () => {
      if (harness === undefined) throw new Error('suite not initialised');

      const fixture = await tenant('n4-emit-standalone');
      const reservation = await reservedTask(fixture, 'emit-standalone', { status: 'queued' });

      await expect(
        harness.executeStandalone('emitEventActivity', [
          { event: taskEvent(reservation, 'task.succeeded.v1', `n4-${randomUUID()}`) },
        ]),
      ).rejects.toMatchObject({ type: 'EXECUTION_IDENTITY_UNAVAILABLE', nonRetryable: true });

      expect(await auditsFor(reservation, 'task.succeeded.v1')).toBe(0);
    }, 60_000);

    it('refuses a `task.succeeded.v1` written by a workflow that is not this task’s execution', async () => {
      if (harness === undefined) throw new Error('suite not initialised');

      const fixture = await tenant('n4-emit-rogue');
      const reservation = await reservedTask(fixture, 'emit-rogue', { status: 'queued' });

      // A real execution, random id, no claim: it knows the task id and nothing else.
      const session = await harness.session();

      try {
        await expect(
          session.call({
            op: 'emit',
            input: { event: taskEvent(reservation, 'task.succeeded.v1', `n4-${randomUUID()}`) },
          }),
        ).rejects.toMatchObject({ type: 'EXECUTION_CLAIM_REFUSED', nonRetryable: true });
      } finally {
        await session.stop();
      }

      expect(await auditsFor(reservation, 'task.succeeded.v1')).toBe(0);

      const task = await client.task.findUniqueOrThrow({
        where: { id: reservation.taskId },
        select: { status: true },
      });

      expect(task.status).toBe('queued');
    }, 60_000);

    it('refuses a `task.succeeded.v1` from this task’s own execution when it holds no claim', async () => {
      if (harness === undefined) throw new Error('suite not initialised');

      const fixture = await tenant('n4-emit-canonical-no-claim');
      const reservation = await reservedTask(fixture, 'emit-canonical', { status: 'queued' });

      // Identity alone is not authority: a run that never claimed anything may record a
      // refusal, and a success is not one.
      const session = await harness.session({ workflowId: `task-${reservation.taskId}` });

      try {
        await expect(
          session.call({
            op: 'emit',
            input: { event: taskEvent(reservation, 'task.succeeded.v1', `n4-${randomUUID()}`) },
          }),
        ).rejects.toMatchObject({ type: 'EXECUTION_CLAIM_REFUSED', nonRetryable: true });
      } finally {
        await session.stop();
      }

      expect(await auditsFor(reservation, 'task.succeeded.v1')).toBe(0);
    }, 60_000);

    it('refuses the refusal event from a workflow that is not this task’s execution', async () => {
      if (harness === undefined) throw new Error('suite not initialised');

      const fixture = await tenant('n4-emit-foreign-refusal');
      const reservation = await reservedTask(fixture, 'emit-foreign-refusal', { status: 'queued' });

      // `task.failed.v1` is the one event the pre-dispatch arm admits — but only from this
      // task's **own** execution. A workflow started under `task-<id>-direct` (or any other
      // id) is not it, so its refusal is not its to record on the task. This is the shape
      // `approval-attempt-binding`'s direct-start fixture used to carry, and it is refused
      // here rather than silently: the run's own result and history are the record.
      const session = await harness.session({ workflowId: `task-${reservation.taskId}-direct` });

      try {
        await expect(
          session.call({
            op: 'emit',
            input: { event: taskEvent(reservation, 'task.failed.v1', `n4-${randomUUID()}`) },
          }),
        ).rejects.toMatchObject({ type: 'EXECUTION_CLAIM_REFUSED', nonRetryable: true });
      } finally {
        await session.stop();
      }

      expect(await auditsFor(reservation, 'task.failed.v1')).toBe(0);
    }, 60_000);

    it('allows the refusal event the pre-dispatch failure path exists to write', async () => {
      if (harness === undefined) throw new Error('suite not initialised');

      const fixture = await tenant('n4-emit-refusal');
      const reservation = await reservedTask(fixture, 'emit-refusal', { status: 'queued' });

      // The state `runTaskWorkflow` is in when validation refuses: no claim, this task's own
      // execution, and `task.failed.v1` is the only durable record the refusal will get. If
      // this stopped working, every approval refusal would become invisible.
      const session = await harness.session({ workflowId: `task-${reservation.taskId}` });
      const event = taskEvent(reservation, 'task.failed.v1', `n4-refusal-${randomUUID()}`);

      try {
        const emitted = await session.call<Record<string, unknown>>({
          op: 'emit',
          input: { event, attemptId: reservation.attemptId },
        });

        expect(emitted).toMatchObject({ eventId: event['eventId'], created: true });
      } finally {
        await session.stop();
      }

      expect(await auditsFor(reservation, 'task.failed.v1')).toBe(1);

      // The attempt is forwarded and holds no claim; the arm did not need one. It also did
      // not spend anything: `failed` recorded, reservation untouched.
      expect((await attemptRow(reservation.attemptId)).claimedByWorkflowRunId).toBeNull();
    }, 60_000);

    it('refuses a start recorded by a standalone activity', async () => {
      if (harness === undefined) throw new Error('suite not initialised');

      const fixture = await tenant('n4-start-standalone');
      const reservation = await reservedTask(fixture, 'start-standalone', { status: 'queued' });

      // The reviewer's probe: move a task `queued → running` by dispatching the activity by
      // name, with no workflow and no claim.
      await expect(
        harness.executeStandalone('recordStartActivity', [
          {
            taskId: reservation.taskId,
            orgId: fixture.orgId,
            workflowRunId: randomUUID(),
            attemptId: reservation.attemptId,
          },
        ]),
      ).rejects.toMatchObject({ type: 'EXECUTION_IDENTITY_UNAVAILABLE', nonRetryable: true });

      const task = await client.task.findUniqueOrThrow({
        where: { id: reservation.taskId },
        select: { status: true },
      });

      expect(task.status).toBe('queued');
    }, 60_000);

    it('refuses a start recorded by a workflow that holds no claim', async () => {
      if (harness === undefined) throw new Error('suite not initialised');

      const fixture = await tenant('n4-start-no-claim');
      const reservation = await reservedTask(fixture, 'start-no-claim', { status: 'queued' });

      // Canonical id, no claim: the pre-dispatch arm has no case for a start, because the
      // claim is granted *before* the transition this activity writes.
      const session = await harness.session({ workflowId: `task-${reservation.taskId}` });

      try {
        await expect(
          session.call({
            op: 'start',
            input: {
              taskId: reservation.taskId,
              orgId: fixture.orgId,
              workflowRunId: randomUUID(),
              attemptId: reservation.attemptId,
            },
          }),
        ).rejects.toMatchObject({ type: 'EXECUTION_CLAIM_REFUSED', nonRetryable: true });
      } finally {
        await session.stop();
      }

      const task = await client.task.findUniqueOrThrow({
        where: { id: reservation.taskId },
        select: { status: true },
      });

      expect(task.status).toBe('queued');
    }, 60_000);

    it('allows the start the claim authorises, so the normal path still records it', async () => {
      if (harness === undefined) throw new Error('suite not initialised');

      const fixture = await tenant('n4-start-claimed');
      const reservation = await reservedTask(fixture, 'start-claimed', { status: 'queued' });
      const session = await claimedSession(reservation);

      try {
        const started = await session.call<Record<string, unknown>>({
          op: 'start',
          input: {
            taskId: reservation.taskId,
            orgId: fixture.orgId,
            // The Temporal run id is what `recordStartActivity` adopts the run row by.
            workflowRunId: session.runId,
            attemptId: reservation.attemptId,
          },
        });

        expect(started).toMatchObject({ started: true, taskStatus: 'running' });
      } finally {
        await session.stop();
      }

      const task = await client.task.findUniqueOrThrow({
        where: { id: reservation.taskId },
        select: { status: true },
      });

      expect(task.status).toBe('running');
    }, 60_000);
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
