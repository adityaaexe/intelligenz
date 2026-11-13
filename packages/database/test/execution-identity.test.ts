import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { PrismaClient } from '../src';

import { createTenant, createTestClient, dropTenant, type TenantFixture } from './helpers';

/**
 * Phase 3 execution identity: the guarantees that make "which attempt was this?"
 * answerable, and that keep a tool trace from becoming a transcript dump.
 *
 * These are database-level assertions. A retried Temporal activity bypasses the
 * application's own retry bookkeeping, so the constraint has to be the authority.
 */

let client: PrismaClient;
const tenants: TenantFixture[] = [];

async function tenant(label: string): Promise<TenantFixture> {
  const fixture = await createTenant(client, label);
  tenants.push(fixture);
  return fixture;
}

/**
 * `ExecutionAttempt.orgId` and `ExecutionWorkspace.orgId` are `Restrict`, so the
 * plain `dropTenant` would fail with P2003 on any tenant that reached this file.
 * Execution rows are removed first, newest concept outwards. This ordering is the
 * cost of keeping attempt history non-cascading, and it is deliberate.
 */
async function dropExecutionTenant(fixture: TenantFixture): Promise<void> {
  await client.toolInvocation.deleteMany({ where: { orgId: fixture.orgId } });
  await client.executionAttempt.deleteMany({ where: { orgId: fixture.orgId } });
  await client.agentRun.updateMany({
    where: { orgId: fixture.orgId },
    data: { workspaceId: null },
  });
  await client.executionWorkspace.deleteMany({ where: { orgId: fixture.orgId } });
  await dropTenant(client, fixture);
}

beforeAll(() => {
  client = createTestClient();
});

afterEach(async () => {
  for (const fixture of tenants) await dropExecutionTenant(fixture);
  tenants.length = 0;
});

afterAll(async () => {
  await client.$disconnect();
});

interface RunFixture {
  taskId: string;
  workflowRunId: string;
}

async function createRun(fixture: TenantFixture, key: string): Promise<RunFixture> {
  const task = await client.task.create({
    data: {
      orgId: fixture.orgId,
      projectId: fixture.projectId,
      workspaceId: fixture.workspaceId,
      title: `execution ${key}`,
      goal: 'Provide a parent for a workflow run.',
      riskClass: 'LOW',
      acceptanceCriteria: [],
      createdById: fixture.userId,
      idempotencyKey: `execution-${key}`,
    },
  });

  const workflowRun = await client.workflowRun.create({
    data: {
      orgId: fixture.orgId,
      taskId: task.id,
      workflowId: `run-task-${task.id}`,
      status: 'running',
    },
  });

  return { taskId: task.id, workflowRunId: workflowRun.id };
}

describe('execution attempt identity', () => {
  it('rejects a second attempt with the same (workflowRunId, attemptNumber)', async () => {
    const fixture = await tenant('attempt-unique');
    const run = await createRun(fixture, 'unique');

    const data = {
      orgId: fixture.orgId,
      taskId: run.taskId,
      workflowRunId: run.workflowRunId,
      attemptNumber: 1,
      runtimeId: 'opencode-cli',
      status: 'running' as const,
    };

    await client.executionAttempt.create({ data });

    let caught: unknown;
    try {
      await client.executionAttempt.create({ data });
    } catch (error) {
      caught = error;
    }

    expect((caught as { code?: string }).code).toBe('P2002');
    expect(
      await client.executionAttempt.count({ where: { workflowRunId: run.workflowRunId } }),
    ).toBe(1);
  });

  it('allows attempt 2 on the same workflow run', async () => {
    const fixture = await tenant('attempt-two');
    const run = await createRun(fixture, 'two');

    const base = {
      orgId: fixture.orgId,
      taskId: run.taskId,
      workflowRunId: run.workflowRunId,
      runtimeId: 'opencode-cli',
      status: 'running' as const,
    };

    await client.executionAttempt.create({ data: { ...base, attemptNumber: 1 } });
    await client.executionAttempt.create({ data: { ...base, attemptNumber: 2 } });

    expect(
      await client.executionAttempt.count({ where: { workflowRunId: run.workflowRunId } }),
    ).toBe(2);
  });

  it('defaults simulated to false so a real run is never mislabelled as fake', async () => {
    const fixture = await tenant('attempt-simulated');
    const run = await createRun(fixture, 'simulated');

    const attempt = await client.executionAttempt.create({
      data: {
        orgId: fixture.orgId,
        taskId: run.taskId,
        workflowRunId: run.workflowRunId,
        attemptNumber: 1,
        runtimeId: 'opencode-cli',
      },
    });

    expect(attempt.simulated).toBe(false);
    expect(attempt.status).toBe('queued');
  });
});

describe('execution workspace identity', () => {
  it('rejects two workspaces claiming the same rootPath', async () => {
    const fixture = await tenant('workspace-path');
    const run = await createRun(fixture, 'path');
    const rootPath = `/tmp/intelligenz-test-${fixture.orgId}`;

    const data = {
      orgId: fixture.orgId,
      taskId: run.taskId,
      rootPath,
      sourceKind: 'empty',
    };

    const first = await client.executionWorkspace.create({ data });
    expect(first.state).toBe('requested');

    let caught: unknown;
    try {
      await client.executionWorkspace.create({ data });
    } catch (error) {
      caught = error;
    }

    expect((caught as { code?: string }).code).toBe('P2002');
  });

  it('nulls AgentRun.workspaceId instead of deleting the run when a workspace goes away', async () => {
    const fixture = await tenant('workspace-setnull');
    const run = await createRun(fixture, 'setnull');

    const agentRun = await client.agentRun.create({
      data: {
        orgId: fixture.orgId,
        workflowRunId: run.workflowRunId,
        runtimeId: 'opencode-cli',
        model: 'test',
        status: 'running',
      },
    });

    const workspace = await client.executionWorkspace.create({
      data: {
        orgId: fixture.orgId,
        taskId: run.taskId,
        agentRunId: agentRun.id,
        rootPath: `/tmp/intelligenz-test-setnull-${fixture.orgId}`,
        sourceKind: 'worktree',
      },
    });

    await client.agentRun.update({
      where: { id: agentRun.id },
      data: { workspaceId: workspace.id },
    });

    await client.executionWorkspace.delete({ where: { id: workspace.id } });

    const after = await client.agentRun.findUniqueOrThrow({ where: { id: agentRun.id } });
    expect(after.workspaceId).toBeNull();
  });
});

describe('tool invocation trace', () => {
  it('keeps sequence unique per run and cascades with it', async () => {
    const fixture = await tenant('tool-trace');
    const run = await createRun(fixture, 'trace');

    const agentRun = await client.agentRun.create({
      data: {
        orgId: fixture.orgId,
        workflowRunId: run.workflowRunId,
        runtimeId: 'opencode-cli',
        model: 'test',
        status: 'running',
      },
    });

    const data = {
      orgId: fixture.orgId,
      agentRunId: agentRun.id,
      sequence: 1,
      tool: 'read',
      summary: 'read packages/database/prisma/schema.prisma (412 lines)',
      occurredAt: new Date(),
    };

    await client.toolInvocation.create({ data });

    let caught: unknown;
    try {
      await client.toolInvocation.create({ data });
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe('P2002');

    await client.agentRun.delete({ where: { id: agentRun.id } });
    expect(await client.toolInvocation.count({ where: { agentRunId: agentRun.id } })).toBe(0);
  });

  it('refuses a summary longer than the 500-character redaction budget', async () => {
    const fixture = await tenant('tool-summary');
    const run = await createRun(fixture, 'summary');

    const agentRun = await client.agentRun.create({
      data: {
        orgId: fixture.orgId,
        workflowRunId: run.workflowRunId,
        runtimeId: 'opencode-cli',
        model: 'test',
        status: 'running',
      },
    });

    let caught: unknown;
    try {
      await client.toolInvocation.create({
        data: {
          orgId: fixture.orgId,
          agentRunId: agentRun.id,
          sequence: 1,
          tool: 'bash',
          summary: 'x'.repeat(501),
          occurredAt: new Date(),
        },
      });
    } catch (error) {
      caught = error;
    }

    // Postgres raises 22001 (`value too long for type character varying(500)`);
    // Prisma surfaces it as P2000. Asserted by code, not by absence of a throw:
    // a silent auto-truncation would be worse than a rejection.
    expect((caught as { code?: string }).code).toBe('P2000');
    expect(await client.toolInvocation.count({ where: { agentRunId: agentRun.id } })).toBe(0);
  });
});
