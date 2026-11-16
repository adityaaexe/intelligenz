import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PrismaClient } from '@intelligenz/database';

import { resetWorkerConfig } from '../src/config';
import { resetAgentRuntime } from '../src/runtime';
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
 * Programme-level cancellation, proved against durable rows.
 *
 * ## What this file is for
 *
 * `POST /cancel` cancels a **task** (`task-<taskId>`). Until this unit nothing cancelled a
 * **programme**: `runProgrammeWorkflow` runs under `programme-<programmeId>` and its
 * cancellation handler could not be reached from any public route. A user could only stop a
 * running programme one task at a time, and stopping the tasks did not stop future
 * dispatch — the scheduler kept reading the graph and reserving the next node.
 *
 * So the subject is not "the cancel RPC returned". It is what the database says afterwards:
 *
 *   - `Programme.status = 'cancelled'`, `failureCode = 'CANCELLED'`, `finishedAt` set;
 *   - **no task and no execution attempt left `queued` or `running`** — an orphaned
 *     in-flight child is the failure this suite exists to catch;
 *   - work that already completed is **not rewritten**;
 *   - a second cancellation does not move `finishedAt`;
 *   - an approval grant is not spent by a cancellation.
 *
 * ## Why the cancellation is issued through the Temporal client
 *
 * That is the RPC `POST /programmes/:programmeId/cancel` issues
 * (`OrchestratorService.cancelProgrammeWorkflow` → `workflow.getHandle(id).cancel()`), on
 * the id that route derives. Driving the HTTP endpoint from here would boot a second API
 * process and prove nothing extra about the scheduler; the endpoint's own behaviour is
 * covered by `apps/api/test/programmes.e2e-spec.ts`.
 *
 * ## Why the graph is inserted directly
 *
 * Same reason as `programme-execution.test.ts`: the rows are written exactly as
 * `POST /programmes` writes them, then the parent is started exactly as the API starts it.
 * The endpoint's job ends at "a scheduler owns this graph"; the scheduler's job is here.
 */

const databaseUrl = testDatabaseUrl();
const temporalEnabled = databaseUrl !== undefined && (await temporalReachable());
const enabled = temporalEnabled;

const PROGRAMME_WORKFLOWS = fileURLToPath(
  new URL('./fixtures/programme-bundle.workflow.ts', import.meta.url),
);

const tenants: TenantFixture[] = [];

let client: PrismaClient;
let harness: ExecutionHarness | undefined;

/**
 * The simulated runtime is the only clock this suite owns.
 *
 * Cancellation has to land **while a child is working**, not between two children: a test
 * that cancels a programme whose only child already finished proves nothing about stopping
 * dispatch. 800 ms per step keeps a child alive for seconds after it claims, so the
 * "attempt is running" observation below is a fact rather than a race against a zero-delay
 * run. It is set once, before the harness builds its activities, and never changed: every
 * test in this file needs the same window.
 */
const AGENT_STEP_DELAY_MS = '800';

beforeAll(async () => {
  if (!databaseUrl) return;

  const database = useTestDatabase();
  client = database.client;

  process.env['DATABASE_URL'] = database.url;
  process.env['ARTIFACT_ROOT'] =
    `/tmp/intelligenz-programme-cancel-test-${randomUUID().slice(0, 8)}`;
  process.env['AGENT_RUNTIME'] = 'local-simulated';
  process.env['AGENT_STEP_DELAY_MS'] = AGENT_STEP_DELAY_MS;
  delete process.env['WORKER_FAULT_INJECT'];
  delete process.env['WORKER_RESOURCE_PROFILE'];
  delete process.env['LOCAL_SIMULATED_OUTCOME'];

  resetWorkerConfig();
  resetAgentRuntime();

  // A previous run killed before `afterAll` leaves the same rows an abandoned run does.
  // Age-guarded, so a concurrent run's fresh fixtures are left alone.
  await dropResidualTenants(client, 'programme-cancel-');

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
    `[programme-cancellation] suite skipped — ${
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
 * A task a programme can schedule: `ready`, and **with acceptance criteria**, because the
 * graph validator refuses a task that has none. `riskClass` is a parameter because a HIGH
 * node is the one the scheduler refuses to dispatch.
 */
async function createReadyTask(
  fixture: TenantFixture,
  title: string,
  goal: string,
  riskClass: 'LOW' | 'HIGH' = 'LOW',
): Promise<string> {
  const task = await client.task.create({
    data: {
      orgId: fixture.orgId,
      projectId: fixture.projectId,
      workspaceId: fixture.workspaceId,
      title: `${title} ${randomUUID().slice(0, 8)}`,
      goal,
      status: 'ready',
      riskClass,
      acceptanceCriteria: ['The reported test passes and the change is described.'],
      createdById: fixture.userId,
      idempotencyKey: `programme-${randomUUID()}`,
    },
    select: { id: true },
  });

  return task.id;
}

/**
 * The programme row, its graph and the parent workflow — exactly the rows and the start
 * `POST /programmes` produces.
 */
async function submitProgramme(options: {
  readonly fixture: TenantFixture;
  readonly objective: string;
  readonly nodes: readonly { readonly taskId: string; readonly dependsOn: readonly string[] }[];
}): Promise<{ readonly programmeId: string }> {
  const { fixture, nodes } = options;

  const programme = await client.programme.create({
    data: {
      orgId: fixture.orgId,
      projectId: fixture.projectId,
      objective: options.objective,
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

  await harness.start('runProgrammeWorkflow', {
    // The only id the programme activities accept. Anything else is refused with
    // `PROGRAMME_AUTHORITY_REFUSED`, which is what stops a task execution from scheduling.
    workflowId: `programme-${programme.id}`,
    args: [
      {
        programmeId: programme.id,
        orgId: fixture.orgId,
        deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    ],
  });

  return { programmeId: programme.id };
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

async function programmeRow(programmeId: string): Promise<{
  readonly status: string;
  readonly failureCode: string | null;
  readonly failureReason: string | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}> {
  return client.programme.findUniqueOrThrow({
    where: { id: programmeId },
    select: {
      status: true,
      failureCode: true,
      failureReason: true,
      startedAt: true,
      finishedAt: true,
    },
  });
}

/** Tasks and attempts of one tenant that are still in flight. The orphan count. */
async function inFlight(
  orgId: string,
): Promise<{ readonly tasks: number; readonly attempts: number; readonly ids: readonly string[] }> {
  const [tasks, attempts] = await Promise.all([
    client.task.findMany({
      where: { orgId, status: { in: ['queued', 'running'] } },
      select: { id: true, status: true },
    }),
    client.executionAttempt.findMany({
      where: { orgId, status: { in: ['queued', 'running'] } },
      select: { id: true, taskId: true, status: true },
    }),
  ]);

  return {
    tasks: tasks.length,
    attempts: attempts.length,
    ids: [
      ...tasks.map((row) => `task ${row.id} (${row.status})`),
      ...attempts.map((row) => `attempt ${row.id} of ${row.taskId} (${row.status})`),
    ],
  };
}

describe.skipIf(!enabled)('PROGRAMME-CANCEL — the parent is stopped, and the rows say so', () => {
  it('cancels a running programme, records CANCELLED, and leaves no in-flight child behind', async () => {
    if (harness === undefined) {
      throw new Error('the execution harness was not created; Temporal is not reachable.');
    }

    const execution = harness;
    const fixture = await tenant('programme-cancel-running');
    const goal = 'Repair the module and prove it with a chained programme. [simulate:ok]';

    // A chain, so the scheduler has something left to dispatch when the cancellation lands:
    // A → B → C → D. `maxConcurrent` defaults to 1, so at most one child is in flight.
    const a = await createReadyTask(fixture, 'Cancel chain A', goal);
    const b = await createReadyTask(fixture, 'Cancel chain B', goal);
    const c = await createReadyTask(fixture, 'Cancel chain C', goal);
    const d = await createReadyTask(fixture, 'Cancel chain D', goal);

    const { programmeId } = await submitProgramme({
      fixture,
      objective: 'A four-node chain cancelled while it is executing.',
      nodes: [
        { taskId: a, dependsOn: [] },
        { taskId: b, dependsOn: [a] },
        { taskId: c, dependsOn: [b] },
        { taskId: d, dependsOn: [c] },
      ],
    });

    /**
     * Three facts, each durable, together meaning "the scheduler is running, it has
     * recorded work, and a child is **executing** right now":
     *
     *   - `startedAt` is written by `loadProgrammeActivity`, the workflow's first activity;
     *   - a checkpoint is written after a child's result is observed;
     *   - `ExecutionAttempt.status = 'running'` is written by `executeAgentActivity` (via
     *     `adoptReservedAttempt`), not by the reservation. So it is the fact that the child
     *     has claimed its attempt and is inside the run the cancellation interrupts —
     *     rather than a cancellation landing between a reservation and a start, which is a
     *     different (and much narrower) case.
     */
    await waitFor(
      async () => {
        const programme = await programmeRow(programmeId);
        const checkpoints = await client.programmeCheckpoint.count({ where: { programmeId } });
        const executing = await client.executionAttempt.count({
          where: { orgId: fixture.orgId, status: 'running' },
        });

        return programme.startedAt !== null && checkpoints >= 1 && executing >= 1;
      },
      120_000,
      `programme ${programmeId} to start, checkpoint once, and have a child executing`,
    );

    // The exact RPC and the exact id `POST /programmes/:programmeId/cancel` issues.
    expect(await execution.cancelWorkflow(`programme-${programmeId}`)).toBe('cancelled');

    // Bounded wait for two properties that arrive at different moments: the workflow's
    // non-cancellable scope writes `cancelled`, and the interrupted child settles its own
    // attempt. Waiting for both together is what makes the orphan assertion meaningful —
    // waiting only for the row would sample the attempt mid-finalisation.
    await waitFor(
      async () => {
        const programme = await programmeRow(programmeId);
        if (programme.status !== 'cancelled') return false;

        const { tasks, attempts } = await inFlight(fixture.orgId);
        return tasks === 0 && attempts === 0;
      },
      30_000,
      `programme ${programmeId} to be cancelled with no queued or running task/attempt left`,
    );

    const programme = await programmeRow(programmeId);

    expect(programme.status).toBe('cancelled');
    expect(programme.failureCode).toBe('CANCELLED');
    expect(programme.failureReason).toContain('no further task was dispatched');
    expect(programme.finishedAt).not.toBeNull();

    // ── The invariants the test exists for ────────────────────────────────────
    // A child still `queued`/`running` after its scheduler is gone is work nobody will
    // finish and nobody can cancel again: `claim-release` only reclaims stranded *claims*,
    // and `POST /run` requires `ready`. The IDs are named so a failure says which row.
    const orphans = await inFlight(fixture.orgId);

    expect(orphans.tasks, `in-flight tasks: ${orphans.ids.join(', ')}`).toBe(0);
    expect(orphans.attempts, `in-flight attempts: ${orphans.ids.join(', ')}`).toBe(0);

    // Every task reached *a* verdict: nothing is still `pending` in the programme graph
    // except nodes the scheduler never reached, which stay `pending` and are not in flight.
    const nodes = await client.programmeTask.findMany({
      where: { programmeId },
      select: { taskId: true, status: true },
    });

    expect(nodes).toHaveLength(4);

    /**
     * One residue is real, and asserted as what it is rather than wished away.
     *
     * The scheduler records a node's outcome through `recordProgrammeCheckpointActivity`,
     * which runs *after* the child returns. A cancellation that interrupts the child
     * therefore closes the programme without a checkpoint for that node, and the node row
     * keeps `running` — the state that means "reserved and dispatched". At most **one**
     * node can be in it (`maxConcurrent` is 1), it owns no live task or attempt (asserted
     * above), and `reserveProgrammeTaskActivity` refuses a terminal programme, so nothing
     * can dispatch it again. Recorded as a known limitation in
     * `docs/engineering/phase8.8-operations/PROGRAMME-CANCELLATION-CONTRACT.md`.
     */
    const stranded = nodes.filter((node) => node.status === 'running');

    expect(stranded.length).toBeLessThanOrEqual(1);
  }, 300_000);

  it('does not rewrite a task that completed before the cancellation', async () => {
    if (harness === undefined) {
      throw new Error('the execution harness was not created; Temporal is not reachable.');
    }

    const execution = harness;
    const fixture = await tenant('programme-cancel-preserve');
    const goal = 'Two chained tasks, the first finished before the cancellation. [simulate:ok]';

    const first = await createReadyTask(fixture, 'Preserve A', goal);
    const second = await createReadyTask(fixture, 'Preserve B', goal);

    const { programmeId } = await submitProgramme({
      fixture,
      objective: 'Cancel after the first node completed.',
      nodes: [
        { taskId: first, dependsOn: [] },
        { taskId: second, dependsOn: [first] },
      ],
    });

    await waitFor(
      async () => {
        const row = await client.task.findUniqueOrThrow({
          where: { id: first },
          select: { status: true },
        });

        return row.status === 'succeeded';
      },
      120_000,
      `task ${first} to succeed`,
    );

    // The durable shape of the completed work, captured *before* the cancellation.
    const before = {
      task: await client.task.findUniqueOrThrow({
        where: { id: first },
        select: { status: true },
      }),
      attempt: await client.executionAttempt.findFirstOrThrow({
        where: { orgId: fixture.orgId, taskId: first },
        select: { id: true, status: true, agentRunId: true, finishedAt: true },
      }),
      evidence: await client.evidence.count({ where: { orgId: fixture.orgId, taskId: first } }),
      artifacts: await client.artifact.count({ where: { orgId: fixture.orgId, taskId: first } }),
    };

    expect(before.task.status).toBe('succeeded');
    expect(before.attempt.status).toBe('succeeded');
    expect(before.evidence).toBeGreaterThan(0);

    expect(await execution.cancelWorkflow(`programme-${programmeId}`)).toBe('cancelled');

    await waitFor(
      async () => (await programmeRow(programmeId)).status === 'cancelled',
      30_000,
      `programme ${programmeId} to be cancelled`,
    );

    // ── Completed work is history, not state to be cleaned up ─────────────────
    const after = {
      task: await client.task.findUniqueOrThrow({
        where: { id: first },
        select: { status: true },
      }),
      attempt: await client.executionAttempt.findFirstOrThrow({
        where: { orgId: fixture.orgId, taskId: first },
        select: { id: true, status: true, agentRunId: true, finishedAt: true },
      }),
      evidence: await client.evidence.count({ where: { orgId: fixture.orgId, taskId: first } }),
      artifacts: await client.artifact.count({ where: { orgId: fixture.orgId, taskId: first } }),
    };

    expect(after.task.status).toBe('succeeded');
    expect(after.attempt).toEqual(before.attempt);
    expect(after.evidence).toBe(before.evidence);
    expect(after.artifacts).toBe(before.artifacts);

    // The programme is cancelled, and the node the scheduler had not finished is not
    // recorded as a success it never had.
    const programme = await programmeRow(programmeId);
    expect(programme.status).toBe('cancelled');
    expect(programme.failureCode).toBe('CANCELLED');

    const secondRow = await client.task.findUniqueOrThrow({
      where: { id: second },
      select: { status: true },
    });

    expect(secondRow.status).not.toBe('succeeded');
  }, 300_000);

  it('answers a second cancellation by leaving the row where it was', async () => {
    if (harness === undefined) {
      throw new Error('the execution harness was not created; Temporal is not reachable.');
    }

    const execution = harness;
    const fixture = await tenant('programme-cancel-twice');
    const goal = 'Cancel the same programme twice. [simulate:ok]';

    const a = await createReadyTask(fixture, 'Twice A', goal);
    const b = await createReadyTask(fixture, 'Twice B', goal);

    const { programmeId } = await submitProgramme({
      fixture,
      objective: 'A second cancellation must not move the terminal row.',
      nodes: [
        { taskId: a, dependsOn: [] },
        { taskId: b, dependsOn: [a] },
      ],
    });

    await waitFor(
      async () => {
        const programme = await programmeRow(programmeId);
        const executing = await client.executionAttempt.count({
          where: { orgId: fixture.orgId, status: 'running' },
        });

        return programme.startedAt !== null && executing >= 1;
      },
      120_000,
      `programme ${programmeId} to start and have a child executing`,
    );

    expect(await execution.cancelWorkflow(`programme-${programmeId}`)).toBe('cancelled');

    await waitFor(
      async () => (await programmeRow(programmeId)).status === 'cancelled',
      30_000,
      `programme ${programmeId} to be cancelled`,
    );

    const cancelled = await programmeRow(programmeId);

    /**
     * The same call again. On a closed execution Temporal answers `not_found` rather than
     * re-cancelling it — both answers are legitimate, so what is asserted is the row: a
     * second write would move `finishedAt`, and nothing did.
     */
    const second = await execution.cancelWorkflow(`programme-${programmeId}`);
    expect(['cancelled', 'not_found']).toContain(second);

    const after = await programmeRow(programmeId);

    expect(after.status).toBe('cancelled');
    expect(after.failureCode).toBe('CANCELLED');
    expect(after.finishedAt?.getTime()).toBe(cancelled.finishedAt?.getTime());
  }, 300_000);

  it('does not spend an approval grant that was waiting for a human', async () => {
    if (harness === undefined) {
      throw new Error('the execution harness was not created; Temporal is not reachable.');
    }

    const execution = harness;
    const fixture = await tenant('programme-cancel-grant');
    const goal = 'Approval-gated work that a cancellation must not authorise. [simulate:ok]';

    const gated = await createReadyTask(fixture, 'Gated node', goal, 'HIGH');
    // A second, unapproved node keeps the programme alive long enough to cancel it. A
    // single HIGH node settles the programme `blocked` within milliseconds of the
    // `waiting_for_approval` checkpoint — by design (`APPROVAL_PENDING`) — and a blocked
    // programme is correctly refused as `PROGRAMME_NOT_CANCELLABLE`. The grant is still the
    // subject; this node is only the clock.
    const running = await createReadyTask(fixture, 'Keep-alive node', goal);

    // The row `POST /tasks` creates for a HIGH task. Written directly because this suite
    // inserts its own fixtures — the endpoint's approval creation is covered by the API
    // suite.
    const approval = await client.approvalRequest.create({
      data: {
        orgId: fixture.orgId,
        taskId: gated,
        riskClass: 'HIGH',
        requestedById: fixture.userId,
      },
      select: { id: true, status: true },
    });

    const { programmeId } = await submitProgramme({
      fixture,
      objective: 'Cancel a programme whose grant is still waiting for a decision.',
      nodes: [
        { taskId: gated, dependsOn: [] },
        { taskId: running, dependsOn: [] },
      ],
    });

    await waitFor(
      async () => {
        const executing = await client.executionAttempt.count({
          where: { orgId: fixture.orgId, taskId: running, status: 'running' },
        });

        return executing >= 1;
      },
      120_000,
      `the keep-alive task ${running} to be executing while ${gated} waits for approval`,
    );

    expect(await execution.cancelWorkflow(`programme-${programmeId}`)).toBe('cancelled');

    await waitFor(
      async () => (await programmeRow(programmeId)).status === 'cancelled',
      30_000,
      `programme ${programmeId} to be cancelled`,
    );

    // ── The grant is exactly as it was ────────────────────────────────────────
    // A programme does not spend approvals: the reservation refuses a HIGH node with
    // `approval_required` and the scheduler records `waiting_for_approval`. A cancellation
    // stops dispatch; it does not authorise, and it does not revoke either.
    const after = await client.approvalRequest.findUniqueOrThrow({
      where: { id: approval.id },
      select: {
        status: true,
        consumedAt: true,
        consumedByAttemptId: true,
        decidedAt: true,
        decidedById: true,
      },
    });

    expect(after.status).toBe('PENDING');
    expect(after.consumedAt).toBeNull();
    expect(after.consumedByAttemptId).toBeNull();
    expect(after.decidedAt).toBeNull();
    expect(after.decidedById).toBeNull();

    // And the gated task was never dispatched: it is not in flight, and no attempt or run
    // exists for it.
    expect(
      await client.executionAttempt.count({ where: { orgId: fixture.orgId, taskId: gated } }),
    ).toBe(0);
    expect(await client.workflowRun.count({ where: { orgId: fixture.orgId, taskId: gated } })).toBe(
      0,
    );

    const gatedRow = await client.task.findUniqueOrThrow({
      where: { id: gated },
      select: { status: true },
    });

    expect(gatedRow.status).toBe('ready');
  }, 300_000);
});
