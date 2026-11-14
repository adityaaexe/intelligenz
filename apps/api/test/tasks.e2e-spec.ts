import { Client, Connection } from '@temporalio/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiErrorBody, ApprovalBody, DataBody, PageBody, RunBody, TaskBody } from './helpers/api-types';
import type { Suite, TemporalProbe } from './helpers/app';
import { authHeaders, createTestApp, login, probeTemporal, startSuite } from './helpers/app';
import { optionalEnv } from './helpers/env';

/**
 * Task lifecycle — required cases 4, 5, 6, 7 and 10.
 *
 * Two applications are booted against the same database:
 *
 *   - `suite.app` talks to the Temporal address from `.env`;
 *   - `offline.app` is pointed at `127.0.0.1:1`, which is how the
 *     `ORCHESTRATOR_UNAVAILABLE` branch is tested deterministically instead of
 *     depending on whether a dev server happens to be running on this host.
 *
 * The test that genuinely cannot run without Temporal (a real workflow start) skips
 * with the probe's reason rather than passing vacuously.
 */

let suite: Suite;
let offline: { app: Awaited<ReturnType<typeof createTestApp>>; close(): Promise<void> };
let ownerToken: string;
let memberToken: string;
let temporal: TemporalProbe;

const startedWorkflowIds: string[] = [];

beforeAll(async () => {
  suite = await startSuite();

  offline = await (async () => {
    const app = await createTestApp({
      temporal: { address: '127.0.0.1:1', namespace: 'default', taskQueue: 'intelligenz-tasks' },
      readinessTimeoutMs: 1_000,
    });

    return { app, close: () => app.close() };
  })();

  ownerToken = await login(suite.app, suite.fixtures.users.ownerA.email);
  memberToken = await login(suite.app, suite.fixtures.users.memberA.email);
  temporal = await probeTemporal();
});

afterAll(async () => {
  // A started workflow with no worker stays open in the dev store forever. Terminate
  // what this suite started; failure to do so must not fail the suite.
  if (startedWorkflowIds.length > 0) {
    const address = optionalEnv('TEMPORAL_ADDRESS') ?? 'localhost:7233';
    const connection = await Connection.connect({ address }).catch(() => undefined);

    if (connection !== undefined) {
      const client = new Client({ connection });

      for (const workflowId of startedWorkflowIds) {
        await client.workflow
          .getHandle(workflowId)
          .terminate('api test cleanup')
          .catch(() => undefined);
      }

      await connection.close();
    }
  }

  await offline.close();
  await suite.close();
});

function tasksPath(): string {
  return `/v1/orgs/${suite.fixtures.orgA.id}/projects/${suite.fixtures.projectA}/tasks`;
}

function taskPath(taskId: string): string {
  return `/v1/orgs/${suite.fixtures.orgA.id}/tasks/${taskId}`;
}

interface CreateTaskBody {
  data: TaskBody;
  meta: { created: boolean };
}

const lowRiskTask = {
  title: 'Ship the endpoint',
  goal: 'Exercise the task creation path with a LOW risk task.',
  riskClass: 'LOW',
  acceptanceCriteria: ['returns 201', 'writes an audit event'],
} as const;

describe('task creation', () => {
  it('creates a task and writes exactly one task.created.v1 audit event', async () => {
    const response = await request(suite.app.getHttpServer())
      .post(tasksPath())
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .send({ ...lowRiskTask, title: 'Audited task' })
      .expect(201);

    const body = response.body as CreateTaskBody;

    expect(body.meta.created).toBe(true);
    expect(body.data.orgId).toBe(suite.fixtures.orgA.id);
    expect(body.data.workspaceId).toBe(suite.fixtures.workspaceA);
    expect(body.data.status).toBe('draft');

    const audits = await suite.prisma.auditEvent.findMany({
      where: { aggregateId: body.data.id, eventType: 'task.created.v1' },
    });

    expect(audits).toHaveLength(1);
    expect(audits[0]?.orgId).toBe(suite.fixtures.orgA.id);
    expect(audits[0]?.projectId).toBe(suite.fixtures.projectA);
    expect(audits[0]?.actorId).toBe(suite.fixtures.users.ownerA.id);
  });

  it('rejects a body with an unknown field (400 with field details)', async () => {
    const response = await request(suite.app.getHttpServer())
      .post(tasksPath())
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      // `orgId` in the body must be impossible: the schema is strict and has no such field.
      .send({ ...lowRiskTask, orgId: suite.fixtures.orgB.id })
      .expect(400);

    const body = response.body as ApiErrorBody;

    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details).toBeDefined();
  });

  it('is idempotent: the same key returns the existing task with 200 and one row', async () => {
    const headers = { ...authHeaders(ownerToken, suite.fixtures.orgA.id), 'idempotency-key': 'idem-alpha-1' };

    const first = await request(suite.app.getHttpServer())
      .post(tasksPath())
      .set(headers)
      .send({ ...lowRiskTask, title: 'Idempotent task' })
      .expect(201);

    const second = await request(suite.app.getHttpServer())
      .post(tasksPath())
      .set(headers)
      .send({ ...lowRiskTask, title: 'Idempotent task' })
      .expect(200);

    const firstBody = first.body as CreateTaskBody;
    const secondBody = second.body as CreateTaskBody;

    expect(secondBody.data.id).toBe(firstBody.data.id);
    expect(secondBody.meta.created).toBe(false);

    const rows = await suite.prisma.task.count({
      where: { projectId: suite.fixtures.projectA, idempotencyKey: 'idem-alpha-1' },
    });

    expect(rows).toBe(1);
  });

  it('creates a PENDING approval request for a server-classified HIGH risk task', async () => {
    const response = await request(suite.app.getHttpServer())
      .post(tasksPath())
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .set('idempotency-key', 'high-risk-create-1')
      .send({
        title: 'High risk change',
        // Shell execution is a server-side HIGH floor (D-006); the client no longer
        // chooses its own class, so the payload has to *be* high risk, not say so.
        goal: 'Run a shell command that rewrites the build script.',
        riskClass: 'HIGH',
        acceptanceCriteria: [],
      })
      .expect(201);

    const body = response.body as CreateTaskBody;

    const approvals = await suite.prisma.approvalRequest.findMany({
      where: { taskId: body.data.id, orgId: suite.fixtures.orgA.id },
    });

    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.status).toBe('PENDING');
    expect(approvals[0]?.riskClass).toBe('HIGH');
    // Bound from birth: the grant names the content it is about before anyone decides.
    expect(approvals[0]?.taskContentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(approvals[0]?.executionProfile).toBe('standard');
  });
});

describe('pagination', () => {
  it('pages by cursor without repeating or skipping a row', async () => {
    const firstPage = await request(suite.app.getHttpServer())
      .get(`${tasksPath()}?limit=2`)
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .expect(200);

    const firstBody = firstPage.body as PageBody<TaskBody>;

    expect(firstBody.data).toHaveLength(2);
    expect(firstBody.meta.limit).toBe(2);

    if (!firstBody.meta.hasMore || firstBody.meta.nextCursor === null) {
      // The fixture set is larger than two tasks, so this is a real failure, not an
      // environment detail.
      throw new Error('Expected more than one page of tasks in the fixture set.');
    }

    const secondPage = await request(suite.app.getHttpServer())
      .get(`${tasksPath()}?limit=2&cursor=${firstBody.meta.nextCursor}`)
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .expect(200);

    const secondBody = secondPage.body as PageBody<TaskBody>;
    const firstIds = firstBody.data.map((task) => task.id);
    const secondIds = secondBody.data.map((task) => task.id);

    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
  });

  it('rejects a cursor from another project (400)', async () => {
    const response = await request(suite.app.getHttpServer())
      .get(`${tasksPath()}?limit=2&cursor=${suite.fixtures.tasks.draftB}`)
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .expect(400);

    expect((response.body as ApiErrorBody).error.code).toBe('INVALID_CURSOR');
  });

  it('rejects a limit outside 1..100 (400)', async () => {
    await request(suite.app.getHttpServer())
      .get(`${tasksPath()}?limit=500`)
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .expect(400);
  });
});

describe('state machine', () => {
  it('rejects queued → succeeded with 422 INVALID_TRANSITION and does not write', async () => {
    const response = await request(suite.app.getHttpServer())
      .patch(taskPath(suite.fixtures.tasks.queuedA))
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .send({ status: 'succeeded' })
      .expect(422);

    const body = response.body as ApiErrorBody;

    expect(body.error.code).toBe('INVALID_TRANSITION');
    expect(body.error.details?.transition?.[0]).toContain('queued');

    const row = await suite.prisma.task.findUniqueOrThrow({
      where: { id: suite.fixtures.tasks.queuedA },
    });

    expect(row.status).toBe('queued');
  });

  /**
   * The integrity test: a MEMBER must not be able to *write* a success.
   *
   * `PATCH` used to accept every legal edge, so four calls —
   * ready → queued → running → verifying → succeeded — produced a terminal
   * "succeeded" task with no workflow run, no agent run and no artifact. The
   * shared machine is right (the worker needs those edges); the endpoint was
   * wrong to offer them to a user.
   */
  it('refuses a user-driven fabrication path at the second call and leaves the task non-terminal', async () => {
    const created = await request(suite.app.getHttpServer())
      .post(tasksPath())
      .set(authHeaders(memberToken, suite.fixtures.orgA.id))
      .set('idempotency-key', 'fabrication-path-1')
      .send({
        title: 'Fabricated success',
        goal: 'A MEMBER tries to walk the execution edges to a terminal success.',
        riskClass: 'LOW',
        acceptanceCriteria: [],
      })
      .expect(201);

    const taskId = (created.body as CreateTaskBody).data.id;

    // Call 1: the one edge a human owns.
    await request(suite.app.getHttpServer())
      .patch(taskPath(taskId))
      .set(authHeaders(memberToken, suite.fixtures.orgA.id))
      .send({ status: 'ready', reason: 'Ready for engineering.' })
      .expect(200);

    // Call 2: `ready → queued` is legal in the machine and owned by POST /run.
    const refused = await request(suite.app.getHttpServer())
      .patch(taskPath(taskId))
      .set(authHeaders(memberToken, suite.fixtures.orgA.id))
      .send({ status: 'queued' })
      .expect(409);

    expect((refused.body as ApiErrorBody).error.code).toBe('TRANSITION_IS_SYSTEM_MANAGED');

    // Calls 3 and 4 cannot be reached: the task is still `ready`, so they are not
    // even edges of the machine.
    await request(suite.app.getHttpServer())
      .patch(taskPath(taskId))
      .set(authHeaders(memberToken, suite.fixtures.orgA.id))
      .send({ status: 'running' })
      .expect(422);

    await request(suite.app.getHttpServer())
      .patch(taskPath(taskId))
      .set(authHeaders(memberToken, suite.fixtures.orgA.id))
      .send({ status: 'succeeded' })
      .expect(422);

    const row = await suite.prisma.task.findUniqueOrThrow({ where: { id: taskId } });

    // Non-terminal, and nothing was executed on its behalf.
    expect(row.status).toBe('ready');
    expect(await suite.prisma.workflowRun.count({ where: { taskId } })).toBe(0);
    expect(await suite.prisma.artifact.count({ where: { taskId } })).toBe(0);
  });

  it('refuses every execution edge on a task that is in that state (409, not 422)', async () => {
    // `queuedA` is left `queued` by the fixture; `queued → running` is a real edge
    // the orchestrator owns.
    const response = await request(suite.app.getHttpServer())
      .patch(taskPath(suite.fixtures.tasks.queuedA))
      .set(authHeaders(memberToken, suite.fixtures.orgA.id))
      .send({ status: 'running' })
      .expect(409);

    expect((response.body as ApiErrorBody).error.code).toBe('TRANSITION_IS_SYSTEM_MANAGED');

    const row = await suite.prisma.task.findUniqueOrThrow({
      where: { id: suite.fixtures.tasks.queuedA },
    });

    expect(row.status).toBe('queued');
  });

  it('requires a reason when moving a task to ready', async () => {
    const response = await request(suite.app.getHttpServer())
      .patch(taskPath(suite.fixtures.tasks.draftA))
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .send({ status: 'ready' })
      .expect(400);

    expect((response.body as ApiErrorBody).error.details?.reason).toBeDefined();
  });

  it('applies an allowed transition and audits it', async () => {
    const response = await request(suite.app.getHttpServer())
      .patch(taskPath(suite.fixtures.tasks.draftA))
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .send({ status: 'ready', reason: 'Ready for engineering.' })
      .expect(200);

    expect((response.body as DataBody<TaskBody>).data.status).toBe('ready');

    const audits = await suite.prisma.auditEvent.findMany({
      where: {
        aggregateId: suite.fixtures.tasks.draftA,
        eventType: 'task.status_changed.v1',
      },
    });

    expect(audits).toHaveLength(1);
  });
});

/**
 * F5 — documented, not silently changed.
 *
 * The approval gate is risk-class based: `requiresApproval` is true for `HIGH` and
 * `CRITICAL` only. A `MEMBER` can therefore create a task labelled `LOW` and run it
 * with no approval at all. That is a real bypass of the approvals screen as a control,
 * and it is a **product decision**, not a bug to patch by reclassifying risk on the
 * owner's behalf: many low-risk edits are meant to run unattended.
 *
 * The decision is recorded in `docs/decisions/OPEN-DECISIONS.md` (D-006) with options
 * and a recommendation. This test exists so the current behaviour is *visible* — if a
 * later change closes the bypass, this test fails and the decision gets updated.
 */
describe('approval gate — current behaviour for LOW risk (F5, documented)', () => {
  it('lets a MEMBER run a LOW task with no approval request, because LOW is not gated', async () => {
    const created = await request(suite.app.getHttpServer())
      .post(tasksPath())
      .set(authHeaders(memberToken, suite.fixtures.orgA.id))
      .set('idempotency-key', 'member-low-bypass-1')
      .send({
        title: 'LOW change started by a MEMBER with no approval',
        goal: 'Document the current approval policy: LOW is self-attested.',
        riskClass: 'LOW',
        acceptanceCriteria: [],
      })
      .expect(201);

    const taskId = (created.body as CreateTaskBody).data.id;

    await request(suite.app.getHttpServer())
      .patch(taskPath(taskId))
      .set(authHeaders(memberToken, suite.fixtures.orgA.id))
      .send({ status: 'ready', reason: 'Ready to run.' })
      .expect(200);

    // No approval row was ever created for this task: `requiresApproval('LOW')` is false.
    expect(await suite.prisma.approvalRequest.count({ where: { taskId } })).toBe(0);

    // The run is accepted on the same terms as any other LOW task. With Temporal up it
    // is a 202; without it, the orchestrator failure is 503 — either way the approval
    // gate did not refuse it, which is the behaviour under test.
    const run = await request(suite.app.getHttpServer())
      .post(`${taskPath(taskId)}/run`)
      .set(authHeaders(memberToken, suite.fixtures.orgA.id));

    expect([202, 503]).toContain(run.status);
  });
});

describe('approval gate (contract §15 A3)', () => {
  it('refuses to start a HIGH risk task without an approved request', async () => {
    const response = await request(suite.app.getHttpServer())
      .post(`${taskPath(suite.fixtures.tasks.highReadyA)}/run`)
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .expect(409);

    const body = response.body as ApiErrorBody;

    expect(body.error.code).toBe('APPROVAL_REQUIRED');

    const row = await suite.prisma.task.findUniqueOrThrow({
      where: { id: suite.fixtures.tasks.highReadyA },
    });

    expect(row.status).toBe('ready');

    // The refusal is an event, not a silent no-op.
    const audits = await suite.prisma.auditEvent.findMany({
      where: {
        aggregateId: suite.fixtures.tasks.highReadyA,
        eventType: 'task.transition_refused.v1',
      },
    });

    expect(audits.length).toBeGreaterThan(0);
    expect(audits[0]?.payload).toMatchObject({ reason: 'approval_required', to: 'queued' });
  });

  it('cannot be queued through PATCH, and names the approval that is missing first', async () => {    // `ready → queued` is a real edge of the state machine, owned by the orchestrator.
    // Refusing it here is what makes `POST /run` (and its approval gate) the only way
    // to execution; without it a MEMBER could queue a CRITICAL task with two calls and
    // never touch the gate.
    //
    // Phase 4 answers `APPROVAL_REQUIRED` rather than the generic system-managed
    // refusal when the task is HIGH/CRITICAL and has no live grant: both refuse, but
    // the first is the reason the person cannot proceed. The check does not consume
    // the grant — this call can never queue anything.
    const response = await request(suite.app.getHttpServer())
      .patch(taskPath(suite.fixtures.tasks.highReadyA))
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .send({ status: 'queued' })
      .expect(409);

    expect((response.body as ApiErrorBody).error.code).toBe('APPROVAL_REQUIRED');

    const row = await suite.prisma.task.findUniqueOrThrow({
      where: { id: suite.fixtures.tasks.highReadyA },
    });

    expect(row.status).toBe('ready');
    expect(
      await suite.prisma.workflowRun.count({ where: { taskId: suite.fixtures.tasks.highReadyA } }),
    ).toBe(0);

    // Nothing was spent: the refusal is a precondition check, not a use.
    const approval = await suite.prisma.approvalRequest.findUniqueOrThrow({
      where: { id: suite.fixtures.pendingApprovalId },
    });

    expect(approval.consumedAt).toBeNull();
  });

  it('allows the same task once the request is approved', async () => {
    const decision = await request(suite.app.getHttpServer())
      .post(`/v1/orgs/${suite.fixtures.orgA.id}/approvals/${suite.fixtures.pendingApprovalId}/decision`)
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .send({ decision: 'approve', note: 'Reviewed: bounded and reversible.' })
      .expect(200);

    expect((decision.body as DataBody<ApprovalBody>).data.status).toBe('APPROVED');

    const run = await request(suite.app.getHttpServer())
      .post(`${taskPath(suite.fixtures.tasks.highReadyA)}/run`)
      .set(authHeaders(memberToken, suite.fixtures.orgA.id));

    // With Temporal up: 202 and a real run. Without it: a typed 503. Both are
    // correct; what must never happen is a task left `running`.
    expect([202, 503]).toContain(run.status);

    if (run.status === 503) {
      expect((run.body as ApiErrorBody).error.code).toBe('ORCHESTRATOR_UNAVAILABLE');
      console.warn(`[tasks] run returned 503 — ${temporal.reason}`);
    } else {
      const body = run.body as DataBody<RunBody>;

      startedWorkflowIds.push(body.data.workflowId);
      expect(body.data.workflowId).toBe(`task-${suite.fixtures.tasks.highReadyA}`);
      expect(body.data.status).toBe('queued');
    }

    const row = await suite.prisma.task.findUniqueOrThrow({
      where: { id: suite.fixtures.tasks.highReadyA },
    });

    expect(row.status).not.toBe('running');

    if (run.status === 503) {
      expect(row.status).toBe('ready');
    } else {
      expect(row.status).toBe('queued');
    }
  });

  it('records an approval.decided.v1 audit event naming the approver', async () => {
    const audits = await suite.prisma.auditEvent.findMany({
      where: { aggregateId: suite.fixtures.pendingApprovalId, eventType: 'approval.decided.v1' },
    });

    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorId).toBe(suite.fixtures.users.ownerA.id);
  });

  it('refuses a second decision on the same request (409)', async () => {
    const response = await request(suite.app.getHttpServer())
      .post(`/v1/orgs/${suite.fixtures.orgA.id}/approvals/${suite.fixtures.pendingApprovalId}/decision`)
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .send({ decision: 'reject', note: 'Too late.' })
      .expect(409);

    expect((response.body as ApiErrorBody).error.code).toBe('ALREADY_DECIDED');
  });

  it('requires a note when rejecting (400)', async () => {
    const task = await request(suite.app.getHttpServer())
      .post(tasksPath())
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .set('idempotency-key', 'reject-flow-1')
      .send({
        title: 'Needs review',
        // Server-derived HIGH (shell), so an approval request exists to reject.
        goal: 'Run a shell command and then ask for it to be rejected without a note.',
        riskClass: 'HIGH',
        acceptanceCriteria: [],
      })
      .expect(201);

    const taskBody = task.body as CreateTaskBody;
    const approval = await suite.prisma.approvalRequest.findFirstOrThrow({
      where: { taskId: taskBody.data.id },
    });

    const response = await request(suite.app.getHttpServer())
      .post(`/v1/orgs/${suite.fixtures.orgA.id}/approvals/${approval.id}/decision`)
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .send({ decision: 'reject' })
      .expect(400);

    expect((response.body as ApiErrorBody).error.details?.note).toBeDefined();
  });
});

describe('orchestrator unavailable', () => {
  it('returns 503, leaves the task ready, and records the failed start', async () => {
    // A LOW risk task so the approval gate is not in the way of the branch under test.
    const created = await request(suite.app.getHttpServer())
      .post(tasksPath())
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .set('idempotency-key', 'offline-run-1')
      .send({
        title: 'Offline run',
        goal: 'Start a workflow while the orchestrator address is unreachable.',
        riskClass: 'LOW',
        acceptanceCriteria: [],
      })
      .expect(201);

    const taskId = (created.body as CreateTaskBody).data.id;

    await request(suite.app.getHttpServer())
      .patch(taskPath(taskId))
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .send({ status: 'ready', reason: 'Ready to run.' })
      .expect(200);

    const response = await request(offline.app.getHttpServer())
      .post(`${taskPath(taskId)}/run`)
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .expect(503);

    expect((response.body as ApiErrorBody).error.code).toBe('ORCHESTRATOR_UNAVAILABLE');

    const row = await suite.prisma.task.findUniqueOrThrow({ where: { id: taskId } });

    // The whole point: a failed start must not leave the task looking alive.
    expect(row.status).toBe('ready');

    const run = await suite.prisma.workflowRun.findFirstOrThrow({
      where: { taskId, orgId: suite.fixtures.orgA.id },
      orderBy: { createdAt: 'desc' },
    });

    expect(run.status).toBe('failed');
    expect(run.workflowId).toBe(`task-${taskId}`);
    expect(run.temporalRunId).toBeNull();

    const audits = await suite.prisma.auditEvent.findMany({
      where: { aggregateId: run.id, eventType: 'workflow.start_failed.v1' },
    });

    expect(audits).toHaveLength(1);
  });

  it('refuses to cancel while the orchestrator is unreachable, leaving status untouched', async () => {
    const created = await request(suite.app.getHttpServer())
      .post(tasksPath())
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .set('idempotency-key', 'offline-cancel-1')
      .send({
        title: 'Queued for cancellation',
        goal: 'Exercise the cancel path with no orchestrator.',
        riskClass: 'LOW',
        acceptanceCriteria: [],
      })
      .expect(201);

    const taskId = (created.body as CreateTaskBody).data.id;

    // Put it in a cancellable state directly: the run endpoint needs Temporal, which
    // is exactly what this test is pretending is missing.
    await suite.prisma.task.update({ where: { id: taskId }, data: { status: 'running' } });

    const response = await request(offline.app.getHttpServer())
      .post(`${taskPath(taskId)}/cancel`)
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .expect(503);

    expect((response.body as ApiErrorBody).error.code).toBe('ORCHESTRATOR_UNAVAILABLE');

    const row = await suite.prisma.task.findUniqueOrThrow({ where: { id: taskId } });

    expect(row.status).toBe('running');
  });
});

describe('workflow start (requires Temporal)', () => {
  it('starts runTaskWorkflow on intelligenz-tasks with the deterministic id', async (context) => {
    if (!temporal.ok) {
      // Visible skip with the environment's own words. A silent pass here would be a
      // lie about what was verified.
      context.skip(temporal.reason);
    }

    const created = await request(suite.app.getHttpServer())
      .post(tasksPath())
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .set('idempotency-key', 'real-run-1')
      .send({
        title: 'Real workflow start',
        goal: 'Start a workflow against the configured Temporal server.',
        riskClass: 'LOW',
        acceptanceCriteria: [],
      })
      .expect(201);

    const taskId = (created.body as CreateTaskBody).data.id;

    await request(suite.app.getHttpServer())
      .patch(taskPath(taskId))
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .send({ status: 'ready', reason: 'Ready to run.' })
      .expect(200);

    const response = await request(suite.app.getHttpServer())
      .post(`${taskPath(taskId)}/run`)
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .expect(202);

    const run = response.body as DataBody<RunBody>;

    startedWorkflowIds.push(run.data.workflowId);

    expect(run.data.workflowId).toBe(`task-${taskId}`);
    expect(run.data.temporalRunId).toHaveLength(36);

    // The workflow exists in Temporal, under the expected type and task queue.
    const address = optionalEnv('TEMPORAL_ADDRESS') ?? 'localhost:7233';
    const connection = await Connection.connect({ address });
    const client = new Client({ connection, namespace: optionalEnv('TEMPORAL_NAMESPACE') ?? 'default' });

    try {
      const description = await client.workflow.getHandle(run.data.workflowId).describe();

      expect(description.type).toBe('runTaskWorkflow');
      expect(description.taskQueue).toBe(optionalEnv('TEMPORAL_TASK_QUEUE') ?? 'intelligenz-tasks');
    } finally {
      await connection.close();
    }

    const auditRow = await suite.prisma.auditEvent.findFirstOrThrow({
      where: { aggregateId: run.data.workflowRunId, eventType: 'workflow.started.v1' },
    });

    expect(auditRow.payload).toMatchObject({ workflowId: run.data.workflowId, taskId });
  });
});
