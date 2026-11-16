import { randomUUID } from 'node:crypto';

import { Client, Connection } from '@temporalio/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/app-config';
import type { ApiErrorBody, DataBody, TaskBody } from './helpers/api-types';
import type { Suite, TemporalProbe } from './helpers/app';
import { authHeaders, login, probeTemporal, startSuite } from './helpers/app';
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

beforeAll(async () => {
  const base = loadConfig();

  suite = await startSuite({
    appOverrides: {
      // No worker polls this queue: the parent workflow is created and stays queued, which
      // is exactly what "the endpoint started it" means.
      temporal: { ...base.temporal, taskQueue },
    },
  });

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
