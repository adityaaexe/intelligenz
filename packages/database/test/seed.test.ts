import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seed, type SeedSummary } from '../prisma/seed';
import type { PrismaClient } from '../src';

import { createTestClient } from './helpers';

/**
 * The seed is the fixture every demo and every screenshot depends on. If running it
 * twice duplicates rows, the third run duplicates them again and the Overview starts
 * counting phantoms. Idempotency is therefore a test, not a comment.
 *
 * The seed takes the client as an argument precisely so this test can point it at
 * `intelligenz_test` instead of whatever `DATABASE_URL` happens to hold.
 */

let client: PrismaClient;
let firstRun: SeedSummary;
let secondRun: SeedSummary;

beforeAll(async () => {
  client = createTestClient();
  firstRun = await seed(client);
  secondRun = await seed(client);
}, 60_000);

afterAll(async () => {
  await client.$disconnect();
});

describe('dev seed', () => {
  it('produces the same row counts when run twice', () => {
    expect(secondRun).toEqual(firstRun);
  });

  it('creates exactly one organisation, workspace and project', () => {
    expect(firstRun.organizations).toBe(1);
    expect(firstRun.workspaces).toBe(1);
    expect(firstRun.projects).toBe(1);
  });

  it('creates four users with one membership each', () => {
    expect(firstRun.users).toBe(4);
    expect(firstRun.memberships).toBe(4);
  });

  it('creates eight tasks, two workflow runs and two agent runs', () => {
    expect(firstRun.tasks).toBe(8);
    expect(firstRun.workflowRuns).toBe(2);
    expect(firstRun.agentRuns).toBe(2);
  });

  it('creates two pending approvals, one granted approval and seven audit events', () => {
    expect(firstRun.approvalRequests).toBe(3);
    expect(firstRun.pendingApprovals).toBe(2);
    expect(firstRun.auditEvents).toBe(7);
  });

  it('leaves exactly one organisation with the seeded slug', async () => {
    const count = await client.organization.count({ where: { slug: 'northwind-labs' } });
    expect(count).toBe(1);
  });

  it('gives every task a project-scoped idempotency key', async () => {
    const tasks = await client.task.findMany({
      where: { project: { key: 'CTRL', workspace: { slug: 'reveilchat' } } },
      select: { idempotencyKey: true },
    });

    expect(tasks).toHaveLength(8);
    expect(new Set(tasks.map((task) => task.idempotencyKey)).size).toBe(8);
  });
});
