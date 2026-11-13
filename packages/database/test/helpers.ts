import { randomUUID } from 'node:crypto';

import { createPrismaClient, type PrismaClient } from '../src';
import { loadNearestEnvFile, readDatabaseUrl } from '../src/env';

/**
 * Integration-test database access.
 *
 * Two guards, because a test suite that truncates the wrong database is worse than
 * a failing test:
 *   1. it reads `TEST_DATABASE_URL`, never `DATABASE_URL`;
 *   2. it refuses to run unless that database name ends in `_test`.
 */

loadNearestEnvFile();

function assertTestDatabase(url: string): string {
  const databaseName = new URL(url).pathname.replace(/^\//, '');

  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run integration tests against "${databaseName}": TEST_DATABASE_URL must name a *_test database.`,
    );
  }

  return url;
}

export function createTestClient(): PrismaClient {
  return createPrismaClient(assertTestDatabase(readDatabaseUrl('TEST_DATABASE_URL')));
}

export interface TenantFixture {
  orgId: string;
  workspaceId: string;
  projectId: string;
  userId: string;
}

/**
 * Creates a throwaway tenant with one workspace, one project and one user. Slugs and
 * emails carry a random suffix so parallel test files never collide.
 */
export async function createTenant(client: PrismaClient, label: string): Promise<TenantFixture> {
  const suffix = randomUUID().slice(0, 8);
  const slug = `${label}-${suffix}`;

  const organization = await client.organization.create({
    data: { name: `${label} ${suffix}`, slug },
  });

  const workspace = await client.workspace.create({
    data: { orgId: organization.id, name: `${label} workspace`, slug: 'main' },
  });

  const project = await client.project.create({
    data: {
      orgId: organization.id,
      workspaceId: workspace.id,
      key: 'TEST',
      name: `${label} project`,
      environment: 'dev',
    },
  });

  const user = await client.user.create({
    data: {
      email: `${slug}@example.test`,
      name: `${label} user`,
      passwordHash: 'not-a-real-hash-tests-only',
    },
  });

  return {
    orgId: organization.id,
    workspaceId: workspace.id,
    projectId: project.id,
    userId: user.id,
  };
}

export async function dropTenant(client: PrismaClient, fixture: TenantFixture): Promise<void> {
  // Cascades cover workspace, project and task. ApprovalRequest/AuditEvent use
  // Restrict, and these fixtures never create them.
  await client.organization.delete({ where: { id: fixture.orgId } });
  await client.user.delete({ where: { id: fixture.userId } });
}
