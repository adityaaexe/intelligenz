import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { PrismaClient } from '../src';

import { createTenant, createTestClient, dropTenant, type TenantFixture } from './helpers';

/**
 * Contract §6: `(projectId, idempotencyKey)` is unique, so a duplicate POST returns
 * the existing task instead of creating a second row. The database is the last line
 * of defence — the API's "find then create" is a race without this constraint.
 */

let client: PrismaClient;
const tenants: TenantFixture[] = [];

async function tenant(label: string): Promise<TenantFixture> {
  const fixture = await createTenant(client, label);
  tenants.push(fixture);
  return fixture;
}

beforeAll(() => {
  client = createTestClient();
});

afterEach(async () => {
  for (const fixture of tenants) await dropTenant(client, fixture);
  tenants.length = 0;
});

afterAll(async () => {
  await client.$disconnect();
});

describe('task idempotency', () => {
  it('rejects a second task with the same (projectId, idempotencyKey)', async () => {
    const fixture = await tenant('idempotency');

    const data = {
      orgId: fixture.orgId,
      projectId: fixture.projectId,
      workspaceId: fixture.workspaceId,
      title: 'Only one of me',
      goal: 'Prove the unique constraint exists.',
      riskClass: 'LOW' as const,
      acceptanceCriteria: ['One row'],
      createdById: fixture.userId,
      idempotencyKey: 'client-request-42',
    };

    const first = await client.task.create({ data });
    expect(first.idempotencyKey).toBe('client-request-42');

    let caught: unknown;
    try {
      await client.task.create({ data });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe('P2002');

    const count = await client.task.count({ where: { projectId: fixture.projectId } });
    expect(count).toBe(1);
  });

  it('allows the same idempotencyKey in a different project', async () => {
    const first = await tenant('idempotency-scope');
    const second = await tenant('idempotency-other');

    const base = {
      title: 'Scoped key',
      goal: 'The uniqueness is per project, not global.',
      riskClass: 'LOW' as const,
      acceptanceCriteria: [],
      idempotencyKey: 'shared-key',
    };

    await client.task.create({
      data: {
        ...base,
        orgId: first.orgId,
        workspaceId: first.workspaceId,
        projectId: first.projectId,
        createdById: first.userId,
      },
    });

    await client.task.create({
      data: {
        ...base,
        orgId: second.orgId,
        workspaceId: second.workspaceId,
        projectId: second.projectId,
        createdById: second.userId,
      },
    });

    expect(await client.task.count({ where: { idempotencyKey: 'shared-key' } })).toBe(2);
  });
});
