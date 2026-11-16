import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PrismaClient } from '@intelligenz/database';
import type { WorkflowHandleWithFirstExecutionRunId } from '@temporalio/client';
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
 * The Continue-As-New boundary, actually crossed.
 *
 * ## What this file is for
 *
 * `shouldContinueAsNew` has existed since the programme layer landed, and until this file
 * it was only ever *read*: no test ran a programme past its own boundary, so the mechanism
 * — the `continueAsNew` call, the reload of the graph and the checkpoint count in the new
 * generation, the sequence numbering that has to continue rather than restart — was
 * asserted to exist, not exercised. A helper unit test on the predicate would be the same
 * defect in a smaller shape: it can be green while `continueAsNew` is never called.
 *
 * So the subject here is a **real crossing**, proved from a runtime fact:
 *
 *   - the first run of `programme-<id>` closes `CONTINUED_AS_NEW` — a status only the
 *     server's own execution record can report;
 *   - its history contains `WorkflowExecutionContinuedAsNew` with a `newExecutionRunId`;
 *   - following that link reaches a *different* run that closes `COMPLETED`;
 *   - and the latest run under the id is that final run, i.e. the one whose result
 *     `handle.result()` returned.
 *
 * The installed `@temporalio/client` is 1.25.0. Its `WorkflowExecutionDescription` has no
 * `continuedExecutionRunId` field: the id lives on
 * `WorkflowExecutionStartedEventAttributes`, not on the visibility record, so the link is
 * read from the closing run's history (`describeRun` in `execution-harness.ts`). The
 * assertion is unchanged in substance — a crossing that leaves no link fails the test.
 *
 * ## Why the checkpoint count is the second subject
 *
 * A new generation must resume from `checkpointCount`, not from zero. `ProgrammeCheckpoint`
 * is `@@unique([programmeId, sequence])`, so a restart at zero would not merely renumber the
 * history: checkpoint 1 for node C would collide with checkpoint 1 for node A and the write
 * would be refused. Five checkpoints with sequences 1..5 on a programme that crossed three
 * times is therefore a proof that the sequence was carried, not re-derived.
 *
 * ## The negative control
 *
 * The same five tasks, the same harness, the same run — with the boundary above the
 * checkpoint count. No crossing, `continuedAsNewRunId` empty, one run. Without it, the
 * first test could be green because the assertion is always true; with it, the assertion is
 * shown to detect the difference.
 */

const databaseUrl = testDatabaseUrl();
const temporalEnabled = databaseUrl !== undefined && (await temporalReachable());
const enabled = temporalEnabled;

const PROGRAMME_WORKFLOWS = fileURLToPath(
  new URL('./fixtures/programme-bundle.workflow.ts', import.meta.url),
);

/** Five chained nodes, so a boundary of 2 is crossed twice and left unfinished. */
const CHAIN_LENGTH = 5;
const CROSSING_BOUNDARY = 2;
const NO_CROSSING_BOUNDARY = 10_000;

const tenants: TenantFixture[] = [];

let client: PrismaClient;
let harness: ExecutionHarness | undefined;

beforeAll(async () => {
  if (!databaseUrl) return;

  const database = useTestDatabase();
  client = database.client;

  process.env['DATABASE_URL'] = database.url;
  process.env['ARTIFACT_ROOT'] = `/tmp/intelligenz-programme-can-test-${randomUUID().slice(0, 8)}`;
  process.env['AGENT_RUNTIME'] = 'local-simulated';
  process.env['AGENT_STEP_DELAY_MS'] = '0';
  delete process.env['WORKER_FAULT_INJECT'];
  delete process.env['WORKER_RESOURCE_PROFILE'];
  delete process.env['LOCAL_SIMULATED_OUTCOME'];

  // A run killed before `afterAll` leaves the same rows an abandoned run does. Age-guarded,
  // so a concurrent run's fresh fixtures are left alone. The prefix is this file's own, so
  // the programme suites never sweep each other's tenants.
  await dropResidualTenants(client, 'programme-can-');

  if (temporalEnabled) {
    harness = await createExecutionHarness({ workflowsPath: PROGRAMME_WORKFLOWS });
  }
}, 90_000);

afterAll(async () => {
  if (!databaseUrl) return;

  // The harness first: a child still polling would write after the tenants are gone.
  await harness?.close();
  await dropAllTenants(client, tenants);
  await client.$disconnect();
});

if (!enabled) {
  console.warn(
    `[programme-continue-as-new] suite skipped — ${
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
 * A task a programme can schedule: `ready`, LOW risk (no approval), with acceptance
 * criteria, because the graph validator refuses a task that has none.
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
 * One submission — the programme row, its graph and the parent workflow — with the boundary
 * supplied explicitly. `POST /programmes` sends no `continueAfterCheckpoints`; this is the
 * only caller that does, and that is the point of it being in the input at all.
 */
async function submitChainedProgramme(options: {
  readonly fixture: TenantFixture;
  readonly taskIds: readonly string[];
  readonly continueAfterCheckpoints: number;
}): Promise<{
  readonly programmeId: string;
  readonly workflowId: string;
  readonly handle: WorkflowHandleWithFirstExecutionRunId<Workflow>;
}> {
  const { fixture, taskIds, continueAfterCheckpoints } = options;

  const programme = await client.programme.create({
    data: {
      orgId: fixture.orgId,
      projectId: fixture.projectId,
      objective: 'Carry a five-node chain across Continue-As-New without losing its history.',
      idempotencyKey: `programme-${randomUUID()}`,
    },
    select: { id: true },
  });

  await client.programmeTask.createMany({
    data: taskIds.map((taskId, index) => ({
      orgId: fixture.orgId,
      programmeId: programme.id,
      taskId,
      // A → B → C → D → E: each node waits for the one before it, so the checkpoints are
      // ordered by the graph rather than by which reservation happened to answer first.
      dependsOn: index === 0 ? [] : [taskIds[index - 1]!],
    })),
  });

  if (harness === undefined) {
    throw new Error('the execution harness was not created; Temporal is not reachable.');
  }

  const workflowId = `programme-${programme.id}`;
  const handle = await harness.start('runProgrammeWorkflow', {
    workflowId,
    args: [
      {
        programmeId: programme.id,
        orgId: fixture.orgId,
        deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        maxConcurrent: 1,
        continueAfterCheckpoints,
      },
    ],
  });

  return { programmeId: programme.id, workflowId, handle };
}

/**
 * Follows the Continue-As-New chain from the first run to the last.
 *
 * Returns the runs in order. The first link is what the crossing produced; each subsequent
 * one comes from the previous run's own history. A missing run is a failure, not a skip: the
 * link pointing at nothing would mean the history and the visibility record disagree.
 */
async function followRuns(
  workflowId: string,
  firstRunId: string,
): Promise<readonly { readonly status: string; readonly runId: string }[]> {
  if (harness === undefined) {
    throw new Error('the execution harness was not created; Temporal is not reachable.');
  }

  const first = await harness.describeRun(workflowId, firstRunId);
  expect(first, `run ${firstRunId} must exist`).not.toBeNull();

  const runs: { readonly status: string; readonly runId: string }[] = [
    { status: first!.status, runId: first!.runId },
  ];

  let current = first!;

  while (current.continuedAsNewRunId !== '') {
    const next = await harness.describeRun(workflowId, current.continuedAsNewRunId);
    expect(next, `run ${current.continuedAsNewRunId} must exist`).not.toBeNull();

    runs.push({ status: next!.status, runId: next!.runId });
    current = next!;

    if (runs.length > CHAIN_LENGTH * 2) {
      throw new Error(
        `Continue-As-New chain did not terminate after ${String(runs.length)} runs: ` +
          'the backstop is crossing without recording progress.',
      );
    }
  }

  return runs;
}

describe.skipIf(!enabled)(
  'PROGRAMME-CAN — the Continue-As-New boundary is crossed, not asserted',
  () => {
    it('crosses twice on a five-node chain and carries the checkpoint sequence across both boundaries', async () => {
      if (harness === undefined) {
        throw new Error('the execution harness was not created; Temporal is not reachable.');
      }

      const execution = harness;
      const fixture = await tenant('programme-can-cross');
      const goal = 'Continue-as-new chain step. [simulate:ok]';

      const taskIds = [
        await createReadyTask(fixture, 'CAN A — first', goal),
        await createReadyTask(fixture, 'CAN B — second', goal),
        await createReadyTask(fixture, 'CAN C — third', goal),
        await createReadyTask(fixture, 'CAN D — fourth', goal),
        await createReadyTask(fixture, 'CAN E — fifth', goal),
      ];

      const { programmeId, workflowId, handle } = await submitChainedProgramme({
        fixture,
        taskIds,
        continueAfterCheckpoints: CROSSING_BOUNDARY,
      });

      // The submission is the last call the test makes into the system. Everything below is a
      // read of what the workflow wrote, or of what Temporal recorded about it.
      const result = (await handle.result()) as RunProgrammeWorkflowResult;

      expect(result.status).toBe('succeeded');
      expect(result.succeeded).toBe(CHAIN_LENGTH);
      expect(result.checkpoints).toBe(CHAIN_LENGTH);

      // ── 1. Five checkpoints, sequences 1..5, none repeated ────────────────────
      //
      // `@@unique([programmeId, sequence])` makes a duplicate impossible to store, so the
      // claim being tested is stronger than "no duplicates": each generation allocated its
      // next sequence from the count it reloaded, so the five writes are 1,2,3,4,5 and not
      // 1,2,1,2,1 (which would have been refused) and not 3,4,5,6,7 (which would mean the
      // count was read as something other than "checkpoints so far").
      const checkpoints = await client.programmeCheckpoint.findMany({
        where: { programmeId },
        orderBy: { sequence: 'asc' },
        select: { sequence: true, taskId: true, outcome: true, evidence: true },
      });

      expect(checkpoints.map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5]);
      expect(new Set(checkpoints.map((row) => row.sequence)).size).toBe(CHAIN_LENGTH);
      // Dependency order survived the boundary: A..E is 1..5, not shuffled by the restart.
      expect(checkpoints.map((row) => row.taskId)).toEqual([...taskIds]);
      expect(checkpoints.every((row) => row.outcome === 'succeeded')).toBe(true);

      // ── 2. Each task succeeded, with its own claimed attempt ──────────────────
      const claimedRuns: string[] = [];

      for (const [index, taskId] of taskIds.entries()) {
        const task = await client.task.findUniqueOrThrow({
          where: { id: taskId },
          select: { status: true },
        });

        expect(task.status, `task ${String(index + 1)} status`).toBe('succeeded');

        const attempts = await client.executionAttempt.findMany({
          where: { orgId: fixture.orgId, taskId },
          select: {
            id: true,
            status: true,
            claimedByWorkflowRunId: true,
            claimedByWorkflowId: true,
            claimedAt: true,
          },
        });

        // Exactly one: no generation re-reserved a node the previous generation had already
        // checkpointed. A second attempt here is the double-dispatch this layer exists to
        // prevent, and it would also mean the reloaded node state was ignored.
        expect(attempts, `task ${String(index + 1)} attempts`).toHaveLength(1);
        const attempt = attempts[0]!;

        expect(attempt.status).toBe('succeeded');
        expect(attempt.claimedAt, 'the attempt was claimed, not merely reserved').not.toBeNull();
        expect(attempt.claimedByWorkflowRunId).not.toBeNull();
        expect(attempt.claimedByWorkflowId).not.toBeNull();

        claimedRuns.push(attempt.claimedByWorkflowRunId!);

        // The checkpoint names the attempt that claimed it — evidence, not an assertion.
        expect(checkpoints[index]?.evidence).toMatchObject({
          attemptId: attempt.id,
          childRunId: attempt.claimedByWorkflowRunId,
        });
      }

      expect(new Set(claimedRuns).size).toBe(CHAIN_LENGTH);

      const nodes = await client.programmeTask.findMany({
        where: { programmeId },
        select: { status: true, attemptCount: true },
      });

      expect(nodes).toHaveLength(CHAIN_LENGTH);
      expect(nodes.every((node) => node.status === 'succeeded')).toBe(true);
      expect(nodes.every((node) => node.attemptCount === 1)).toBe(true);

      const programme = await client.programme.findUniqueOrThrow({
        where: { id: programmeId },
        select: { status: true, failureReason: true, failureCode: true },
      });

      expect(programme.status).toBe('succeeded');
      expect(programme.failureReason).toBeNull();
      expect(programme.failureCode).toBeNull();

      // ── 3. The crossing, from Temporal's own record ───────────────────────────
      const firstRunId = handle.firstExecutionRunId;
      const first = await execution.describeRun(workflowId, firstRunId);

      expect(first, 'the first execution must be describable').not.toBeNull();
      expect(first!.runId).toBe(firstRunId);

      // A status only the server can assign: this run did not complete, it continued.
      expect(first!.status).toBe('CONTINUED_AS_NEW');
      // ...and it left a link to the run it continued into. This is the assertion that fails
      // if the boundary is not crossed; it is read from history, not from the code path.
      expect(first!.continuedAsNewRunId).not.toBe('');

      const runs = await followRuns(workflowId, firstRunId);

      // 2 checkpoints per run, then 1: three runs, two boundaries.
      expect(runs).toHaveLength(3);
      expect(runs[0]?.runId).toBe(firstRunId);
      expect(new Set(runs.map((run) => run.runId)).size).toBe(3);
      expect(runs.at(-1)?.status).toBe('COMPLETED');

      // The last run in the chain is the one `handle.result()` joined: a handle without a run
      // id describes the latest execution, and that is the run whose verdict was asserted
      // above. If the SDK had followed a different run, this comparison would not hold.
      const latest = await execution.describeRun(workflowId);

      expect(latest?.runId).toBe(runs.at(-1)?.runId);
      expect(latest?.continuedAsNewRunId).toBe('');
    }, 300_000);

    it('does not continue as new when the boundary is above the checkpoint count — same chain, no crossing', async () => {
      if (harness === undefined) {
        throw new Error('the execution harness was not created; Temporal is not reachable.');
      }

      const execution = harness;
      const fixture = await tenant('programme-can-hold');
      const goal = 'Negative control: the same chain without a crossing. [simulate:ok]';

      const taskIds = [
        await createReadyTask(fixture, 'Control A', goal),
        await createReadyTask(fixture, 'Control B', goal),
        await createReadyTask(fixture, 'Control C', goal),
        await createReadyTask(fixture, 'Control D', goal),
        await createReadyTask(fixture, 'Control E', goal),
      ];

      const { programmeId, workflowId, handle } = await submitChainedProgramme({
        fixture,
        taskIds,
        // Clamped to 10_000 by the workflow; five checkpoints never reach it.
        continueAfterCheckpoints: NO_CROSSING_BOUNDARY,
      });

      const result = (await handle.result()) as RunProgrammeWorkflowResult;

      expect(result.status).toBe('succeeded');
      expect(result.checkpoints).toBe(CHAIN_LENGTH);

      const checkpoints = await client.programmeCheckpoint.findMany({
        where: { programmeId },
        orderBy: { sequence: 'asc' },
        select: { sequence: true, taskId: true },
      });

      expect(checkpoints.map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5]);
      expect(checkpoints.map((row) => row.taskId)).toEqual([...taskIds]);

      const firstRunId = handle.firstExecutionRunId;
      const first = await execution.describeRun(workflowId, firstRunId);

      expect(first).not.toBeNull();
      expect(first!.runId).toBe(firstRunId);

      // The difference the first test asserts on: this run completed in one execution and
      // left no Continue-As-New link at all.
      expect(first!.status).toBe('COMPLETED');
      expect(first!.continuedAsNewRunId).toBe('');

      const latest = await execution.describeRun(workflowId);

      expect(latest?.runId).toBe(firstRunId);
      expect(latest?.continuedAsNewRunId).toBe('');

      const programme = await client.programme.findUniqueOrThrow({
        where: { id: programmeId },
        select: { status: true, failureCode: true },
      });

      expect(programme.status).toBe('succeeded');
      expect(programme.failureCode).toBeNull();
    }, 300_000);
  },
);
