import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import argon2 from 'argon2';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@intelligenz/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { authHeaders, createTestApp, login } from './helpers/app';
import { acquireSuiteLock, createTestClient } from './helpers/database';
import {
  canonicalJson,
  createTenancyPair,
  derivedId,
  describeId,
  dropAllTenants,
  tenantSnapshot,
  type TenancyPair,
  type TenancyTenant,
} from './helpers/tenancy';

/**
 * Gate M — the multi-tenant adversarial suite, HTTP surface.
 *
 * ## What this file is for
 *
 * Every service in this API carries `orgId` in its `where` clauses, and until now that
 * claim was tested only by reading the code. Absence of proof is not a passing gate: a
 * dropped conjunct is one deleted token away in any of a dozen queries, and the failure is
 * silent — the request succeeds, against the wrong tenant's row.
 *
 * So this file builds two complete synthetic tenants (`helpers/tenancy.ts`) and attacks
 * tenant A with tenant B's identifiers. The rule that makes it a *gate* rather than a bug
 * hunt: every attack has a positive control on A's own identifier. A route that 404s for
 * everything passes a negative test and fails these.
 *
 * ## Three properties every attack asserts
 *
 * 1. **404, never 403.** A 403 confirms the id exists; a 404 is the only answer that does
 *    not answer the attacker's real question ("is this id real?"). Asserted as an exact
 *    status, with the body checked for any echo of B's identifiers.
 * 2. **The row is unchanged, read back twice.** Once through the API *as tenant B* — which
 *    is what "B's row is untouched" means to a person — and once as a whole-tenant snapshot
 *    straight from the database, because a status that survived while `updatedAt`,
 *    `consumedAt` or a foreign key moved is a write that happened.
 * 3. **The refusal is not an oracle.** "Exists in another tenant" and "does not exist" must
 *    be byte-identical apart from the correlation id, which is per-request by design.
 *
 * ## Fixtures are synthetic and deterministic
 *
 * No customer data. Every id is derived from the seed, so a failure names the object
 * (`describeId`) and reproduces on the next run. See `helpers/tenancy.ts` for the cleanup
 * guarantee: reclaim-before-create, per-tenant drop, aggregate failure.
 */

const SEED = 'gate-m-701-api';
const TENANT_LABEL = 'Gate M';

interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, string[]> };
  correlationId: string;
}

interface DataBody<T> {
  data: T;
}

interface TaskData {
  id: string;
  orgId: string;
  projectId: string;
  workspaceId: string;
  title: string;
  status: string;
  updatedAt: string;
}

interface TaskDetailData extends TaskData {
  artifacts: { id: string; checksum: string; attemptId: string | null }[];
  approvals: { id: string; status: string; consumedAt: string | null }[];
  latestRun: { id: string } | null;
  latestAttempt: { id: string } | null;
}

interface AttemptSummaryData {
  id: string;
  taskId: string;
  attemptNumber: number;
}

interface AttemptDetailData {
  attempt: { id: string; taskId: string };
  artifacts: { id: string; checksum: string }[];
}

interface ApprovalData {
  id: string;
  taskId: string;
  status: string;
  decidedById: string | null;
  decidedAt: string | null;
  consumedAt: string | null;
}

interface PageData<T> {
  data: T[];
  meta: { limit: number; hasMore: boolean; nextCursor: string | null };
}

let prisma: PrismaClient;
let app: INestApplication;
let offline: INestApplication;
let pair: TenancyPair;
let artifactRoot: string;
let release: (() => Promise<void>) | undefined;

let ownerA: string;
let memberA: string;
let ownerB: string;

const sha256 = (value: string | Buffer): string =>
  createHash('sha256')
    .update(typeof value === 'string' ? Buffer.from(value, 'utf8') : value)
    .digest('hex');

function http(): ReturnType<INestApplication['getHttpServer']> {
  return app.getHttpServer();
}

function asA(method: 'get' | 'post' | 'patch', path: string): request.Test {
  return request(http())[method](path).set(authHeaders(ownerA, pair.a.orgId));
}

function asAMember(method: 'get' | 'post' | 'patch', path: string): request.Test {
  return request(http())[method](path).set(authHeaders(memberA, pair.a.orgId));
}

function asB(method: 'get' | 'post' | 'patch', path: string): request.Test {
  return request(http())[method](path).set(authHeaders(ownerB, pair.b.orgId));
}

/** A 404 with the one code the contract names for "absent or in another organisation". */
function expectNotFound(response: request.Response): void {
  expect(response.status).toBe(404);
  expect((response.body as ApiErrorBody).error.code).toBe('NOT_FOUND');
}

/**
 * The same refusal, with its exact wording.
 *
 * Pinned on purpose. `NOT_FOUND` alone leaves the *message* free to grow an id, a tenant
 * slug or a "belongs to another workspace" hint — which is the leak the code exists to
 * avoid. Pinning it also means a contract change is a visible test failure rather than a
 * silent change of what an attacker learns.
 */
function expectNotFoundMessage(response: request.Response, message: string): void {
  expectNotFound(response);
  expect((response.body as ApiErrorBody).error.message).toBe(message);
  expect((response.body as ApiErrorBody).error.details).toBeUndefined();
}

/**
 * Nothing in the response may name tenant B.
 *
 * A body can leak through a message, a `details` field or an echoed id even when the
 * status is right, so the check is on the serialised response rather than on the code.
 */
function expectNoTenantBTrace(response: request.Response): void {
  const body = canonicalJson(response.body);

  for (const id of [pair.b.orgId, pair.b.projectId, pair.b.workspaceId, pair.b.orgSlug]) {
    expect(body).not.toContain(id);
  }

  for (const id of Object.values(pair.b.ids.tasks)) {
    expect(body).not.toContain(id);
  }

  expect(body).not.toContain(TENANT_LABEL + ' b');
}

async function taskSnapshotRow(taskId: string): Promise<Record<string, unknown>> {
  const row = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });

  return row as unknown as Record<string, unknown>;
}

async function approvalRows(tenant: TenancyTenant): Promise<string> {
  const rows = await prisma.approvalRequest.findMany({
    where: { orgId: tenant.orgId },
    orderBy: { id: 'asc' },
  });

  return canonicalJson(rows);
}

beforeAll(async () => {
  release = await acquireSuiteLock();
  prisma = createTestClient();

  artifactRoot = await mkdtemp(join('/tmp/opencode', 'gate-m-api-'));

  // Cheaper than production on purpose: `verify` reads its cost from the stored hash, so a
  // cheap hash still exercises the real login path without 50 ms per sign-in. Same choice as
  // `helpers/database.ts`, and the same reason.
  const passwordHash = await argon2.hash('Passw0rd!demo', {
    type: argon2.argon2id,
    memoryCost: 4_096,
    timeCost: 1,
    parallelism: 1,
  });

  pair = await createTenancyPair(prisma, { seed: SEED, artifactRoot, passwordHash });

  app = await createTestApp({ artifactRoot, workspaceRoot: join(artifactRoot, 'workspaces') });

  // A second application pointed at a port that cannot answer: the in-tenant `POST /run`
  // control has to reach the reservation and then fail to start, deterministically, without
  // leaving a live workflow in the dev Temporal store for every run of this suite.
  offline = await createTestApp({
    artifactRoot,
    workspaceRoot: join(artifactRoot, 'workspaces'),
    temporal: { address: '127.0.0.1:1', namespace: 'default', taskQueue: 'intelligenz-tasks' },
    readinessTimeoutMs: 1_000,
  });

  ownerA = await login(app, pair.a.users.owner.email);
  memberA = await login(app, pair.a.users.member.email);
  ownerB = await login(app, pair.b.users.owner.email);
});

afterAll(async () => {
  // Every step is attempted, and the suite lock is released in `finally`: a failing cleanup
  // that skipped the release would hang every following API suite on the advisory lock.
  try {
    await app?.close();
    await offline?.close();
    if (pair !== undefined && prisma !== undefined) {
      await dropAllTenants(prisma, [pair.a, pair.b]).catch((error: unknown) => {
        console.error(`[gate-m] tenant teardown failed: ${String(error)}`);
      });
    }
    if (artifactRoot !== undefined) {
      await rm(artifactRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  } finally {
    await prisma?.$disconnect().catch(() => undefined);
    await release?.();
  }
});

// ─── 1. Cross-tenant read ────────────────────────────────────────────────────

describe('attack 1 — a cross-tenant read is a 404, and the route works on our own id', () => {
  /**
   * Each case carries both sides: the same route addressed with **our** id (the control —
   * a route that 404s everything would fail here) and with **B's** id (the attack).
   *
   * The control runs first on purpose. If it fails, the attack's 404 proves nothing and the
   * failure says so, instead of the suite reporting a passing tenancy gate for a typo.
   */
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly own: () => string;
    readonly foreign: () => string;
    readonly message: string;
    readonly assertOwnBody?: (body: unknown) => void;
  }> = [
    {
      name: 'task list under a project',
      own: () => `/v1/orgs/${pair.a.orgId}/projects/${pair.a.projectId}/tasks`,
      foreign: () => `/v1/orgs/${pair.a.orgId}/projects/${pair.b.projectId}/tasks`,
      message: 'Project not found.',
      assertOwnBody: (body) => {
        const page = body as PageData<TaskData>;
        expect(page.data.length).toBeGreaterThan(0);
        expect(page.data.every((task) => task.orgId === pair.a.orgId)).toBe(true);
      },
    },
    {
      name: 'project list under a workspace',
      own: () => `/v1/orgs/${pair.a.orgId}/workspaces/${pair.a.workspaceId}/projects`,
      foreign: () => `/v1/orgs/${pair.a.orgId}/workspaces/${pair.b.workspaceId}/projects`,
      message: 'Workspace not found.',
      assertOwnBody: (body) => {
        const page = body as DataBody<{ id: string; orgId: string }[]>;
        expect(page.data.map((project) => project.id)).toContain(pair.a.projectId);
      },
    },
    {
      name: 'task detail',
      own: () => `/v1/orgs/${pair.a.orgId}/tasks/${pair.a.tasks.executed}`,
      foreign: () => `/v1/orgs/${pair.a.orgId}/tasks/${pair.b.tasks.executed}`,
      message: 'Task not found.',
      assertOwnBody: (body) => {
        expect((body as DataBody<TaskData>).data.orgId).toBe(pair.a.orgId);
      },
    },
    {
      name: 'task detail of a task that carries an approval',
      own: () => `/v1/orgs/${pair.a.orgId}/tasks/${pair.a.tasks.high}`,
      foreign: () => `/v1/orgs/${pair.a.orgId}/tasks/${pair.b.tasks.high}`,
      message: 'Task not found.',
      assertOwnBody: (body) => {
        const detail = (body as DataBody<TaskDetailData>).data;
        expect(detail.approvals.map((approval) => approval.id).sort()).toEqual(
          [pair.a.approvals.approved, pair.a.approvals.pending].sort(),
        );
      },
    },
    {
      name: 'execution list of a task',
      own: () => `/v1/orgs/${pair.a.orgId}/tasks/${pair.a.tasks.executed}/executions`,
      foreign: () => `/v1/orgs/${pair.a.orgId}/tasks/${pair.b.tasks.executed}/executions`,
      message: 'Task not found.',
      assertOwnBody: (body) => {
        expect((body as DataBody<AttemptSummaryData[]>).data.map((a) => a.id)).toContain(
          pair.a.attemptId,
        );
      },
    },
    {
      name: 'execution detail of an attempt',
      own: () =>
        `/v1/orgs/${pair.a.orgId}/tasks/${pair.a.tasks.executed}/executions/${pair.a.attemptId}`,
      foreign: () =>
        `/v1/orgs/${pair.a.orgId}/tasks/${pair.b.tasks.executed}/executions/${pair.b.attemptId}`,
      message: 'Task not found.',
      assertOwnBody: (body) => {
        expect((body as DataBody<AttemptDetailData>).data.attempt.id).toBe(pair.a.attemptId);
      },
    },
    {
      name: 'artifact metadata',
      own: () => `/v1/orgs/${pair.a.orgId}/artifacts/${pair.a.artifact.id}`,
      foreign: () => `/v1/orgs/${pair.a.orgId}/artifacts/${pair.b.artifact.id}`,
      message: 'Artifact not found.',
      assertOwnBody: (body) => {
        expect((body as DataBody<{ id: string }>).data.id).toBe(pair.a.artifact.id);
      },
    },
    {
      name: 'artifact content',
      own: () => `/v1/orgs/${pair.a.orgId}/artifacts/${pair.a.artifact.id}/content`,
      foreign: () => `/v1/orgs/${pair.a.orgId}/artifacts/${pair.b.artifact.id}/content`,
      message: 'Artifact not found.',
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name}: 200 on our id, 404 on B's`, async () => {
      const own = await asA('get', testCase.own());

      expect(own.status).toBe(200);

      if (testCase.assertOwnBody !== undefined) {
        testCase.assertOwnBody(own.body);
      }

      const foreign = await asA('get', testCase.foreign());

      // 404, not 403: a 403 would confirm that B's id is real.
      expectNotFoundMessage(foreign, testCase.message);
      expectNoTenantBTrace(foreign);
    });
  }

  it('the pending-approvals queue is this organisation only', async () => {
    const response = await asA('get', `/v1/orgs/${pair.a.orgId}/approvals`);

    expect(response.status).toBe(200);

    const page = response.body as PageData<ApprovalData>;
    const ids = page.data.map((approval) => approval.id);

    // The control: our own queue is not empty, so "B is absent" is a fact about tenancy and
    // not about an empty list.
    expect(ids).toContain(pair.a.approvals.pending);
    expect(ids).not.toContain(pair.b.approvals.pending);
    expect(ids).not.toContain(pair.b.approvals.approved);
    expectNoTenantBTrace(response);
  });

  it('GET /v1/orgs lists only the organisations the caller is a member of', async () => {
    const response = await request(http()).get('/v1/orgs').set(authHeaders(ownerA));

    expect(response.status).toBe(200);

    const body = response.body as DataBody<{ id: string; slug: string }[]>;
    const ids = body.data.map((organisation) => organisation.id);

    // The control: the caller must see their own organisation here, or "B is absent" would
    // be a fact about the response being empty rather than about membership.
    expect(ids).toEqual([pair.a.orgId]);
    expect(ids).not.toContain(pair.b.orgId);
    expect(canonicalJson(response.body)).not.toContain(pair.b.orgSlug);
  });

  it('a task detail carries only its own organisation’s runs, attempts and artifacts', async () => {
    const response = await asA('get', `/v1/orgs/${pair.a.orgId}/tasks/${pair.a.tasks.executed}`);

    expect(response.status).toBe(200);

    const detail = (response.body as DataBody<TaskDetailData>).data;

    expect(detail.latestAttempt?.id).toBe(pair.a.attemptId);
    expect(detail.artifacts.map((artifact) => artifact.id)).toEqual([pair.a.artifact.id]);
    expect(canonicalJson(response.body)).not.toContain(pair.b.artifact.id);
    expect(canonicalJson(response.body)).not.toContain(pair.b.attemptId);
  });
});

// ─── 2. Cross-tenant write ───────────────────────────────────────────────────

describe('attack 2 — a cross-tenant write is refused, and B’s rows are byte-identical', () => {
  it('a PATCH on B’s draft task does not move it, and is not a 403', async () => {
    const before = await tenantSnapshot(prisma, pair.b.orgId);
    const rowBefore = await taskSnapshotRow(pair.b.tasks.draft);
    const detailBefore = await asB('get', `/v1/orgs/${pair.b.orgId}/tasks/${pair.b.tasks.draft}`);

    expect(detailBefore.status).toBe(200);
    expect((detailBefore.body as DataBody<TaskData>).data.status).toBe('draft');

    // As a MEMBER of A — the minimum role the route admits — so the refusal cannot be a
    // role check wearing a tenant check's clothes.
    const attack = await asAMember(
      'patch',
      `/v1/orgs/${pair.a.orgId}/tasks/${pair.b.tasks.draft}`,
    ).send({ status: 'ready', reason: 'gate-m: cross-tenant write attempt' });

    expectNotFoundMessage(attack, 'Task not found.');
    expectNoTenantBTrace(attack);

    // Read back twice: through the API as B (what a person sees) and from the database
    // (every column, including the ones no response exposes).
    const detailAfter = await asB('get', `/v1/orgs/${pair.b.orgId}/tasks/${pair.b.tasks.draft}`);

    expect(detailAfter.status).toBe(200);
    expect(canonicalJson(detailAfter.body)).toBe(canonicalJson(detailBefore.body));
    expect(canonicalJson(await taskSnapshotRow(pair.b.tasks.draft))).toBe(canonicalJson(rowBefore));

    // The whole tenant, not just the targeted row: an attack that wrote a sibling row is a
    // cross-tenant write too.
    expect(await tenantSnapshot(prisma, pair.b.orgId)).toEqual(before);
  });

  it('a POST /run on B’s ready task reserves nothing in either tenant', async () => {
    const before = await tenantSnapshot(prisma, pair.b.orgId);

    const attack = await asAMember(
      'post',
      `/v1/orgs/${pair.a.orgId}/tasks/${pair.b.tasks.ready}/run`,
    ).send({});

    expectNotFoundMessage(attack, 'Task not found.');
    expectNoTenantBTrace(attack);

    // The shape the hole would leave: a run whose `orgId` is A and whose `taskId` is B's.
    // Counted explicitly because a whole-tenant snapshot of B cannot see a row filed under A.
    expect(
      await prisma.workflowRun.count({
        where: { orgId: pair.a.orgId, taskId: pair.b.tasks.ready },
      }),
    ).toBe(0);
    expect(await prisma.workflowRun.count({ where: { taskId: pair.b.tasks.ready } })).toBe(0);
    expect(await prisma.executionAttempt.count({ where: { taskId: pair.b.tasks.ready } })).toBe(0);

    expect(await tenantSnapshot(prisma, pair.b.orgId)).toEqual(before);
  });

  it('a POST /projects into B’s workspace creates no project', async () => {
    const before = await tenantSnapshot(prisma, pair.b.orgId);

    const attack = await asA(
      'post',
      `/v1/orgs/${pair.a.orgId}/workspaces/${pair.b.workspaceId}/projects`,
    ).send({ key: 'GATE', name: 'Gate M intrusion', environment: 'dev' });

    expectNotFoundMessage(attack, 'Workspace not found.');
    expectNoTenantBTrace(attack);

    expect(
      await prisma.project.count({
        where: { orgId: pair.a.orgId, workspaceId: pair.b.workspaceId },
      }),
    ).toBe(0);
    expect(await prisma.project.count({ where: { workspaceId: pair.b.workspaceId } })).toBe(1);
    expect(await tenantSnapshot(prisma, pair.b.orgId)).toEqual(before);
  });

  it('a POST /cancel on B’s task cancels nothing, and is told the task is absent', async () => {
    const before = await tenantSnapshot(prisma, pair.b.orgId);
    const rowBefore = await taskSnapshotRow(pair.b.tasks.ready);

    const attack = await asAMember(
      'post',
      `/v1/orgs/${pair.a.orgId}/tasks/${pair.b.tasks.ready}/cancel`,
    ).send({});

    /**
     * 404, where the same call on our own `ready` task is 409 (`TASK_NOT_CANCELLABLE`).
     *
     * That difference is the assertion: 409 is a statement about a row we can see, and it is
     * what an attacker would get if the tenant conjunct were dropped — a confirmation that
     * the id is real, without the cancellation itself succeeding.
     */
    expectNotFoundMessage(attack, 'Task not found.');
    expectNoTenantBTrace(attack);

    const own = await asAMember(
      'post',
      `/v1/orgs/${pair.a.orgId}/tasks/${pair.a.tasks.executed}/cancel`,
    ).send({});

    expect(own.status).toBe(409);
    expect((own.body as ApiErrorBody).error.code).toBe('TASK_NOT_CANCELLABLE');

    expect(canonicalJson(await taskSnapshotRow(pair.b.tasks.ready))).toBe(canonicalJson(rowBefore));
    expect(await tenantSnapshot(prisma, pair.b.orgId)).toEqual(before);
  });
});

// ─── 3. Artifact replay ──────────────────────────────────────────────────────

describe('attack 3 — B’s artifact bytes are never served under A', () => {
  it('metadata and content of B’s artifact are 404, and no response digests to B’s bytes', async () => {
    const attackDigest = sha256(pair.b.artifact.content);

    const metadata = await asA('get', `/v1/orgs/${pair.a.orgId}/artifacts/${pair.b.artifact.id}`);

    expectNotFoundMessage(metadata, 'Artifact not found.');
    expect(sha256(canonicalJson(metadata.body))).not.toBe(attackDigest);
    expectNoTenantBTrace(metadata);

    const content = await asA(
      'get',
      `/v1/orgs/${pair.a.orgId}/artifacts/${pair.b.artifact.id}/content`,
    );

    expectNotFoundMessage(content, 'Artifact not found.');
    // The literal form of the requirement: whatever bytes came back, they are not B's.
    expect(sha256(content.text ?? '')).not.toBe(attackDigest);
    expect(content.text ?? '').not.toBe(pair.b.artifact.content);
  });

  it('B’s artifact cannot be reached through A’s task path', async () => {
    // A's own attempt path: the control. It must list A's artifact and nothing else.
    const own = await asA(
      'get',
      `/v1/orgs/${pair.a.orgId}/tasks/${pair.a.tasks.executed}/executions/${pair.a.attemptId}`,
    );

    expect(own.status).toBe(200);

    const ownDetail = (own.body as DataBody<AttemptDetailData>).data;
    const digests = ownDetail.artifacts.map((artifact) => artifact.checksum);

    expect(ownDetail.artifacts.map((artifact) => artifact.id)).toEqual([pair.a.artifact.id]);
    expect(digests).not.toContain(pair.b.artifact.checksum);
    expect(sha256(canonicalJson(ownDetail.artifacts))).not.toBe(sha256(pair.b.artifact.content));

    // B's task and attempt addressed under A's organisation: the task lookup refuses before
    // any artifact is considered.
    const foreignTask = await asA(
      'get',
      `/v1/orgs/${pair.a.orgId}/tasks/${pair.b.tasks.executed}/executions/${pair.b.attemptId}`,
    );

    expectNotFoundMessage(foreignTask, 'Task not found.');
    expect(sha256(foreignTask.text ?? '')).not.toBe(sha256(pair.b.artifact.content));

    // A's own task with B's attempt id: the task is ours, the attempt is not. The composite
    // predicate is `(id, orgId, taskId)`, so this is refused by the task arm.
    const mismatched = await asA(
      'get',
      `/v1/orgs/${pair.a.orgId}/tasks/${pair.a.tasks.executed}/executions/${pair.b.attemptId}`,
    );

    // The task is ours and the attempt is not: the composite predicate `(id, orgId, taskId)`
    // refuses it, and says so without naming which half failed.
    expectNotFoundMessage(mismatched, 'Execution attempt not found.');
    expect(sha256(mismatched.text ?? '')).not.toBe(sha256(pair.b.artifact.content));
  });

  it('the same artifact is served to B, so the digest comparison above is meaningful', async () => {
    const response = await asB(
      'get',
      `/v1/orgs/${pair.b.orgId}/artifacts/${pair.b.artifact.id}/content`,
    );

    expect(response.status).toBe(200);
    expect(sha256(response.text ?? '')).toBe(sha256(pair.b.artifact.content));
    expect(response.text).toBe(pair.b.artifact.content);
    expect(response.headers['x-artifact-checksum']).toBe(pair.b.artifact.checksum);
  });
});

// ─── 4. Approval replay ──────────────────────────────────────────────────────

describe('attack 4 — B’s approvals cannot be decided, revoked or spent by A', () => {
  it('deciding B’s pending request leaves it PENDING', async () => {
    const before = await approvalRows(pair.b);

    const attack = await asA(
      'post',
      `/v1/orgs/${pair.a.orgId}/approvals/${pair.b.approvals.pending}/decision`,
    ).send({ decision: 'approve' });

    expectNotFoundMessage(attack, 'Approval request not found.');
    expectNoTenantBTrace(attack);

    const pending = await prisma.approvalRequest.findUniqueOrThrow({
      where: { id: pair.b.approvals.pending },
      select: { status: true, decidedById: true, decidedAt: true, decisionNote: true },
    });

    expect(pending.status).toBe('PENDING');
    expect(pending.decidedById).toBeNull();
    expect(pending.decidedAt).toBeNull();
    expect(await approvalRows(pair.b)).toBe(before);
  });

  it('revoking B’s approved grant leaves it APPROVED and unconsumed', async () => {
    const before = await approvalRows(pair.b);

    const attack = await asA(
      'post',
      `/v1/orgs/${pair.a.orgId}/approvals/${pair.b.approvals.approved}/revoke`,
    ).send({});

    expectNotFoundMessage(attack, 'Approval request not found.');
    expectNoTenantBTrace(attack);

    const grant = await prisma.approvalRequest.findUniqueOrThrow({
      where: { id: pair.b.approvals.approved },
      select: { status: true, revokedAt: true, revokedById: true, consumedAt: true },
    });

    expect(grant.status).toBe('APPROVED');
    expect(grant.revokedAt).toBeNull();
    expect(grant.revokedById).toBeNull();
    expect(grant.consumedAt).toBeNull();
    expect(await approvalRows(pair.b)).toBe(before);
  });

  it('a run addressed at B’s HIGH task spends nothing', async () => {
    const before = await approvalRows(pair.b);
    const taskBefore = await taskSnapshotRow(pair.b.tasks.high);

    const attack = await asAMember(
      'post',
      `/v1/orgs/${pair.a.orgId}/tasks/${pair.b.tasks.high}/run`,
    ).send({});

    expectNotFoundMessage(attack, 'Task not found.');
    expectNoTenantBTrace(attack);

    const grant = await prisma.approvalRequest.findUniqueOrThrow({
      where: { id: pair.b.approvals.approved },
      select: { status: true, consumedAt: true, consumedByAttemptId: true },
    });

    // The precise residual this attack would recreate: a consumed grant attributable to no
    // attempt of the owning tenant.
    expect(grant.status).toBe('APPROVED');
    expect(grant.consumedAt).toBeNull();
    expect(grant.consumedByAttemptId).toBeNull();

    expect(await approvalRows(pair.b)).toBe(before);
    expect(canonicalJson(await taskSnapshotRow(pair.b.tasks.high))).toBe(canonicalJson(taskBefore));
    expect(await prisma.workflowRun.count({ where: { taskId: pair.b.tasks.high } })).toBe(0);
  });
});

// ─── 6. The error-code oracle ────────────────────────────────────────────────

describe('attack 6 — “another tenant” and “does not exist” are indistinguishable', () => {
  const absent = (): string => randomUUID();

  /**
   * Every pair is `[a B id, an id that has never existed]` for the same route.
   *
   * `expectedStatus` is 404 for a resource and 400 for a cursor, because a cursor is refused
   * as a malformed position rather than as a missing row — but the *two answers to the same
   * question* still have to be identical, which is what the assertions below check.
   */
  const pairs: ReadonlyArray<{
    readonly name: string;
    readonly foreign: () => request.Test;
    readonly missing: () => request.Test;
    readonly expectedStatus: number;
  }> = [
    {
      name: 'task detail',
      foreign: () => asA('get', `/v1/orgs/${pair.a.orgId}/tasks/${pair.b.tasks.draft}`),
      missing: () => asA('get', `/v1/orgs/${pair.a.orgId}/tasks/${absent()}`),
      expectedStatus: 404,
    },
    {
      name: 'PATCH task',
      foreign: () =>
        asAMember('patch', `/v1/orgs/${pair.a.orgId}/tasks/${pair.b.tasks.draft}`).send({
          status: 'ready',
          reason: 'gate-m oracle probe',
        }),
      missing: () =>
        asAMember('patch', `/v1/orgs/${pair.a.orgId}/tasks/${absent()}`).send({
          status: 'ready',
          reason: 'gate-m oracle probe',
        }),
      expectedStatus: 404,
    },
    {
      name: 'POST run',
      foreign: () =>
        asAMember('post', `/v1/orgs/${pair.a.orgId}/tasks/${pair.b.tasks.ready}/run`).send({}),
      missing: () => asAMember('post', `/v1/orgs/${pair.a.orgId}/tasks/${absent()}/run`).send({}),
      expectedStatus: 404,
    },
    {
      name: 'executions list',
      foreign: () =>
        asA('get', `/v1/orgs/${pair.a.orgId}/tasks/${pair.b.tasks.executed}/executions`),
      missing: () => asA('get', `/v1/orgs/${pair.a.orgId}/tasks/${absent()}/executions`),
      expectedStatus: 404,
    },
    {
      name: 'artifact metadata',
      foreign: () => asA('get', `/v1/orgs/${pair.a.orgId}/artifacts/${pair.b.artifact.id}`),
      missing: () => asA('get', `/v1/orgs/${pair.a.orgId}/artifacts/${absent()}`),
      expectedStatus: 404,
    },
    {
      name: 'artifact content',
      foreign: () => asA('get', `/v1/orgs/${pair.a.orgId}/artifacts/${pair.b.artifact.id}/content`),
      missing: () => asA('get', `/v1/orgs/${pair.a.orgId}/artifacts/${absent()}/content`),
      expectedStatus: 404,
    },
    {
      name: 'approval decision',
      foreign: () =>
        asA('post', `/v1/orgs/${pair.a.orgId}/approvals/${pair.b.approvals.pending}/decision`).send(
          { decision: 'approve' },
        ),
      missing: () =>
        asA('post', `/v1/orgs/${pair.a.orgId}/approvals/${absent()}/decision`).send({
          decision: 'approve',
        }),
      expectedStatus: 404,
    },
    {
      name: 'projects under a workspace',
      foreign: () =>
        asA('get', `/v1/orgs/${pair.a.orgId}/workspaces/${pair.b.workspaceId}/projects`),
      missing: () => asA('get', `/v1/orgs/${pair.a.orgId}/workspaces/${absent()}/projects`),
      expectedStatus: 404,
    },
    {
      // A cursor is the one place a *position* is a tenant identifier: Prisma would happily
      // seek to a foreign row and return a page that starts after it.
      name: 'task-list cursor',
      foreign: () =>
        asA(
          'get',
          `/v1/orgs/${pair.a.orgId}/projects/${pair.a.projectId}/tasks?cursor=${pair.b.tasks.draft}`,
        ),
      missing: () =>
        asA(
          'get',
          `/v1/orgs/${pair.a.orgId}/projects/${pair.a.projectId}/tasks?cursor=${absent()}`,
        ),
      expectedStatus: 400,
    },
    {
      name: 'approval-queue cursor',
      foreign: () =>
        asA('get', `/v1/orgs/${pair.a.orgId}/approvals?cursor=${pair.b.approvals.pending}`),
      missing: () => asA('get', `/v1/orgs/${pair.a.orgId}/approvals?cursor=${absent()}`),
      expectedStatus: 400,
    },
  ];

  for (const probe of pairs) {
    it(`${probe.name}: the two refusals are the same bytes`, async () => {
      const foreign = await probe.foreign();
      const missing = await probe.missing();

      expect(foreign.status).toBe(probe.expectedStatus);
      expect(missing.status).toBe(probe.expectedStatus);

      // The whole `error` object: code, message and any details. A differing message is the
      // oracle — it tells a guessing attacker which ids are real.
      expect(foreign.body.error).toEqual(missing.body.error);
      expect(Object.keys(foreign.body as object).sort()).toEqual(['correlationId', 'error']);
      expect(foreign.headers['content-type']).toBe(missing.headers['content-type']);

      // The correlation id is the one field that may differ, and it must be a real one:
      // the envelope promises it, and a client that quotes it in a bug report needs it.
      expect((foreign.body as ApiErrorBody).correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  }
});

// ─── Positive controls ───────────────────────────────────────────────────────

describe('controls — the same routes do work inside the tenant', () => {
  /**
   * These run last and mutate tenant A on purpose.
   *
   * Without them the 404s above are compatible with "the endpoint is broken", which is the
   * way a tenancy suite becomes decorative: every attack passes, and so would an empty
   * controller.
   */

  it('A’s own draft task moves draft → ready', async () => {
    const response = await asAMember(
      'patch',
      `/v1/orgs/${pair.a.orgId}/tasks/${pair.a.tasks.draft}`,
    ).send({ status: 'ready', reason: 'gate-m: in-tenant control' });

    expect(response.status).toBe(200);
    expect((response.body as DataBody<TaskData>).data.status).toBe('ready');
  });

  it('A’s own ready task reaches the reservation (and fails only at the orchestrator)', async () => {
    const response = await request(offline.getHttpServer())
      .post(`/v1/orgs/${pair.a.orgId}/tasks/${pair.a.tasks.ready}/run`)
      .set(authHeaders(memberA, pair.a.orgId))
      .send({});

    // 503, not 404: the task was found, reserved and then the start failed. That is the
    // exact difference the cross-tenant attempt above must not produce.
    expect(response.status).toBe(503);
    expect((response.body as ApiErrorBody).error.code).toBe('ORCHESTRATOR_UNAVAILABLE');

    const task = await prisma.task.findUniqueOrThrow({
      where: { id: pair.a.tasks.ready },
      select: { status: true },
    });

    // The documented compensation: nothing is left queued with nothing running it.
    expect(task.status).toBe('ready');

    const attempt = await prisma.executionAttempt.findFirstOrThrow({
      where: { orgId: pair.a.orgId, taskId: pair.a.tasks.ready },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, terminationReason: true },
    });

    expect(attempt.status).toBe('failed');
    expect(attempt.terminationReason).toBe('start_failed');
  });

  it('A’s own HIGH task consumes its grant, and only its own', async () => {
    const response = await request(offline.getHttpServer())
      .post(`/v1/orgs/${pair.a.orgId}/tasks/${pair.a.tasks.high}/run`)
      .set(authHeaders(memberA, pair.a.orgId))
      .send({});

    expect(response.status).toBe(503);

    const grant = await prisma.approvalRequest.findUniqueOrThrow({
      where: { id: pair.a.approvals.approved },
      select: { status: true, consumedAt: true, consumedByAttemptId: true },
    });

    const attempt = await prisma.executionAttempt.findFirstOrThrow({
      where: { orgId: pair.a.orgId, taskId: pair.a.tasks.high },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    // Consumed, and attributable to the attempt that spent it — the Phase 5 link a
    // cross-tenant run would have written with the wrong `orgId`.
    expect(grant.status).toBe('APPROVED');
    expect(grant.consumedAt).not.toBeNull();
    expect(grant.consumedByAttemptId).toBe(attempt.id);

    // Tenant B is untouched by A's legitimate spend. This is the assertion the cross-tenant
    // attack above could not make on its own: it shows the consume path really runs.
    const unaffected = await prisma.approvalRequest.findUniqueOrThrow({
      where: { id: pair.b.approvals.approved },
      select: { status: true, consumedAt: true, consumedByAttemptId: true },
    });

    expect(unaffected.status).toBe('APPROVED');
    expect(unaffected.consumedAt).toBeNull();
    expect(unaffected.consumedByAttemptId).toBeNull();
  });

  it('A’s own pending approval can be decided by A’s owner', async () => {
    const response = await asA(
      'post',
      `/v1/orgs/${pair.a.orgId}/approvals/${pair.a.approvals.pending}/decision`,
    ).send({ decision: 'approve' });

    expect(response.status).toBe(200);
    expect((response.body as DataBody<ApprovalData>).data.status).toBe('APPROVED');

    // And B's queue is still exactly as the attacks left it.
    const pendingB = await prisma.approvalRequest.findUniqueOrThrow({
      where: { id: pair.b.approvals.pending },
      select: { status: true },
    });

    expect(pendingB.status).toBe('PENDING');
  });
});

/**
 * Reported in the run output, not asserted: the exact identifiers this suite used, so a
 * failure in a later run can be reproduced against the same rows by hand.
 */
describe('fixture provenance', () => {
  it('every id is derived from the seed, is UUID-shaped, and names its object', () => {
    // Determinism is the property the whole gate leans on: a re-run must attack the same
    // rows, or a failure is not reproducible.
    expect(derivedId(SEED, 'org', 'a')).toBe(pair.a.orgId);
    expect(derivedId(SEED, 'org', 'b')).toBe(pair.b.orgId);

    for (const tenant of [pair.a, pair.b]) {
      for (const [name, id] of Object.entries({
        org: tenant.orgId,
        project: tenant.projectId,
        artifact: tenant.artifact.id,
      })) {
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(describeId(pair, id)).toBe(`tenant ${tenant.label}:${name}`);
      }
    }
  });
});
