import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PrismaClient } from '@intelligenz/database';

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
 * The programme deadline, and the return value that has to agree with the row — P87-012.
 *
 * ## What was wrong
 *
 * 1. **The deadline failed open.** The workflow did `Date.parse(input.deadlineAt)` and then
 *    `now >= deadline`. An unparseable value makes that `NaN`, and `now >= NaN` is `false`,
 *    so the programme ran with **no deadline at all** and said nothing about it.
 * 2. **The return value contradicted the row on two paths.** The deadline committed
 *    `timed_out` and returned a status derived from the nodes — all `pending`, therefore
 *    `blocked`. The invalid-graph path committed `failed` and returned the same derived
 *    value. A workflow result that disagrees with the durable row is exactly the class of
 *    inconsistency the programme layer exists to remove.
 *
 * ## What each test proves
 *
 *   - a deadline in the past closes the row `timed_out`, dispatches nothing, and **returns**
 *     `timed_out` — the row and the return are asserted together, which is defect 2;
 *   - `'not-a-date'` does the same, which is the fail-closed proof: without the fix that
 *     value is `NaN`, no comparison fires, and the programme runs to completion;
 *   - a far-future deadline still succeeds, so the two tests above detect a firing deadline
 *     rather than asserting something that is always true;
 *   - a cycle inserted into `ProgrammeTask.dependsOn` closes the row `failed` and **returns**
 *     `failed`, where the pre-fix value was `blocked`;
 *   - the deadline survives Continue-As-New, read from the **second run's** own
 *     `WorkflowExecutionStartedEventAttributes.input` — a fact from history, not an
 *     inference from "it completed".
 *
 * ## Why the graph is inserted directly
 *
 * Same discipline as `programme-execution.test.ts`: the subject is the scheduler, so the
 * rows are written exactly as `POST /programmes` writes them and the parent is started
 * exactly as the API starts it (`programme-<id>`, same input shape). The cycle cannot come
 * through the API — it refuses it — and a workflow can be started directly, which is why
 * the parent repeats the validation.
 */

const databaseUrl = testDatabaseUrl();
const temporalEnabled = databaseUrl !== undefined && (await temporalReachable());
const enabled = temporalEnabled;

const PROGRAMME_WORKFLOWS = fileURLToPath(
  new URL('./fixtures/programme-bundle.workflow.ts', import.meta.url),
);

/** The tenant prefix this file owns, so its residue sweep cannot touch another suite. */
const TENANT_PREFIX = 'programme-deadline-';

const tenants: TenantFixture[] = [];

let client: PrismaClient;
let harness: ExecutionHarness | undefined;

beforeAll(async () => {
  if (!databaseUrl) return;

  const database = useTestDatabase();
  client = database.client;

  process.env['DATABASE_URL'] = database.url;
  process.env['ARTIFACT_ROOT'] =
    `/tmp/intelligenz-programme-deadline-test-${randomUUID().slice(0, 8)}`;
  process.env['AGENT_RUNTIME'] = 'local-simulated';
  process.env['AGENT_STEP_DELAY_MS'] = '0';
  delete process.env['WORKER_FAULT_INJECT'];
  delete process.env['WORKER_RESOURCE_PROFILE'];
  delete process.env['LOCAL_SIMULATED_OUTCOME'];

  // A run killed before `afterAll` leaves the same rows an abandoned run does. Age-guarded
  // and prefix-scoped, so a concurrent suite's fresh fixtures are left alone.
  await dropResidualTenants(client, TENANT_PREFIX);

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
    `[programme-deadline] suite skipped — ${
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
 * A task a programme can schedule: `ready`, LOW risk (no approval) and **with acceptance
 * criteria**, because the graph validator refuses a task that has none.
 */
async function createReadyTask(
  fixture: TenantFixture,
  title: string,
  goal = 'The programme deadline suite. [simulate:ok]',
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
      idempotencyKey: `programme-deadline-${randomUUID()}`,
    },
    select: { id: true },
  });

  return task.id;
}

interface SubmitOptions {
  readonly fixture: TenantFixture;
  readonly objective: string;
  readonly nodes: readonly { readonly taskId: string; readonly dependsOn: readonly string[] }[];
  /**
   * The deadline verbatim. Tests pass `'not-a-date'` here, which is not a string the API
   * would ever produce — that is the point: a workflow can be started directly.
   */
  readonly deadlineAt: string;
  readonly continueAfterCheckpoints?: number;
}

/**
 * One submission: the programme row, its graph and the parent workflow — the same rows the
 * API writes and the same start it performs.
 *
 * The deadline is a parameter rather than a computed default, because on this subject the
 * deadline **is** the input under test.
 */
async function submitProgramme(options: SubmitOptions): Promise<{
  readonly programmeId: string;
  readonly workflowId: string;
  readonly handle: Awaited<ReturnType<ExecutionHarness['start']>>;
}> {
  const { fixture, objective, nodes, deadlineAt, continueAfterCheckpoints } = options;

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

  const workflowId = `programme-${programme.id}`;
  const handle = await harness.start('runProgrammeWorkflow', {
    workflowId,
    args: [
      {
        programmeId: programme.id,
        orgId: fixture.orgId,
        deadlineAt,
        ...(continueAfterCheckpoints === undefined ? {} : { continueAfterCheckpoints }),
      },
    ],
  });

  return { programmeId: programme.id, workflowId, handle };
}

describe.skipIf(!enabled)(
  'PROGRAMME-DEADLINE — the row is the record, and the return value agrees with it',
  () => {
    it('closes a programme whose deadline is already past as timed_out, dispatches nothing, and returns timed_out', async () => {
      const fixture = await tenant(`${TENANT_PREFIX}past`);

      const a = await createReadyTask(fixture, 'Deadline past — A');
      const b = await createReadyTask(fixture, 'Deadline past — B');

      // The boundary direction, not a race: `now >= deadline` counts the instant itself as
      // exceeded, and this instant is stamped **before** the start, so it is already in the
      // past by the time the workflow evaluates it.
      const deadlineAt = new Date().toISOString();

      const { programmeId, handle } = await submitProgramme({
        fixture,
        objective: 'A deadline that has passed must not dispatch a node.',
        nodes: [
          { taskId: a, dependsOn: [] },
          { taskId: b, dependsOn: [a] },
        ],
        deadlineAt,
      });

      const result = (await handle.result()) as RunProgrammeWorkflowResult;

      // ── The return value and the row, asserted together (defect 2) ─────────
      expect(result.status).toBe('timed_out');
      expect(result.checkpoints).toBe(0);
      expect(result.succeeded).toBe(0);

      const programme = await client.programme.findUniqueOrThrow({
        where: { id: programmeId },
        select: {
          status: true,
          failureReason: true,
          failureCode: true,
          startedAt: true,
          finishedAt: true,
        },
      });

      expect(programme.status).toBe('timed_out');
      expect(programme.failureCode).toBe('DEADLINE_EXCEEDED');
      expect(programme.failureReason).toContain('DEADLINE_EXCEEDED');
      // The load ran, so the scheduler did start; it then refused to dispatch.
      expect(programme.startedAt).not.toBeNull();
      expect(programme.finishedAt).not.toBeNull();

      // ── Nothing was dispatched ────────────────────────────────────────────
      expect(await client.programmeCheckpoint.count({ where: { programmeId } })).toBe(0);
      expect(
        await client.executionAttempt.count({ where: { orgId: fixture.orgId } }),
        'no execution attempt exists for any node',
      ).toBe(0);

      const nodes = await client.programmeTask.findMany({
        where: { programmeId },
        select: { taskId: true, status: true, attemptCount: true },
      });

      expect(nodes).toHaveLength(2);
      // The node states are the schedule, and none of them moved: no checkpoint was written.
      expect(nodes.every((node) => node.status === 'pending')).toBe(true);
      expect(nodes.every((node) => node.attemptCount === 0)).toBe(true);

      for (const taskId of [a, b]) {
        expect(
          (await client.task.findUniqueOrThrow({ where: { id: taskId }, select: { status: true } }))
            .status,
          `task ${taskId} was never queued`,
        ).toBe('ready');
      }
    }, 300_000);

    it('fails closed on an unparseable deadline: timed_out with DEADLINE_EXCEEDED, nothing dispatched', async () => {
      const fixture = await tenant(`${TENANT_PREFIX}invalid`);
      const taskId = await createReadyTask(fixture, 'Deadline unparseable');

      const { programmeId, handle } = await submitProgramme({
        fixture,
        objective: 'A malformed deadlineAt must not become "no deadline".',
        nodes: [{ taskId, dependsOn: [] }],
        // Without the fix this is `NaN`, every `now >= NaN` is false, and the programme
        // runs to completion — which is the fail-open this test exists to catch.
        deadlineAt: 'not-a-date',
      });

      const result = (await handle.result()) as RunProgrammeWorkflowResult;

      expect(result.status).toBe('timed_out');
      expect(result.checkpoints).toBe(0);

      const programme = await client.programme.findUniqueOrThrow({
        where: { id: programmeId },
        select: { status: true, failureReason: true, failureCode: true, finishedAt: true },
      });

      expect(programme.status).toBe('timed_out');
      expect(programme.failureCode).toBe('DEADLINE_EXCEEDED');
      expect(programme.finishedAt).not.toBeNull();

      // The reason names the invalid input, quoted and truncated, rather than echoing
      // whatever the caller sent.
      expect(programme.failureReason).toContain('DEADLINE_EXCEEDED');
      expect(programme.failureReason).toContain('"not-a-date"');

      expect(await client.programmeCheckpoint.count({ where: { programmeId } })).toBe(0);
      expect(await client.executionAttempt.count({ where: { orgId: fixture.orgId } })).toBe(0);
      expect(
        (await client.task.findUniqueOrThrow({ where: { id: taskId }, select: { status: true } }))
          .status,
      ).toBe('ready');
    }, 300_000);

    it('runs a chain to success under a far-future deadline — the negative control', async () => {
      const fixture = await tenant(`${TENANT_PREFIX}future`);

      const a = await createReadyTask(fixture, 'Deadline future — A');
      const b = await createReadyTask(fixture, 'Deadline future — B');

      const deadlineAt = new Date(Date.now() + 3_600_000).toISOString();

      const { programmeId, handle } = await submitProgramme({
        fixture,
        objective: 'A deadline that has not passed must not stop the programme.',
        nodes: [
          { taskId: a, dependsOn: [] },
          { taskId: b, dependsOn: [a] },
        ],
        deadlineAt,
      });

      const result = (await handle.result()) as RunProgrammeWorkflowResult;

      // The same assertions the deadline tests make, inverted. Without this, `timed_out`
      // could be the answer to everything and the two tests above would prove nothing.
      expect(result.status).toBe('succeeded');
      expect(result.succeeded).toBe(2);
      expect(result.checkpoints).toBe(2);

      const programme = await client.programme.findUniqueOrThrow({
        where: { id: programmeId },
        select: { status: true, failureReason: true, failureCode: true },
      });

      expect(programme.status).toBe('succeeded');
      expect(programme.failureCode).toBeNull();
      expect(programme.failureReason).toBeNull();

      const nodes = await client.programmeTask.findMany({
        where: { programmeId },
        select: { status: true },
      });

      expect(nodes.map((node) => node.status)).toEqual(['succeeded', 'succeeded']);

      for (const taskId of [a, b]) {
        expect(
          (await client.task.findUniqueOrThrow({ where: { id: taskId }, select: { status: true } }))
            .status,
        ).toBe('succeeded');
      }
    }, 300_000);

    it('closes an invalid graph as failed and returns failed, not a status derived from pending nodes', async () => {
      const fixture = await tenant(`${TENANT_PREFIX}graph`);

      const a = await createReadyTask(fixture, 'Graph cycle — A');
      const b = await createReadyTask(fixture, 'Graph cycle — B');

      // A cycle inserted directly: the API refuses this shape, and the parent must not
      // trust that it came from the API.
      const { programmeId, handle } = await submitProgramme({
        fixture,
        objective: 'A cycle cannot be scheduled, and the row says failed.',
        nodes: [
          { taskId: a, dependsOn: [b] },
          { taskId: b, dependsOn: [a] },
        ],
        deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
      });

      const result = (await handle.result()) as RunProgrammeWorkflowResult;

      // Before the fix this was `blocked`: every node is still `pending`, so the derived
      // status disagreed with the committed `failed`.
      expect(result.status).toBe('failed');
      expect(result.checkpoints).toBe(0);

      const programme = await client.programme.findUniqueOrThrow({
        where: { id: programmeId },
        select: { status: true, failureReason: true, failureCode: true, finishedAt: true },
      });

      expect(programme.status).toBe('failed');
      expect(programme.failureCode).toBe('GRAPH_INVALID');
      expect(programme.failureReason).toContain('GRAPH_INVALID');
      expect(programme.finishedAt).not.toBeNull();

      expect(await client.programmeCheckpoint.count({ where: { programmeId } })).toBe(0);
      expect(await client.executionAttempt.count({ where: { orgId: fixture.orgId } })).toBe(0);
      expect(await client.programmeTask.count({ where: { programmeId, status: 'pending' } })).toBe(
        2,
      );
    }, 300_000);

    it('carries deadlineAt across Continue-As-New, read from the second run’s own history', async () => {
      if (harness === undefined) {
        throw new Error('the execution harness was not created; Temporal is not reachable.');
      }

      const execution = harness;
      const fixture = await tenant(`${TENANT_PREFIX}can`);

      const taskIds = [
        await createReadyTask(fixture, 'CAN deadline — A'),
        await createReadyTask(fixture, 'CAN deadline — B'),
        await createReadyTask(fixture, 'CAN deadline — C'),
        await createReadyTask(fixture, 'CAN deadline — D'),
      ];

      // Far enough away that it cannot fire, close enough to the shape the API sends.
      const deadlineAt = new Date(Date.now() + 3_600_000).toISOString();

      const { programmeId, workflowId, handle } = await submitProgramme({
        fixture,
        objective: 'A deadline must survive the Continue-As-New boundary unchanged.',
        nodes: taskIds.map((taskId, index) => ({
          taskId,
          dependsOn: index === 0 ? [] : [taskIds[index - 1]!],
        })),
        deadlineAt,
        // One checkpoint per execution: a four-node chain crosses three times.
        continueAfterCheckpoints: 1,
      });

      const result = (await handle.result()) as RunProgrammeWorkflowResult;

      // The programme completes, so the deadline never fired — the crossing is the only
      // thing under test here.
      expect(result.status).toBe('succeeded');
      expect(result.checkpoints).toBe(taskIds.length);

      const firstRunId = handle.firstExecutionRunId;
      const first = await execution.describeRun(workflowId, firstRunId);

      expect(first, 'the first execution must be describable').not.toBeNull();
      expect(first!.status).toBe('CONTINUED_AS_NEW');
      expect(first!.continuedAsNewRunId).not.toBe('');

      // ── The fact, from history ────────────────────────────────────────────
      //
      // The second generation was started with the payload `continueAsNew(input)` wrote.
      // Reading it back is the only way to prove the deadline crossed instead of being
      // recomputed by a fresh `now + 6h`.
      const startedWith = await execution.startedWith(workflowId, first!.continuedAsNewRunId);
      const [secondInput] = startedWith as [Record<string, unknown> | undefined];

      expect(secondInput, 'the second run must carry exactly one argument').toBeDefined();
      expect(secondInput).toEqual({
        programmeId,
        orgId: fixture.orgId,
        deadlineAt,
        continueAfterCheckpoints: 1,
      });

      // Stated separately, because this is the property D3 depends on: not merely a date,
      // the same date — same string, same bytes, no re-derivation.
      expect(secondInput!['deadlineAt']).toBe(deadlineAt);
      expect(typeof secondInput!['deadlineAt']).toBe('string');

      const programme = await client.programme.findUniqueOrThrow({
        where: { id: programmeId },
        select: { status: true, failureCode: true },
      });

      expect(programme.status).toBe('succeeded');
      expect(programme.failureCode).toBeNull();
    }, 300_000);
  },
);
