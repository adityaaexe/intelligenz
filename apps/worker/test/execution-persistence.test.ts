import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionResult } from '@intelligenz/agent-runtime';
import type { PrismaClient } from '@intelligenz/database';

import { executeAgentActivity } from '../src/activities/execute-agent';
import { persistResultActivity } from '../src/activities/persist-result';
import { resolveWorkflowRun, startAttempt } from '../src/activities/attempts';
import { executionWorkspaceIdFor } from '../src/activities/ids';
import { resetWorkerConfig } from '../src/config';
import { resetAgentRuntime } from '../src/runtime';
import {
  createTask,
  createTenant,
  dropTenant,
  reserveAndClaim,
  testDatabaseUrl,
  useTestDatabase,
  type TenantFixture,
} from './helpers/database';

/**
 * Attempt identity and durable persistence, against a real Postgres.
 *
 * These are the guarantees the Phase 3 schema exists for, and the ones a mocked
 * Prisma client cannot prove:
 *
 *   - a retry gets a new attempt number, and `(workflowRunId, attemptNumber)` stays
 *     unique;
 *   - `AgentRun.simulated` is the adapter's report, never a default;
 *   - a simulated adapter claiming to be real is refused before it reaches a row;
 *   - a tool trace is capped, and the cap is visible in `providerMeta`.
 *
 * The suite never truncates: it owns a randomly-suffixed tenant per test, because the
 * root test run executes other packages' integration files against the same database.
 */

const databaseUrl = testDatabaseUrl();
const enabled = databaseUrl !== undefined;

let client: PrismaClient;
const tenants: TenantFixture[] = [];
let artifactRoot: string;

async function tenant(label: string): Promise<TenantFixture> {
  const created = await createTenant(client, label);
  tenants.push(created);
  return created;
}

beforeAll(async () => {
  if (!enabled) return;

  const database = useTestDatabase();
  client = database.client;
  artifactRoot = await mkdtemp(join(tmpdir(), 'intelligenz-worker-test-'));

  process.env['DATABASE_URL'] = database.url;
  process.env['ARTIFACT_ROOT'] = artifactRoot;
  process.env['AGENT_RUNTIME'] = 'local-simulated';
  process.env['AGENT_STEP_DELAY_MS'] = '0';
  delete process.env['WORKER_FAULT_INJECT'];

  resetWorkerConfig();
  resetAgentRuntime();
});

afterAll(async () => {
  if (!enabled) return;

  for (const fixture of tenants) await dropTenant(client, fixture);
  await client.$disconnect();
});

describe.skipIf(!enabled)('execution attempts', () => {
  it('numbers attempts per workflow run and keeps the pair unique', async () => {
    const fixture = await tenant('attempts');
    const task = await createTask(client, fixture, {
      title: 'Attempt numbering',
      goal: 'Fix the failing test and prove it passes. [simulate:ok]',
    });

    // The reservation and the claim, then the activity — the order production forces.
    const claim = await reserveAndClaim(client, fixture, task);

    const first = await executeAgentActivity({
      taskId: task.taskId,
      orgId: fixture.orgId,
      correlationId: 'attempt-test-1',
      workflowRunId: task.workflowRunId,
      attemptId: claim.attemptId,
      executionRunId: claim.executionRunId,
    });

    expect(first.simulated).toBe(true);
    expect(first.runtimeId).toBe('local-simulated');

    const afterFirst = await client.executionAttempt.findMany({
      where: { orgId: fixture.orgId },
      orderBy: { attemptNumber: 'asc' },
    });

    expect(afterFirst.map((row) => row.attemptNumber)).toEqual([1]);
    expect(afterFirst[0]?.status).toBe('succeeded');
    expect(afterFirst[0]?.simulated).toBe(true);
    expect(afterFirst[0]?.startedAt).not.toBeNull();
    expect(afterFirst[0]?.finishedAt).not.toBeNull();

    // A Temporal retry re-runs the activity. That must be a second attempt, not a
    // second run hidden behind the first one.
    const second = await executeAgentActivity({
      taskId: task.taskId,
      orgId: fixture.orgId,
      correlationId: 'attempt-test-2',
      workflowRunId: task.workflowRunId,
      // The same execution: a Temporal retry keeps its run id, and the claim it holds.
      attemptId: claim.attemptId,
      executionRunId: claim.executionRunId,
    });

    expect(second.status).toBe('succeeded');

    const afterSecond = await client.executionAttempt.findMany({
      where: { orgId: fixture.orgId },
      orderBy: { attemptNumber: 'asc' },
    });

    expect(afterSecond.map((row) => row.attemptNumber)).toEqual([1, 2]);
    expect(afterSecond.every((row) => row.simulated)).toBe(true);
    // The retry's second attempt carries the same execution's claim: no attempt that ran
    // is left with a NULL holder.
    expect(afterSecond.map((row) => row.claimedByWorkflowRunId)).toEqual([
      claim.executionRunId,
      claim.executionRunId,
    ]);
  }, 30_000);

  it('never reuses an attempt number even when a caller asks twice', async () => {
    const fixture = await tenant('attempt-direct');
    const task = await createTask(client, fixture, { title: 'Direct attempt allocation' });
    const run = await resolveWorkflowRun({
      orgId: fixture.orgId,
      taskId: task.taskId,
      workflowRunId: task.workflowRunId,
    });

    const one = await startAttempt({
      orgId: fixture.orgId,
      taskId: task.taskId,
      workflowRunId: run.id,
      runtimeId: 'local-simulated',
      simulated: true,
      startedAt: new Date(),
      executionRunId: `execution-${randomUUID()}`,
    });
    const two = await startAttempt({
      orgId: fixture.orgId,
      taskId: task.taskId,
      workflowRunId: run.id,
      runtimeId: 'local-simulated',
      simulated: true,
      startedAt: new Date(),
      executionRunId: `execution-${randomUUID()}`,
    });

    expect([one.attemptNumber, two.attemptNumber]).toEqual([1, 2]);
    expect(one.id).not.toBe(two.id);
  });
});

describe.skipIf(!enabled)('result persistence', () => {
  it('persists simulated from the adapter report and links attempt, artifact and evidence', async () => {
    const fixture = await tenant('persist-simulated');
    const task = await createTask(client, fixture, {
      title: 'Persist a simulated run',
      goal: 'Write a report. [simulate:ok]',
    });

    const claim = await reserveAndClaim(client, fixture, task);

    const result = await executeAgentActivity({
      taskId: task.taskId,
      orgId: fixture.orgId,
      correlationId: 'persist-1',
      workflowRunId: task.workflowRunId,
      attemptId: claim.attemptId,
      executionRunId: claim.executionRunId,
    });

    expect(result.simulated).toBe(true);
    expect(result.artifacts.length).toBeGreaterThan(0);

    const persisted = await persistResultActivity({
      taskId: task.taskId,
      orgId: fixture.orgId,
      result,
    });

    const agentRun = await client.agentRun.findUniqueOrThrow({
      where: { id: persisted.agentRunId },
    });

    expect(agentRun.simulated).toBe(true);
    expect(agentRun.model).toBe('simulated');
    expect(agentRun.attemptNumber).toBe(1);
    expect(agentRun.status).toBe('succeeded');
    expect(agentRun.costUsd?.toString()).toBe('0');

    const attempt = await client.executionAttempt.findFirstOrThrow({
      where: { orgId: fixture.orgId },
    });

    expect(attempt.agentRunId).toBe(agentRun.id);

    const artifacts = await client.artifact.findMany({ where: { orgId: fixture.orgId } });
    expect(artifacts.length).toBe(result.artifacts.length);
    expect(artifacts[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(await client.evidence.count({ where: { orgId: fixture.orgId } })).toBe(
      result.artifacts.length,
    );
  }, 30_000);

  it('refuses a local-simulated result that claims to be real', async () => {
    const fixture = await tenant('persist-lie');
    const task = await createTask(client, fixture, { title: 'Refuse a simulated lie' });

    const claim = await reserveAndClaim(client, fixture, task);

    const result = await executeAgentActivity({
      taskId: task.taskId,
      orgId: fixture.orgId,
      correlationId: 'persist-lie',
      workflowRunId: task.workflowRunId,
      attemptId: claim.attemptId,
      executionRunId: claim.executionRunId,
    });

    await expect(
      persistResultActivity({
        taskId: task.taskId,
        orgId: fixture.orgId,
        result: { ...result, simulated: false },
      }),
    ).rejects.toThrow(/simulated=false/);

    expect(await client.agentRun.count({ where: { orgId: fixture.orgId } })).toBe(0);
  }, 30_000);

  it('persists a real adapter result with simulated=false, its version and its workspace', async () => {
    const fixture = await tenant('persist-real');
    const task = await createTask(client, fixture, { title: 'Persist a real run' });

    const run = await resolveWorkflowRun({
      orgId: fixture.orgId,
      taskId: task.taskId,
      workflowRunId: task.workflowRunId,
    });
    await startAttempt({
      orgId: fixture.orgId,
      taskId: task.taskId,
      workflowRunId: run.id,
      runtimeId: 'opencode-cli',
      simulated: false,
      startedAt: new Date(),
      executionRunId: `execution-${randomUUID()}`,
    });

    const workspaceId = executionWorkspaceIdFor(run.id, 1);
    await client.executionWorkspace.create({
      data: {
        id: workspaceId,
        orgId: fixture.orgId,
        taskId: task.taskId,
        state: 'preserving',
        rootPath: join(artifactRoot, 'workspace-lease', 'real'),
        sourceKind: 'clone',
      },
    });

    const result: ExecutionResult = {
      status: 'succeeded',
      summary: 'Fixed src/sum.js and proved the suite passes.',
      artifacts: [],
      events: [],
      usage: { tokensIn: 43_598, tokensOut: 120, usd: 0.000452 },
      runtimeId: 'opencode-cli',
      simulated: false,
      runtimeVersion: '2.2.7',
      providerMeta: { model: 'commandcode/deepseek/deepseek-v4-flash', workspaceId },
      toolInvocations: [
        {
          sequence: 1,
          tool: 'read',
          summary: 'read src/sum.js',
          occurredAt: new Date().toISOString(),
        },
        {
          sequence: 2,
          tool: 'edit',
          summary: 'edit src/sum.js',
          occurredAt: new Date().toISOString(),
        },
      ],
    };

    const persisted = await persistResultActivity({
      taskId: task.taskId,
      orgId: fixture.orgId,
      result,
    });

    const agentRun = await client.agentRun.findUniqueOrThrow({
      where: { id: persisted.agentRunId },
    });

    expect(agentRun.simulated).toBe(false);
    expect(agentRun.runtimeVersion).toBe('2.2.7');
    expect(agentRun.workspaceId).toBe(workspaceId);
    expect(agentRun.model).toBe('commandcode/deepseek/deepseek-v4-flash');
    expect(agentRun.costUsd?.toString()).toBe('0.0005');

    const workspace = await client.executionWorkspace.findUniqueOrThrow({
      where: { id: workspaceId },
    });
    expect(workspace.agentRunId).toBe(agentRun.id);

    const invocations = await client.toolInvocation.findMany({
      where: { agentRunId: agentRun.id },
      orderBy: { sequence: 'asc' },
    });
    expect(invocations.map((row) => row.tool)).toEqual(['read', 'edit']);
  });

  it('caps the tool trace at 200 rows and records the truncation', async () => {
    const fixture = await tenant('persist-cap');
    const task = await createTask(client, fixture, { title: 'Cap the tool trace' });

    const run = await resolveWorkflowRun({
      orgId: fixture.orgId,
      taskId: task.taskId,
      workflowRunId: task.workflowRunId,
    });
    await startAttempt({
      orgId: fixture.orgId,
      taskId: task.taskId,
      workflowRunId: run.id,
      runtimeId: 'opencode-cli',
      simulated: false,
      startedAt: new Date(),
      executionRunId: `execution-${randomUUID()}`,
    });

    const occurredAt = new Date().toISOString();
    const result: ExecutionResult = {
      status: 'succeeded',
      summary: 'Many tool calls.',
      artifacts: [],
      events: [],
      usage: {},
      runtimeId: 'opencode-cli',
      simulated: false,
      toolInvocations: Array.from({ length: 205 }, (_, index) => ({
        sequence: index + 1,
        tool: 'bash',
        summary: `command ${String(index + 1)}`,
        occurredAt,
      })),
    };

    const persisted = await persistResultActivity({
      taskId: task.taskId,
      orgId: fixture.orgId,
      result,
    });

    const rows = await client.toolInvocation.findMany({
      where: { agentRunId: persisted.agentRunId },
      orderBy: { sequence: 'asc' },
    });

    expect(rows).toHaveLength(200);
    expect(rows[0]?.sequence).toBe(1);
    expect(rows[199]?.sequence).toBe(200);

    const agentRun = await client.agentRun.findUniqueOrThrow({
      where: { id: persisted.agentRunId },
    });
    expect(agentRun.providerMeta).toMatchObject({
      toolInvocations: { total: 205, persisted: 200, truncated: true },
    });
  });
});
