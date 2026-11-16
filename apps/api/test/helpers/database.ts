import { createPrismaClient, type PrismaClient } from '@intelligenz/database';
import argon2 from 'argon2';

import { computeTaskContentHash } from '../../src/approvals/approval-binding';
import { DEFAULT_EXECUTION_PROFILE, RISK_POLICY_VERSION } from '../../src/risk/risk-policy';
import { testDatabaseUrl } from './env';

/**
 * Test database control.
 *
 * ## Truncate, then seed, per suite
 *
 * The contract asks for a truncating suite, and it is the right call: a test that
 * depends on rows another test left behind passes in one order and fails in another.
 * Every suite starts from the same known fixture set.
 *
 * ## The advisory lock
 *
 * Two suites truncating the same database concurrently would produce nonsense. Vitest
 * runs test *files* in parallel by default (and the workspace root config does, even
 * when this package's config says otherwise). A session-level Postgres advisory lock
 * held for the whole suite serialises them regardless of which config launched the
 * run — no sleeps, no retries, no ordering assumption.
 */

export interface Fixtures {
  readonly orgA: { readonly id: string; readonly slug: string };
  readonly orgB: { readonly id: string; readonly slug: string };
  readonly workspaceA: string;
  readonly workspaceB: string;
  readonly projectA: string;
  readonly projectB: string;
  readonly users: {
    readonly ownerA: FixtureUser;
    readonly memberA: FixtureUser;
    readonly viewerA: FixtureUser;
    readonly ownerB: FixtureUser;
  };
  readonly tasks: {
    readonly draftA: string;
    readonly queuedA: string;
    /** HIGH risk, `ready`, with a PENDING approval request. */
    readonly highReadyA: string;
    readonly draftB: string;
  };
  readonly pendingApprovalId: string;
}

export interface FixtureUser {
  readonly id: string;
  readonly email: string;
  readonly role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
}

export const TEST_PASSWORD = 'Passw0rd!demo';

/**
 * Cheaper argon2 parameters than production.
 *
 * `verify` reads its cost from the stored hash, so a cheap hash still exercises the
 * real verification path — it just does not spend 50 ms per login across a dozen
 * logins per suite. The production parameters live in `AuthService` and the seed, and
 * are not what these tests are measuring.
 */
const TEST_HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 4_096,
  timeCost: 1,
  parallelism: 1,
} as const;

const TRUNCATE_TABLES = [
  'AuditEvent',
  'ApprovalRequest',
  'ToolInvocation',
  'ExecutionAttempt',
  'ExecutionWorkspace',
  'Evidence',
  'Artifact',
  'AgentRun',
  'WorkflowRun',
  // Phase 8.6. Before `Task`: `ProgrammeTask` and `ProgrammeCheckpoint` reference it with
  // ON DELETE RESTRICT. `CASCADE` would cover the FK, but the list is the record of what a
  // suite expects to empty, and a programme row left behind is state a later test reads.
  'ProgrammeCheckpoint',
  'ProgrammeTask',
  'Programme',
  // Phase 8.7. Before `Programme` in a *delete* order (it points at one), but `TRUNCATE`
  // needs only the table named: the list is the record of what a suite expects to empty,
  // and a plan row left behind is state a later test would read.
  'Plan',
  'Task',
  'Project',
  'Workspace',
  'Membership',
  'User',
  'Organization',
] as const;

const SUITE_LOCK_KEY = 728_410_001;

export function createTestClient(): PrismaClient {
  return createPrismaClient(testDatabaseUrl());
}

/**
 * Blocks until this suite is the only one touching the database. Returns the release
 * function; call it in `afterAll` so the next suite can start.
 */
export async function acquireSuiteLock(): Promise<() => Promise<void>> {
  const client = createPrismaClient(testDatabaseUrl());

  let release: () => void = () => undefined;
  let signalAcquired: () => void = () => undefined;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acquired = new Promise<void>((resolve) => {
    signalAcquired = resolve;
  });

  const holding = client.$transaction(
    async (transaction) => {
      // Constant defined above; not user input, so `Unsafe` is about the API shape,
      // not an injection risk.
      await transaction.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${SUITE_LOCK_KEY})`);
      signalAcquired();
      await gate;
    },
    // The default interactive-transaction timeout is 5 s, which would silently drop
    // the lock mid-suite. A suite is seconds; two minutes is a failsafe, not a wait.
    { maxWait: 60_000, timeout: 120_000 },
  );

  await acquired;

  return async () => {
    release();
    await holding;
    await client.$disconnect();
  };
}

export async function truncateAll(prisma: PrismaClient): Promise<void> {
  const tables = TRUNCATE_TABLES.map((table) => `"${table}"`).join(', ');

  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}

/**
 * The fixture set every suite starts from: two organisations, four users with one
 * role each, one workspace and project per organisation, and the three task shapes
 * the state machine tests need.
 */
export async function seedFixtures(prisma: PrismaClient): Promise<Fixtures> {
  const passwordHash = await argon2.hash(TEST_PASSWORD, TEST_HASH_OPTIONS);

  const orgA = await prisma.organization.create({
    data: { name: 'Alpha Corp', slug: 'alpha-test' },
  });
  const orgB = await prisma.organization.create({
    data: { name: 'Beta Ltd', slug: 'beta-test' },
  });

  const workspaceA = await prisma.workspace.create({
    data: { orgId: orgA.id, name: 'Alpha workspace', slug: 'main' },
  });
  const workspaceB = await prisma.workspace.create({
    data: { orgId: orgB.id, name: 'Beta workspace', slug: 'main' },
  });

  const projectA = await prisma.project.create({
    data: {
      orgId: orgA.id,
      workspaceId: workspaceA.id,
      key: 'ALPHA',
      name: 'Alpha project',
      environment: 'dev',
    },
  });
  const projectB = await prisma.project.create({
    data: {
      orgId: orgB.id,
      workspaceId: workspaceB.id,
      key: 'BETA',
      name: 'Beta project',
      environment: 'dev',
    },
  });

  async function userFixture(
    email: string,
    role: FixtureUser['role'],
    orgId: string,
    name: string,
  ): Promise<FixtureUser> {
    const user = await prisma.user.create({ data: { email, name, passwordHash } });

    if (orgId.length > 0) {
      await prisma.membership.create({ data: { orgId, userId: user.id, role } });
    }

    return { id: user.id, email, role };
  }

  const ownerA = await userFixture('owner-a@example.test', 'OWNER', orgA.id, 'Owner A');
  const memberA = await userFixture('member-a@example.test', 'MEMBER', orgA.id, 'Member A');
  const viewerA = await userFixture('viewer-a@example.test', 'VIEWER', orgA.id, 'Viewer A');
  const ownerB = await userFixture('owner-b@example.test', 'OWNER', orgB.id, 'Owner B');

  async function taskFixture(input: {
    orgId: string;
    projectId: string;
    workspaceId: string;
    createdById: string;
    title: string;
    status: 'draft' | 'ready' | 'queued';
    riskClass: 'LOW' | 'HIGH';
    idempotencyKey: string;
  }): Promise<string> {
    const task = await prisma.task.create({
      data: {
        orgId: input.orgId,
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        title: input.title,
        goal: 'Fixture task created by the API test suite.',
        status: input.status,
        riskClass: input.riskClass,
        acceptanceCriteria: [],
        createdById: input.createdById,
        idempotencyKey: input.idempotencyKey,
      },
    });

    return task.id;
  }

  const draftA = await taskFixture({
    orgId: orgA.id,
    projectId: projectA.id,
    workspaceId: workspaceA.id,
    createdById: ownerA.id,
    title: 'Alpha draft task',
    status: 'draft',
    riskClass: 'LOW',
    idempotencyKey: 'fixture-draft-a',
  });

  const queuedA = await taskFixture({
    orgId: orgA.id,
    projectId: projectA.id,
    workspaceId: workspaceA.id,
    createdById: ownerA.id,
    title: 'Alpha queued task',
    status: 'queued',
    riskClass: 'LOW',
    idempotencyKey: 'fixture-queued-a',
  });

  const highReadyA = await taskFixture({
    orgId: orgA.id,
    projectId: projectA.id,
    workspaceId: workspaceA.id,
    createdById: ownerA.id,
    title: 'Alpha high-risk task',
    status: 'ready',
    riskClass: 'HIGH',
    idempotencyKey: 'fixture-high-a',
  });

  const draftB = await taskFixture({
    orgId: orgB.id,
    projectId: projectB.id,
    workspaceId: workspaceB.id,
    createdById: ownerB.id,
    title: 'Beta draft task',
    status: 'draft',
    riskClass: 'LOW',
    idempotencyKey: 'fixture-draft-b',
  });

  const pendingApproval = await prisma.approvalRequest.create({
    data: {
      orgId: orgA.id,
      taskId: highReadyA,
      riskClass: 'HIGH',
      status: 'PENDING',
      requestedById: memberA.id,
      // Phase 4: the fixture is a bound, expiring grant like any row the API writes.
      // A fixture with a null hash would be `APPROVAL_UNBOUND` at the execution gate,
      // which is correct behaviour and the wrong starting point for every other test.
      taskContentHash: computeTaskContentHash({
        title: 'Alpha high-risk task',
        goal: 'Fixture task created by the API test suite.',
        acceptanceCriteria: [],
        riskClass: 'HIGH',
        executionProfile: DEFAULT_EXECUTION_PROFILE,
        sourceRef: null,
        baseCommit: null,
      }),
      riskClassAtApproval: 'HIGH',
      policyVersion: RISK_POLICY_VERSION,
      executionProfile: DEFAULT_EXECUTION_PROFILE,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    },
  });

  return {
    orgA: { id: orgA.id, slug: orgA.slug },
    orgB: { id: orgB.id, slug: orgB.slug },
    workspaceA: workspaceA.id,
    workspaceB: workspaceB.id,
    projectA: projectA.id,
    projectB: projectB.id,
    users: { ownerA, memberA, viewerA, ownerB },
    tasks: { draftA, queuedA, highReadyA, draftB },
    pendingApprovalId: pendingApproval.id,
  };
}

export async function resetDatabase(prisma: PrismaClient): Promise<Fixtures> {
  await truncateAll(prisma);

  return seedFixtures(prisma);
}
