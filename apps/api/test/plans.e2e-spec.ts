import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

import { Client, Connection } from '@temporalio/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/app-config';
import type { ApiErrorBody } from './helpers/api-types';
import { createTestApp, startSuite, authHeaders, login, type Suite } from './helpers/app';
import { optionalEnv } from './helpers/env';

/**
 * The proposal API, end to end, against a **local stub model**.
 *
 * Nothing here talks to a real model or the internet: the planner endpoint is a
 * `node:http` server on port 0 that returns canned OpenAI-compatible responses. That is
 * the point — every assertion is about what *this service* does with a response, not about
 * what a model can produce.
 *
 * The suite is organised around the one sentence that governs the feature: the planner
 * proposes, validation judges, a human authorises, and the existing programme workflow
 * executes. Each test attacks one boundary:
 *
 *   1. a valid proposal creates a plan and nothing else;
 *   2. an unschedulable proposal is recorded as `invalid` and cannot be approved;
 *   3. approval records a decision and still creates nothing that can run;
 *   4. submission materialises exactly once, and a retry returns the same programme;
 *   5. a changed proposal cannot be submitted under an old approval;
 *   6. an expired approval cannot be spent;
 *   7. roles and tenants are enforced before the plan is touched;
 *   8. a broken or absent planner creates no row;
 *   9. a plan's `riskClass` is a claim — the server's class is the effective one, and the
 *      task stops at the approval gate rather than running;
 *  10. proposing is idempotent, and a replay does not call the model twice;
 *  11. the proposer cannot approve their own plan (four-eyes, owned by `org-policy.ts`).
 *
 * The parent programme workflow is started on a task queue no worker polls, so nothing
 * executes. Test 9 therefore asserts at the submission boundary exactly what is provable
 * there — effective risk class, task state, no attempt, no grant — and does not claim the
 * worker refused to run something it was never asked to run.
 */

let suite: Suite;
let ownerToken: string;
let memberToken: string;
let ownerBToken: string;
let secondAdminToken: string;

let stub: Server;
let stubUrl: string;
const stubCalls: StubCall[] = [];

const startedWorkflowIds: string[] = [];

const orgId = (): string => suite.fixtures.orgA.id;
const projectId = (): string => suite.fixtures.projectA;
const plansPath = (): string => `/v1/orgs/${orgId()}/plans`;

interface StubCall {
  readonly objective: string;
  readonly authorization: string | undefined;
  readonly model: string | undefined;
}

interface PlanBody {
  data: {
    id: string;
    projectId: string;
    objective: string;
    status: string;
    provider: string;
    providerModel: string | null;
    simulated: boolean;
    validation: { ok: boolean; issues: { code: string; taskKey: string | null; message: string }[] };
    tasks: {
      key: string;
      title: string;
      goal: string;
      acceptanceCriteria: string[];
      dependsOn: string[];
      riskClass: string;
    }[];
    assumptions: string[];
    unresolved: string[];
    createdBy: string;
    approvedBy: string | null;
    approvedAt: string | null;
    approvalExpiresAt: string | null;
    approvalExpired: boolean;
    rejectedBy: string | null;
    decidedAt: string | null;
    decisionNote: string | null;
    programmeId: string | null;
    createdAt: string;
  };
  meta: { created: boolean };
}

interface SubmitBody {
  data: { planId: string; programme: { programmeId: string; status: string } };
  meta: { created: boolean };
}

interface Counts {
  tasks: number;
  programmes: number;
  attempts: number;
  plans: number;
}

function errorOf(body: unknown): ApiErrorBody['error'] {
  return (body as ApiErrorBody).error;
}

/** A well-formed three-task linear plan. */
function validPlan(objective: string): object {
  return {
    version: 1,
    objective,
    tasks: [
      {
        key: 'spec',
        title: 'Write the specification',
        goal: 'State the change and the check that proves it.',
        acceptanceCriteria: ['The specification names one observable outcome.'],
        dependsOn: [],
        riskClass: 'LOW',
      },
      {
        key: 'build',
        title: 'Implement the change',
        goal: 'Implement the specified change without widening its scope.',
        acceptanceCriteria: ['The test suite passes.'],
        dependsOn: ['spec'],
        riskClass: 'LOW',
      },
      {
        key: 'verify',
        title: 'Verify the change',
        goal: 'Run the checks the specification named and record the result.',
        acceptanceCriteria: ['The named check passes and its output is recorded.'],
        dependsOn: ['build'],
        riskClass: 'MEDIUM',
      },
    ],
    assumptions: ['The repository builds from a clean checkout.'],
    unresolved: [],
  };
}

/** A schema-valid plan whose graph is not schedulable: alpha → beta → alpha. */
function cyclicPlan(objective: string): object {
  return {
    version: 1,
    objective,
    tasks: [
      {
        key: 'alpha',
        title: 'Alpha task',
        goal: 'The first half of a cycle.',
        acceptanceCriteria: ['Alpha is done.'],
        dependsOn: ['beta'],
        riskClass: 'LOW',
      },
      {
        key: 'beta',
        title: 'Beta task',
        goal: 'The second half of a cycle.',
        acceptanceCriteria: ['Beta is done.'],
        dependsOn: ['alpha'],
        riskClass: 'LOW',
      },
    ],
    assumptions: [],
    unresolved: [],
  };
}

/**
 * A one-task plan that *claims* `LOW` and asks for a production deploy.
 *
 * The server's classifier (D-006) reads `deploy` / `production` and derives `CRITICAL`.
 * The claim must be recorded and ignored — this is the test that proves it.
 */
function highRiskClaimPlan(objective: string): object {
  return {
    version: 1,
    objective,
    tasks: [
      {
        key: 'deploy',
        title: 'Deploy the service',
        goal: 'Deploy the payment service to production.',
        acceptanceCriteria: ['The deployment reports healthy.'],
        dependsOn: [],
        // The claim. It is deliberately wrong.
        riskClass: 'LOW',
      },
    ],
    assumptions: [],
    unresolved: ['No rollback plan was supplied.'],
  };
}

/** The OpenAI-compatible response the stub returns for a plan payload. */
function completion(payload: unknown): string {
  return JSON.stringify({
    id: 'chatcmpl-stub',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: JSON.stringify(payload) },
        finish_reason: 'stop',
      },
    ],
  });
}

/**
 * The stub model. It dispatches on a marker inside the objective, so one server can serve
 * every case without the app being rebooted between tests.
 */
function startStub(): Promise<void> {
  stub = createServer((req, res) => {
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => chunks.push(chunk));

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: {
        model?: string;
        messages?: { role: string; content: string }[];
      } = {};

      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        // A malformed request is answered as a bad request; the test that sends one would
        // assert on that, and none does today.
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid request body' }));
        return;
      }

      const userMessage = body.messages?.find((message) => message.role === 'user')?.content ?? '';
      const objective = /<objective>\s*([\s\S]*?)\s*<\/objective>/.exec(userMessage)?.[1] ?? '';

      stubCalls.push({
        objective,
        authorization: req.headers.authorization,
        model: body.model,
      });

      if (objective.includes('FAIL_PROBE')) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'upstream exploded' } }));
        return;
      }

      const payload = objective.includes('CYCLE_PROBE')
        ? cyclicPlan(objective)
        : objective.includes('HIGH_PROBE')
          ? highRiskClaimPlan(objective)
          : validPlan(objective);

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(completion(payload));
    });
  });

  return new Promise((resolve) => {
    stub.listen(0, '127.0.0.1', () => {
      const address = stub.address() as AddressInfo;
      stubUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
}

/** A base URL nothing listens on: the port is allocated, then released. */
async function closedPortUrl(): Promise<string> {
  const server = createServer();

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address() as AddressInfo;

  await new Promise<void>((resolve) => server.close(() => resolve()));

  return `http://127.0.0.1:${address.port}`;
}

beforeAll(async () => {
  await startStub();

  const base = loadConfig();

  suite = await startSuite({
    appOverrides: {
      planner: {
        baseUrl: stubUrl,
        apiKey: 'stub-key-not-a-secret',
        model: 'stub-model',
        timeoutMs: 5_000,
        approvalTtlHours: 24,
      },
      // No worker polls this queue: the parent programme workflow is created and stays
      // queued, which is exactly what "the endpoint started it" means.
      temporal: {
        ...base.temporal,
        taskQueue: `intelligenz-plans-api-test-${randomUUID().slice(0, 8)}`,
      },
    },
  });

  ownerToken = await login(suite.app, suite.fixtures.users.ownerA.email);
  memberToken = await login(suite.app, suite.fixtures.users.memberA.email);
  ownerBToken = await login(suite.app, suite.fixtures.users.ownerB.email);

  // A second ADMIN in org A, so separation of duties can be satisfied by *somebody*.
  // The password hash is copied from an existing fixture, so the standard test password
  // still signs in.
  const existing = await suite.prisma.user.findUniqueOrThrow({
    where: { id: suite.fixtures.users.memberA.id },
    select: { passwordHash: true },
  });

  const secondAdmin = await suite.prisma.user.create({
    data: {
      email: 'admin-a2@example.test',
      name: 'Second Admin A',
      passwordHash: existing.passwordHash,
    },
  });

  await suite.prisma.membership.create({
    data: { orgId: orgId(), userId: secondAdmin.id, role: 'ADMIN' },
  });

  secondAdminToken = await login(suite.app, secondAdmin.email);
}, 120_000);

afterAll(async () => {
  if (startedWorkflowIds.length > 0) {
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
          .terminate('plans api test cleanup')
          .catch(() => undefined);
      }

      await connection.close();
    }
  }

  await suite.close();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

async function counts(): Promise<Counts> {
  const [tasks, programmes, attempts, plans] = await Promise.all([
    suite.prisma.task.count({ where: { orgId: orgId() } }),
    suite.prisma.programme.count({ where: { orgId: orgId() } }),
    suite.prisma.executionAttempt.count({ where: { orgId: orgId() } }),
    suite.prisma.plan.count({ where: { orgId: orgId() } }),
  ]);

  return { tasks, programmes, attempts, plans };
}

function propose(
  token: string,
  body: { projectId: string; objective: string },
  idempotencyKey?: string,
): request.Test {
  const call = request(suite.app.getHttpServer())
    .post(plansPath())
    .set(authHeaders(token, orgId()));

  if (idempotencyKey !== undefined) call.set('idempotency-key', idempotencyKey);

  return call.send(body);
}

function approve(token: string, planId: string, body: object = {}): request.Test {
  return request(suite.app.getHttpServer())
    .post(`${plansPath()}/${planId}/approve`)
    .set(authHeaders(token, orgId()))
    .send(body);
}

function reject(token: string, planId: string, body: object): request.Test {
  return request(suite.app.getHttpServer())
    .post(`${plansPath()}/${planId}/reject`)
    .set(authHeaders(token, orgId()))
    .send(body);
}

function submit(token: string, planId: string): request.Test {
  return request(suite.app.getHttpServer())
    .post(`${plansPath()}/${planId}/submit`)
    .set(authHeaders(token, orgId()));
}

async function proposeValid(proposer: string, marker: string): Promise<PlanBody['data']> {
  const response = await propose(proposer, {
    projectId: projectId(),
    objective: `${marker}: ${randomUUID()}`,
  });

  expect(response.status).toBe(201);

  return (response.body as PlanBody).data;
}

/** Propose → approve, the state every submission test starts from. */
async function approvedPlan(proposer: string, approver: string): Promise<PlanBody['data']> {
  const plan = await proposeValid(proposer, 'VALID_PROBE');
  const decision = await approve(approver, plan.id);

  expect(decision.status).toBe(200);

  return (decision.body as PlanBody).data;
}

describe('POST /plans — propose', () => {
  it('turns one objective into a three-task proposal and no execution rows', async () => {
    const before = await counts();

    const response = await propose(memberToken, {
      projectId: projectId(),
      objective: `VALID_PROBE: one objective becomes three tasks ${randomUUID()}`,
    });

    expect(response.status).toBe(201);

    const body = response.body as PlanBody;

    expect(body.meta.created).toBe(true);
    expect(body.data.status).toBe('proposed');
    expect(body.data.validation).toEqual({ ok: true, issues: [] });
    expect(body.data.tasks.map((task) => task.key)).toEqual(['spec', 'build', 'verify']);
    expect(body.data.tasks[1]?.dependsOn).toEqual(['spec']);
    expect(body.data.provider).toBe('http-llm');
    expect(body.data.providerModel).toBe('stub-model');
    expect(body.data.simulated).toBe(false);
    expect(body.data.approvedBy).toBeNull();
    expect(body.data.programmeId).toBeNull();

    // Provenance and the hash are not on the wire.
    expect(response.body).not.toHaveProperty('data.approvedContentHash');
    expect(response.body).not.toHaveProperty('data.idempotencyKey');

    // The proposal is a row; the work is not.
    const after = await counts();

    expect(after).toEqual({ ...before, plans: before.plans + 1 });

    const stored = await suite.prisma.plan.findUniqueOrThrow({ where: { id: body.data.id } });
    expect(stored.approvedContentHash).toBeNull();
    expect(stored.approvedById).toBeNull();
    expect(stored.createdById).toBe(suite.fixtures.users.memberA.id);
    expect(stored.orgId).toBe(orgId());

    const audit = await suite.prisma.auditEvent.findMany({
      where: { aggregateId: body.data.id, eventType: 'plan.proposed.v1' },
    });

    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorId).toBe(suite.fixtures.users.memberA.id);
    expect(audit[0]?.payload).toMatchObject({
      provider: 'http-llm',
      model: 'stub-model',
      simulated: false,
      status: 'proposed',
      taskKeys: ['spec', 'build', 'verify'],
    });
    // Never the prompt or the raw body.
    expect(JSON.stringify(audit[0]?.payload)).not.toContain('acceptanceCriteria');
  }, 30_000);

  it('records an unschedulable graph as invalid, with a cycle issue, and refuses approval', async () => {
    const before = await counts();

    const response = await propose(memberToken, {
      projectId: projectId(),
      objective: `CYCLE_PROBE: a cycle is proposed ${randomUUID()}`,
    });

    expect(response.status).toBe(201);

    const body = response.body as PlanBody;

    expect(body.data.status).toBe('invalid');
    expect(body.data.validation.ok).toBe(false);
    expect(body.data.validation.issues.map((issue) => issue.code)).toContain('cycle');
    // Translated to plan keys: no synthetic id leaks to the client.
    expect(body.data.validation.issues.every((issue) => !issue.message.includes('plan:'))).toBe(
      true,
    );

    // A rejected proposal is a successful response, not a 4xx — but it is still no work.
    expect(await counts()).toEqual({ ...before, plans: before.plans + 1 });

    const decision = await approve(ownerToken, body.data.id);

    expect(decision.status).toBe(422);
    expect(errorOf(decision.body).code).toBe('PLAN_NOT_VALID');

    const stored = await suite.prisma.plan.findUniqueOrThrow({ where: { id: body.data.id } });
    expect(stored.status).toBe('invalid');
    expect(stored.approvedById).toBeNull();
  }, 30_000);

  it('is idempotent: the same Idempotency-Key returns the same plan and calls the model once', async () => {
    const key = `plan-${randomUUID()}`;
    const callsBefore = stubCalls.length;

    const first = await propose(
      memberToken,
      { projectId: projectId(), objective: `VALID_PROBE: replay ${randomUUID()}` },
      key,
    );
    const second = await propose(
      memberToken,
      { projectId: projectId(), objective: `VALID_PROBE: replay ${randomUUID()}` },
      key,
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);

    const firstBody = first.body as PlanBody;
    const secondBody = second.body as PlanBody;

    expect(secondBody.data.id).toBe(firstBody.data.id);
    expect(secondBody.meta.created).toBe(false);

    // The provider was not asked twice. This is the assertion a `meta.created` check alone
    // cannot make.
    expect(stubCalls.length - callsBefore).toBe(1);

    expect(
      await suite.prisma.plan.count({ where: { orgId: orgId(), idempotencyKey: key } }),
    ).toBe(1);
  }, 30_000);
});

describe('POST /plans/:id/approve — the decision', () => {
  it('records the approver, the hash and the expiry, and creates no execution rows', async () => {
    const before = await counts();
    const plan = await proposeValid(memberToken, 'VALID_PROBE');

    const response = await approve(ownerToken, plan.id, { note: 'Scope is acceptable.' });

    expect(response.status).toBe(200);

    const body = response.body as PlanBody;

    expect(body.meta.created).toBe(true);
    expect(body.data.status).toBe('approved');
    expect(body.data.approvedBy).toBe(suite.fixtures.users.ownerA.id);
    expect(body.data.approvedAt).not.toBeNull();
    expect(body.data.approvalExpiresAt).not.toBeNull();
    expect(body.data.approvalExpired).toBe(false);
    expect(body.data.decisionNote).toBe('Scope is acceptable.');

    const stored = await suite.prisma.plan.findUniqueOrThrow({ where: { id: plan.id } });

    expect(stored.status).toBe('approved');
    expect(stored.approvedById).toBe(suite.fixtures.users.ownerA.id);
    expect(stored.approvedContentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.approvedAt).not.toBeNull();
    expect(stored.approvalExpiresAt).not.toBeNull();

    // The hard requirement: an approval authorises, it does not execute or schedule.
    expect(await counts()).toEqual({ ...before, plans: before.plans + 1 });

    const audit = await suite.prisma.auditEvent.findMany({
      where: { aggregateId: plan.id, eventType: 'plan.approved.v1' },
    });

    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorId).toBe(suite.fixtures.users.ownerA.id);
    expect(audit[0]?.payload).toMatchObject({
      planId: plan.id,
      approvedById: suite.fixtures.users.ownerA.id,
      contentHash: stored.approvedContentHash,
      taskKeys: ['spec', 'build', 'verify'],
      unresolvedCount: 0,
    });
  }, 30_000);

  it('refuses the proposer approving their own plan, changes nothing and audits the refusal', async () => {
    const before = await counts();

    // ownerA is OWNER, which satisfies `@Roles('ADMIN')`. The refusal is the separation of
    // duties rule, not the role check.
    const plan = await proposeValid(ownerToken, 'VALID_PROBE');

    const response = await approve(ownerToken, plan.id, { note: 'Approving my own work.' });

    expect(response.status).toBe(403);
    expect(errorOf(response.body).code).toBe('SELF_APPROVAL_FORBIDDEN');

    const stored = await suite.prisma.plan.findUniqueOrThrow({ where: { id: plan.id } });

    expect(stored.status).toBe('proposed');
    expect(stored.approvedById).toBeNull();
    expect(stored.approvedContentHash).toBeNull();
    expect(stored.approvedAt).toBeNull();

    const refusals = await suite.prisma.auditEvent.findMany({
      where: { aggregateId: plan.id, eventType: 'plan.self_approval_refused.v1' },
    });

    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.actorId).toBe(suite.fixtures.users.ownerA.id);
    expect(refusals[0]?.payload).toMatchObject({
      planId: plan.id,
      userId: suite.fixtures.users.ownerA.id,
      role: 'OWNER',
    });

    // A refusal is not a decision: no plan change (beyond the proposal row) and no work.
    expect(await counts()).toEqual({ ...before, plans: before.plans + 1 });

    // A second admin in the same organisation can approve it.
    const second = await approve(secondAdminToken, plan.id);

    expect(second.status).toBe(200);
    expect((second.body as PlanBody).data.status).toBe('approved');
  }, 30_000);

  it('rejects a plan, idempotently, without creating work', async () => {
    const before = await counts();
    const plan = await proposeValid(memberToken, 'VALID_PROBE');

    const first = await reject(ownerToken, plan.id, { note: 'The goal is too vague.' });
    const second = await reject(ownerToken, plan.id, { note: 'The goal is too vague.' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((second.body as PlanBody).meta.created).toBe(false);

    const stored = await suite.prisma.plan.findUniqueOrThrow({ where: { id: plan.id } });

    expect(stored.status).toBe('rejected');
    expect(stored.rejectedById).toBe(suite.fixtures.users.ownerA.id);
    expect(stored.decisionNote).toBe('The goal is too vague.');
    expect(stored.approvedById).toBeNull();
    expect(await counts()).toEqual({ ...before, plans: before.plans + 1 });
  }, 30_000);
});

describe('POST /plans/:id/submit — the deterministic consequence', () => {
  it('creates one programme and one set of tasks, and a retry returns the same programme', async () => {
    const plan = await approvedPlan(memberToken, ownerToken);

    const first = await submit(memberToken, plan.id);

    expect(first.status).toBe(202);

    const firstBody = first.body as SubmitBody;
    const programmeId = firstBody.data.programme.programmeId;

    expect(firstBody.meta.created).toBe(true);

    const second = await submit(memberToken, plan.id);

    expect(second.status).toBe(200);

    const secondBody = second.body as SubmitBody;

    expect(secondBody.data.planId).toBe(plan.id);
    expect(secondBody.data.programme.programmeId).toBe(programmeId);
    expect(secondBody.meta.created).toBe(false);

    // One programme, one task set — not two of either.
    const programmes = await suite.prisma.programme.findMany({
      where: { orgId: orgId(), idempotencyKey: `plan:${plan.id}` },
      include: { tasks: true },
    });

    expect(programmes).toHaveLength(1);
    expect(programmes[0]?.tasks).toHaveLength(3);

    const tasks = await suite.prisma.task.findMany({
      where: { orgId: orgId(), idempotencyKey: { startsWith: `plan:${plan.id}:` } },
      orderBy: { title: 'asc' },
    });

    expect(tasks).toHaveLength(3);
    // Submission promotes through the existing transition path.
    expect(tasks.every((task) => task.status === 'ready')).toBe(true);
    expect(tasks.every((task) => task.createdById === suite.fixtures.users.ownerA.id)).toBe(true);

    const stored = await suite.prisma.plan.findUniqueOrThrow({ where: { id: plan.id } });

    expect(stored.status).toBe('submitted');
    expect(stored.programmeId).toBe(programmeId);

    const audits = await suite.prisma.auditEvent.findMany({
      where: { aggregateId: plan.id, eventType: 'plan.submitted.v1' },
    });

    expect(audits).toHaveLength(1);
    expect(audits[0]?.payload).toMatchObject({ programmeId });

    // No execution attempt is created by submission: nothing has run.
    expect(await suite.prisma.executionAttempt.count({ where: { orgId: orgId() } })).toBe(0);

    startedWorkflowIds.push(`programme-${programmeId}`);
  }, 60_000);

  it('refuses to spend an approval on content that changed after the decision', async () => {
    const plan = await approvedPlan(memberToken, ownerToken);

    const stored = await suite.prisma.plan.findUniqueOrThrow({ where: { id: plan.id } });
    const proposal = stored.proposal as {
      tasks: { acceptanceCriteria: string[] }[];
    };

    proposal.tasks[0]!.acceptanceCriteria = ['A criterion the approver never saw.'];

    await suite.prisma.plan.update({ where: { id: plan.id }, data: { proposal } });

    const programmesBefore = await suite.prisma.programme.count({ where: { orgId: orgId() } });
    const tasksBefore = await suite.prisma.task.count({ where: { orgId: orgId() } });

    const response = await submit(memberToken, plan.id);

    expect(response.status).toBe(409);
    expect(errorOf(response.body).code).toBe('PLAN_CONTENT_CHANGED');

    // Nothing created: the approval was for other bytes.
    expect(await suite.prisma.programme.count({ where: { orgId: orgId() } })).toBe(
      programmesBefore,
    );
    expect(await suite.prisma.task.count({ where: { orgId: orgId() } })).toBe(tasksBefore);

    const unchanged = await suite.prisma.plan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(unchanged.status).toBe('approved');
    expect(unchanged.programmeId).toBeNull();
  }, 30_000);

  it('refuses to spend an expired approval', async () => {
    const plan = await approvedPlan(memberToken, ownerToken);

    await suite.prisma.plan.update({
      where: { id: plan.id },
      data: { approvalExpiresAt: new Date(Date.now() - 60_000) },
    });

    const programmesBefore = await suite.prisma.programme.count({ where: { orgId: orgId() } });
    const tasksBefore = await suite.prisma.task.count({ where: { orgId: orgId() } });

    const response = await submit(memberToken, plan.id);

    expect(response.status).toBe(422);
    expect(errorOf(response.body).code).toBe('PLAN_APPROVAL_EXPIRED');

    expect(await suite.prisma.programme.count({ where: { orgId: orgId() } })).toBe(
      programmesBefore,
    );
    expect(await suite.prisma.task.count({ where: { orgId: orgId() } })).toBe(tasksBefore);

    const stored = await suite.prisma.plan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(stored.status).toBe('approved');
    expect(stored.programmeId).toBeNull();
  }, 30_000);

  it('refuses submission of a plan that was never approved', async () => {
    const plan = await proposeValid(memberToken, 'VALID_PROBE');

    const response = await submit(memberToken, plan.id);

    expect(response.status).toBe(422);
    expect(errorOf(response.body).code).toBe('PLAN_NOT_APPROVED');
  }, 30_000);

  it('does not let a claimed LOW risk class through: the server class holds and nothing runs', async () => {
    const plan = await proposeValid(memberToken, 'HIGH_PROBE');

    expect(plan.tasks[0]?.riskClass).toBe('LOW');

    const decision = await approve(ownerToken, plan.id);
    expect(decision.status).toBe(200);

    const response = await submit(memberToken, plan.id);
    expect(response.status).toBe(202);

    const created = await suite.prisma.task.findFirstOrThrow({
      where: { orgId: orgId(), idempotencyKey: `plan:${plan.id}:deploy` },
    });

    // The claim is recorded, the derived class is what gates: `deploy … production` is
    // CRITICAL by policy (D-006), not LOW because the planner said so.
    expect(created.riskSource).toBe('server');
    expect(created.derivedRiskClass).toBe('CRITICAL');
    expect(created.riskClass).toBe('CRITICAL');
    expect(created.riskClass).not.toBe('LOW');

    // Submission promotes to `ready`; it does not queue, run or dispatch.
    expect(created.status).toBe('ready');

    // No attempt, and no grant: only a PENDING request, which is the approval gate's
    // queue item. The planner has not spent anything, because it cannot.
    expect(
      await suite.prisma.executionAttempt.count({
        where: { orgId: orgId(), taskId: created.id },
      }),
    ).toBe(0);

    const approvals = await suite.prisma.approvalRequest.findMany({
      where: { orgId: orgId(), taskId: created.id },
      select: { status: true },
    });

    expect(approvals.length).toBeGreaterThan(0);
    expect(approvals.every((approval) => approval.status === 'PENDING')).toBe(true);

    const programme = await suite.prisma.plan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(programme.status).toBe('submitted');

    if (programme.programmeId !== null) startedWorkflowIds.push(`programme-${programme.programmeId}`);
  }, 60_000);
});

describe('authorisation and tenancy', () => {
  it('does not let a MEMBER approve or reject', async () => {
    const plan = await proposeValid(memberToken, 'VALID_PROBE');

    const approval = await approve(memberToken, plan.id);
    expect(approval.status).toBe(403);
    expect(errorOf(approval.body).code).toBe('FORBIDDEN');

    const rejection = await reject(memberToken, plan.id, { note: 'I would like to reject this.' });
    expect(rejection.status).toBe(403);
    expect(errorOf(rejection.body).code).toBe('FORBIDDEN');
  }, 30_000);

  it('answers 404 for a plan in another organisation, never 403', async () => {
    const foreign = await request(suite.app.getHttpServer())
      .post(`/v1/orgs/${suite.fixtures.orgB.id}/plans`)
      .set(authHeaders(ownerBToken, suite.fixtures.orgB.id))
      .send({
        projectId: suite.fixtures.projectB,
        objective: `VALID_PROBE: another tenant's proposal ${randomUUID()}`,
      });

    expect(foreign.status).toBe(201);

    const foreignPlan = (foreign.body as PlanBody).data;

    // ownerA is an admin in org A; the plan is org B's. The tenant conjunct makes it
    // invisible rather than forbidden.
    const response = await approve(ownerToken, foreignPlan.id);
    expect(response.status).toBe(404);
    expect(errorOf(response.body).code).toBe('NOT_FOUND');

    const detail = await request(suite.app.getHttpServer())
      .get(`${plansPath()}/${foreignPlan.id}`)
      .set(authHeaders(ownerToken, orgId()));

    expect(detail.status).toBe(404);

    // And a project from another organisation cannot be proposed against.
    const wrongProject = await propose(memberToken, {
      projectId: suite.fixtures.projectB,
      objective: `VALID_PROBE: wrong project ${randomUUID()}`,
    });

    expect(wrongProject.status).toBe(404);
  }, 30_000);

  it('returns the plan detail without the hash, the idempotency key or the raw response', async () => {
    const plan = await approvedPlan(memberToken, ownerToken);

    const response = await request(suite.app.getHttpServer())
      .get(`${plansPath()}/${plan.id}`)
      .set(authHeaders(memberToken, orgId()));

    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty('data.approvedContentHash');
    expect(response.body).not.toHaveProperty('data.idempotencyKey');
    expect(response.body).not.toHaveProperty('data.proposal');
    expect((response.body as PlanBody).data.tasks).toHaveLength(3);
  }, 30_000);
});

describe('planner availability', () => {
  it('answers 503 PLANNER_INVALID_RESPONSE when the endpoint fails, and writes no plan', async () => {
    const before = await counts();

    const response = await propose(memberToken, {
      projectId: projectId(),
      objective: `FAIL_PROBE: the endpoint is broken ${randomUUID()}`,
    });

    expect(response.status).toBe(503);
    expect(errorOf(response.body).code).toBe('PLANNER_INVALID_RESPONSE');
    expect(await counts()).toEqual(before);
  }, 30_000);

  it('answers 503 PLANNER_UNAVAILABLE when nothing is configured, and writes no plan', async () => {
    const before = await counts();
    const app = await createTestApp({
      planner: {
        baseUrl: null,
        apiKey: null,
        model: null,
        timeoutMs: 5_000,
        approvalTtlHours: 24,
      },
    });

    try {
      const response = await request(app.getHttpServer())
        .post(plansPath())
        .set(authHeaders(memberToken, orgId()))
        .send({
          projectId: projectId(),
          objective: `VALID_PROBE: unconfigured ${randomUUID()}`,
        });

      expect(response.status).toBe(503);
      expect(errorOf(response.body).code).toBe('PLANNER_UNAVAILABLE');
    } finally {
      await app.close();
    }

    expect(await counts()).toEqual(before);
  }, 60_000);

  it('answers 503 PLANNER_UNAVAILABLE when the endpoint is unreachable', async () => {
    const before = await counts();
    const app = await createTestApp({
      planner: {
        baseUrl: await closedPortUrl(),
        apiKey: 'stub-key-not-a-secret',
        model: 'stub-model',
        timeoutMs: 2_000,
        approvalTtlHours: 24,
      },
    });

    try {
      const response = await request(app.getHttpServer())
        .post(plansPath())
        .set(authHeaders(memberToken, orgId()))
        .send({
          projectId: projectId(),
          objective: `VALID_PROBE: unreachable ${randomUUID()}`,
        });

      expect(response.status).toBe(503);
      expect(errorOf(response.body).code).toBe('PLANNER_UNAVAILABLE');
    } finally {
      await app.close();
    }

    expect(await counts()).toEqual(before);
  }, 60_000);
});
