import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PrismaClient } from '@intelligenz/database';

import { evaluateApprovalGrant, type ApprovalCandidate } from '../src/approvals/authorisation';
import { validateTaskActivity } from '../src/activities/validate-task';
import { computeTaskContentHash } from '../src/approvals/task-binding';
import { resetWorkerConfig } from '../src/config';
import { resetAgentRuntime } from '../src/runtime';
import {
  createTenant,
  dropTenant,
  testDatabaseUrl,
  useTestDatabase,
  type TenantFixture,
} from './helpers/database';

/**
 * **Audit F2** — the worker's approval gate must enforce what the API enforces.
 *
 * Until this was fixed the activity asked one question (`status = 'APPROVED'`) while the
 * API asked five. The worker is the last line of defence and its caller is *not* the
 * API — `runTaskWorkflow` is a Temporal workflow that anything holding the frontend
 * address can start — so a weaker copy is worse than no copy: it looks like a gate.
 *
 * Each test below isolates one condition by making every other condition true, so a
 * refusal can only be attributed to the predicate under test. The happy path at the end
 * is the control: without it, "refuses everything" would pass every assertion here.
 *
 * The database is real (`TEST_DATABASE_URL`, `*_test` only). These tests never truncate:
 * each suite owns a randomly-suffixed tenant and removes only that tenant.
 */

const databaseUrl = testDatabaseUrl();
const enabled = databaseUrl !== undefined;

let tenant: TenantFixture | undefined;
let client: PrismaClient | undefined;

const GOAL = 'Fix the failing test in src/sum.js and prove it passes.';

beforeAll(async () => {
  if (!enabled) return;

  const database = useTestDatabase();
  client = database.client;

  process.env['AGENT_RUNTIME'] = process.env['AGENT_RUNTIME'] ?? 'local-simulated';

  resetWorkerConfig();
  resetAgentRuntime();

  tenant = await createTenant(client, 'approval-grant');
});

afterAll(async () => {
  if (client !== undefined && tenant !== undefined) {
    await dropTenant(client, tenant);
    await client.$disconnect();
  }
});

if (!enabled) {
  console.warn('[approval-grant] suite skipped — TEST_DATABASE_URL is not set');
}

/** A HIGH task, ready to run, with the binding the hash covers and its reserved attempt. */
async function createHighTask(
  label: string,
): Promise<{ taskId: string; hash: string; attemptId: string; workflowRunId: string }> {
  if (client === undefined || tenant === undefined) throw new Error('suite not initialised');

  const task = await client.task.create({
    data: {
      orgId: tenant.orgId,
      projectId: tenant.projectId,
      workspaceId: tenant.workspaceId,
      title: `${label} ${randomUUID().slice(0, 8)}`,
      goal: GOAL,
      status: 'ready',
      riskClass: 'HIGH',
      acceptanceCriteria: [],
      createdById: tenant.userId,
      idempotencyKey: `gate-${randomUUID().slice(0, 8)}`,
    },
  });

  // Phase 5: the attempt the API would have reserved in the transaction that spent the
  // grant. `validateTaskActivity` now refuses a grant that does not name a queued attempt,
  // so every fixture needs one.
  const run = await client.workflowRun.create({
    data: {
      orgId: tenant.orgId,
      taskId: task.id,
      workflowId: `task-${task.id}`,
      temporalRunId: `gate-run-${randomUUID()}`,
      status: 'queued',
    },
  });

  const attempt = await client.executionAttempt.create({
    data: {
      orgId: tenant.orgId,
      taskId: task.id,
      workflowRunId: run.id,
      attemptNumber: 1,
      runtimeId: 'unassigned',
      simulated: true,
      status: 'queued',
    },
  });

  // The same preimage the API hashes — imported, not re-derived.
  const hash = computeTaskContentHash({
    title: task.title,
    goal: task.goal,
    acceptanceCriteria: task.acceptanceCriteria,
    riskClass: task.derivedRiskClass ?? task.riskClass,
    executionProfile: 'standard',
    sourceRef: null,
    baseCommit: null,
  });

  return { taskId: task.id, hash, attemptId: attempt.id, workflowRunId: run.id };
}

async function createApproval(input: {
  taskId: string;
  hash: string | null;
  status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'REVOKED';
  consumedAt?: Date | null;
  /** Which attempt spent the grant. Omitted means "the API did not record one". */
  consumedByAttemptId?: string | null;
  revokedAt?: Date | null;
  expiresAt?: Date | null;
}): Promise<void> {
  if (client === undefined || tenant === undefined) throw new Error('suite not initialised');

  await client.approvalRequest.create({
    data: {
      orgId: tenant.orgId,
      taskId: input.taskId,
      riskClass: 'HIGH',
      status: input.status ?? 'APPROVED',
      requestedById: tenant.userId,
      taskContentHash: input.hash,
      riskClassAtApproval: 'HIGH',
      policyVersion: '2026-11-14.1',
      executionProfile: 'standard',
      consumedAt: input.consumedAt === undefined ? new Date() : input.consumedAt,
      consumedByAttemptId: input.consumedByAttemptId ?? null,
      revokedAt: input.revokedAt ?? null,
      expiresAt: input.expiresAt === undefined ? new Date(Date.now() + 3_600_000) : input.expiresAt,
    },
  });
}

function validate(taskId: string, attemptId?: string): Promise<unknown> {
  if (tenant === undefined) throw new Error('suite not initialised');

  return validateTaskActivity({
    taskId,
    orgId: tenant.orgId,
    ...(attemptId === undefined ? {} : { attemptId }),
    // Phase 6: a direct activity call has no Temporal execution context, so the claim
    // needs an explicit identity. Derived from the attempt so both calls in a test are
    // the same execution — which is what the idempotency test depends on.
    ...(attemptId === undefined ? {} : { workflowRunId: `test-execution-${attemptId}` }),
  });
}

describe.skipIf(!enabled)('validateTaskActivity approval gate', () => {
  it('refuses when no approval exists at all', async () => {
    const { taskId } = await createHighTask('no approval');

    await expect(validate(taskId)).rejects.toMatchObject({ type: 'APPROVAL_REQUIRED' });
  });

  it('refuses an APPROVED grant the API never reserved (consumedAt is null)', async () => {
    const { taskId, hash } = await createHighTask('unreserved');
    await createApproval({ taskId, hash, consumedAt: null });

    // This is the direct-Temporal-start case: a perfect-looking grant, never spent by
    // `POST /run`, therefore not this caller's to spend.
    await expect(validate(taskId)).rejects.toMatchObject({ type: 'APPROVAL_NOT_RESERVED' });
  });

  it('refuses a consumed grant that was revoked afterwards', async () => {
    const { taskId, hash } = await createHighTask('revoked');
    await createApproval({ taskId, hash, revokedAt: new Date() });

    await expect(validate(taskId)).rejects.toMatchObject({ type: 'APPROVAL_REVOKED' });
  });

  it('refuses a consumed grant whose expiresAt has passed', async () => {
    const { taskId, hash } = await createHighTask('expired');
    await createApproval({ taskId, hash, expiresAt: new Date(Date.now() - 1_000) });

    await expect(validate(taskId)).rejects.toMatchObject({ type: 'APPROVAL_EXPIRED' });
  });

  it('refuses a pre-Phase-4 grant with no content hash', async () => {
    const { taskId } = await createHighTask('unbound');
    await createApproval({ taskId, hash: null });

    await expect(validate(taskId)).rejects.toMatchObject({ type: 'APPROVAL_UNBOUND' });
  });

  it('refuses a grant issued for different content', async () => {
    const { taskId, hash } = await createHighTask('stale');
    await createApproval({ taskId, hash: `${hash.slice(0, 63)}${hash.endsWith('0') ? '1' : '0'}` });

    await expect(validate(taskId)).rejects.toMatchObject({ type: 'APPROVAL_STALE' });
  });

  it('refuses a grant for a task whose content changed after approval', async () => {
    if (client === undefined) throw new Error('suite not initialised');

    const { taskId, hash } = await createHighTask('edited after approval');
    await createApproval({ taskId, hash });

    // The same approval, the same row: only the task moved. That is precisely what the
    // hash exists to detect, and what a status-only check would wave through.
    await client.task.update({
      where: { id: taskId },
      data: { goal: `${GOAL} Also update the docs.` },
    });

    await expect(validate(taskId)).rejects.toMatchObject({ type: 'APPROVAL_STALE' });
  });

  it('accepts a consumed, unrevoked, unexpired grant bound to the current content', async () => {
    const { taskId, hash, attemptId } = await createHighTask('live grant');
    await createApproval({ taskId, hash, consumedByAttemptId: attemptId });

    const result = await validate(taskId, attemptId);

    expect(result).toMatchObject({ runnable: true });
  });

  it('does not consume the approval: the worker must not be a second writer', async () => {
    if (client === undefined || tenant === undefined) throw new Error('suite not initialised');

    const { taskId, hash, attemptId } = await createHighTask('no double spend');
    const consumedAt = new Date(Date.now() - 5_000);

    await createApproval({ taskId, hash, consumedAt, consumedByAttemptId: attemptId });

    await expect(validate(taskId, attemptId)).resolves.toMatchObject({ runnable: true });

    const row = await client.approvalRequest.findFirstOrThrow({
      where: { orgId: tenant.orgId, taskId },
    });

    // Still the API's timestamp, not a new one: `validateTaskActivity` checked the
    // reservation, it did not take one.
    expect(row.consumedAt?.getTime()).toBe(consumedAt.getTime());
  });
});

/**
 * Ordering, without a database.
 *
 * The loop is newest-first and a live grant wins. These pin the two cases that are hard
 * to set up through rows: a newer dead grant beside an older live one, and the reported
 * code when every row is dead.
 */
describe('evaluateApprovalGrant', () => {
  const live: ApprovalCandidate = {
    id: 'live',
    status: 'APPROVED',
    taskContentHash: 'a'.repeat(64),
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: new Date(),
    revokedAt: null,
    createdAt: new Date(Date.now() - 60_000),
  };

  it('vetoes on a revocation newer than the grant, instead of falling back to it', () => {
    const revoked: ApprovalCandidate = {
      ...live,
      id: 'revoked',
      revokedAt: new Date(),
      createdAt: new Date(),
    };

    // The newest word on this task's approval history is "revoked". An older grant is
    // spent by construction (it is `consumedAt` non-null), so falling through to it would
    // authorise a second execution from a single-use grant.
    const refusal = evaluateApprovalGrant({
      approvals: [revoked, live],
      expectedTaskContentHash: live.taskContentHash ?? '',
      now: Date.now(),
    });

    expect(refusal?.code).toBe('APPROVAL_REVOKED');
  });

  it('skips a PENDING re-approval request and evaluates the approved grant behind it', () => {
    const pending: ApprovalCandidate = { ...live, id: 'pending', status: 'PENDING' };

    expect(
      evaluateApprovalGrant({
        approvals: [pending, live],
        expectedTaskContentHash: live.taskContentHash ?? '',
        now: Date.now(),
      }),
    ).toBeNull();
  });

  it('does not fall through from a stale grant to an older, spent one', () => {
    const stale: ApprovalCandidate = { ...live, id: 'stale', taskContentHash: 'b'.repeat(64) };
    const older: ApprovalCandidate = { ...live, id: 'older' };

    const refusal = evaluateApprovalGrant({
      approvals: [stale, older],
      expectedTaskContentHash: live.taskContentHash ?? '',
      now: Date.now(),
    });

    expect(refusal?.code).toBe('APPROVAL_STALE');
  });
});
