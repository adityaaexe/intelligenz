import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import argon2 from 'argon2';

import type { PrismaClient } from '../src';
import { createPrismaClient } from '../src';
import { loadNearestEnvFile } from '../src/env';

/**
 * Development seed.
 *
 * DEV FIXTURE ONLY. The password below is public, the users are fictional, and the
 * project is a demo. Nothing here may run against a database that holds real data.
 *
 * Idempotency is structural, not "delete everything first":
 *   - rows with a natural key are `upsert`ed on it (org slug, workspace slug,
 *     project key, user email, membership, task `(projectId, idempotencyKey)`);
 *   - rows without one (runs, approvals, audit events) get an id derived from a
 *     stable string, so a second run updates the same row instead of adding a copy.
 * Running the seed twice therefore leaves the row counts unchanged.
 */

const DEV_PASSWORD = 'Passw0rd!demo';

const ORG = { slug: 'northwind-labs', name: 'Northwind Labs' } as const;
const WORKSPACE = { slug: 'reveilchat', name: 'ReveilChat' } as const;
const PROJECT = { key: 'CTRL', name: 'Control Plane', environment: 'prod' } as const;

/**
 * Deterministic RFC 9562 version-5-shaped UUID derived from a fixture key.
 * `z.uuid()` on the contracts side rejects malformed ids, so the version and
 * variant bits are set correctly rather than approximated.
 */
function stableUuid(key: string): string {
  const hash = createHash('sha1').update(`intelligenz.seed:${key}`).digest('hex');
  const version = '5';
  const variant = ((Number.parseInt(hash.charAt(16), 16) & 0x3) | 0x8).toString(16);

  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `${version}${hash.slice(13, 16)}`,
    `${variant}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join('-');
}

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60_000);
}

type SeedPrisma = PrismaClient;

export interface SeedSummary {
  organizations: number;
  workspaces: number;
  projects: number;
  users: number;
  memberships: number;
  tasks: number;
  workflowRuns: number;
  agentRuns: number;
  approvalRequests: number;
  pendingApprovals: number;
  auditEvents: number;
}

/**
 * Hashes per user so each row gets its own salt. argon2id parameters are the
 * OWASP baseline recorded in ADR-005 (19 MiB, time cost 2, parallelism 1).
 */
function hashFixturePassword(): Promise<string> {
  return argon2.hash(DEV_PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
}

export async function seed(prisma: SeedPrisma): Promise<SeedSummary> {
  const organization = await prisma.organization.upsert({
    where: { slug: ORG.slug },
    update: { name: ORG.name },
    create: { id: stableUuid('organization'), name: ORG.name, slug: ORG.slug },
  });

  const workspace = await prisma.workspace.upsert({
    where: { orgId_slug: { orgId: organization.id, slug: WORKSPACE.slug } },
    update: { name: WORKSPACE.name },
    create: {
      id: stableUuid('workspace'),
      orgId: organization.id,
      name: WORKSPACE.name,
      slug: WORKSPACE.slug,
    },
  });

  const project = await prisma.project.upsert({
    where: { workspaceId_key: { workspaceId: workspace.id, key: PROJECT.key } },
    update: { name: PROJECT.name, environment: PROJECT.environment },
    create: {
      id: stableUuid('project'),
      orgId: organization.id,
      workspaceId: workspace.id,
      key: PROJECT.key,
      name: PROJECT.name,
      environment: PROJECT.environment,
    },
  });

  const userFixtures = [
    { email: 'owner@northwind.test', name: 'Priya Nair', role: 'OWNER' },
    { email: 'admin@northwind.test', name: 'Tomas Ferreira', role: 'ADMIN' },
    { email: 'member@northwind.test', name: 'Jules Bennett', role: 'MEMBER' },
    { email: 'viewer@northwind.test', name: 'Sam Whitfield', role: 'VIEWER' },
  ] as const;

  const users: Record<(typeof userFixtures)[number]['role'], string> = {
    OWNER: '',
    ADMIN: '',
    MEMBER: '',
    VIEWER: '',
  };

  for (const fixture of userFixtures) {
    const passwordHash = await hashFixturePassword();
    const user = await prisma.user.upsert({
      where: { email: fixture.email },
      update: { name: fixture.name },
      create: {
        id: stableUuid(`user:${fixture.email}`),
        email: fixture.email,
        name: fixture.name,
        passwordHash,
      },
    });

    users[fixture.role] = user.id;

    await prisma.membership.upsert({
      where: { orgId_userId: { orgId: organization.id, userId: user.id } },
      update: { role: fixture.role },
      create: {
        id: stableUuid(`membership:${fixture.email}`),
        orgId: organization.id,
        userId: user.id,
        role: fixture.role,
      },
    });
  }

  const taskFixtures = [
    {
      idempotencyKey: 'seed-task-01',
      title: 'Add tenant-scoped task listing endpoint',
      goal: 'Expose GET /v1/orgs/:orgId/projects/:projectId/tasks with cursor pagination and an orgId predicate that cannot be omitted.',
      status: 'running',
      riskClass: 'MEDIUM',
      priority: 'high',
      acceptanceCriteria: [
        'Returns 25 rows by default',
        'A task from another org is never present in the response',
      ],
      createdById: users.OWNER,
    },
    {
      idempotencyKey: 'seed-task-02',
      title: 'Harden login rate limiting per email and IP',
      goal: 'Limit login attempts to five per fifteen minutes per (email, ip) pair, using Redis with a sliding window and constant-shaped responses.',
      status: 'running',
      riskClass: 'HIGH',
      priority: 'urgent',
      acceptanceCriteria: [
        'The sixth attempt within the window returns 429',
        'An unknown email and a wrong password are indistinguishable in timing and body',
      ],
      createdById: users.ADMIN,
    },
    {
      idempotencyKey: 'seed-task-03',
      title: 'Emit task.created.v1 audit event on task creation',
      goal: 'Write an AuditEvent in the same transaction as the Task insert so the history cannot lag the state.',
      status: 'queued',
      riskClass: 'LOW',
      priority: 'normal',
      acceptanceCriteria: ['The audit row uses the envelope from contract §7'],
      createdById: users.MEMBER,
    },
    {
      idempotencyKey: 'seed-task-04',
      title: 'Stabilise the Overview readiness probe timeout',
      goal: 'The readiness endpoint reports Temporal as reachable within its two-second budget instead of timing out under load.',
      status: 'verifying',
      riskClass: 'MEDIUM',
      priority: 'normal',
      acceptanceCriteria: [
        'Ten consecutive probes answer in under 500 ms',
        'A stopped Temporal server reports not-ready rather than hanging',
      ],
      createdById: users.MEMBER,
    },
    {
      idempotencyKey: 'seed-task-05',
      title: 'Move artifact storage to content-addressed paths',
      goal: 'Store artifacts under ARTIFACT_ROOT by SHA-256 checksum so identical output is written once and re-running a task cannot corrupt an earlier artifact.',
      status: 'blocked',
      riskClass: 'HIGH',
      priority: 'high',
      acceptanceCriteria: [
        'Two identical artifacts occupy one path',
        'A checksum mismatch is rejected before the file is promoted',
      ],
      createdById: users.ADMIN,
    },
    {
      idempotencyKey: 'seed-task-06',
      title: 'Retry Temporal activities on transient Postgres errors',
      goal: 'Classify serialization failures and connection resets as retryable, and leave a non-retryable error as a terminal failure with the error recorded.',
      status: 'failed',
      riskClass: 'MEDIUM',
      priority: 'normal',
      acceptanceCriteria: [
        'A simulated serialization failure succeeds on the second attempt',
        'A validation error is not retried',
      ],
      createdById: users.MEMBER,
    },
    {
      idempotencyKey: 'seed-task-07',
      title: 'Paginate the project task list',
      goal: 'Replace the unpaginated task list with a cursor and a limit, defaulting to 25 and capped at 100.',
      status: 'succeeded',
      riskClass: 'LOW',
      priority: 'low',
      acceptanceCriteria: ['The page size is capped at 100 server-side'],
      createdById: users.OWNER,
    },
    {
      idempotencyKey: 'seed-task-08',
      title: 'Design the approval flow for CRITICAL tasks',
      goal: 'Specify who may approve a CRITICAL task, what the refusal looks like, and which audit events the decision emits.',
      status: 'draft',
      riskClass: 'CRITICAL',
      priority: 'high',
      acceptanceCriteria: [
        'The refusal is 409 APPROVAL_REQUIRED with a machine-readable code',
        'Approving emits an audit event that names the approver',
      ],
      createdById: users.OWNER,
    },
  ] as const;

  const tasks: Record<string, { id: string }> = {};

  for (const fixture of taskFixtures) {
    const task = await prisma.task.upsert({
      where: {
        projectId_idempotencyKey: {
          projectId: project.id,
          idempotencyKey: fixture.idempotencyKey,
        },
      },
      update: {
        title: fixture.title,
        goal: fixture.goal,
        status: fixture.status,
        riskClass: fixture.riskClass,
        priority: fixture.priority,
        acceptanceCriteria: [...fixture.acceptanceCriteria],
      },
      create: {
        id: stableUuid(`task:${fixture.idempotencyKey}`),
        orgId: organization.id,
        projectId: project.id,
        workspaceId: workspace.id,
        title: fixture.title,
        goal: fixture.goal,
        status: fixture.status,
        riskClass: fixture.riskClass,
        priority: fixture.priority,
        acceptanceCriteria: [...fixture.acceptanceCriteria],
        createdById: fixture.createdById,
        idempotencyKey: fixture.idempotencyKey,
      },
    });

    tasks[fixture.idempotencyKey] = { id: task.id };
  }

  function taskId(key: string): string {
    const task = tasks[key];
    if (!task) throw new Error(`Seed fixture is missing the task ${key}`);
    return task.id;
  }

  // One workflow run and one agent run for each task that is actually running, so
  // the Overview's "active workflows" and "agent activity" regions have real rows.
  const runningTasks = [
    {
      key: 'seed-task-01',
      startedMinutesAgo: 14,
      tokensIn: 18_240,
      tokensOut: 6_110,
      cost: '0.4210',
    },
    {
      key: 'seed-task-02',
      startedMinutesAgo: 6,
      tokensIn: 9_870,
      tokensOut: 2_940,
      cost: '0.1985',
    },
  ] as const;

  for (const running of runningTasks) {
    const id = taskId(running.key);

    const workflowRunId = stableUuid(`workflow-run:${running.key}`);
    const startedAt = minutesAgo(running.startedMinutesAgo);

    await prisma.workflowRun.upsert({
      where: { id: workflowRunId },
      update: { status: 'running', startedAt, finishedAt: null },
      create: {
        id: workflowRunId,
        orgId: organization.id,
        taskId: id,
        workflowId: `run-task-${id}`,
        temporalRunId: stableUuid(`temporal-run:${running.key}`),
        status: 'running',
        startedAt,
      },
    });

    await prisma.agentRun.upsert({
      where: { id: stableUuid(`agent-run:${running.key}`) },
      update: { status: 'running', startedAt },
      create: {
        id: stableUuid(`agent-run:${running.key}`),
        orgId: organization.id,
        workflowRunId,
        // The only runtime that exists in Phase 2. Never present this as a real
        // coding-agent integration (contract §8).
        runtimeId: 'local-simulated',
        model: 'simulated-v1',
        status: 'running',
        startedAt,
        tokensIn: running.tokensIn,
        tokensOut: running.tokensOut,
        costUsd: running.cost,
      },
    });
  }

  // Approval gate fixtures (contract §15 A3). Two PENDING requests are what the
  // Overview's "awaiting approvals" region counts. The APPROVED one is not decoration:
  // task-02 is HIGH risk and already running, which the rule only permits because an
  // approval was granted first. Without it the seed would contain data the API itself
  // would refuse to create.
  const approvalFixtures = [
    {
      taskKey: 'seed-task-02',
      riskClass: 'HIGH',
      status: 'APPROVED',
      requestedMinutesAgo: 70,
      decidedMinutesAgo: 64,
      decidedById: users.OWNER,
      note: 'Approved: rate limiting is bounded to the auth endpoints and is reversible.',
    },
    {
      taskKey: 'seed-task-08',
      riskClass: 'CRITICAL',
      status: 'PENDING',
      requestedMinutesAgo: 20,
      decidedMinutesAgo: null,
      decidedById: null,
      note: 'Awaiting owner sign-off before the CRITICAL approval design is implemented.',
    },
    {
      taskKey: 'seed-task-05',
      riskClass: 'HIGH',
      status: 'PENDING',
      requestedMinutesAgo: 95,
      decidedMinutesAgo: null,
      decidedById: null,
      note: 'Artifact relocation touches every existing run; approval required before retry.',
    },
  ] as const;

  for (const fixture of approvalFixtures) {
    const decidedAt =
      fixture.decidedMinutesAgo === null ? null : minutesAgo(fixture.decidedMinutesAgo);

    await prisma.approvalRequest.upsert({
      where: { id: stableUuid(`approval:${fixture.taskKey}`) },
      update: {
        status: fixture.status,
        decidedAt,
        decidedById: fixture.decidedById,
        decisionNote: fixture.note,
      },
      create: {
        id: stableUuid(`approval:${fixture.taskKey}`),
        orgId: organization.id,
        taskId: taskId(fixture.taskKey),
        riskClass: fixture.riskClass,
        status: fixture.status,
        requestedById: users.ADMIN,
        decidedById: fixture.decidedById,
        decisionNote: fixture.note,
        createdAt: minutesAgo(fixture.requestedMinutesAgo),
        decidedAt,
      },
    });
  }

  const auditFixtures = [
    {
      key: 'task-01-created',
      actorType: 'user',
      actorId: users.OWNER,
      action: 'task.created',
      aggregateType: 'Task',
      aggregateId: taskId('seed-task-01'),
      eventType: 'task.created.v1',
      minutesAgo: 92,
      payload: { title: 'Add tenant-scoped task listing endpoint', riskClass: 'MEDIUM' },
    },
    {
      key: 'task-01-ready',
      actorType: 'user',
      actorId: users.OWNER,
      action: 'task.status_changed',
      aggregateType: 'Task',
      aggregateId: taskId('seed-task-01'),
      eventType: 'task.status_changed.v1',
      minutesAgo: 90,
      payload: { from: 'draft', to: 'ready' },
    },
    {
      key: 'task-01-run-started',
      actorType: 'system',
      actorId: stableUuid('system:temporal'),
      action: 'workflow.started',
      aggregateType: 'WorkflowRun',
      aggregateId: stableUuid('workflow-run:seed-task-01'),
      eventType: 'workflow.started.v1',
      minutesAgo: 14,
      payload: { workflowId: `run-task-${taskId('seed-task-01')}`, status: 'running' },
    },
    {
      key: 'task-06-failed',
      actorType: 'agent',
      actorId: stableUuid('runtime:local-simulated'),
      action: 'task.status_changed',
      aggregateType: 'Task',
      aggregateId: taskId('seed-task-06'),
      eventType: 'task.status_changed.v1',
      minutesAgo: 35,
      payload: { from: 'verifying', to: 'failed', errorCode: 'POSTGRES_SERIALIZATION' },
    },
    {
      key: 'task-02-approval-decided',
      actorType: 'user',
      actorId: users.OWNER,
      action: 'approval.decided',
      aggregateType: 'ApprovalRequest',
      aggregateId: stableUuid('approval:seed-task-02'),
      eventType: 'approval.decided.v1',
      minutesAgo: 64,
      payload: { decision: 'APPROVED', riskClass: 'HIGH', taskId: taskId('seed-task-02') },
    },
    {
      key: 'task-08-approval-requested',
      actorType: 'user',
      actorId: users.ADMIN,
      action: 'approval.requested',
      aggregateType: 'ApprovalRequest',
      aggregateId: stableUuid('approval:seed-task-08'),
      eventType: 'approval.requested.v1',
      minutesAgo: 20,
      payload: { riskClass: 'CRITICAL', taskId: taskId('seed-task-08') },
    },
    {
      key: 'task-02-created',
      actorType: 'user',
      actorId: users.ADMIN,
      action: 'task.created',
      aggregateType: 'Task',
      aggregateId: taskId('seed-task-02'),
      eventType: 'task.created.v1',
      minutesAgo: 61,
      payload: { title: 'Harden login rate limiting per email and IP', riskClass: 'HIGH' },
    },
  ] as const;

  for (const fixture of auditFixtures) {
    await prisma.auditEvent.upsert({
      where: { id: stableUuid(`audit:${fixture.key}`) },
      update: { payload: fixture.payload },
      create: {
        id: stableUuid(`audit:${fixture.key}`),
        orgId: organization.id,
        projectId: project.id,
        actorType: fixture.actorType,
        actorId: fixture.actorId,
        action: fixture.action,
        aggregateType: fixture.aggregateType,
        aggregateId: fixture.aggregateId,
        eventType: fixture.eventType,
        correlationId: stableUuid(`correlation:${fixture.key}`),
        causationId: null,
        idempotencyKey: `seed:${fixture.key}`,
        payload: fixture.payload,
        occurredAt: minutesAgo(fixture.minutesAgo),
      },
    });
  }

  const [
    organizations,
    workspaces,
    projects,
    usersCount,
    memberships,
    taskCount,
    workflowRuns,
    agentRuns,
    approvalRequests,
    pendingApprovals,
    auditEvents,
  ] = await Promise.all([
    prisma.organization.count({ where: { id: organization.id } }),
    prisma.workspace.count({ where: { orgId: organization.id } }),
    prisma.project.count({ where: { orgId: organization.id } }),
    prisma.user.count(),
    prisma.membership.count({ where: { orgId: organization.id } }),
    prisma.task.count({ where: { orgId: organization.id } }),
    prisma.workflowRun.count({ where: { orgId: organization.id } }),
    prisma.agentRun.count({ where: { orgId: organization.id } }),
    prisma.approvalRequest.count({ where: { orgId: organization.id } }),
    prisma.approvalRequest.count({ where: { orgId: organization.id, status: 'PENDING' } }),
    prisma.auditEvent.count({ where: { orgId: organization.id } }),
  ]);

  return {
    organizations,
    workspaces,
    projects,
    users: usersCount,
    memberships,
    tasks: taskCount,
    workflowRuns,
    agentRuns,
    approvalRequests,
    pendingApprovals,
    auditEvents,
  };
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  loadNearestEnvFile();

  const prisma = createPrismaClient();

  seed(prisma)
    .then((summary) => {
      process.stdout.write(`Seed complete (dev fixture): ${JSON.stringify(summary)}\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `Seed failed: ${error instanceof Error ? error.stack : String(error)}\n`,
      );
      process.exitCode = 1;
    })
    .finally(() => {
      void prisma.$disconnect();
    });
}
