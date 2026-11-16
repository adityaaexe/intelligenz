import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PrismaClient } from '@intelligenz/database';
import type { WorkflowHandle } from '@temporalio/client';
import type { Workflow } from '@temporalio/workflow';

import type { RunProgrammeWorkflowResult } from '../src/shared/programme';
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
 * The programme layer, proved against durable rows — Phase 8.6.
 *
 * ## What this file is for
 *
 * Before this unit, `POST /run` started one task workflow and the system stopped. Nothing
 * dispatched task B when task A finished, no dependency edge existed, and no row said
 * "these tasks are one objective". The claim "autonomous operation is not yet proven" was
 * a description of the code, not a reporting gap.
 *
 * So the decisive test is not "the workflow returned". It is: **one submission, no further
 * calls, and the database says the chain ran**. Every assertion below reads rows:
 *
 *   - `Programme.status = 'succeeded'`;
 *   - three `ProgrammeCheckpoint` rows in dependency order;
 *   - three `Task.status = 'succeeded'`, each with its own `ExecutionAttempt`, claim and
 *     `AgentRun`;
 *   - an artifact/evidence chain per task;
 *   - the checkpoint's `evidence` names the attempt and the exact child execution that
 *     claimed it.
 *
 * The second test is the failure rule the architecture map states: one task failing
 * permanently must not stop independent branches. A succeeds, B fails, C (depends on B)
 * blocks, D (independent) still runs to success.
 *
 * ## Why the graph is inserted directly
 *
 * `POST /programmes` is covered by `apps/api/test/programmes.e2e-spec.ts`. Here the subject
 * is the scheduler, so the rows are written exactly as that endpoint writes them and the
 * parent workflow is started exactly as the API starts it (`programme-<id>`, same input).
 * Submitting through HTTP from a worker suite would add an API process to the test without
 * adding a fact about continuation.
 */

const databaseUrl = testDatabaseUrl();
const temporalEnabled = databaseUrl !== undefined && (await temporalReachable());
const enabled = temporalEnabled;

const PROGRAMME_WORKFLOWS = fileURLToPath(new URL('../src/workflows/index.ts', import.meta.url));

const tenants: TenantFixture[] = [];

let client: PrismaClient;
let harness: ExecutionHarness | undefined;

beforeAll(async () => {
  if (!databaseUrl) return;

  const database = useTestDatabase();
  client = database.client;

  process.env['DATABASE_URL'] = database.url;
  process.env['ARTIFACT_ROOT'] = `/tmp/intelligenz-programme-test-${randomUUID().slice(0, 8)}`;
  process.env['AGENT_RUNTIME'] = 'local-simulated';
  process.env['AGENT_STEP_DELAY_MS'] = '0';
  delete process.env['WORKER_FAULT_INJECT'];
  delete process.env['WORKER_RESOURCE_PROFILE'];
  delete process.env['LOCAL_SIMULATED_OUTCOME'];

  // A previous run killed before `afterAll` leaves the same rows an abandoned run does.
  // Age-guarded, so a concurrent run's fresh fixtures are left alone.
  await dropResidualTenants(client, 'programme-');

  if (temporalEnabled) {
    harness = await createExecutionHarness({ workflowsPath: PROGRAMME_WORKFLOWS });
  }
}, 90_000);

afterAll(async () => {
  if (!databaseUrl) return;

  // The harness first: its worker holds nothing in the database, but a child still polling
  // would write after the tenants are gone and turn cleanup into a failure.
  await harness?.close();
  await dropAllTenants(client, tenants);
  await client.$disconnect();
});

if (!enabled) {
  console.warn(
    `[programme-execution] suite skipped — ${
      databaseUrl === undefined ? 'TEST_DATABASE_URL is not set' : 'Temporal is not reachable'
    }`,
  );
}

async function tenant(label: string): Promise<TenantFixture> {
  const created = await createTenant(client, label);
  tenants.push(created);
  return created;
}

/**
 * A task in the shape a programme can schedule: `ready`, LOW risk (no approval needed) and
 * **with acceptance criteria**, because the graph validator refuses a task that has none.
 *
 * No `WorkflowRun` row is pre-created. The reservation mints it, which is the production
 * shape for a programme-dispatched task and the thing the child adopts.
 */
async function createReadyTask(
  fixture: TenantFixture,
  title: string,
  goal: string,
): Promise<string> {
  const task = await client.task.create({
    data: {
      orgId: fixture.orgId,
      projectId: fixture.projectId,
      workspaceId: fixture.workspaceId,
      title: `${title} ${randomUUID().slice(0, 8)}`,
      goal,
      status: 'ready',
      riskClass: 'LOW',
      acceptanceCriteria: ['The reported test passes and the change is described.'],
      createdById: fixture.userId,
      idempotencyKey: `programme-${randomUUID()}`,
    },
    select: { id: true },
  });

  return task.id;
}

/**
 * One submission: the programme row, its graph, and the parent workflow — the same rows and
 * the same start `POST /programmes` produces.
 *
 * Everything the tests assert afterwards happens without another call from here. The only
 * await is the workflow's own result, which is itself a read of what Temporal recorded.
 */
async function submitProgramme(options: {
  readonly fixture: TenantFixture;
  readonly objective: string;
  readonly nodes: readonly { readonly taskId: string; readonly dependsOn: readonly string[] }[];
}): Promise<{ readonly programmeId: string; readonly handle: WorkflowHandle<Workflow> }> {
  const { fixture, objective, nodes } = options;

  const programme = await client.programme.create({
    data: {
      orgId: fixture.orgId,
      projectId: fixture.projectId,
      objective,
      idempotencyKey: `programme-${randomUUID()}`,
    },
    select: { id: true },
  });

  await client.programmeTask.createMany({
    data: nodes.map((node) => ({
      orgId: fixture.orgId,
      programmeId: programme.id,
      taskId: node.taskId,
      dependsOn: [...node.dependsOn],
    })),
  });

  if (harness === undefined) {
    throw new Error('the execution harness was not created; Temporal is not reachable.');
  }

  const handle = await harness.start('runProgrammeWorkflow', {
    // The id the programme activities demand. A different id is refused by every one of
    // them (`PROGRAMME_AUTHORITY_REFUSED`), which is what stops a task execution from
    // minting reservations.
    workflowId: `programme-${programme.id}`,
    args: [
      {
        programmeId: programme.id,
        orgId: fixture.orgId,
        deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    ],
    workflowRunTimeout: '10m',
  });

  return { programmeId: programme.id, handle };
}

describe.skipIf(!enabled)('THREE-TASK-E2E — one submission, then only the database speaks', () => {
  it('runs A → B → C to success with a checkpoint, a claim and evidence per task', async () => {
    const fixture = await tenant('programme-chain');
    const goal = 'Fix the failing test in src/sum.js and prove it passes. [simulate:ok]';

    const a = await createReadyTask(fixture, 'Programme A — prepare the change', goal);
    const b = await createReadyTask(fixture, 'Programme B — apply the change', goal);
    const c = await createReadyTask(fixture, 'Programme C — verify the change', goal);

    const submittedAt = new Date();

    const { programmeId, handle } = await submitProgramme({
      fixture,
      objective: 'Repair the sum implementation and prove it with three dependent tasks.',
      // The chain the unit exists for: C depends on B, B depends on A.
      nodes: [
        { taskId: a, dependsOn: [] },
        { taskId: b, dependsOn: [a] },
        { taskId: c, dependsOn: [b] },
      ],
    });

    // ── The submission is the last thing the test does ────────────────────────
    // From here on: reads only. No POST /run, no signal, no second workflow start.
    const result = (await handle.result()) as RunProgrammeWorkflowResult;

    expect(result.status).toBe('succeeded');
    expect(result.succeeded).toBe(3);
    expect(result.checkpoints).toBe(3);

    // ── 1. The programme row ──────────────────────────────────────────────────
    const programme = await client.programme.findUniqueOrThrow({
      where: { id: programmeId },
      select: {
        status: true,
        objective: true,
        startedAt: true,
        finishedAt: true,
        failureReason: true,
      },
    });

    expect(programme.status).toBe('succeeded');
    expect(programme.failureReason).toBeNull();
    expect(programme.startedAt).not.toBeNull();
    expect(programme.startedAt!.getTime()).toBeGreaterThanOrEqual(submittedAt.getTime() - 1_000);
    expect(programme.finishedAt).not.toBeNull();

    // ── 2. Three checkpoints, in dependency order ─────────────────────────────
    const checkpoints = await client.programmeCheckpoint.findMany({
      where: { programmeId },
      orderBy: { sequence: 'asc' },
      select: { sequence: true, taskId: true, outcome: true, evidence: true },
    });

    expect(checkpoints.map((row) => [row.sequence, row.taskId, row.outcome])).toEqual([
      [1, a, 'succeeded'],
      [2, b, 'succeeded'],
      [3, c, 'succeeded'],
    ]);

    // ── 3. Three tasks succeeded, each with its own attempt and claim ─────────
    const nodes = await client.programmeTask.findMany({
      where: { programmeId },
      orderBy: { taskId: 'asc' },
      select: { taskId: true, status: true, attemptCount: true },
    });

    expect(nodes).toHaveLength(3);
    expect(nodes.every((node) => node.status === 'succeeded')).toBe(true);
    expect(nodes.every((node) => node.attemptCount === 1)).toBe(true);

    const claimedExecutions: string[] = [];

    for (const [index, taskId] of [a, b, c].entries()) {
      const task = await client.task.findUniqueOrThrow({
        where: { id: taskId },
        select: { status: true },
      });

      expect(task.status, `task ${String(index + 1)} status`).toBe('succeeded');

      // Exactly one attempt: the programme reserved once, the child claimed it once.
      const attempts = await client.executionAttempt.findMany({
        where: { orgId: fixture.orgId, taskId },
        select: {
          id: true,
          status: true,
          claimedByWorkflowRunId: true,
          claimedByWorkflowId: true,
          claimedAt: true,
          agentRunId: true,
        },
      });

      expect(attempts, `task ${String(index + 1)} attempts`).toHaveLength(1);
      const attempt = attempts[0]!;

      expect(attempt.status).toBe('succeeded');
      expect(attempt.claimedByWorkflowRunId, 'the claim names the child execution').not.toBeNull();
      expect(attempt.claimedByWorkflowId).not.toBeNull();
      expect(attempt.claimedAt).not.toBeNull();
      expect(attempt.agentRunId, 'an AgentRun exists for the attempt').not.toBeNull();

      claimedExecutions.push(attempt.claimedByWorkflowRunId!);

      // The checkpoint names the attempt and the execution that claimed it — the link that
      // makes it evidence instead of an assertion.
      const checkpoint = checkpoints[index]!;

      expect(checkpoint.evidence).toMatchObject({
        attemptId: attempt.id,
        childRunId: attempt.claimedByWorkflowRunId,
      });

      // ── 4. An artifact and evidence chain per task ─────────────────────────
      expect(
        await client.artifact.count({ where: { orgId: fixture.orgId, taskId } }),
        `task ${String(index + 1)} artifacts`,
      ).toBeGreaterThan(0);

      expect(
        await client.evidence.count({ where: { orgId: fixture.orgId, taskId } }),
        `task ${String(index + 1)} evidence`,
      ).toBeGreaterThan(0);

      const agentRun = await client.agentRun.findUniqueOrThrow({
        where: { id: attempt.agentRunId! },
        select: { status: true, simulated: true, attemptNumber: true },
      });

      expect(agentRun.status).toBe('succeeded');
      expect(agentRun.simulated).toBe(true);
      expect(agentRun.attemptNumber).toBe(1);
    }

    // Three tasks, three executions: no execution ran more than one task, and no task was
    // executed twice under the same claim.
    expect(new Set(claimedExecutions).size).toBe(3);

    // ── The audit trail says the scheduler queued each task ──────────────────
    expect(
      await client.auditEvent.count({
        where: {
          orgId: fixture.orgId,
          eventType: 'task.status_changed.v1',
          payload: { path: ['cause'], equals: 'programme_dispatch' },
        },
      }),
    ).toBe(3);

    expect(
      await client.auditEvent.count({
        where: {
          orgId: fixture.orgId,
          aggregateId: programmeId,
          eventType: 'programme.finished.v1',
        },
      }),
    ).toBe(1);
  }, 300_000);

  it('runs a diamond: two independent branches, one join after both', async () => {
    // A four-node diamond, so more than one node is ready at once. The order among
    // independent nodes is task-id order (documented in `loadProgrammeActivity`), thus
    // stable — the assertions here are about counts and outcomes, not about that order.
    const fixture = await tenant('programme-diamond');
    const goal = 'Diamond work. [simulate:ok]';

    const root = await createReadyTask(fixture, 'Diamond root', goal);
    const left = await createReadyTask(fixture, 'Diamond left', goal);
    const right = await createReadyTask(fixture, 'Diamond right', goal);
    const join = await createReadyTask(fixture, 'Diamond join', goal);

    const { programmeId, handle } = await submitProgramme({
      fixture,
      objective: 'A diamond: two independent branches, one join.',
      nodes: [
        { taskId: root, dependsOn: [] },
        { taskId: left, dependsOn: [root] },
        { taskId: right, dependsOn: [root] },
        { taskId: join, dependsOn: [left, right] },
      ],
    });

    const result = (await handle.result()) as RunProgrammeWorkflowResult;
    expect(result.status).toBe('succeeded');

    expect(await client.programmeCheckpoint.count({ where: { programmeId } })).toBe(4);

    // The join cannot start before both branches: its checkpoint follows theirs.
    const ordered = await client.programmeCheckpoint.findMany({
      where: { programmeId },
      orderBy: { sequence: 'asc' },
      select: { taskId: true, outcome: true },
    });

    const position = (taskId: string): number => ordered.findIndex((row) => row.taskId === taskId);

    expect(position(join)).toBe(3);
    expect(position(join)).toBeGreaterThan(position(left));
    expect(position(join)).toBeGreaterThan(position(right));
    expect(ordered[3]?.outcome).toBe('succeeded');
    expect(ordered.every((row) => row.outcome === 'succeeded')).toBe(true);
  }, 300_000);
});

describe.skipIf(!enabled)('one failure does not stop independent branches', () => {
  it('fails B, blocks C, and still runs D to success', async () => {
    const fixture = await tenant('programme-isolation');
    const okGoal = 'Independent work. [simulate:ok]';
    const failGoal = 'This one fails on purpose. [simulate:fail]';

    const a = await createReadyTask(fixture, 'Isolation A — succeeds', okGoal);
    const b = await createReadyTask(fixture, 'Isolation B — fails permanently', failGoal);
    const c = await createReadyTask(fixture, 'Isolation C — depends on B', okGoal);
    const d = await createReadyTask(fixture, 'Isolation D — independent', okGoal);

    const { programmeId, handle } = await submitProgramme({
      fixture,
      objective: 'Prove that a failed branch blocks only its dependents.',
      nodes: [
        { taskId: a, dependsOn: [] },
        { taskId: b, dependsOn: [a] },
        { taskId: c, dependsOn: [b] },
        { taskId: d, dependsOn: [] },
      ],
    });

    const result = (await handle.result()) as RunProgrammeWorkflowResult;
    expect(result.status).toBe('failed');

    const programme = await client.programme.findUniqueOrThrow({
      where: { id: programmeId },
      select: { status: true, failureReason: true },
    });

    expect(programme.status).toBe('failed');
    expect(programme.failureReason).toContain('independent branches ran');

    const nodes = await client.programmeTask.findMany({
      where: { programmeId },
      select: { taskId: true, status: true, attemptCount: true },
    });

    const statusOf = (taskId: string): string | undefined =>
      nodes.find((node) => node.taskId === taskId)?.status;

    expect(statusOf(a)).toBe('succeeded');
    expect(statusOf(b)).toBe('failed');
    expect(statusOf(c)).toBe('blocked');
    // The rule: an independent branch keeps running after a sibling failed.
    expect(statusOf(d)).toBe('succeeded');

    // C never ran: blocking happened at the scheduler, not by an execution that failed.
    expect(nodes.find((node) => node.taskId === c)?.attemptCount).toBe(0);
    expect(
      await client.executionAttempt.count({
        where: { orgId: fixture.orgId, taskId: c },
      }),
    ).toBe(0);
    expect(
      (await client.task.findUniqueOrThrow({ where: { id: c }, select: { status: true } })).status,
    ).toBe('ready');

    // B ran and failed, and it did so with its own attempt and claim.
    const bAttempt = await client.executionAttempt.findFirstOrThrow({
      where: { orgId: fixture.orgId, taskId: b },
      select: { id: true, status: true, claimedByWorkflowRunId: true },
    });

    expect(bAttempt.status).toBe('failed');
    expect(bAttempt.claimedByWorkflowRunId).not.toBeNull();

    // D's success is real: its task, attempt and claim are all there.
    const dAttempt = await client.executionAttempt.findFirstOrThrow({
      where: { orgId: fixture.orgId, taskId: d },
      select: { status: true, claimedByWorkflowRunId: true, agentRunId: true },
    });

    expect(dAttempt.status).toBe('succeeded');
    expect(dAttempt.claimedByWorkflowRunId).not.toBeNull();
    expect(dAttempt.agentRunId).not.toBeNull();
    expect(
      (await client.task.findUniqueOrThrow({ where: { id: d }, select: { status: true } })).status,
    ).toBe('succeeded');

    // The checkpoints explain the block, with the dependency that caused it.
    const checkpoints = await client.programmeCheckpoint.findMany({
      where: { programmeId },
      orderBy: { sequence: 'asc' },
      select: { taskId: true, outcome: true, evidence: true },
    });

    const cCheckpoint = checkpoints.find((row) => row.taskId === c);
    expect(cCheckpoint?.outcome).toBe('blocked');
    expect(JSON.stringify(cCheckpoint?.evidence)).toContain(b);

    // B's checkpoint carries the child's own verdict, not just "failed".
    const bCheckpoint = checkpoints.find((row) => row.taskId === b);
    expect(bCheckpoint?.outcome).toBe('failed');
    expect(bCheckpoint?.evidence).toMatchObject({
      attemptId: bAttempt.id,
      childRunId: bAttempt.claimedByWorkflowRunId,
    });

    // And the order is the dependency order: C is recorded only after B failed.
    const sequenceOf = (taskId: string): number =>
      checkpoints.findIndex((row) => row.taskId === taskId);
    expect(sequenceOf(c)).toBeGreaterThan(sequenceOf(b));
  }, 300_000);
});
