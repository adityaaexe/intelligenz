import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';

import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PrismaClient } from '@intelligenz/database';

import { activities } from '../src/activities';
import { executionWorkspaceIdFor } from '../src/activities/ids';
import { claimExecution, classifyLostClaim } from '../src/activities/claim';
import { validateTaskActivity } from '../src/activities/validate-task';
import { computeTaskContentHash } from '../src/approvals/task-binding';
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
 * The one-shot execution claim — Phase 6, AG-601.
 *
 * The defect: `validateTaskActivity` decided authority by **reading** the attempt
 * (`status === 'queued'`) and writing nothing. Two executions holding the same genuine
 * `attemptId` could both read it, both pass, and both proceed toward execution — one
 * grant, two agents, with Temporal's workflow-id dedupe as the only obstacle.
 *
 * What they prove is the property the system needs: **one attempt authorises one
 * execution**, and a loser leaves nothing behind. Concurrency is real — two calls race on
 * separate pool connections against the real test database, with no mocks, no fake clock
 * and no injected interleaving.
 *
 * ## AG-603: why the race tests call `claimExecution` directly
 *
 * The race used to be driven through `validateTaskActivity` with a supplied
 * `workflowRunId`, because `executionIdentity` fell back to that field when there was no
 * activity context. The re-review broke the fallback with a real standalone activity, so
 * that seam is gone and a direct call to validation now has no identity to claim under.
 *
 * The write under test is `claimExecution`, and its only production caller is
 * `validateTaskActivity`. Racing `claimExecution` therefore tests the exact statement that
 * arbitrates — `UPDATE … WHERE status = 'queued' AND claimedByWorkflowRunId IS NULL` —
 * without inventing an identity. What the round trip through validation adds is *identity
 * provenance*, and that is proved separately and for real: `execution-identity.test.ts`
 * shows a running workflow's activities claim under the server's run id and that no input
 * can name a different one, and the two tests at the bottom of this file run the whole
 * workflow through a real Temporal worker.
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

const enabled = databaseEnabled && temporalReachable;

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
 * The exact row shape `POST /run` leaves behind: task `ready`, a queued `WorkflowRun`, a
 * `queued` attempt, and (for HIGH risk) an `APPROVED` grant consumed by that attempt.
 *
 * Deliberately not built through the API: these tests are about the worker's gate, and a
 * helper that reproduced the API would only prove the two agree.
 */
async function reservedTask(
  fixture: TenantFixture,
  label: string,
  options: { readonly riskClass?: 'LOW' | 'HIGH'; readonly goal?: string } = {},
): Promise<Reservation> {
  const riskClass = options.riskClass ?? 'LOW';
  const goal = options.goal ?? 'Fix the failing test in src/sum.js and prove it passes.';

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
      idempotencyKey: `claim-${randomUUID().slice(0, 8)}`,
    },
  });

  const run = await client.workflowRun.create({
    data: {
      orgId: fixture.orgId,
      taskId: task.id,
      workflowId: `task-${task.id}`,
      temporalRunId: `claim-run-${randomUUID()}`,
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

  if (riskClass === 'HIGH') {
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

/**
 * The claim, written by the module `validateTaskActivity` uses.
 *
 * `workflowRunId` here is the execution identity **as an argument**, which is legitimate
 * for this function and only for this function: `claimExecution` is an internal writer that
 * is *given* an identity by its caller, and the one caller that matters
 * (`validateTaskActivity`) derives it from the activity context. Nothing reachable from
 * Temporal can choose the argument — see `execution-identity.test.ts`.
 */
function claimAs(
  reservation: Reservation,
  workflowRunId: string,
  overrides: { readonly attemptId?: string } = {},
): Promise<unknown> {
  return claimExecution({
    orgId: reservation.orgId,
    taskId: reservation.taskId,
    projectId: reservation.projectId,
    attemptId: overrides.attemptId ?? reservation.attemptId,
    workflowRunId,
    correlationId: randomUUID(),
  });
}

async function attemptRow(attemptId: string): Promise<{
  status: string;
  claimedByWorkflowRunId: string | null;
  claimedAt: Date | null;
}> {
  return client.executionAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    select: { status: true, claimedByWorkflowRunId: true, claimedAt: true },
  });
}

/** Nothing that a launch would create exists, in the database or on the filesystem. */
async function assertNoExecutionSideEffects(reservation: Reservation): Promise<void> {
  expect(await client.agentRun.count({ where: { orgId: reservation.orgId } })).toBe(0);
  expect(await client.executionWorkspace.count({ where: { orgId: reservation.orgId } })).toBe(0);
  expect(await client.toolInvocation.count({ where: { orgId: reservation.orgId } })).toBe(0);

  // The cgroup is named after the derived workspace id, so its absence is checkable
  // without root: the directory simply must not exist. A missing root is the same answer
  // (nothing could have been created under it).
  const cgroupRoot = getWorkerConfig().resources.cgroupRoot;
  const workspaceId = executionWorkspaceIdFor(reservation.workflowRunId, 1);
  const entries = await readdir(cgroupRoot).catch(() => [] as string[]);

  expect(entries).not.toContain(workspaceId);
}

beforeAll(async () => {
  if (!databaseEnabled) return;

  const database = useTestDatabase();
  client = database.client;
  artifactRoot = `/tmp/intelligenz-claim-test-${randomUUID().slice(0, 8)}`;

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
    `[execution-claim] suite skipped — ${
      databaseEnabled ? temporalReason : 'TEST_DATABASE_URL is not set'
    }`,
  );
}

describe('classifyLostClaim (pure)', () => {
  const base = { attemptId: 'attempt-1', workflowRunId: 'run-1' } as const;

  it('recognises the same execution still holding a queued attempt as a retry', () => {
    expect(
      classifyLostClaim({ ...base, status: 'queued', claimedByWorkflowRunId: 'run-1' }),
    ).toEqual({ outcome: 'retry' });
  });

  it('recognises the same execution after adoption, while the attempt is running', () => {
    expect(
      classifyLostClaim({ ...base, status: 'running', claimedByWorkflowRunId: 'run-1' }),
    ).toEqual({ outcome: 'retry' });
  });

  it('refuses a different execution with EXECUTION_ALREADY_CLAIMED', () => {
    const decision = classifyLostClaim({
      ...base,
      status: 'queued',
      claimedByWorkflowRunId: 'run-2',
    });

    expect(decision).toMatchObject({ outcome: 'refused', code: 'EXECUTION_ALREADY_CLAIMED' });
  });

  it('refuses an attempt that never matched the tenant and task', () => {
    const decision = classifyLostClaim({ ...base, status: null, claimedByWorkflowRunId: null });

    expect(decision).toMatchObject({ outcome: 'refused', code: 'EXECUTION_CLAIM_REFUSED' });
  });

  it('refuses a terminal attempt, even for the execution that held it', () => {
    for (const status of ['succeeded', 'failed', 'cancelled', 'timed_out']) {
      expect(
        classifyLostClaim({ ...base, status, claimedByWorkflowRunId: 'run-1' }),
      ).toMatchObject({ outcome: 'refused', code: 'EXECUTION_CLAIM_REFUSED' });
    }
  });

  it('refuses an attempt adopted by an execution that recorded no claim', () => {
    const decision = classifyLostClaim({ ...base, status: 'running', claimedByWorkflowRunId: null });

    expect(decision).toMatchObject({ outcome: 'refused', code: 'EXECUTION_ALREADY_CLAIMED' });
  });
});

describe.skipIf(!databaseEnabled)('the claim is atomic at the database', () => {
  it('gives one attempt to exactly one of two concurrent claimants, and one grant total', async () => {
    const fixture = await tenant('claim-race');

    // Five independent races. One lucky interleaving proves nothing; five make a
    // one-winner claim that only sometimes works fail visibly.
    for (let round = 0; round < 5; round += 1) {
      const reservation = await reservedTask(fixture, `race-${String(round)}`);
      const first = `execution-a-${randomUUID()}`;
      const second = `execution-b-${randomUUID()}`;

      const [a, b] = await Promise.allSettled([
        claimAs(reservation, first),
        claimAs(reservation, second),
      ]);

      const fulfilled = [a, b].filter((outcome) => outcome.status === 'fulfilled');
      const rejected = [a, b].filter((outcome) => outcome.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const winner = a.status === 'fulfilled' ? first : second;
      const loser = winner === first ? second : first;

      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        type: 'EXECUTION_ALREADY_CLAIMED',
        nonRetryable: true,
      });

      const row = await attemptRow(reservation.attemptId);

      expect(row.claimedByWorkflowRunId).toBe(winner);
      expect(row.claimedAt).not.toBeNull();
      // The claim never moves the attempt: adoption belongs to `startAttempt`, and a
      // gate that wrote `running` would make a failed run unretryable.
      expect(row.status).toBe('queued');

      // Literally one claimed attempt for this task: a second claimant left no row with
      // its name on it.
      expect(
        await client.executionAttempt.count({
          where: {
            orgId: fixture.orgId,
            taskId: reservation.taskId,
            claimedByWorkflowRunId: { not: null },
          },
        }),
      ).toBe(1);

      // One grant for this attempt — the loser did not write a second one, and did not
      // leave a half-applied claim behind.
      expect(
        await client.auditEvent.count({
          where: {
            orgId: fixture.orgId,
            aggregateId: reservation.attemptId,
            eventType: 'execution.claim_granted.v1',
          },
        }),
      ).toBe(1);

      // Both outcomes are on the record, with the server-side ids that distinguish them.
      const duplicates = await client.auditEvent.findMany({
        where: {
          orgId: fixture.orgId,
          aggregateId: reservation.attemptId,
          eventType: 'execution.claim_duplicate.v1',
        },
        select: { payload: true },
      });

      expect(duplicates).toHaveLength(1);
      expect(duplicates[0]?.payload).toMatchObject({
        attemptId: reservation.attemptId,
        workflowRunId: loser,
        claimedByWorkflowRunId: winner,
      });

      await assertNoExecutionSideEffects(reservation);
    }
  }, 60_000);

  it('refuses a different execution after the first claim, before anything is provisioned', async () => {
    const fixture = await tenant('claim-second');
    const reservation = await reservedTask(fixture, 'second-claim');
    const owner = `execution-owner-${randomUUID()}`;

    await expect(claimAs(reservation, owner)).resolves.toMatchObject({ outcome: 'granted' });

    await expect(claimAs(reservation, `execution-intruder-${randomUUID()}`)).rejects.toMatchObject(
      { type: 'EXECUTION_ALREADY_CLAIMED', nonRetryable: true },
    );

    const row = await attemptRow(reservation.attemptId);

    expect(row.claimedByWorkflowRunId).toBe(owner);
    expect(row.status).toBe('queued');
    await assertNoExecutionSideEffects(reservation);
  }, 30_000);

  it('treats a re-claim by the same execution as a retry: no error, no second side effect', async () => {
    const fixture = await tenant('claim-idempotent');
    const reservation = await reservedTask(fixture, 'idempotent');
    const execution = `execution-retry-${randomUUID()}`;

    await expect(claimAs(reservation, execution)).resolves.toMatchObject({ outcome: 'granted' });

    const afterGrant = await attemptRow(reservation.attemptId);

    // Second and third calls: an activity retry of the same execution. Recognised as the
    // same execution rather than refused as a duplicate of itself.
    await expect(claimAs(reservation, execution)).resolves.toMatchObject({ outcome: 'retry' });
    await expect(claimAs(reservation, execution)).resolves.toMatchObject({ outcome: 'retry' });

    const afterRetries = await attemptRow(reservation.attemptId);

    // Write-once: `claimedAt` is the moment authority was granted, not the moment it was
    // last observed.
    expect(afterRetries.claimedAt?.getTime()).toBe(afterGrant.claimedAt?.getTime());
    expect(afterRetries.claimedByWorkflowRunId).toBe(execution);

    expect(
      await client.auditEvent.count({
        where: {
          orgId: fixture.orgId,
          aggregateId: reservation.attemptId,
          eventType: 'execution.claim_granted.v1',
        },
      }),
    ).toBe(1);

    // One retry row for three calls: the event is idempotent on (attempt, execution), so
    // a flapping activity does not fill the audit trail with the same fact.
    expect(
      await client.auditEvent.count({
        where: {
          orgId: fixture.orgId,
          aggregateId: reservation.attemptId,
          eventType: 'execution.claim_retry.v1',
        },
      }),
    ).toBe(1);

    await assertNoExecutionSideEffects(reservation);
  }, 30_000);

  it('never re-claims a terminal attempt, and leaves the recorded claim untouched', async () => {
    const fixture = await tenant('claim-terminal');
    const reservation = await reservedTask(fixture, 'terminal');
    const owner = `execution-terminal-${randomUUID()}`;

    await expect(claimAs(reservation, owner)).resolves.toMatchObject({ outcome: 'granted' });

    const claimed = await attemptRow(reservation.attemptId);

    await client.executionAttempt.updateMany({
      where: { id: reservation.attemptId },
      data: { status: 'succeeded', finishedAt: new Date() },
    });

    // A different execution: refused as a duplicate, whatever the status.
    await expect(claimAs(reservation, `execution-late-${randomUUID()}`)).rejects.toMatchObject({
      type: 'EXECUTION_ALREADY_CLAIMED',
    });

    // The execution that held it: refused too. A finished attempt cannot be revived by
    // the retry branch, which is why that branch is limited to queued and running.
    await expect(claimAs(reservation, owner)).rejects.toMatchObject({
      type: 'EXECUTION_CLAIM_REFUSED',
    });

    const row = await attemptRow(reservation.attemptId);

    expect(row.status).toBe('succeeded');
    expect(row.claimedByWorkflowRunId).toBe(owner);
    expect(row.claimedAt?.getTime()).toBe(claimed.claimedAt?.getTime());

    // And a terminal attempt that was never claimed stays unclaimed.
    const unclaimed = await reservedTask(fixture, 'terminal-unclaimed');

    await client.executionAttempt.updateMany({
      where: { id: unclaimed.attemptId },
      data: { status: 'failed', finishedAt: new Date() },
    });

    await expect(claimAs(unclaimed, `execution-late-${randomUUID()}`)).rejects.toMatchObject({
      type: 'EXECUTION_CLAIM_REFUSED',
    });

    expect((await attemptRow(unclaimed.attemptId)).claimedByWorkflowRunId).toBeNull();
  }, 30_000);

  it('writes no workspace, cgroup or AgentRun when the claim is lost', async () => {
    const fixture = await tenant('claim-no-side-effects');
    const reservation = await reservedTask(fixture, 'no-side-effects');

    await expect(
      claimAs(reservation, `execution-first-${randomUUID()}`),
    ).resolves.toMatchObject({ outcome: 'granted' });

    await expect(claimAs(reservation, `execution-second-${randomUUID()}`)).rejects.toMatchObject({
      type: 'EXECUTION_ALREADY_CLAIMED',
    });

    // The three things a launch creates — all absent, and the attempt still reserved.
    await assertNoExecutionSideEffects(reservation);
    expect((await attemptRow(reservation.attemptId)).status).toBe('queued');
  }, 30_000);

  it('keeps the existing approval checks in front of the claim (regression)', async () => {
    const fixture = await tenant('claim-regression');

    // Wrong attempt: the run names an attempt the grant does not name.
    const substituted = await reservedTask(fixture, 'wrong-attempt', { riskClass: 'HIGH' });

    // A direct call to validation is the right shape here: every case below is a refusal
    // that happens **before** the claim, so no execution identity is needed — and the fact
    // that the approval gate runs first is part of what the test asserts.
    await expect(
      validateTaskActivity({
        taskId: substituted.taskId,
        orgId: substituted.orgId,
        attemptId: randomUUID(),
        correlationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ type: 'APPROVAL_ATTEMPT_MISMATCH' });
    expect((await attemptRow(substituted.attemptId)).claimedByWorkflowRunId).toBeNull();

    // Wrong approval: a grant bound to another real attempt of the same run.
    const rebound = await reservedTask(fixture, 'wrong-approval', { riskClass: 'HIGH' });

    const otherAttempt = await client.executionAttempt.create({
      data: {
        orgId: fixture.orgId,
        taskId: rebound.taskId,
        workflowRunId: rebound.workflowRunId,
        attemptNumber: 2,
        runtimeId: 'unassigned',
        simulated: true,
        status: 'queued',
      },
      select: { id: true },
    });

    await client.approvalRequest.updateMany({
      where: { orgId: fixture.orgId, taskId: rebound.taskId },
      data: { consumedByAttemptId: otherAttempt.id },
    });

    await expect(
      validateTaskActivity({
        taskId: rebound.taskId,
        orgId: rebound.orgId,
        attemptId: rebound.attemptId,
        correlationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ type: 'APPROVAL_ATTEMPT_MISMATCH' });

    // Wrong content hash: the task moved after the grant was issued.
    const stale = await reservedTask(fixture, 'wrong-hash', { riskClass: 'HIGH' });

    await client.task.update({
      where: { id: stale.taskId },
      data: { goal: 'Something else entirely.' },
    });

    await expect(
      validateTaskActivity({
        taskId: stale.taskId,
        orgId: stale.orgId,
        attemptId: stale.attemptId,
        correlationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ type: 'APPROVAL_STALE' });

    for (const reservation of [substituted, rebound, stale]) {
      expect((await attemptRow(reservation.attemptId)).claimedByWorkflowRunId).toBeNull();
      await assertNoExecutionSideEffects(reservation);
    }
  }, 60_000);

  it('never resolves another tenant’s attempt, and never claims it', async () => {
    const owning = await tenant('claim-cross-tenant-owner');
    const attacking = await tenant('claim-cross-tenant-attacker');

    const foreign = await reservedTask(owning, 'foreign-reservation');
    const local = await reservedTask(attacking, 'local-task');

    // The task is local, the attempt is not: the claim's predicate carries `orgId` and
    // `taskId`, so the read-back is null and the write matches nothing.
    await expect(
      claimExecution({
        orgId: attacking.orgId,
        taskId: local.taskId,
        projectId: attacking.projectId,
        attemptId: foreign.attemptId,
        workflowRunId: `execution-cross-tenant-${randomUUID()}`,
        correlationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ type: 'EXECUTION_CLAIM_REFUSED', nonRetryable: true });

    // An attempt of another task in the same tenant is the same answer.
    await expect(claimAs(foreign, `execution-${randomUUID()}`, { attemptId: local.attemptId }))
      .rejects.toMatchObject({ type: 'EXECUTION_CLAIM_REFUSED' });

    expect((await attemptRow(foreign.attemptId)).claimedByWorkflowRunId).toBeNull();
    expect((await attemptRow(local.attemptId)).claimedByWorkflowRunId).toBeNull();

    await assertNoExecutionSideEffects(foreign);
    await assertNoExecutionSideEffects(local);
  }, 30_000);
});

describe.skipIf(!enabled)('a direct Temporal start cannot join a claimed execution', () => {
  it('grants the claim to a real execution, keyed on the Temporal run id, and the run completes', async () => {
    const fixture = await tenant('claim-grant-e2e');

    // LOW risk with a reservation and no approval: the ordinary `POST /run` shape. The
    // goal marker makes the simulated adapter deterministic (`local-simulated.ts`,
    // "Forcing the failure bucket") so the assertion below is about the claim, not luck.
    const reservation = await reservedTask(fixture, 'grant-e2e', {
      goal: 'Fix the failing test in src/sum.js and prove it passes. [simulate:ok]',
    });

    const taskQueue = `intelligenz-claim-grant-${randomUUID().slice(0, 8)}`;
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
      const handle = await temporal.workflow.start('runTaskWorkflow', {
        taskQueue,
        workflowId: `task-${reservation.taskId}`,
        args: [
          {
            taskId: reservation.taskId,
            orgId: fixture.orgId,
            correlationId: randomUUID(),
            attemptId: reservation.attemptId,
          },
        ],
      });

      result = (await worker.runUntil(handle.result())) as RunTaskWorkflowResult;
    } finally {
      await connection.close().catch(() => undefined);
      await nativeConnection.close().catch(() => undefined);
    }

    expect(result.status).toBe('succeeded');

    const run = await client.workflowRun.findUniqueOrThrow({
      where: { id: reservation.workflowRunId },
      select: { temporalRunId: true },
    });

    const claimed = await attemptRow(reservation.attemptId);

    // The claim's key is the orchestrator's run id — the same value `recordStartActivity`
    // adopted — and the claim did not stop `startAttempt` from adopting the reservation.
    expect(claimed.claimedByWorkflowRunId).toBe(run.temporalRunId);
    expect(claimed.claimedAt).not.toBeNull();
    expect(claimed.status).toBe('succeeded');

    // One attempt, one run: the claim did not divert the execution into a second row.
    expect(
      await client.executionAttempt.count({
        where: { orgId: fixture.orgId, taskId: reservation.taskId },
      }),
    ).toBe(1);

    expect(
      await client.auditEvent.count({
        where: {
          orgId: fixture.orgId,
          aggregateId: reservation.attemptId,
          eventType: 'execution.claim_granted.v1',
        },
      }),
    ).toBe(1);
  }, 120_000);

  it('refuses the workflow, executes nothing, and leaves the claim with its owner', async () => {
    const fixture = await tenant('claim-direct-start');

    // HIGH risk with a live, consumed grant bound to the attempt: every Phase 5
    // condition passes. The only thing that can refuse this run is the claim.
    const reservation = await reservedTask(fixture, 'direct-start', { riskClass: 'HIGH' });
    const owner = `execution-api-${randomUUID()}`;

    await expect(claimAs(reservation, owner)).resolves.toMatchObject({ outcome: 'granted' });

    const claimedBefore = await attemptRow(reservation.attemptId);

    const taskQueue = `intelligenz-claim-${randomUUID().slice(0, 8)}`;
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
      // No API, no `POST /run`: a workflow started by anything that can reach Temporal,
      // carrying the genuine attempt id and nothing else.
      const handle = await temporal.workflow.start('runTaskWorkflow', {
        taskQueue,
        workflowId: `task-${reservation.taskId}`,
        args: [
          {
            taskId: reservation.taskId,
            orgId: fixture.orgId,
            correlationId: randomUUID(),
            attemptId: reservation.attemptId,
          },
        ],
      });

      result = (await worker.runUntil(handle.result())) as RunTaskWorkflowResult;
    } finally {
      await connection.close().catch(() => undefined);
      await nativeConnection.close().catch(() => undefined);
    }

    expect(result.status).toBe('failed');

    // Nothing ran — not "nothing succeeded".
    await assertNoExecutionSideEffects(reservation);

    // The claim is still the owner's, and the attempt is still reserved rather than
    // adopted: a refused execution does not spend the reservation it could not claim.
    const claimedAfter = await attemptRow(reservation.attemptId);

    expect(claimedAfter.claimedByWorkflowRunId).toBe(owner);
    expect(claimedAfter.claimedAt?.getTime()).toBe(claimedBefore.claimedAt?.getTime());
    expect(claimedAfter.status).toBe('queued');

    // The refusal is on the record with its specific code.
    //
    // Since AG-604 it is recorded on the **attempt**, not on the task: this execution holds
    // no claim, and the attempt it named belongs to another execution, so neither the
    // terminal write nor `task.failed.v1` is its to write. `claimExecution` writes the
    // durable row before it throws — that is the record, and it names the holder.
    const duplicates = await client.auditEvent.findMany({
      where: {
        orgId: fixture.orgId,
        aggregateId: reservation.attemptId,
        eventType: 'execution.claim_duplicate.v1',
      },
      select: { payload: true },
    });

    expect(duplicates.length).toBeGreaterThan(0);
    expect(duplicates[0]?.payload).toMatchObject({
      code: 'EXECUTION_ALREADY_CLAIMED',
      claimedByWorkflowRunId: owner,
    });

    // And it did not write to the task aggregate: a duplicate execution does not get to
    // declare the task failed underneath the execution that owns it.
    expect(
      await client.auditEvent.count({
        where: {
          orgId: fixture.orgId,
          aggregateId: reservation.taskId,
          eventType: 'task.failed.v1',
        },
      }),
    ).toBe(0);
  }, 120_000);
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
