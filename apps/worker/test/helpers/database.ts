import { randomUUID } from 'node:crypto';

import { createPrismaClient, type PrismaClient } from '@intelligenz/database';

import { loadNearestEnvFile } from '../../src/config';
import { claimExecution } from '../../src/activities/claim';

/**
 * Worker-test database access.
 *
 * Same two guards as the other integration suites: the URL comes from
 * `TEST_DATABASE_URL`, and the database name must end in `_test` — a test that
 * truncates or writes into the wrong database is worse than a failing one.
 *
 * Unlike the API suites, these tests **never truncate**: the root `vitest run` executes
 * `packages/database`'s and this package's files concurrently against the same test
 * database, so each test owns a randomly-suffixed tenant and removes only that tenant.
 */

loadNearestEnvFile();

export interface TestDatabase {
  readonly client: PrismaClient;
  readonly url: string;
}

export function testDatabaseUrl(): string | undefined {
  const url = process.env['TEST_DATABASE_URL']?.trim();
  if (url === undefined || url.length === 0) return undefined;

  const databaseName = new URL(url).pathname.replace(/^\//, '');

  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run worker tests against "${databaseName}": TEST_DATABASE_URL must name a *_test database.`,
    );
  }

  return url;
}

/**
 * Points the activity code at the test database.
 *
 * `getPrismaClient()` and `getWorkerConfig()` are lazy singletons that read
 * `process.env` on first use, so this must run before the first activity call — not
 * before the imports.
 */
export function useTestDatabase(): TestDatabase {
  const url = testDatabaseUrl();

  if (url === undefined) {
    throw new Error('TEST_DATABASE_URL is not set; integration tests need a *_test database.');
  }

  process.env['DATABASE_URL'] = url;

  return { client: createPrismaClient(url), url };
}

export interface TenantFixture {
  readonly orgId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly userId: string;
}

export interface TaskFixture {
  readonly taskId: string;
  readonly workflowRunId: string;
}

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
    data: { email: `${slug}@example.test`, name: `${label} user`, passwordHash: 'not-a-hash' },
  });

  return {
    orgId: organization.id,
    workspaceId: workspace.id,
    projectId: project.id,
    userId: user.id,
  };
}

export async function createTask(
  client: PrismaClient,
  tenant: TenantFixture,
  input: {
    readonly title: string;
    readonly goal?: string;
    readonly status?: 'draft' | 'ready' | 'queued';
    readonly riskClass?: 'LOW' | 'HIGH';
  },
): Promise<TaskFixture> {
  const suffix = randomUUID().slice(0, 8);

  const task = await client.task.create({
    data: {
      orgId: tenant.orgId,
      projectId: tenant.projectId,
      workspaceId: tenant.workspaceId,
      title: input.title,
      goal: input.goal ?? 'Fix the failing test in src/sum.js and prove it passes.',
      status: input.status ?? 'ready',
      riskClass: input.riskClass ?? 'LOW',
      acceptanceCriteria: [],
      createdById: tenant.userId,
      idempotencyKey: `worker-${suffix}`,
    },
  });

  const run = await client.workflowRun.create({
    data: {
      orgId: tenant.orgId,
      taskId: task.id,
      workflowId: `task-${task.id}`,
      temporalRunId: `test-run-${suffix}`,
      status: 'running',
      startedAt: new Date(),
    },
  });

  return { taskId: task.id, workflowRunId: run.id };
}

/**
 * The row `POST /run` reserves and validation claims, written the way production writes
 * it: a `queued` attempt plus a conditional claim by one execution run id.
 *
 * Phase 6 made the claim an entry condition of `executeAgentActivity`, so a test that
 * calls the activity directly has to hold one — which is the point: there is no longer a
 * direct invocation path that skips the reservation. `claimExecution` is used rather than
 * a hand-written `updateMany` so the fixture cannot drift from the writer it stands in
 * for.
 */
export async function reserveAndClaim(
  client: PrismaClient,
  tenant: TenantFixture,
  task: TaskFixture,
  executionRunId: string = `execution-${randomUUID()}`,
): Promise<{ readonly attemptId: string; readonly executionRunId: string }> {
  const attempt = await client.executionAttempt.create({
    data: {
      orgId: tenant.orgId,
      taskId: task.taskId,
      workflowRunId: task.workflowRunId,
      attemptNumber: 1,
      runtimeId: 'unassigned',
      simulated: true,
      status: 'queued',
    },
    select: { id: true },
  });

  await claimExecution({
    orgId: tenant.orgId,
    taskId: task.taskId,
    projectId: tenant.projectId,
    attemptId: attempt.id,
    workflowRunId: executionRunId,
    correlationId: randomUUID(),
  });

  return { attemptId: attempt.id, executionRunId };
}

/**
 * Removes everything an organisation owns, in dependency order.
 *
 * `ExecutionAttempt.orgId` and `ExecutionWorkspace.orgId` are `Restrict`, so the
 * organization cannot be deleted until those rows are gone. `AgentRun.workspaceId`
 * is `SetNull`, so it must be nulled before the workspace rows are removed.
 * `ApprovalRequest.task` and `AuditEvent.organization` are `Restrict` too: the history
 * must outlive the aggregate, so it has to be removed explicitly before the org.
 */
async function deleteOrganizationRows(client: PrismaClient, orgId: string): Promise<void> {
  await client.toolInvocation.deleteMany({ where: { orgId } });
  await client.executionAttempt.deleteMany({ where: { orgId } });
  // Phase 8.6: both reference `Task` with ON DELETE RESTRICT, so they must be removed
  // before the organisation cascade reaches the tasks. Checkpoints first, then nodes, then
  // the programme itself.
  await client.programmeCheckpoint.deleteMany({ where: { orgId } });
  await client.programmeTask.deleteMany({ where: { orgId } });
  await client.programme.deleteMany({ where: { orgId } });
  await client.agentRun.updateMany({ where: { orgId }, data: { workspaceId: null } });
  await client.executionWorkspace.deleteMany({ where: { orgId } });
  await client.approvalRequest.deleteMany({ where: { orgId } });
  await client.auditEvent.deleteMany({ where: { orgId } });
  await client.organization.delete({ where: { id: orgId } });
}

/**
 * Removes one tenant and everything it owns.
 *
 * A failure here propagates: the caller decides whether one tenant's failure should end
 * the rest of the teardown (`dropAllTenants` does not).
 */
export async function dropTenant(client: PrismaClient, fixture: TenantFixture): Promise<void> {
  await deleteOrganizationRows(client, fixture.orgId);

  // `User` is not owned by an organisation — deleting the organisation removes the
  // membership, not the account. Leaving the row behind is what made the seed test's
  // `User` count depend on which suites ran first.
  try {
    await client.user.delete({ where: { id: fixture.userId } });
  } catch (error) {
    // Named, not swallowed. The organisation is already gone, so nothing in this run can
    // observe the account; `dropResidualTenants()` reclaims it on the next run by the
    // `<label>-<suffix>@example.test` shape `createTenant()` mints.
    console.error(
      `[tenant-cleanup] residual user ${fixture.userId} (${fixture.orgId}) could not be deleted: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Drops every tenant in `fixtures`, independently.
 *
 * A bare `for` over `dropTenant()` ends at the first throw, so one foreign-key surprise,
 * lock wait or serialization error abandons every tenant after it. Each attempt is
 * isolated here, every failure is named, and the aggregate is thrown at the end so a
 * residual tenant cannot be reported as a clean teardown.
 */
export async function dropAllTenants(
  client: PrismaClient,
  fixtures: readonly TenantFixture[],
): Promise<void> {
  const failures: { readonly orgId: string; readonly error: unknown }[] = [];

  for (const fixture of fixtures) {
    try {
      await dropTenant(client, fixture);
    } catch (error) {
      failures.push({ orgId: fixture.orgId, error });
      console.error(
        `[tenant-cleanup] residual tenant ${fixture.orgId} could not be deleted: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `[tenant-cleanup] ${failures.length} tenant(s) survived teardown: ${failures
        .map((failure) => failure.orgId)
        .join(', ')}`,
    );
  }
}

/**
 * Reclaims tenants a previous run could not delete.
 *
 * This is the only cleanup that survives SIGKILL, an OOM kill and a hook timeout — an
 * `afterAll` cannot run when the process is gone. It runs *before* a suite creates its
 * own fixtures, so an aborted run heals on the next run of the same file instead of
 * poisoning an unrelated suite.
 *
 * **Age-guarded on purpose.** A concurrent run of the same file leaves exactly the same
 * rows as an abandoned one; the only discriminator is age. A live run's fixtures are
 * seconds old, an abandoned run's are at least one hook timeout old, so rows younger
 * than `minimumAgeMs` are left alone. Without the guard this sweep would be a new
 * cross-run hazard of the kind it exists to fix.
 */
export async function dropResidualTenants(
  client: PrismaClient,
  prefix: string,
  options: { readonly minimumAgeMs?: number } = {},
): Promise<{ readonly organizations: number; readonly users: number }> {
  const minimumAgeMs = options.minimumAgeMs ?? 5 * 60_000;
  const cutoff = new Date(Date.now() - minimumAgeMs);

  const organizations = await client.organization.findMany({
    where: { slug: { startsWith: prefix }, createdAt: { lt: cutoff } },
    select: { id: true, slug: true },
    orderBy: { createdAt: 'asc' },
  });

  let dropped = 0;

  for (const organization of organizations) {
    try {
      await deleteOrganizationRows(client, organization.id);
      dropped += 1;
    } catch (error) {
      console.error(
        `[tenant-cleanup] residual tenant ${organization.slug} (${organization.id}) could not be reclaimed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // Accounts are not owned by the organisation, so an aborted run can leave one behind
  // after its organisation is already gone.
  const users = await client.user.deleteMany({
    where: {
      email: { startsWith: prefix, endsWith: '@example.test' },
      createdAt: { lt: cutoff },
    },
  });

  return { organizations: dropped, users: users.count };
}
