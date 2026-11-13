import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { PrismaClient } from '../src';

import { createTenant, createTestClient, dropTenant, type TenantFixture } from './helpers';

/**
 * Tenant isolation is the property the enterprise persona buys (ADR-005). The guard
 * is not enough on its own: the query layer must also carry `orgId`. These tests
 * assert the layer, not the guard, by querying with and without the predicate.
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

describe('tenant scoping', () => {
  it('returns no rows belonging to another organisation when filtered by orgId', async () => {
    const alpha = await tenant('alpha');
    const beta = await tenant('beta');

    const alphaTask = await client.task.create({
      data: {
        orgId: alpha.orgId,
        projectId: alpha.projectId,
        workspaceId: alpha.workspaceId,
        title: 'Alpha task',
        goal: 'Visible only inside alpha.',
        riskClass: 'LOW',
        acceptanceCriteria: [],
        createdById: alpha.userId,
        idempotencyKey: 'alpha-1',
      },
    });

    const betaTask = await client.task.create({
      data: {
        orgId: beta.orgId,
        projectId: beta.projectId,
        workspaceId: beta.workspaceId,
        title: 'Beta task',
        goal: 'Visible only inside beta.',
        riskClass: 'LOW',
        acceptanceCriteria: [],
        createdById: beta.userId,
        idempotencyKey: 'beta-1',
      },
    });

    const visibleToAlpha = await client.task.findMany({ where: { orgId: alpha.orgId } });
    const ids = visibleToAlpha.map((task) => task.id);

    expect(ids).toEqual([alphaTask.id]);
    expect(ids).not.toContain(betaTask.id);
  });

  it('returns null for another tenant’s row addressed by id plus the wrong orgId', async () => {
    const alpha = await tenant('cross-read-alpha');
    const beta = await tenant('cross-read-beta');

    const betaTask = await client.task.create({
      data: {
        orgId: beta.orgId,
        projectId: beta.projectId,
        workspaceId: beta.workspaceId,
        title: 'Beta-only task',
        goal: 'A caller who knows the id but not the tenant must not read it.',
        riskClass: 'HIGH',
        acceptanceCriteria: [],
        createdById: beta.userId,
        idempotencyKey: 'beta-secret',
      },
    });

    const leaked = await client.task.findFirst({
      where: { id: betaTask.id, orgId: alpha.orgId },
    });

    expect(leaked).toBeNull();

    const legitimate = await client.task.findFirst({
      where: { id: betaTask.id, orgId: beta.orgId },
    });

    expect(legitimate?.id).toBe(betaTask.id);
  });

  it('has no composite FK tying task.orgId to project.orgId — the service layer must', async () => {
    const alpha = await tenant('attach-alpha');
    const beta = await tenant('attach-beta');

    // The project belongs to beta; orgId says alpha. Plain single-column foreign
    // keys allow this shape, which is exactly why every write path must derive
    // orgId from the path project rather than trusting the body. This test records
    // the gap rather than pretending the constraint closes it; a composite
    // `(projectId, orgId)` foreign key is the follow-up that would.
    const mismatched = await client.task.create({
      data: {
        orgId: alpha.orgId,
        projectId: beta.projectId,
        workspaceId: beta.workspaceId,
        title: 'Cross-tenant attach',
        goal: 'Demonstrates the shape the service layer must reject.',
        riskClass: 'LOW',
        acceptanceCriteria: [],
        createdById: alpha.userId,
        idempotencyKey: 'cross-attach',
      },
    });

    const reachableThroughAlpha = await client.task.count({ where: { orgId: alpha.orgId } });
    const reachableThroughBetaProject = await client.task.count({
      where: { projectId: beta.projectId },
    });

    expect(reachableThroughAlpha).toBe(1);
    expect(reachableThroughBetaProject).toBe(1);
    expect(mismatched.orgId).toBe(alpha.orgId);
  });
});
