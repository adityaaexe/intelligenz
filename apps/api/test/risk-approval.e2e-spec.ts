import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { authHeaders, createTestApp, login, startSuite, type Suite } from './helpers/app';

/**
 * D-006 — server-derived risk classification and bound, single-use approvals.
 *
 * Every test here is adversarial: it plays a `MEMBER` who is trying to get work done
 * without a second pair of eyes, and asserts that the server either refuses or
 * records the attempt. They run against the real application (guards, validation,
 * filter) and the real database.
 *
 * ## Why the offline orchestrator
 *
 * The gate runs **before** Temporal is contacted, so an unreachable orchestrator makes
 * these tests deterministic: a run that gets past the gate answers `503` and leaves a
 * `failed` `WorkflowRun`, while a run that is refused answers `409`. Nothing is left
 * open in the dev Temporal store, and the tests do not depend on whether a worker is
 * running on this host.
 *
 * A `503` is still a *pass* through the gate — that is what makes "the approval was
 * consumed" observable without a real execution.
 */

let suite: Suite;
let offline: { app: INestApplication; close(): Promise<void> };

let ownerToken: string;
let memberToken: string;
let ownerBToken: string;

const POLICY_VERSION = '2026-11-14.1';

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
  ownerBToken = await login(suite.app, suite.fixtures.users.ownerB.email);
});

afterAll(async () => {
  await offline.close();
  await suite.close();
});

function orgId(): string {
  return suite.fixtures.orgA.id;
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

interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, string[]>;
  };
}

interface ApprovalBody {
  readonly id: string;
  readonly status: string;
  readonly expiresAt: string | null;
  readonly consumedAt: string | null;
  readonly revokedAt: string | null;
}

function errorOf(body: unknown): ErrorEnvelope['error'] {
  return (body as ErrorEnvelope).error;
}

function taskOf(body: unknown): TaskBody {
  return (body as { data: TaskBody }).data;
}

function approvalOf(body: unknown): ApprovalBody {
  return (body as { data: ApprovalBody }).data;
}

interface CreatePayload {
  readonly title: string;
  readonly goal: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly riskClass?: string;
  readonly executionProfile?: string;
  readonly sourceRef?: string;
  readonly baseCommit?: string;
  readonly [key: string]: unknown;
}

/** Creates a task through the API and returns its id. The class is whatever the server says. */
async function createTask(
  token: string,
  payload: CreatePayload,
  idempotencyKey: string,
): Promise<TaskBody> {
  const response = await request(suite.app.getHttpServer())
    .post(tasksPath())
    .set(authHeaders(token, orgId()))
    .set('idempotency-key', idempotencyKey)
    .send(payload)
    .expect(201);

  return taskOf(response.body);
}

async function approvalFor(taskId: string): Promise<{ id: string; status: string }> {
  return suite.prisma.approvalRequest.findFirstOrThrow({
    where: { taskId, orgId: orgId() },
    select: { id: true, status: true },
    orderBy: { createdAt: 'desc' },
  });
}

async function decide(
  approvalId: string,
  decision: 'approve' | 'reject',
  token: string = ownerToken,
  note = 'Reviewed: scope is understood.',
): Promise<HttpResult> {
  return request(suite.app.getHttpServer())
    .post(`/v1/orgs/${orgId()}/approvals/${approvalId}/decision`)
    .set(authHeaders(token, orgId()))
    .send({ decision, note });
}

/** `POST /run` against the offline app: no workflow is ever started. */
async function runTask(taskId: string, body?: Record<string, unknown>): Promise<HttpResult> {
  const base = request(offline.app.getHttpServer())
    .post(`${taskPath(taskId)}/run`)
    .set(authHeaders(memberToken, orgId()));

  return body === undefined ? base : base.send(body);
}

/** Creates a task, approves it as a different admin, and returns both ids. */
async function approvedTask(payload: CreatePayload, key: string): Promise<{
  taskId: string;
  approvalId: string;
}> {
  const task = await createTask(memberToken, payload, key);

  // A task is born `draft`; the owner's promotion is the one human-owned edge.
  await request(suite.app.getHttpServer())
    .patch(taskPath(task.id))
    .set(authHeaders(memberToken, orgId()))
    .send({ status: 'ready', reason: 'Ready for review.' })
    .expect(200);

  const approval = await approvalFor(task.id);
  const decision = await decide(approval.id, 'approve');

  expect(decision.status).toBe(200);

  return { taskId: task.id, approvalId: approval.id };
}

const deployTask: CreatePayload = {
  title: 'Deploy to production',
  goal: 'Deploy the payment service to production.',
  acceptanceCriteria: ['the service is reachable'],
};

const shellTask: CreatePayload = {
  title: 'Rewrite the build script',
  goal: 'Run a shell command that rewrites scripts/build.sh.',
  acceptanceCriteria: [],
};

describe('1. client asserts LOW on critical content', () => {
  it('stores CRITICAL and records clientAttemptedDowngrade instead of failing the request', async () => {
    const task = await createTask(memberToken, { ...deployTask, riskClass: 'LOW' }, 'adv-001');

    expect(task.riskClass).toBe('CRITICAL');

    const row = await suite.prisma.task.findUniqueOrThrow({ where: { id: task.id } });

    expect(row.riskClass).toBe('CRITICAL');
    expect(row.derivedRiskClass).toBe('CRITICAL');
    expect(row.riskSource).toBe('server');
    expect(row.riskPolicyVersion).toBe(POLICY_VERSION);
    expect(row.riskFactors).toMatchObject({
      clientRiskClass: 'LOW',
      clientAttemptedDowngrade: true,
      clientAttemptedEscalation: false,
      policyVersion: POLICY_VERSION,
    });

    const audits = await suite.prisma.auditEvent.findMany({
      where: { aggregateId: task.id, eventType: 'task.risk_class_overridden.v1' },
    });

    expect(audits).toHaveLength(1);
    expect(audits[0]?.payload).toMatchObject({ direction: 'downgrade', clientRiskClass: 'LOW' });
  });
});

describe('2. client omits riskClass entirely', () => {
  it('still derives the class server-side', async () => {
    const task = await createTask(
      memberToken,
      { title: shellTask.title, goal: shellTask.goal, acceptanceCriteria: [] },
      'adv-002',
    );

    expect(task.riskClass).toBe('HIGH');

    const row = await suite.prisma.task.findUniqueOrThrow({ where: { id: task.id } });

    expect(row.riskSource).toBe('server');
    expect(row.derivedRiskClass).toBe('HIGH');
    expect(row.riskFactors).toMatchObject({ clientRiskClass: null, clientAttemptedDowngrade: false });
  });
});

describe('3. task content changed after approval', () => {
  it('refuses the run with 409 APPROVAL_STALE and does not spend the grant', async () => {
    const { taskId, approvalId } = await approvedTask(shellTask, 'adv-003');

    // No edit endpoint exists, so this stands in for an out-of-band change: the grant
    // must be about content, not about a row id.
    await suite.prisma.task.update({
      where: { id: taskId },
      data: { goal: 'Run a shell command that rewrites scripts/build.sh and deploys it.' },
    });

    const response = await runTask(taskId);

    expect(response.status).toBe(409);
    expect(errorOf(response.body).code).toBe('APPROVAL_STALE');

    const approval = await suite.prisma.approvalRequest.findUniqueOrThrow({
      where: { id: approvalId },
    });

    expect(approval.consumedAt).toBeNull();
  });
});

describe('4. source repository / branch changed after approval', () => {
  it('refuses the run with 409 APPROVAL_STALE', async () => {
    const { taskId, approvalId } = await approvedTask(
      {
        ...shellTask,
        sourceRef: 'github.com/acme/app#main',
        baseCommit: 'a'.repeat(40),
      },
      'adv-004',
    );

    const bound = await suite.prisma.task.findUniqueOrThrow({ where: { id: taskId } });

    // Move the pin: the same task id, a different commit.
    await suite.prisma.task.update({
      where: { id: taskId },
      data: {
        riskFactors: {
          ...(bound.riskFactors as Record<string, unknown>),
          binding: {
            executionProfile: 'standard',
            sourceRef: 'github.com/acme/app#release',
            baseCommit: 'b'.repeat(40),
          },
        },
      },
    });

    const response = await runTask(taskId);

    expect(response.status).toBe(409);
    expect(errorOf(response.body).code).toBe('APPROVAL_STALE');

    const approval = await suite.prisma.approvalRequest.findUniqueOrThrow({
      where: { id: approvalId },
    });

    expect(approval.consumedAt).toBeNull();
  });
});

describe('5. execution profile changed after approval', () => {
  it('refuses a heavier profile than the grant names, and says which field moved', async () => {
    const { taskId } = await approvedTask(shellTask, 'adv-005');

    const response = await runTask(taskId, { executionProfile: 'heavy' });

    expect(response.status).toBe(409);

    const error = errorOf(response.body);

    expect(error.code).toBe('APPROVAL_STALE');
    expect(error.details?.approval).toEqual(['executionProfile']);
  });

  it('accepts a run that asserts the profile it was approved for', async () => {
    const { taskId } = await approvedTask(shellTask, 'adv-005b');

    const response = await runTask(taskId, { executionProfile: 'standard' });

    // Past the gate: the offline orchestrator is what refuses, not the approval.
    expect(response.status).toBe(503);
    expect(errorOf(response.body).code).toBe('ORCHESTRATOR_UNAVAILABLE');
  });
});

describe('6. one approval cannot authorise a second run', () => {
  it('answers 409 APPROVAL_CONSUMED on reuse', async () => {
    const { taskId, approvalId } = await approvedTask(shellTask, 'adv-006');

    const first = await runTask(taskId);
    expect(first.status).toBe(503);

    const consumed = await suite.prisma.approvalRequest.findUniqueOrThrow({
      where: { id: approvalId },
    });

    expect(consumed.consumedAt).not.toBeNull();

    const second = await runTask(taskId);

    expect(second.status).toBe(409);
    expect(errorOf(second.body).code).toBe('APPROVAL_CONSUMED');
  });
});

describe('7. two concurrent runs, one approval', () => {
  it('lets exactly one through and refuses the other with 409', async () => {
    const { taskId, approvalId } = await approvedTask(shellTask, 'adv-007');

    const responses = await Promise.all([runTask(taskId), runTask(taskId)]);
    const statuses = responses.map((response) => response.status).sort((a, b) => a - b);

    // One spends the grant and reaches the (offline) orchestrator; the other is refused
    // by the compare-and-swap. The order in the array is not deterministic, the multiset
    // is.
    expect(statuses).toEqual([409, 503]);

    const refusal = responses.find((response) => response.status === 409);
    expect(errorOf(refusal?.body).code).toBe('APPROVAL_CONSUMED');

    const approval = await suite.prisma.approvalRequest.findUniqueOrThrow({
      where: { id: approvalId },
    });

    expect(approval.consumedAt).not.toBeNull();
    expect(
      await suite.prisma.auditEvent.count({
        where: { aggregateId: approvalId, eventType: 'approval.consumed.v1' },
      }),
    ).toBe(1);
  });
});

describe('8. self-approval', () => {
  it('refuses the requester approving their own request with 403 SELF_APPROVAL_FORBIDDEN', async () => {
    // The OWNER creates the task, so `requestedById` is the owner.
    const task = await createTask(ownerToken, shellTask, 'adv-008');
    const approval = await approvalFor(task.id);

    const response = await decide(approval.id, 'approve', ownerToken);

    expect(response.status).toBe(403);
    expect(errorOf(response.body).code).toBe('SELF_APPROVAL_FORBIDDEN');

    const row = await suite.prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } });

    expect(row.status).toBe('PENDING');
    expect(row.decidedById).toBeNull();

    expect(
      await suite.prisma.auditEvent.count({
        where: { aggregateId: approval.id, eventType: 'approval.self_approval_refused.v1' },
      }),
    ).toBe(1);
  });
});

describe('9. expired approval', () => {
  it('flips the row to EXPIRED, refuses with 409 APPROVAL_EXPIRED, and audits it', async () => {
    const { taskId, approvalId } = await approvedTask(shellTask, 'adv-009');

    await suite.prisma.approvalRequest.update({
      where: { id: approvalId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const response = await runTask(taskId);

    expect(response.status).toBe(409);
    expect(errorOf(response.body).code).toBe('APPROVAL_EXPIRED');

    const row = await suite.prisma.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });

    expect(row.status).toBe('EXPIRED');
    expect(row.consumedAt).toBeNull();

    expect(
      await suite.prisma.auditEvent.count({
        where: { aggregateId: approvalId, eventType: 'approval.expired.v1' },
      }),
    ).toBe(1);
  });
});

describe('10. revoked approval', () => {
  it('refuses with 409 APPROVAL_REVOKED and is idempotent on a second revoke', async () => {
    const { taskId, approvalId } = await approvedTask(shellTask, 'adv-010');

    const revoked = await request(suite.app.getHttpServer())
      .post(`/v1/orgs/${orgId()}/approvals/${approvalId}/revoke`)
      .set(authHeaders(ownerToken, orgId()));

    expect(revoked.status).toBe(200);
    expect(approvalOf(revoked.body).status).toBe('REVOKED');
    expect(approvalOf(revoked.body).revokedAt).not.toBeNull();

    const again = await request(suite.app.getHttpServer())
      .post(`/v1/orgs/${orgId()}/approvals/${approvalId}/revoke`)
      .set(authHeaders(ownerToken, orgId()));

    expect(again.status).toBe(200);
    expect(approvalOf(again.body).status).toBe('REVOKED');

    const response = await runTask(taskId);

    expect(response.status).toBe(409);
    expect(errorOf(response.body).code).toBe('APPROVAL_REVOKED');
  });

  it('records a revoked-after-use grant without pretending the run was undone', async () => {
    const { taskId, approvalId } = await approvedTask(shellTask, 'adv-010b');

    await runTask(taskId); // spends the grant; 503 from the offline orchestrator

    const revoked = await request(suite.app.getHttpServer())
      .post(`/v1/orgs/${orgId()}/approvals/${approvalId}/revoke`)
      .set(authHeaders(ownerToken, orgId()));

    expect(revoked.status).toBe(200);
    expect(approvalOf(revoked.body).status).toBe('REVOKED');
    // The consumption stands. Revocation controls the future, not the past.
    expect(approvalOf(revoked.body).consumedAt).not.toBeNull();
  });

  it('refuses to revoke a request that was never granted (409 APPROVAL_NOT_REVOCABLE)', async () => {
    const task = await createTask(memberToken, shellTask, 'adv-010c');
    const approval = await approvalFor(task.id);

    const response = await request(suite.app.getHttpServer())
      .post(`/v1/orgs/${orgId()}/approvals/${approval.id}/revoke`)
      .set(authHeaders(ownerToken, orgId()));

    expect(response.status).toBe(409);
    expect(errorOf(response.body).code).toBe('APPROVAL_NOT_REVOCABLE');
  });
});

describe('11. an approval id used under a different organisation', () => {
  it('answers 404 for a decision and for a revoke', async () => {
    const task = await createTask(memberToken, shellTask, 'adv-011');
    const approval = await approvalFor(task.id);
    const foreign = `/v1/orgs/${suite.fixtures.orgB.id}/approvals/${approval.id}`;

    const decision = await request(suite.app.getHttpServer())
      .post(`${foreign}/decision`)
      .set(authHeaders(ownerBToken, suite.fixtures.orgB.id))
      .send({ decision: 'approve', note: 'Wrong tenant.' });

    expect(decision.status).toBe(404);
    expect(errorOf(decision.body).code).toBe('NOT_FOUND');

    const revoke = await request(suite.app.getHttpServer())
      .post(`${foreign}/revoke`)
      .set(authHeaders(ownerBToken, suite.fixtures.orgB.id));

    expect(revoke.status).toBe(404);

    const row = await suite.prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } });

    expect(row.status).toBe('PENDING');
  });
});

describe('12. an approval with no content binding (Phase 3 legacy row)', () => {
  it('is unusable: 409 APPROVAL_UNBOUND rather than a guess', async () => {
    const { taskId, approvalId } = await approvedTask(shellTask, 'adv-012');

    await suite.prisma.approvalRequest.update({
      where: { id: approvalId },
      data: { taskContentHash: null },
    });

    const response = await runTask(taskId);

    expect(response.status).toBe(409);
    expect(errorOf(response.body).code).toBe('APPROVAL_UNBOUND');
  });
});

describe('13. retry after consumption', () => {
  it('refuses every retry and never mints a replacement approval', async () => {
    const { taskId } = await approvedTask(shellTask, 'adv-013');

    await runTask(taskId);

    const before = await suite.prisma.approvalRequest.count({ where: { taskId } });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await runTask(taskId);

      expect(response.status).toBe(409);
      expect(errorOf(response.body).code).toBe('APPROVAL_CONSUMED');
    }

    const after = await suite.prisma.approvalRequest.count({ where: { taskId } });

    expect(after).toBe(before);
    // No *live* grant was created: the spent APPROVED row is still APPROVED, but it
    // has been consumed, which is exactly why the retries are refused.
    expect(
      await suite.prisma.approvalRequest.count({
        where: { taskId, status: 'APPROVED', consumedAt: null },
      }),
    ).toBe(0);
    expect(await suite.prisma.approvalRequest.count({ where: { taskId, status: 'PENDING' } })).toBe(0);
  });
});

describe('14. server-owned fields in the request body', () => {
  it('accepts the body, strips the fields, and stores the server values', async () => {
    const task = await createTask(
      memberToken,
      {
        ...deployTask,
        riskSource: 'client',
        derivedRiskClass: 'LOW',
        riskPolicyVersion: '1999-01-01.1',
        riskFactors: { clientAttemptedDowngrade: false },
        riskClass: 'LOW',
      },
      'adv-014',
    );

    expect(task.riskClass).toBe('CRITICAL');

    const row = await suite.prisma.task.findUniqueOrThrow({ where: { id: task.id } });

    expect(row.riskSource).toBe('server');
    expect(row.riskPolicyVersion).toBe(POLICY_VERSION);
    expect(row.derivedRiskClass).toBe('CRITICAL');
    expect(row.riskFactors).toMatchObject({ clientAttemptedDowngrade: true });
    // The bogus `riskFactors` body field was dropped, not merged.
    expect((row.riskFactors as Record<string, unknown>)['signals']).toBeDefined();
  });
});

describe('15. a HIGH task with no approval through PATCH → queued', () => {
  it('refuses with 409 APPROVAL_REQUIRED and leaves the task ready', async () => {
    const task = await createTask(memberToken, shellTask, 'adv-015');

    await request(suite.app.getHttpServer())
      .patch(taskPath(task.id))
      .set(authHeaders(memberToken, orgId()))
      .send({ status: 'ready', reason: 'Ready to run.' })
      .expect(200);

    const response = await request(suite.app.getHttpServer())
      .patch(taskPath(task.id))
      .set(authHeaders(memberToken, orgId()))
      .send({ status: 'queued' });

    expect(response.status).toBe(409);
    expect(errorOf(response.body).code).toBe('APPROVAL_REQUIRED');

    const row = await suite.prisma.task.findUniqueOrThrow({ where: { id: task.id } });

    expect(row.status).toBe('ready');
    expect(await suite.prisma.workflowRun.count({ where: { taskId: task.id } })).toBe(0);
  });
});
