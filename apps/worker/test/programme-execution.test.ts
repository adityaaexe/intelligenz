import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PrismaClient } from '@intelligenz/database';
import type { WorkflowHandle } from '@temporalio/client';
import type { Workflow } from '@temporalio/workflow';

import { resetWorkerConfig } from '../src/config';
import { resetAgentRuntime } from '../src/runtime';
import type { RunProgrammeWorkflowResult } from '../src/shared/programme';
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

const PROGRAMME_WORKFLOWS = fileURLToPath(
  new URL('./fixtures/programme-bundle.workflow.ts', import.meta.url),
);

/**
 * The probe's update and signal names, as strings.
 *
 * Deliberately not imported from the fixture: that module imports `@temporalio/workflow`,
 * and dragging the workflow SDK into the test process is the thing the harness exists to
 * avoid. The strings are the contract — a typo fails the first update instead of quietly
 * passing, exactly like `runSteps`/`finish` in `execution-harness.ts`.
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
  const { fixture } = options;
  const programmeId = await createProgrammeRow(options);

  if (harness === undefined) {
    throw new Error('the execution harness was not created; Temporal is not reachable.');
  }

  const handle = await harness.start('runProgrammeWorkflow', {
    // The id the programme activities demand. A different id is refused by every one of
    // them (`PROGRAMME_AUTHORITY_REFUSED`), which is what stops a task execution from
    // minting reservations.
    workflowId: `programme-${programmeId}`,
    args: [
      {
        programmeId,
        orgId: fixture.orgId,
        deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    ],
  });

  return { programmeId, handle };
}

/**
 * The programme row and its graph, exactly as `POST /programmes` writes them — without
 * starting the parent.
 *
 * The reservation and checkpoint suites call the activities themselves (through
 * `programmeProbe`), so they need the rows a submission would have produced and no
 * scheduler competing with them for the same nodes.
 */
async function createProgrammeRow(options: {
  readonly fixture: TenantFixture;
  readonly objective: string;
  readonly nodes: readonly { readonly taskId: string; readonly dependsOn: readonly string[] }[];
}): Promise<string> {
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

  return programme.id;
}

/**
 * Runs programme-activity steps inside a real execution started under `workflowId`.
 *
 * `programme-<id>` is the only id `requireProgrammeAuthority` accepts, so this is the only
 * way to ask the activities anything. The execution is finished before returning: a probe
 * left running would occupy the worker's queue for the rest of the file.
 */
async function callProgrammeProbe(
  workflowId: string,
  steps: readonly ProgrammeProbeStep[],
): Promise<readonly unknown[]> {
  if (harness === undefined) {
    throw new Error('the execution harness was not created; Temporal is not reachable.');
  }

  const handle = await harness.start('programmeProbe', {
    workflowId,
    args: [],
    workflowRunTimeout: '10m',
  });

  try {
    return await handle.executeUpdate<readonly unknown[], [readonly ProgrammeProbeStep[]]>(
      PROGRAMME_PROBE_UPDATE,
      { args: [steps] },
    );
  } finally {
    await handle.signal(PROGRAMME_PROBE_FINISH).catch(() => undefined);
    await handle.result().catch(() => undefined);
  }
}

/** Polls until `condition` holds, or throws with the deadline it exceeded. */
async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${description}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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

// ─── AUTH-02/03: the child's workflow id ─────────────────────────────────────

/**
 * A child started without an explicit `workflowId` gets a random uuid4 from the SDK
 * (`addDefaultWorkflowOptions` does `workflowId ?? uuid4()`), and three things then break at
 * once, all of them quiet:
 *
 *   - `POST /cancel` cancels `task-<taskId>`, which names nobody. The cancellation cannot
 *     reach the child, and a task the caller cancelled keeps working — long enough to write
 *     `task.succeeded.v1` as the last word about it;
 *   - `requireCompletionAuthority`'s pre-dispatch arm expects `task-<taskId>`, so a child
 *     cancelled before it claimed cannot record the refusal at all;
 *   - the checkpoint's `childWorkflowId` is a uuid nobody can connect to a task.
 *
 * These two tests are the id space and the cancellation it enables.
 */
describe.skipIf(!enabled)('AUTH-02/03 — a programme child runs under the task id space', () => {
  it('starts the child under task-<taskId>, so the checkpoint names an execution an operator can re-probe', async () => {
    if (harness === undefined) {
      throw new Error('the execution harness was not created; Temporal is not reachable.');
    }

    const execution = harness;
    const fixture = await tenant('programme-child-id');
    const taskId = await createReadyTask(fixture, 'Child id', 'Child id work. [simulate:ok]');

    const { programmeId, handle } = await submitProgramme({
      fixture,
      objective: 'Prove the child runs under the task id space.',
      nodes: [{ taskId, dependsOn: [] }],
    });

    const result = (await handle.result()) as RunProgrammeWorkflowResult;
    expect(result.status).toBe('succeeded');

    const checkpoint = await client.programmeCheckpoint.findFirstOrThrow({
      where: { programmeId },
      select: { taskId: true, outcome: true, evidence: true },
    });

    // The evidence names the exact execution, derived from the task — not a uuid4 that
    // cannot be reached from anything an operator has.
    expect(checkpoint.evidence).toMatchObject({ childWorkflowId: `task-${taskId}` });

    // And it is a real execution, in a terminal state, under that id.
    const child = await execution.describeWorkflow(`task-${taskId}`);

    expect(child).not.toBeNull();
    expect(child?.status).toBe('COMPLETED');
  }, 300_000);

  it('cancels a dispatched child by its task id, and the cancelled task is never recorded as succeeded', async () => {
    if (harness === undefined) {
      throw new Error('the execution harness was not created; Temporal is not reachable.');
    }

    const execution = harness;
    const fixture = await tenant('programme-cancel');
    const taskId = await createReadyTask(
      fixture,
      'Cancel a dispatched child',
      'Slow simulated work so the cancellation lands mid-run. [simulate:ok]',
    );

    /**
     * The simulated runtime is the only clock this suite owns. 1500 ms per step keeps the
     * child alive for seconds after it has claimed, so "the task is running, cancel it" is a
     * fact rather than a race against a zero-delay run. The cancellation may land in
     * `recordStartActivity` or in `executeAgentActivity`; either way the execution was alive
     * and the id is the only thing that reached it. Restored below so every other test in the
     * file keeps the zero-delay run.
     */
    const previousDelay = process.env['AGENT_STEP_DELAY_MS'];
    process.env['AGENT_STEP_DELAY_MS'] = '1500';
    resetWorkerConfig();
    resetAgentRuntime();

    try {
      const { programmeId, handle } = await submitProgramme({
        fixture,
        objective: 'Cancel a child that is already running.',
        nodes: [{ taskId, dependsOn: [] }],
      });

      await waitFor(
        async () => {
          const row = await client.task.findUniqueOrThrow({
            where: { id: taskId },
            select: { status: true },
          });

          return row.status === 'running';
        },
        60_000,
        `task ${taskId} to be claimed and running`,
      );

      // The exact RPC and the exact id `POST /cancel` uses. Before the fix the child was
      // under a uuid4 and this answered `not_found`.
      expect(await execution.cancelWorkflow(`task-${taskId}`)).toBe('cancelled');

      const result = (await handle.result()) as RunProgrammeWorkflowResult;
      expect(result.status).toBe('failed');

      // The task ends cancelled, not succeeded.
      const task = await client.task.findUniqueOrThrow({
        where: { id: taskId },
        select: { status: true },
      });
      expect(task.status).toBe('cancelled');

      // The decisive assertion: no success was ever emitted for a task the caller cancelled.
      // Under the pre-fix id — a random uuid4 — this cancellation reached nobody, the child
      // finished, and its `task.succeeded.v1` was the last word about the task.
      expect(
        await client.auditEvent.count({
          where: { orgId: fixture.orgId, aggregateId: taskId, eventType: 'task.succeeded.v1' },
        }),
      ).toBe(0);

      expect(
        await client.auditEvent.count({
          where: { orgId: fixture.orgId, aggregateId: taskId, eventType: 'task.cancelled.v1' },
        }),
      ).toBe(1);

      // The child execution reached a terminal state under the id every operator has.
      const child = await execution.describeWorkflow(`task-${taskId}`);
      expect(child?.status).toBe('CANCELLED');

      const checkpoint = await client.programmeCheckpoint.findFirstOrThrow({
        where: { programmeId, taskId },
        select: { outcome: true, evidence: true },
      });

      expect(checkpoint.outcome).toBe('cancelled');
      expect(checkpoint.evidence).toMatchObject({ childWorkflowId: `task-${taskId}` });

      expect(
        (
          await client.programmeTask.findFirstOrThrow({
            where: { programmeId, taskId },
            select: { status: true },
          })
        ).status,
      ).toBe('cancelled');
    } finally {
      if (previousDelay === undefined) delete process.env['AGENT_STEP_DELAY_MS'];
      else process.env['AGENT_STEP_DELAY_MS'] = previousDelay;

      resetWorkerConfig();
      resetAgentRuntime();
    }
  }, 300_000);
});

// ─── AUTH-01/04/06: what the reservation answers, and in which order ─────────

/**
 * The reservation is the scheduler's only write, so its answers are the scheduler's whole
 * view of the world. These tests pin the four things that were wrong:
 *
 *   - a retry that finds its own committed rows must report `reserved`, not `not_runnable`
 *     (which wedged the task: `queued` with an unclaimed attempt and no sweep to reclaim it);
 *   - a terminal programme must refuse the reservation;
 *   - a task held by another execution is a **scheduling** observation (`blocked`), not a
 *     task failure (`failed`);
 *   - a task that really failed is recorded as failed.
 */
describe.skipIf(!enabled)(
  'AUTH-01/04/06 — the reservation answers truthfully, in that order',
  () => {
    it('answers a second identical reservation with the same attempt instead of not_runnable', async () => {
      const fixture = await tenant('programme-idempotent');
      const taskId = await createReadyTask(fixture, 'Idempotent reservation', 'Reserve me twice.');

      const programmeId = await createProgrammeRow({
        fixture,
        objective: 'A retried reservation must find its own rows.',
        nodes: [{ taskId, dependsOn: [] }],
      });

      // One input object, sent twice: the correlation id is part of the reservation, so an
      // identical call is what a Temporal retry of a lost response produces.
      const input = {
        programmeId,
        orgId: fixture.orgId,
        taskId,
        attemptNumber: 1,
        correlationId: randomUUID(),
      };

      const [first, second] = (await callProgrammeProbe(`programme-${programmeId}`, [
        { op: 'reserve', input },
        { op: 'reserve', input },
      ])) as [
        { outcome: string; attemptId: string; workflowRunId: string },
        { outcome: string; attemptId: string; workflowRunId: string },
      ];

      expect(first.outcome).toBe('reserved');

      // The retry sees `Task.status = 'queued'` — because this reservation moved it there —
      // and must still answer `reserved`. Answering `not_runnable` here is what left the task
      // queued forever with an attempt no sweep reclaims.
      expect(second.outcome).toBe('reserved');
      expect(second.attemptId).toBe(first.attemptId);
      expect(second.workflowRunId).toBe(first.workflowRunId);

      const task = await client.task.findUniqueOrThrow({
        where: { id: taskId },
        select: { status: true },
      });
      expect(task.status).toBe('queued');

      // Exactly one reservation: not zero (the retry re-created nothing) and not two.
      expect(await client.executionAttempt.count({ where: { orgId: fixture.orgId, taskId } })).toBe(
        1,
      );
      expect(await client.workflowRun.count({ where: { orgId: fixture.orgId, taskId } })).toBe(1);
    }, 120_000);

    it('refuses a reservation for a programme that is already terminal, writing no rows', async () => {
      const fixture = await tenant('programme-terminal');
      const taskId = await createReadyTask(fixture, 'Terminal programme', 'Nothing here may run.');

      const programmeId = await createProgrammeRow({
        fixture,
        objective: 'A cancelled programme reserves nothing.',
        nodes: [{ taskId, dependsOn: [] }],
      });

      await client.programme.update({
        where: { id: programmeId },
        data: { status: 'cancelled', finishedAt: new Date() },
      });

      const [reservation] = (await callProgrammeProbe(`programme-${programmeId}`, [
        {
          op: 'reserve',
          input: {
            programmeId,
            orgId: fixture.orgId,
            taskId,
            attemptNumber: 1,
            correlationId: randomUUID(),
          },
        },
      ])) as [{ outcome: string; programmeStatus: string }];

      expect(reservation.outcome).toBe('programme_terminal');
      expect(reservation.programmeStatus).toBe('cancelled');

      // No reservation, no status change: the row is the authority, and it says stop.
      expect(await client.workflowRun.count({ where: { orgId: fixture.orgId, taskId } })).toBe(0);
      expect(await client.executionAttempt.count({ where: { orgId: fixture.orgId, taskId } })).toBe(
        0,
      );
      expect(
        (
          await client.task.findUniqueOrThrow({
            where: { id: taskId },
            select: { status: true },
          })
        ).status,
      ).toBe('ready');
    }, 120_000);

    it('records a node whose task is already running elsewhere as blocked, not failed', async () => {
      const fixture = await tenant('programme-held');
      const taskId = await createReadyTask(fixture, 'Held elsewhere', 'Already held by a run.');

      // The other execution: submitted through POST /run in production. The row is what makes
      // "held" a fact rather than a status someone typed.
      await client.task.update({ where: { id: taskId }, data: { status: 'running' } });
      await client.workflowRun.create({
        data: {
          orgId: fixture.orgId,
          taskId,
          workflowId: `task-${taskId}`,
          temporalRunId: `held-${randomUUID()}`,
          status: 'running',
          startedAt: new Date(),
        },
      });

      const { programmeId, handle } = await submitProgramme({
        fixture,
        objective: 'A task somebody else is running is not a failure.',
        nodes: [{ taskId, dependsOn: [] }],
      });

      const result = (await handle.result()) as RunProgrammeWorkflowResult;

      // `blocked`, not `failed`: the work may be running to success under the other execution,
      // and a programme that reported `failed` while every task succeeded is the lie this
      // distinction exists to prevent.
      expect(result.status).toBe('blocked');
      expect(result.failed).toBe(0);

      const checkpoint = await client.programmeCheckpoint.findFirstOrThrow({
        where: { programmeId, taskId },
        select: { outcome: true, evidence: true },
      });

      expect(checkpoint.outcome).toBe('held_elsewhere');

      const node = await client.programmeTask.findFirstOrThrow({
        where: { programmeId, taskId },
        select: { status: true, attemptCount: true },
      });

      expect(node.status).toBe('blocked');
      expect(node.attemptCount).toBe(0);

      // Nothing was reserved against it, and the task's own status is untouched.
      expect(await client.executionAttempt.count({ where: { orgId: fixture.orgId, taskId } })).toBe(
        0,
      );
      expect(
        (
          await client.task.findUniqueOrThrow({
            where: { id: taskId },
            select: { status: true },
          })
        ).status,
      ).toBe('running');
    }, 300_000);

    it('records a node whose task already failed as failed', async () => {
      const fixture = await tenant('programme-precondition');
      const taskId = await createReadyTask(
        fixture,
        'Already failed',
        'It failed before we got here.',
      );

      await client.task.update({ where: { id: taskId }, data: { status: 'failed' } });

      const { programmeId, handle } = await submitProgramme({
        fixture,
        objective: 'A task that really failed is recorded as failed.',
        nodes: [{ taskId, dependsOn: [] }],
      });

      const result = (await handle.result()) as RunProgrammeWorkflowResult;
      expect(result.status).toBe('failed');

      const checkpoint = await client.programmeCheckpoint.findFirstOrThrow({
        where: { programmeId, taskId },
        select: { outcome: true },
      });

      expect(checkpoint.outcome).toBe('precondition_failed');

      expect(
        (
          await client.programmeTask.findFirstOrThrow({
            where: { programmeId, taskId },
            select: { status: true },
          })
        ).status,
      ).toBe('failed');
    }, 300_000);
  },
);

// ─── AUTH-07: the checkpoint row may not be relabelled ──────────────────────

describe.skipIf(!enabled)('AUTH-07 — a checkpoint belongs to the task it was written for', () => {
  it('refuses a checkpoint for a sequence already recorded for another task, leaving that row intact', async () => {
    const fixture = await tenant('programme-checkpoint-guard');
    const first = await createReadyTask(fixture, 'Checkpoint owner', 'Owns sequence 1.');
    const second = await createReadyTask(fixture, 'Checkpoint intruder', 'Asks for sequence 1.');

    const programmeId = await createProgrammeRow({
      fixture,
      objective: 'A sequence belongs to the node that recorded it.',
      nodes: [
        { taskId: first, dependsOn: [] },
        { taskId: second, dependsOn: [] },
      ],
    });

    const [recorded, refused] = (await callProgrammeProbe(`programme-${programmeId}`, [
      {
        op: 'checkpoint',
        input: {
          programmeId,
          orgId: fixture.orgId,
          sequence: 1,
          taskId: first,
          outcome: 'succeeded',
          evidence: { summary: 'the first task succeeded' },
        },
      },
      {
        op: 'checkpoint',
        input: {
          programmeId,
          orgId: fixture.orgId,
          sequence: 1,
          taskId: second,
          outcome: 'failed',
          evidence: { summary: 'the second task failed' },
        },
        // Captured as a value: the refusal is the assertion, and the first call's result
        // must survive it.
        captureFailure: true,
      },
    ])) as [{ sequence: number }, { failed: boolean; type: string; message: string }];

    expect(recorded).toEqual({ sequence: 1 });
    expect(refused.failed).toBe(true);
    expect(refused.type).toBe('PROGRAMME_CHECKPOINT_TASK_MISMATCH');
    // The message names both nodes, so the operator can see which one owns the sequence.
    expect(refused.message).toContain(first);
    expect(refused.message).toContain(second);

    // The owner's row is untouched — outcome *and* task id — and there is still exactly one.
    const row = await client.programmeCheckpoint.findFirstOrThrow({
      where: { programmeId, sequence: 1 },
      select: { taskId: true, outcome: true, evidence: true },
    });

    expect(row.taskId).toBe(first);
    expect(row.outcome).toBe('succeeded');
    expect(row.evidence).toMatchObject({ summary: 'the first task succeeded' });
    expect(await client.programmeCheckpoint.count({ where: { programmeId } })).toBe(1);
  }, 120_000);
});

// ─── AUTH-04: a child that never starts ─────────────────────────────────────

/**
 * `POST /run` compensates a reservation whose start failed
 * (`TaskService.compensateFailedStart`); the programme path had no equivalent. If
 * `startChild` rejects — the parent cancelled between the two calls, a server-side start
 * failure, or a workflow id already held — the task stayed `queued` with an unclaimed
 * `queued` attempt and a `queued` run, and nothing reclaims that state: `claim-release`
 * selects only **claimed** attempts and `POST /run` requires `ready`.
 */
describe.skipIf(!enabled)('AUTH-04 — a child that never starts is compensated', () => {
  it('fails the run and the attempt, restores the task to ready, and records dispatch_failed', async () => {
    if (harness === undefined) {
      throw new Error('the execution harness was not created; Temporal is not reachable.');
    }

    const execution = harness;
    const fixture = await tenant('programme-start-failed');
    const taskId = await createReadyTask(fixture, 'Start refused', 'This start will be refused.');

    // Hold the deterministic child id, so the start is refused deterministically: a live
    // execution on `task-<taskId>` is exactly what `ALLOW_DUPLICATE_FAILED_ONLY` refuses.
    const held = await execution.session({ workflowId: `task-${taskId}` });

    try {
      const { programmeId, handle } = await submitProgramme({
        fixture,
        objective: 'A start that fails must not wedge the task.',
        nodes: [{ taskId, dependsOn: [] }],
      });

      const result = (await handle.result()) as RunProgrammeWorkflowResult;
      expect(result.status).toBe('failed');

      // The attempt is failed for the reason it actually failed, not left queued.
      const attempt = await client.executionAttempt.findFirstOrThrow({
        where: { orgId: fixture.orgId, taskId },
        select: { status: true, terminationReason: true, error: true },
      });

      expect(attempt.status).toBe('failed');
      expect(attempt.terminationReason).toBe('start_failed');
      expect(JSON.stringify(attempt.error)).toContain('START_FAILED');

      const run = await client.workflowRun.findFirstOrThrow({
        where: { orgId: fixture.orgId, taskId },
        orderBy: { createdAt: 'desc' },
        select: { status: true, error: true },
      });

      expect(run.status).toBe('failed');
      expect(JSON.stringify(run.error)).toContain('START_FAILED');

      // The task is back where the reservation found it, so the next attempt is possible.
      expect(
        (
          await client.task.findUniqueOrThrow({
            where: { id: taskId },
            select: { status: true },
          })
        ).status,
      ).toBe('ready');

      // The node records the failed dispatch — and nothing is recorded as succeeded.
      const checkpoints = await client.programmeCheckpoint.findMany({
        where: { programmeId },
        select: { outcome: true, evidence: true },
      });

      expect(checkpoints.map((row) => row.outcome)).toEqual(['dispatch_failed']);
      expect(JSON.stringify(checkpoints[0]?.evidence)).toContain('START_FAILED');

      expect(
        await client.auditEvent.count({
          where: { orgId: fixture.orgId, aggregateId: taskId, eventType: 'task.succeeded.v1' },
        }),
      ).toBe(0);
    } finally {
      await held.stop();
    }
  }, 300_000);
});
