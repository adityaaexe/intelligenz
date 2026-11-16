import { randomUUID } from 'node:crypto';

import { Client, Connection } from '@temporalio/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/app-config';
import type { ApiErrorBody, DataBody, TaskBody } from './helpers/api-types';
import type { Suite, TemporalProbe } from './helpers/app';
import { authHeaders, createTestApp, login, probeTemporal, startSuite } from './helpers/app';
import { optionalEnv } from './helpers/env';

/**
 * `POST /v1/orgs/:orgId/programmes` — the submission contract.
 *
 * This suite is about the **endpoint**, not about continuation: the parent workflow is
 * started on a task queue no worker polls, so nothing executes and nothing is asserted
 * about task outcomes. The scheduler itself is proved in
 * `apps/worker/test/programme-execution.test.ts`, where real children run against a real
 * database.
 *
 * Splitting it that way is deliberate. A test that boots the API *and* a worker would
 * conflate two failures (a bad request shape and a scheduler bug) into one red line, and
 * would take a minute per case.
 *
 * What is asserted here:
 *
 *   - the graph is persisted exactly as submitted, with `202` and `pending` status;
 *   - the audit trail says who submitted it;
 *   - a retry of the same `Idempotency-Key` returns the same programme (`200`) and writes
 *     no second row;
 *   - every graph defect the scheduler refuses is refused here first, with `400` and a
 *     field-keyed detail, and **nothing** is persisted;
 *   - the project and the tasks are resolved inside the caller's organisation.
 */

let suite: Suite;
let ownerToken: string;
let memberToken: string;
let temporal: TemporalProbe;

/** Unique per run: the suite truncates, but workflow ids live in Temporal, not Postgres. */
const taskQueue = `intelligenz-programme-api-test-${randomUUID().slice(0, 8)}`;

const startedWorkflowIds: string[] = [];

/**
 * A second application pointed at an address nothing listens on, so the
 * `ORCHESTRATOR_UNAVAILABLE` branch is deterministic instead of depending on whether this
 * host happens to have a Temporal server running.
 */
let offline: { app: Awaited<ReturnType<typeof createTestApp>>; close(): Promise<void> };

beforeAll(async () => {
  const base = loadConfig();

  suite = await startSuite({
    appOverrides: {
      // No worker polls this queue: the parent workflow is created and stays queued, which
      // is exactly what "the endpoint started it" means.
      temporal: { ...base.temporal, taskQueue },
    },
  });

  offline = await (async () => {
    const app = await createTestApp({
      // One attempt: the 503 is the assertion, so a retry can only leave a timer pending
      // for `app.close()` to turn into `Channel has been shut down`.
      temporal: {
        address: '127.0.0.1:1',
        namespace: 'default',
        taskQueue: 'intelligenz-tasks',
        rpcMaxAttempts: 1,
      },
      readinessTimeoutMs: 1_000,
    });

    return { app, close: () => app.close() };
  })();

  ownerToken = await login(suite.app, suite.fixtures.users.ownerA.email);
  memberToken = await login(suite.app, suite.fixtures.users.memberA.email);
  temporal = await probeTemporal(base.temporal.address);
}, 60_000);

afterAll(async () => {
  // A workflow with no worker would otherwise stay open in the dev store forever.
  if (startedWorkflowIds.length > 0 && temporal.ok) {
    const address = optionalEnv('TEMPORAL_ADDRESS') ?? 'localhost:7233';
    const connection = await Connection.connect({ address }).catch(() => undefined);

    if (connection !== undefined) {
      const client = new Client({
        connection,
        namespace: optionalEnv('TEMPORAL_NAMESPACE') ?? 'default',
      });

      for (const workflowId of startedWorkflowIds) {
        await client.workflow
          .getHandle(workflowId)
          .terminate('programme api test cleanup')
          .catch(() => undefined);
      }

      await connection.close();
    }
  }

  await offline.close();
  await suite.close();
});

function programmesPath(): string {
  return `/v1/orgs/${suite.fixtures.orgA.id}/programmes`;
}

interface CreatedProgrammeBody {
  data: {
    programmeId: string;
    projectId: string;
    objective: string;
    status: string;
    failureReason: string | null;
    /** The machine-readable reason. `null` while nothing has failed. */
    failureCode: string | null;
    createdAt: string;
    tasks: { taskId: string; dependsOn: string[]; status: string; attemptCount: number }[];
  };
  meta: { created: boolean };
}

/** A task in the shape a programme needs: acceptance criteria, LOW risk. */
async function createTask(token: string, title: string, criteria: string[]): Promise<string> {
  const response = await request(suite.app.getHttpServer())
    .post(`/v1/orgs/${suite.fixtures.orgA.id}/projects/${suite.fixtures.projectA}/tasks`)
    .set(authHeaders(token, suite.fixtures.orgA.id))
    .send({
      title,
      goal: `Programme fixture: ${title}`,
      riskClass: 'LOW',
      acceptanceCriteria: criteria,
    })
    .expect(201);

  return (response.body as DataBody<TaskBody>).data.id;
}

function submit(token: string, body: object, idempotencyKey?: string): request.Test {
  const call = request(suite.app.getHttpServer())
    .post(programmesPath())
    .set(authHeaders(token, suite.fixtures.orgA.id));

  if (idempotencyKey !== undefined) call.set('idempotency-key', idempotencyKey);

  return call.send(body);
}

describe('programme submission', () => {
  it('persists the graph, answers 202 with its initial state, and starts the parent workflow', async () => {
    if (!temporal.ok) {
      console.warn(`[programmes] workflow start not asserted — ${temporal.reason}`);
    }

    const a = await createTask(ownerToken, 'Programme API A', ['A is done when the test passes.']);
    const b = await createTask(ownerToken, 'Programme API B', ['B is done when the test passes.']);

    const response = await submit(
      ownerToken,
      {
        projectId: suite.fixtures.projectA,
        objective: 'Submit two dependent tasks as one objective.',
        tasks: [
          { taskId: a, dependsOn: [] },
          { taskId: b, dependsOn: [a] },
        ],
      },
      `programme-${randomUUID()}`,
    );

    expect(response.status).toBe(202);

    const body = response.body as CreatedProgrammeBody;

    expect(body.meta.created).toBe(true);
    expect(body.data.status).toBe('pending');
    // A programme that has not finished has no failure code — and `UNSPECIFIED` would be a
    // claim about a failure that has not happened.
    expect(body.data.failureCode).toBeNull();
    expect(body.data.projectId).toBe(suite.fixtures.projectA);
    expect(body.data.objective).toBe('Submit two dependent tasks as one objective.');
    expect(body.data.tasks).toHaveLength(2);

    const nodeB = body.data.tasks.find((task) => task.taskId === b);
    expect(nodeB?.dependsOn).toEqual([a]);
    expect(nodeB?.status).toBe('pending');
    expect(nodeB?.attemptCount).toBe(0);

    // The rows, not the response.
    const programme = await suite.prisma.programme.findUniqueOrThrow({
      where: { id: body.data.programmeId },
      include: { tasks: true },
    });

    expect(programme.orgId).toBe(suite.fixtures.orgA.id);
    expect(programme.status).toBe('pending');
    expect(programme.tasks.map((task) => task.taskId).sort()).toEqual([a, b].sort());

    // One audit event, attributable to the caller.
    const submitted = await suite.prisma.auditEvent.findMany({
      where: { aggregateId: programme.id, eventType: 'programme.submitted.v1' },
    });

    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.actorId).toBe(suite.fixtures.users.ownerA.id);
    expect(submitted[0]?.projectId).toBe(suite.fixtures.projectA);

    startedWorkflowIds.push(`programme-${programme.id}`);

    if (temporal.ok) {
      const address = optionalEnv('TEMPORAL_ADDRESS') ?? 'localhost:7233';
      const connection = await Connection.connect({ address });
      const client = new Client({
        connection,
        namespace: optionalEnv('TEMPORAL_NAMESPACE') ?? 'default',
      });

      try {
        // The id is part of the contract: the programme's workflow is `programme-<id>`,
        // and the scheduler's activities refuse anything else.
        const description = await client.workflow.getHandle(`programme-${programme.id}`).describe();

        expect(description.workflowId).toBe(`programme-${programme.id}`);
        expect(description.type).toBe('runProgrammeWorkflow');
      } finally {
        await connection.close();
      }
    }
  }, 30_000);

  it('answers a retry with 200, the same programme, and no second row', async () => {
    const a = await createTask(ownerToken, 'Idempotent programme A', [
      'Done when the test passes.',
    ]);
    const key = `programme-${randomUUID()}`;

    const body = {
      projectId: suite.fixtures.projectA,
      objective: 'Submit the same objective twice.',
      tasks: [{ taskId: a, dependsOn: [] }],
    };

    const first = await submit(ownerToken, body, key);
    expect(first.status).toBe(202);

    const second = await submit(ownerToken, body, key);
    expect(second.status).toBe(200);

    const firstBody = first.body as CreatedProgrammeBody;
    const secondBody = second.body as CreatedProgrammeBody;

    expect(secondBody.data.programmeId).toBe(firstBody.data.programmeId);
    expect(secondBody.meta.created).toBe(false);

    expect(
      await suite.prisma.programme.count({
        where: { orgId: suite.fixtures.orgA.id, idempotencyKey: key },
      }),
    ).toBe(1);

    expect(
      await suite.prisma.programmeTask.count({
        where: { programmeId: firstBody.data.programmeId },
      }),
    ).toBe(1);

    startedWorkflowIds.push(`programme-${firstBody.data.programmeId}`);
  }, 30_000);

  it('refuses a dependency cycle and persists nothing', async () => {
    const a = await createTask(ownerToken, 'Cycle A', ['Done when the test passes.']);
    const b = await createTask(ownerToken, 'Cycle B', ['Done when the test passes.']);

    const before = await suite.prisma.programme.count();

    const response = await submit(ownerToken, {
      projectId: suite.fixtures.projectA,
      objective: 'A cycle cannot be scheduled.',
      tasks: [
        { taskId: a, dependsOn: [b] },
        { taskId: b, dependsOn: [a] },
      ],
    });

    expect(response.status).toBe(400);

    const body = response.body as ApiErrorBody;
    expect(body.error.code).toBe('PROGRAMME_GRAPH_INVALID');

    // The cycle is reported against a node, so it lands under `tasks.<id>`; flattening the
    // details is what makes the assertion independent of which node the DFS started from.
    expect(
      Object.values(body.error.details ?? {})
        .flat()
        .join(' '),
    ).toContain('Dependency cycle');

    expect(await suite.prisma.programme.count()).toBe(before);
  }, 30_000);

  it('refuses a self-dependency, a dependency outside the programme, and a missing criterion', async () => {
    const a = await createTask(ownerToken, 'Graph A', ['Done when the test passes.']);
    const noCriteria = await createTask(ownerToken, 'Graph B — no criteria', []);
    const outside = await createTask(ownerToken, 'Graph C — not submitted', ['Done.']);
    const estranged = await createTask(ownerToken, 'Graph D', ['Done.']);

    // Self-dependency.
    const selfDep = await submit(ownerToken, {
      projectId: suite.fixtures.projectA,
      objective: 'Self dependency.',
      tasks: [{ taskId: a, dependsOn: [a] }],
    });

    expect(selfDep.status).toBe(400);
    expect(((selfDep.body as ApiErrorBody).error.details ?? {})[`tasks.${a}`]?.join(' ')).toContain(
      'depends on itself',
    );

    // A dependency that is not in the submitted graph, although the task exists.
    const unknownDep = await submit(ownerToken, {
      projectId: suite.fixtures.projectA,
      objective: 'Missing edge.',
      tasks: [{ taskId: estranged, dependsOn: [outside] }],
    });

    expect(unknownDep.status).toBe(400);
    expect(
      ((unknownDep.body as ApiErrorBody).error.details ?? {})[`tasks.${estranged}`]?.join(' '),
    ).toContain('not a task in this programme');

    // A task with nothing to check cannot be judged succeeded.
    const missingCriteria = await submit(ownerToken, {
      projectId: suite.fixtures.projectA,
      objective: 'No acceptance criteria.',
      tasks: [{ taskId: noCriteria, dependsOn: [] }],
    });

    expect(missingCriteria.status).toBe(400);
    expect(
      ((missingCriteria.body as ApiErrorBody).error.details ?? {})[`tasks.${noCriteria}`]?.join(
        ' ',
      ),
    ).toContain('no acceptance criteria');
  }, 30_000);

  it('does not let a caller submit tasks from another organisation or project', async () => {
    // A task that exists, but in organisation B. From organisation A's route it must not
    // resolve — the same 400 as a task that does not exist, so the endpoint is not an
    // existence oracle across tenants.
    const foreignTask = await suite.prisma.task.create({
      data: {
        orgId: suite.fixtures.orgB.id,
        projectId: suite.fixtures.projectB,
        workspaceId: suite.fixtures.workspaceB,
        title: 'Foreign task',
        goal: 'Belongs to the other tenant.',
        status: 'ready',
        riskClass: 'LOW',
        acceptanceCriteria: ['x'],
        createdById: suite.fixtures.users.ownerB.id,
        idempotencyKey: `foreign-${randomUUID()}`,
      },
      select: { id: true },
    });

    const response = await submit(ownerToken, {
      projectId: suite.fixtures.projectA,
      objective: 'Cross-tenant reference.',
      tasks: [{ taskId: foreignTask.id, dependsOn: [] }],
    });

    expect(response.status).toBe(400);

    const body = response.body as ApiErrorBody;
    expect(body.error.code).toBe('PROGRAMME_GRAPH_INVALID');
    expect(body.error.details?.graph?.join(' ')).toContain('does not exist in this project');

    // A project that belongs to another organisation is a 404, not a 403: a 403 would
    // confirm the id is real.
    const foreignProject = await submit(ownerToken, {
      projectId: suite.fixtures.projectB,
      objective: 'Cross-tenant project.',
      tasks: [{ taskId: foreignTask.id, dependsOn: [] }],
    });

    expect(foreignProject.status).toBe(404);
    expect((foreignProject.body as ApiErrorBody).error.code).toBe('NOT_FOUND');
  }, 30_000);

  it('refuses an unknown field in the body', async () => {
    const a = await createTask(ownerToken, 'Strict body A', ['Done.']);

    const response = await submit(ownerToken, {
      projectId: suite.fixtures.projectA,
      objective: 'Strict.',
      tasks: [{ taskId: a, dependsOn: [] }],
      // The schema is strict: a tenant field in the body must be impossible by construction.
      orgId: suite.fixtures.orgB.id,
    });

    expect(response.status).toBe(400);
    expect((response.body as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');
  }, 30_000);

  it('lets a VIEWER see nothing new: submission requires MEMBER', async () => {
    const a = await createTask(ownerToken, 'Role A', ['Done.']);

    // The fixture set has a viewer in org A. A viewer cannot submit a programme: starting
    // work is a write, and the role ladder is the same one `POST /run` uses.
    const viewerToken = await login(suite.app, suite.fixtures.users.viewerA.email);

    const response = await submit(viewerToken, {
      projectId: suite.fixtures.projectA,
      objective: 'A viewer must not schedule work.',
      tasks: [{ taskId: a, dependsOn: [] }],
    });

    expect(response.status).toBe(403);
  }, 30_000);

  it('accepts a submission from a MEMBER, the same role that may start a single run', async () => {
    const a = await createTask(memberToken, 'Member A', ['Done when the test passes.']);

    const response = await submit(memberToken, {
      projectId: suite.fixtures.projectA,
      objective: 'A member schedules work.',
      tasks: [{ taskId: a, dependsOn: [] }],
    });

    expect(response.status).toBe(202);

    const body = response.body as CreatedProgrammeBody;
    startedWorkflowIds.push(`programme-${body.data.programmeId}`);
  }, 30_000);
});

/**
 * `POST /v1/orgs/:orgId/programmes/:programmeId/cancel` — stopping a programme.
 *
 * This suite has no worker polling the programme queue, so a submitted programme stays
 * `pending` with `startedAt = null`. That is not a gap in the test: it is exactly the
 * branch where the API owns the terminal state, because no execution will ever run to
 * write it. The branch where a *started* programme is closed by its workflow is proved in
 * `apps/worker/test/programme-cancellation.test.ts`, against a real worker and a real
 * database.
 *
 * What is asserted here:
 *
 *   - a MEMBER can cancel a programme that never started, and the row is closed by the API
 *     with `failureCode = CANCELLED`, one audit event, and no objective in the payload;
 *   - a terminal programme is refused with `409 PROGRAMME_NOT_CANCELLABLE`, nothing written;
 *   - another organisation's programme is a `404`, never a `403`;
 *   - an unknown id is a `404`;
 *   - a second cancellation answers `200 already_cancelled` and does not move `finishedAt`.
 */
describe('programme cancellation', () => {
  interface CancelBody {
    data: {
      programmeId: string;
      cancellation: string;
      recordedBy?: string;
    };
  }

  function cancel(
    token: string,
    programmeId: string,
    orgId: string = suite.fixtures.orgA.id,
  ): request.Test {
    return request(suite.app.getHttpServer())
      .post(`/v1/orgs/${orgId}/programmes/${programmeId}/cancel`)
      .set(authHeaders(token, orgId));
  }

  it('cancels a programme that never started, records CANCELLED, and answers 202', async (context) => {
    if (!temporal.ok) {
      // The cancellation request goes to the orchestrator before any row is written; with
      // no orchestrator the endpoint answers 503 by design. A silent pass would claim a
      // behaviour that was never exercised.
      context.skip(temporal.reason);
    }

    const a = await createTask(memberToken, 'Cancel A', ['Done when the test passes.']);
    const b = await createTask(memberToken, 'Cancel B', ['Done when the test passes.']);
    const objective = 'A member cancels a programme before it starts.';

    const submitted = await submit(memberToken, {
      projectId: suite.fixtures.projectA,
      objective,
      tasks: [
        { taskId: a, dependsOn: [] },
        { taskId: b, dependsOn: [a] },
      ],
    });

    expect(submitted.status).toBe(202);

    const { programmeId } = (submitted.body as CreatedProgrammeBody).data;
    startedWorkflowIds.push(`programme-${programmeId}`);

    const response = await cancel(memberToken, programmeId);

    expect(response.status).toBe(202);
    expect((response.body as CancelBody).data).toEqual({
      programmeId,
      cancellation: 'cancelled_before_start',
      recordedBy: 'api',
    });

    const row = await suite.prisma.programme.findUniqueOrThrow({
      where: { id: programmeId },
    });

    expect(row.status).toBe('cancelled');
    expect(row.failureCode).toBe('CANCELLED');
    expect(row.failureReason).toContain('no task was dispatched');
    expect(row.startedAt).toBeNull();
    expect(row.finishedAt).not.toBeNull();

    // One event, attributable to the caller, and it names the writer. The objective is
    // deliberately absent: the submission event already carries it, and an audit row that
    // echoed programme content would make every cancellation a second copy of it.
    const events = await suite.prisma.auditEvent.findMany({
      where: { aggregateId: programmeId, eventType: 'programme.cancel_requested.v1' },
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.actorId).toBe(suite.fixtures.users.memberA.id);
    expect(events[0]?.idempotencyKey).toBe(`programme.cancel_requested:${programmeId}`);
    expect(events[0]?.payload).toMatchObject({
      programmeId,
      actorId: suite.fixtures.users.memberA.id,
      recordedBy: 'api',
      previousStatus: 'pending',
    });
    expect(JSON.stringify(events[0]?.payload)).not.toContain(objective);
  }, 30_000);

  it('hands a started programme to its workflow: 202 requested, and the API writes no status', async (context) => {
    if (!temporal.ok) {
      context.skip(temporal.reason);
    }

    const a = await createTask(ownerToken, 'Started A', ['Done when the test passes.']);

    const submitted = await submit(ownerToken, {
      projectId: suite.fixtures.projectA,
      objective: 'A started programme is closed by its workflow, not by the API.',
      tasks: [{ taskId: a, dependsOn: [] }],
    });

    expect(submitted.status).toBe(202);

    const { programmeId } = (submitted.body as CreatedProgrammeBody).data;
    startedWorkflowIds.push(`programme-${programmeId}`);

    // Forced, and stated: no worker polls this queue, so `loadProgrammeActivity` never
    // runs. This is exactly the pair of columns that activity writes on its first call
    // (`status: 'running'`, `startedAt`), and the branch under test is "the scheduler has
    // taken the row".
    const startedAt = new Date();
    await suite.prisma.programme.update({
      where: { id: programmeId },
      data: { status: 'running', startedAt },
    });

    const response = await cancel(ownerToken, programmeId);

    expect(response.status).toBe(202);
    expect((response.body as CancelBody).data).toEqual({
      programmeId,
      cancellation: 'requested',
      recordedBy: 'workflow',
    });

    // The API wrote **nothing** to the status: the workflow's own non-cancellable scope
    // records `cancelled` when it observes the cancellation, and two writers for one
    // terminal state is the failure this branch exists to avoid.
    const row = await suite.prisma.programme.findUniqueOrThrow({ where: { id: programmeId } });

    expect(row.status).toBe('running');
    expect(row.failureCode).toBeNull();
    expect(row.finishedAt).toBeNull();
    expect(row.startedAt?.getTime()).toBe(startedAt.getTime());

    const events = await suite.prisma.auditEvent.findMany({
      where: { aggregateId: programmeId, eventType: 'programme.cancel_requested.v1' },
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      programmeId,
      recordedBy: 'workflow',
      previousStatus: 'running',
    });
  }, 30_000);

  it('refuses a programme that already succeeded, leaving the row untouched', async (context) => {
    if (!temporal.ok) {
      context.skip(temporal.reason);
    }

    const a = await createTask(ownerToken, 'Succeeded A', ['Done when the test passes.']);

    const submitted = await submit(ownerToken, {
      projectId: suite.fixtures.projectA,
      objective: 'A programme that already finished has nothing to stop.',
      tasks: [{ taskId: a, dependsOn: [] }],
    });

    expect(submitted.status).toBe(202);

    const { programmeId } = (submitted.body as CreatedProgrammeBody).data;
    startedWorkflowIds.push(`programme-${programmeId}`);

    // Forced, and stated: no worker polls this queue, so the row cannot reach `succeeded`
    // on its own here. The endpoint's contract is about the row's state, not about how it
    // got there — the transition itself is covered by the worker suite.
    const finishedAt = new Date();
    await suite.prisma.programme.update({
      where: { id: programmeId },
      data: { status: 'succeeded', startedAt: finishedAt, finishedAt, failureCode: null },
    });

    const response = await cancel(ownerToken, programmeId);

    expect(response.status).toBe(409);
    expect((response.body as ApiErrorBody).error.code).toBe('PROGRAMME_NOT_CANCELLABLE');
    expect((response.body as ApiErrorBody).error.message).toContain('succeeded');

    const row = await suite.prisma.programme.findUniqueOrThrow({ where: { id: programmeId } });

    expect(row.status).toBe('succeeded');
    expect(row.failureCode).toBeNull();
    expect(row.finishedAt?.getTime()).toBe(finishedAt.getTime());

    // Nothing written: a refusal is not a cancellation request.
    expect(
      await suite.prisma.auditEvent.count({
        where: { aggregateId: programmeId, eventType: 'programme.cancel_requested.v1' },
      }),
    ).toBe(0);
  }, 30_000);

  it('answers 404, not 403, for another organisation’s programme', async () => {
    // The programme exists, in organisation B. From organisation A's route it must not
    // resolve: a 403 would confirm the id is real, which is an existence oracle across
    // tenants.
    const foreign = await suite.prisma.programme.create({
      data: {
        orgId: suite.fixtures.orgB.id,
        projectId: suite.fixtures.projectB,
        objective: 'Belongs to the other tenant.',
        idempotencyKey: `foreign-programme-${randomUUID()}`,
      },
      select: { id: true },
    });

    const response = await cancel(ownerToken, foreign.id);

    expect(response.status).toBe(404);
    expect((response.body as ApiErrorBody).error.code).toBe('NOT_FOUND');

    const row = await suite.prisma.programme.findUniqueOrThrow({ where: { id: foreign.id } });
    expect(row.status).toBe('pending');
    expect(row.finishedAt).toBeNull();
  }, 30_000);

  it('answers 404 for a programme that does not exist', async () => {
    const response = await cancel(ownerToken, randomUUID());

    expect(response.status).toBe(404);
    expect((response.body as ApiErrorBody).error.code).toBe('NOT_FOUND');
  }, 30_000);

  it('refuses with 409 when the row claims an execution Temporal does not have', async (context) => {
    if (!temporal.ok) {
      context.skip(temporal.reason);
    }

    // The state `POST /programmes` leaves when its start failed but the row was not marked
    // failed: `running` with `startedAt`, and nothing in Temporal under `programme-<id>`.
    // Written directly rather than constructed through a failure, because the endpoint's
    // contract is about the row's state and `submit` compensates that state today.
    const a = await createTask(ownerToken, 'No execution A', ['Done when the test passes.']);

    const programme = await suite.prisma.programme.create({
      data: {
        orgId: suite.fixtures.orgA.id,
        projectId: suite.fixtures.projectA,
        objective: 'A row that claims a scheduler Temporal does not have.',
        status: 'running',
        startedAt: new Date(),
        idempotencyKey: `no-execution-${randomUUID()}`,
      },
      select: { id: true },
    });

    await suite.prisma.programmeTask.create({
      data: {
        orgId: suite.fixtures.orgA.id,
        programmeId: programme.id,
        taskId: a,
        dependsOn: [],
      },
    });

    const response = await cancel(ownerToken, programme.id);

    expect(response.status).toBe(409);
    expect((response.body as ApiErrorBody).error.code).toBe('EXECUTION_NOT_FOUND');

    const row = await suite.prisma.programme.findUniqueOrThrow({ where: { id: programme.id } });

    // Refusing means writing nothing: a programme marked cancelled whose scheduler cannot
    // be reached is the failure `task.cancel` refuses for the same reason.
    expect(row.status).toBe('running');
    expect(row.finishedAt).toBeNull();
    expect(
      await suite.prisma.auditEvent.count({
        where: { aggregateId: programme.id, eventType: 'programme.cancel_requested.v1' },
      }),
    ).toBe(0);
  }, 30_000);

  it('refuses with 503 while the orchestrator is unreachable, writing nothing', async () => {
    const a = await createTask(ownerToken, 'Offline cancel A', ['Done when the test passes.']);

    const programme = await suite.prisma.programme.create({
      data: {
        orgId: suite.fixtures.orgA.id,
        projectId: suite.fixtures.projectA,
        objective: 'A cancellation attempted while the orchestrator is down.',
        status: 'running',
        startedAt: new Date(),
        idempotencyKey: `offline-cancel-${randomUUID()}`,
      },
      select: { id: true },
    });

    await suite.prisma.programmeTask.create({
      data: {
        orgId: suite.fixtures.orgA.id,
        programmeId: programme.id,
        taskId: a,
        dependsOn: [],
      },
    });

    const response = await request(offline.app.getHttpServer())
      .post(`/v1/orgs/${suite.fixtures.orgA.id}/programmes/${programme.id}/cancel`)
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id));

    expect(response.status).toBe(503);
    expect((response.body as ApiErrorBody).error.code).toBe('ORCHESTRATOR_UNAVAILABLE');

    const row = await suite.prisma.programme.findUniqueOrThrow({ where: { id: programme.id } });

    expect(row.status).toBe('running');
    expect(row.finishedAt).toBeNull();
  }, 30_000);

  it('answers a second cancellation with 200 already_cancelled and does not move finishedAt', async (context) => {
    if (!temporal.ok) {
      context.skip(temporal.reason);
    }

    const a = await createTask(ownerToken, 'Double cancel A', ['Done when the test passes.']);

    const submitted = await submit(ownerToken, {
      projectId: suite.fixtures.projectA,
      objective: 'Cancel the same programme twice.',
      tasks: [{ taskId: a, dependsOn: [] }],
    });

    expect(submitted.status).toBe(202);

    const { programmeId } = (submitted.body as CreatedProgrammeBody).data;
    startedWorkflowIds.push(`programme-${programmeId}`);

    const first = await cancel(ownerToken, programmeId);
    expect(first.status).toBe(202);

    const cancelled = await suite.prisma.programme.findUniqueOrThrow({
      where: { id: programmeId },
    });

    const second = await cancel(ownerToken, programmeId);

    expect(second.status).toBe(200);
    expect((second.body as CancelBody).data).toEqual({
      programmeId,
      cancellation: 'already_cancelled',
    });

    const after = await suite.prisma.programme.findUniqueOrThrow({ where: { id: programmeId } });

    expect(after.status).toBe('cancelled');
    // A second write would move this. Equality is the assertion that it did not happen.
    expect(after.finishedAt?.getTime()).toBe(cancelled.finishedAt?.getTime());

    // And no second event: the deterministic key names one cancellation.
    expect(
      await suite.prisma.auditEvent.count({
        where: { aggregateId: programmeId, eventType: 'programme.cancel_requested.v1' },
      }),
    ).toBe(1);
  }, 30_000);
});
