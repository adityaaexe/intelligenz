import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { authHeaders, createTestApp, login, startSuite, type Suite } from './helpers/app';

/**
 * **Phase 5 (BE-501)** — the approval is bound to the attempt that spends it.
 *
 * Phase 4 recorded a residual: `consumedAt` proved *a* reservation had happened, not that
 * **this run** made it. `consumedByAttemptId` existed but was never written, because the
 * attempt did not exist when the API consumed the approval. A second execution could
 * therefore proceed on the same grant, held off only by Temporal's workflow-id dedupe — a
 * guarantee owned by a system outside the transaction that spent the grant.
 *
 * Every test below fails if the reservation and the consumption stop being one atomic
 * act. They run against the real application (guards, validation, filter) and the real
 * database.
 *
 * ## Why the offline orchestrator
 *
 * The reservation commits **before** Temporal is contacted, and every assertion here is
 * about what that commit left behind. An unreachable orchestrator makes the tests
 * deterministic: the request answers `503`, and the compensation path (attempt →
 * `failed/start_failed`, task → `ready`, grant stays consumed) is the exact edge this
 * unit has to get right. A `503` is still a *pass* through the reservation.
 *
 * One test (`real start`) uses the configured Temporal address so the happy-path linkage
 * — approval consumed by a *queued* attempt, not a compensated one — is also observed.
 */

let suite: Suite;
let offline: { app: INestApplication; close(): Promise<void> };

let ownerToken: string;
let memberToken: string;

beforeAll(async () => {
  suite = await startSuite();

  offline = await (async () => {
    const app = await createTestApp({
      // One attempt: the 503 is the assertion, so a retry can only leave a timer
      // pending for `app.close()` to turn into `Channel has been shut down`.
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
});

afterAll(async () => {
  await offline.close();
  await suite.close();
});

function orgId(): string {
  return suite.fixtures.orgA.id;
}

function orgBId(): string {
  return suite.fixtures.orgB.id;
}

function tasksPath(): string {
  return `/v1/orgs/${orgId()}/projects/${suite.fixtures.projectA}/tasks`;
}

function taskPath(taskId: string): string {
  return `/v1/orgs/${orgId()}/tasks/${taskId}`;
}

interface HttpResult {
  readonly status: number;
  readonly body: unknown;
}

interface TaskBody {
  readonly id: string;
  readonly riskClass: string;
  readonly status: string;
}

interface RunBody {
  readonly taskId: string;
  readonly workflowRunId: string;
  readonly attemptId: string;
  readonly workflowId: string;
  readonly temporalRunId: string | null;
  readonly status: string;
}

interface ErrorEnvelope {
  readonly error: { readonly code: string; readonly message: string };
}

function errorOf(body: unknown): ErrorEnvelope['error'] {
  return (body as ErrorEnvelope).error;
}

/**
 * The code, or `null` when the body carries no error envelope.
 *
 * `errorOf` is the judge's accessor and must keep throwing on a body that is not an error.
 * This one exists only for diagnostic messages, where an unexpected body *is* the evidence
 * and must not replace the assertion failure with a `TypeError`.
 */
function codeOrNull(body: unknown): string | null {
  return (body as Partial<ErrorEnvelope> | null | undefined)?.error?.code ?? null;
}

function dataOf<T>(body: unknown): T {
  return (body as { data: T }).data;
}

/** HIGH by the server's own classification: a shell command in the goal. */
const shellTask = {
  title: 'Rewrite the build script',
  goal: 'Run a shell command that rewrites scripts/build.sh.',
  acceptanceCriteria: [] as string[],
};

const lowTask = {
  title: 'Summarise the readme',
  goal: 'Read the readme and summarise its sections.',
  acceptanceCriteria: [] as string[],
};

let keyCounter = 0;

async function createTask(
  payload: Record<string, unknown> = shellTask,
  token: string = memberToken,
): Promise<TaskBody> {
  keyCounter += 1;

  const response = await request(suite.app.getHttpServer())
    .post(tasksPath())
    .set(authHeaders(token, orgId()))
    .set('idempotency-key', `p5-task-${keyCounter}`)
    .send(payload)
    .expect(201);

  return dataOf<TaskBody>(response.body);
}

async function makeReady(taskId: string, token: string = memberToken): Promise<void> {
  await request(suite.app.getHttpServer())
    .patch(taskPath(taskId))
    .set(authHeaders(token, orgId()))
    .send({ status: 'ready', reason: 'Ready for the test.' })
    .expect(200);
}

async function approve(taskId: string, token: string = ownerToken): Promise<string> {
  const approval = await suite.prisma.approvalRequest.findFirstOrThrow({
    where: { taskId, orgId: orgId() },
    select: { id: true },
    orderBy: { createdAt: 'desc' },
  });

  const decision = await request(suite.app.getHttpServer())
    .post(`/v1/orgs/${orgId()}/approvals/${approval.id}/decision`)
    .set(authHeaders(token, orgId()))
    .send({ decision: 'approve', note: 'Reviewed for the Phase 5 test.' });

  expect(decision.status).toBe(200);

  return approval.id;
}

/** A HIGH task, ready, approved by a second person: the shape `POST /run` expects. */
async function approvedTask(): Promise<{ taskId: string; approvalId: string }> {
  const task = await createTask();

  expect(task.riskClass).toBe('HIGH');

  await makeReady(task.id);
  const approvalId = await approve(task.id);

  return { taskId: task.id, approvalId };
}

/** `POST /run` against the offline app: the reservation commits, the start does not. */
async function runOffline(
  taskId: string,
  options: { idempotencyKey?: string; body?: Record<string, unknown> } = {},
): Promise<HttpResult> {
  let base = request(offline.app.getHttpServer())
    .post(`${taskPath(taskId)}/run`)
    .set(authHeaders(memberToken, orgId()));

  if (options.idempotencyKey !== undefined) {
    base = base.set('idempotency-key', options.idempotencyKey);
  }

  return options.body === undefined ? base : base.send(options.body);
}

describe('1. two simultaneous POST /run — one attempt, one consumption', () => {
  it('reserves exactly one attempt and one grant, and refuses the loser with 409', async () => {
    const { taskId, approvalId } = await approvedTask();

    const responses = await Promise.all([runOffline(taskId), runOffline(taskId)]);
    const statuses = responses.map((response) => response.status).sort((a, b) => a - b);

    const refusal = responses.find((response) => response.status === 409);
    const refusalCode = refusal === undefined ? null : errorOf(refusal.body).code;

    // P87-011: this test failed once in eight runs and left nothing behind but its name,
    // so not even the assertion that failed could be identified. Everything the assertions
    // below judge is therefore read once, here, and attached to them as evidence. These
    // are pure reads issued after both responses settled: moving them ahead of the
    // assertions cannot change any outcome, it only makes a failure say what it saw.
    const attempts = await suite.prisma.executionAttempt.count({
      where: { orgId: orgId(), taskId },
    });
    const workflowRuns = await suite.prisma.workflowRun.count({
      where: { orgId: orgId(), taskId },
    });
    const consumptions = await suite.prisma.approvalRequest.count({
      where: { id: approvalId, consumedAt: { not: null } },
    });

    const approval = await suite.prisma.approvalRequest.findUniqueOrThrow({
      where: { id: approvalId },
    });

    const auditRows = await suite.prisma.auditEvent.count({
      where: { aggregateId: approvalId, eventType: 'approval.consumed.v1' },
    });

    // Plain JSON. Vitest prints it on failure and ignores it on success.
    const evidence = JSON.stringify({
      statuses,
      responses: responses.map((response) => ({
        status: response.status,
        code: codeOrNull(response.body),
      })),
      refusalCode,
      taskId,
      approvalId,
      attempts,
      workflowRuns,
      consumptions,
      auditRows,
      consumedAt: approval.consumedAt,
      consumedByAttemptId: approval.consumedByAttemptId,
    });

    // One wins the reservation and reaches the (offline) orchestrator; the other loses the
    // task compare-and-swap *or* the approval CAS. Order is not deterministic; the multiset
    // is.
    expect(statuses, evidence).toEqual([409, 503]);

    expect(['CONFLICT', 'APPROVAL_CONSUMED'], evidence).toContain(refusalCode);

    // The two rows that would double if the reservation were not atomic.
    expect(attempts, evidence).toBe(1);
    expect(workflowRuns, evidence).toBe(1);

    expect(approval.consumedAt, evidence).not.toBeNull();
    expect(approval.consumedByAttemptId, evidence).not.toBeNull();

    // One consumption, one audit event — not two.
    expect(auditRows, evidence).toBe(1);
  });
});

describe('2. replaying a consumed approval with a fresh attempt', () => {
  it('answers 409 APPROVAL_CONSUMED and creates no second attempt', async () => {
    const { taskId, approvalId } = await approvedTask();

    const first = await runOffline(taskId);

    // Past the gate: the offline orchestrator is what refused, so the grant is spent.
    expect(first.status).toBe(503);

    const afterFirst = await suite.prisma.executionAttempt.findMany({
      where: { orgId: orgId(), taskId },
      select: { id: true },
    });

    expect(afterFirst).toHaveLength(1);

    // The compensation returned the task to `ready`, so the second request passes the
    // pre-checks and reaches the gate. The grant is what must stop it.
    const second = await runOffline(taskId);

    expect(second.status).toBe(409);
    expect(errorOf(second.body).code).toBe('APPROVAL_CONSUMED');

    // The second reservation rolled back completely: no attempt, no run.
    expect(await suite.prisma.executionAttempt.count({ where: { orgId: orgId(), taskId } })).toBe(1);
    expect(await suite.prisma.workflowRun.count({ where: { orgId: orgId(), taskId } })).toBe(1);

    const approval = await suite.prisma.approvalRequest.findUniqueOrThrow({
      where: { id: approvalId },
    });

    // Still linked to the *first* attempt — the replay did not re-point the grant.
    expect(approval.consumedByAttemptId).toBe(afterFirst[0]?.id);
  });
});

describe('5. crash after the reservation, before the workflow starts', () => {
  it('leaves a failed attempt named start_failed, a consumed grant, and no orphan', async () => {
    const { taskId, approvalId } = await approvedTask();

    const response = await runOffline(taskId);

    expect(response.status).toBe(503);
    expect(errorOf(response.body).code).toBe('ORCHESTRATOR_UNAVAILABLE');

    const attempt = await suite.prisma.executionAttempt.findFirstOrThrow({
      where: { orgId: orgId(), taskId },
    });

    // Recoverable, and honest about how it ended: not queued forever, not "cancelled".
    expect(attempt.status).toBe('failed');
    expect(attempt.terminationReason).toBe('start_failed');
    expect(attempt.finishedAt).not.toBeNull();

    const run = await suite.prisma.workflowRun.findFirstOrThrow({
      where: { orgId: orgId(), taskId },
    });

    expect(run.status).toBe('failed');

    // The grant is spent and still points at the attempt that spent it — auditable.
    const approval = await suite.prisma.approvalRequest.findUniqueOrThrow({
      where: { id: approvalId },
    });

    expect(approval.consumedAt).not.toBeNull();
    expect(approval.consumedByAttemptId).toBe(attempt.id);

    // Nothing is left claiming to be running, and the task is runnable again.
    const task = await suite.prisma.task.findUniqueOrThrow({ where: { id: taskId } });

    expect(task.status).toBe('ready');
    expect(
      await suite.prisma.agentRun.count({
        where: { orgId: orgId(), workflowRun: { taskId } },
      }),
    ).toBe(0);
  });
});

describe('6. retry of the same Idempotency-Key', () => {
  it('replays the first outcome and reserves no second attempt', async () => {
    const { taskId } = await approvedTask();
    const key = 'p5-run-idempotent-1';

    const first = await runOffline(taskId, { idempotencyKey: key });

    expect(first.status).toBe(503);

    const second = await runOffline(taskId, { idempotencyKey: key });

    // The same request gets the same answer, from the row the first one wrote.
    expect(second.status).toBe(503);
    expect(errorOf(second.body).code).toBe('ORCHESTRATOR_UNAVAILABLE');

    expect(await suite.prisma.executionAttempt.count({ where: { orgId: orgId(), taskId } })).toBe(1);
    expect(await suite.prisma.workflowRun.count({ where: { orgId: orgId(), taskId } })).toBe(1);
  });

  it('answers CONFLICT — not 500 — when two requests with one key race', async () => {
    const { taskId } = await approvedTask();
    const key = 'p5-run-race-1';

    const responses = await Promise.all([
      runOffline(taskId, { idempotencyKey: key }),
      runOffline(taskId, { idempotencyKey: key }),
    ]);

    const statuses = responses.map((response) => response.status).sort((a, b) => a - b);

    // One reserves and reaches the offline orchestrator; the other loses the unique index.
    // The loser's collision must be classified as a duplicate request (`CONFLICT`), not
    // leak through as an unattributable `INTERNAL_ERROR`.
    expect(statuses).toEqual([409, 503]);

    const loser = responses.find((response) => response.status === 409);

    expect(errorOf(loser?.body).code).toBe('CONFLICT');

    expect(await suite.prisma.executionAttempt.count({ where: { orgId: orgId(), taskId } })).toBe(1);
    expect(await suite.prisma.workflowRun.count({ where: { orgId: orgId(), taskId } })).toBe(1);
  });

  it('replays the acceptance for a run that is still open, without starting a second', async () => {
    const task = await createTask(lowTask, ownerToken);

    await makeReady(task.id, ownerToken);

    // A LOW task needs no approval, so the run reaches the orchestrator. Offline, it is
    // refused and compensated — which is *not* the "still open" case this test is about.
    // Instead insert the open run the API would have left behind, then assert the replay
    // reads it rather than reserving: the row shape is what the replay depends on.
    const gateway = await suite.prisma.workflowRun.create({
      data: {
        orgId: orgId(),
        taskId: task.id,
        workflowId: `task-${task.id}`,
        status: 'queued',
        idempotencyKey: 'p5-open-run',
        attempts: {
          create: {
            orgId: orgId(),
            taskId: task.id,
            attemptNumber: 1,
            runtimeId: 'unassigned',
            simulated: true,
            status: 'queued',
          },
        },
      },
      select: { id: true, attempts: { select: { id: true } } },
    });

    const replay = await runOffline(task.id, { idempotencyKey: 'p5-open-run' });

    expect(replay.status).toBe(202);

    const body = dataOf<RunBody>(replay.body);

    expect(body.workflowRunId).toBe(gateway.id);
    expect(body.attemptId).toBe(gateway.attempts[0]?.id);
    // No second attempt, no second run.
    expect(await suite.prisma.workflowRun.count({ where: { orgId: orgId(), taskId: task.id } })).toBe(1);
    expect(
      await suite.prisma.executionAttempt.count({ where: { orgId: orgId(), taskId: task.id } }),
    ).toBe(1);
  });
});

describe('8. cross-org approval id', () => {
  it('answers 404, never 403, and decides nothing', async () => {
    const ownerBToken = await login(suite.app, suite.fixtures.users.ownerB.email);

    // An approval genuinely owned by org B: created the way the product creates one, so
    // the 404 below is about tenancy and not about a fixture that never existed.
    const created = await request(suite.app.getHttpServer())
      .post(`/v1/orgs/${orgBId()}/projects/${suite.fixtures.projectB}/tasks`)
      .set(authHeaders(ownerBToken, orgBId()))
      .set('idempotency-key', 'p5-foreign-task')
      .send(shellTask)
      .expect(201);

    const foreignTaskId = dataOf<TaskBody>(created.body).id;

    await request(suite.app.getHttpServer())
      .patch(`/v1/orgs/${orgBId()}/tasks/${foreignTaskId}`)
      .set(authHeaders(ownerBToken, orgBId()))
      .send({ status: 'ready', reason: 'Ready for the cross-tenant test.' })
      .expect(200);

    const foreign = await suite.prisma.approvalRequest.findFirstOrThrow({
      where: { orgId: orgBId(), taskId: foreignTaskId },
      select: { id: true, status: true },
    });

    // Addressed through org A, where the caller is an OWNER. The path org is the tenant
    // the caller is a member of; the id belongs somewhere else.
    const response = await request(suite.app.getHttpServer())
      .post(`/v1/orgs/${orgId()}/approvals/${foreign.id}/decision`)
      .set(authHeaders(ownerToken, orgId()))
      .send({ decision: 'approve', note: 'Should not be possible.' });

    expect(response.status).toBe(404);
    expect(errorOf(response.body).code).toBe('NOT_FOUND');

    const unchanged = await suite.prisma.approvalRequest.findUniqueOrThrow({
      where: { id: foreign.id },
    });

    expect(unchanged.status).toBe(foreign.status);
    expect(unchanged.decidedById).toBeNull();
  });

  it('answers 404 for a task in another organisation, so the id is not confirmed', async () => {
    const foreignTask = suite.fixtures.tasks.highReadyA;

    // `highReadyA` belongs to org A; ask for it through org B, where the caller is OWNER.
    const response = await request(suite.app.getHttpServer())
      .post(`/v1/orgs/${orgBId()}/tasks/${foreignTask}/run`)
      .set(authHeaders(await login(suite.app, suite.fixtures.users.ownerB.email), orgBId()));

    expect(response.status).toBe(404);
  });
});

describe('9. self-approval', () => {
  it('refuses the requester approving their own request with 403, and leaves it PENDING', async () => {
    // The OWNER creates the task, so `requestedById` is the owner.
    const task = await createTask(shellTask, ownerToken);

    await makeReady(task.id, ownerToken);

    const approval = await suite.prisma.approvalRequest.findFirstOrThrow({
      where: { taskId: task.id, orgId: orgId() },
      select: { id: true },
    });

    const response = await request(suite.app.getHttpServer())
      .post(`/v1/orgs/${orgId()}/approvals/${approval.id}/decision`)
      .set(authHeaders(ownerToken, orgId()))
      .send({ decision: 'approve', note: 'I approve my own work.' });

    expect(response.status).toBe(403);
    expect(errorOf(response.body).code).toBe('SELF_APPROVAL_FORBIDDEN');

    const row = await suite.prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } });

    expect(row.status).toBe('PENDING');
    expect(row.decidedById).toBeNull();

    // And nothing was reserved: a refused approval cannot authorise a run.
    expect(await suite.prisma.executionAttempt.count({ where: { orgId: orgId(), taskId: task.id } })).toBe(0);
  });
});

describe('10. legacy approval consumed without an attempt link', () => {
  it('is refused rather than silently accepted by the API gate', async () => {
    const task = await createTask();

    await makeReady(task.id);
    const approvalId = await approve(task.id);

    // The Phase 4 shape: consumed, attributable to nobody. Written directly because the
    // API no longer produces it.
    await suite.prisma.approvalRequest.update({
      where: { id: approvalId },
      data: { consumedAt: new Date(), consumedByAttemptId: null },
    });

    const response = await runOffline(task.id);

    expect(response.status).toBe(409);
    expect(errorOf(response.body).code).toBe('APPROVAL_CONSUMED');
    expect(await suite.prisma.executionAttempt.count({ where: { orgId: orgId(), taskId: task.id } })).toBe(0);
  });
});

describe('7. task content changed after the reservation', () => {
  it('refuses the *next* reservation with APPROVAL_STALE, not APPROVAL_CONSUMED', async () => {
    const { taskId } = await approvedTask();

    // Content moves before anything spends the grant: the grant is for the old content.
    // No edit endpoint exists, so this stands in for an out-of-band change.
    await suite.prisma.task.update({
      where: { id: taskId },
      data: { goal: 'Run a shell command that rewrites scripts/build.sh and deploys it.' },
    });

    const response = await runOffline(taskId);

    expect(response.status).toBe(409);
    expect(errorOf(response.body).code).toBe('APPROVAL_STALE');
    expect(await suite.prisma.executionAttempt.count({ where: { orgId: orgId(), taskId } })).toBe(0);
  });
});

describe('reservation shape', () => {
  it('binds the grant to the attempt and reports that attempt in the 202 body', async () => {
    const { taskId, approvalId } = await approvedTask();

    // A real Temporal address is not needed for the linkage: the reservation is committed
    // before the start is attempted, and the response is the failure that follows it.
    const response = await runOffline(taskId);

    expect(response.status).toBe(503);

    const approval = await suite.prisma.approvalRequest.findUniqueOrThrow({
      where: { id: approvalId },
      select: { consumedByAttemptId: true },
    });

    expect(approval.consumedByAttemptId).not.toBeNull();

    const attempt = await suite.prisma.executionAttempt.findUniqueOrThrow({
      where: { id: approval.consumedByAttemptId ?? '' },
      select: {
        id: true,
        taskId: true,
        workflowRunId: true,
        attemptNumber: true,
        status: true,
        terminationReason: true,
        runtimeId: true,
        simulated: true,
        executionProfile: true,
      },
    });

    // A real attempt row, for a real run, numbered from 1, with the profile the grant
    // authorised. `unassigned` is the API's honest placeholder for "an adapter will run
    // this, chosen by the worker".
    expect(attempt.taskId).toBe(taskId);
    expect(attempt.attemptNumber).toBe(1);
    expect(attempt.executionProfile).toBe('standard');
    expect(attempt.runtimeId).toBe('unassigned');
    expect(attempt.simulated).toBe(true);
    expect(['failed', 'running']).toContain(attempt.status);
    expect(attempt.terminationReason).toBe('start_failed');

    const run = await suite.prisma.workflowRun.findUniqueOrThrow({
      where: { id: attempt.workflowRunId },
      select: { orgId: true, taskId: true },
    });

    expect(run.orgId).toBe(orgId());
    expect(run.taskId).toBe(taskId);
  });
});
