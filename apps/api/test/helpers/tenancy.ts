import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { PrismaClient } from '@intelligenz/database';

import { computeTaskContentHash } from '../../src/approvals/approval-binding';
import { DEFAULT_EXECUTION_PROFILE, RISK_POLICY_VERSION } from '../../src/risk/risk-policy';

/**
 * Two synthetic tenants, complete and **deterministic** — Gate M.
 *
 * ## Why every id is derived from a seed
 *
 * A tenancy failure is a statement about *which row* was reachable from the wrong
 * organisation. With `randomUUID()` ids, the only way to inspect the failure is to re-run
 * it and hope the same interleaving happens; with derived ids, an id in a failure message
 * is reproducible by hand on the next run, and `describeId()` names the object it stands
 * for. The seed is the whole identity of the fixture, so two suites that use different
 * seeds can never collide, and one suite re-run reclaims exactly its own rows.
 *
 * ## Why the graph is complete
 *
 * The gate under test is "does every `orgId` conjunct hold", and the interesting failures
 * are not on `Task`. They are on the rows reached *through* a task — an artifact served
 * from another tenant's task path, an approval consumed by a run that belongs to somebody
 * else, an attempt adopted across a tenant boundary. A fixture that only created tasks
 * would prove nothing about any of those, so each tenant owns the whole chain the API and
 * the worker read: user → membership → project → task → workflow run → attempt → execution
 * workspace → agent run → artifact → evidence → approval → audit event.
 *
 * ## Why it does not truncate
 *
 * `apps/api/test/helpers/database.ts` truncates, and that is right for suites that assert
 * global shapes. This suite must not: the root `vitest run` executes `apps/worker` and
 * `packages/database` files against the same `_test` database, each owning its own
 * randomly-suffixed tenants, and a `TRUNCATE` here would delete a concurrent suite's
 * fixtures mid-assertion. So each row is owned by a deterministic organisation id, and
 * cleanup is `dropAllTenants` / `reclaim` — the pattern `apps/worker/test/helpers/database.ts`
 * documents for exactly this reason.
 *
 * ## Cleanup guarantee, stated precisely
 *
 * - `createTenancyPair()` **reclaims before it creates**: whatever an aborted previous run
 *   left under this seed is deleted first, so a run that is killed and re-run heals rather
 *   than failing on a unique constraint. The ids are ours by construction, so the reclaim
 *   needs no age guard — no concurrent suite can mint them.
 * - `dropAllTenants()` removes each tenant independently and throws an `AggregateError`
 *   **after** attempting every one, so one foreign-key surprise cannot abandon the rest.
 * - Neither survives `SIGKILL` *this* run; the reclaim on the next run is what does. That
 *   is the only mechanism that can, and it is the same trade the worker helper makes.
 *
 * ## What this fixture is not
 *
 * It is not the API. Nothing here calls a service to create a row, because a fixture that
 * went through the code under test would only prove the two agree. The rows are written the
 * way the writers write them — the approval grant carries a real `taskContentHash`, the
 * attempt carries a real claim column shape — so a broken gate cannot pass by finding a
 * half-shaped row.
 */

/** Every id this module mints, tagged with what it is. A failure can be read by hand. */
export interface TenancyIds {
  readonly org: string;
  readonly workspace: string;
  readonly project: string;
  readonly owner: string;
  readonly member: string;
  readonly tasks: {
    readonly draft: string;
    readonly ready: string;
    readonly high: string;
    readonly executed: string;
  };
  readonly approvals: { readonly pending: string; readonly approved: string };
  readonly workflowRun: string;
  readonly temporalRun: string;
  readonly attempt: string;
  readonly executionWorkspace: string;
  readonly agentRun: string;
  readonly artifact: string;
  readonly evidence: string;
  readonly auditEvent: string;
}

export interface FixtureUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: 'OWNER' | 'MEMBER';
}

export interface TenancyTenant {
  /** `a` or `b`. Every id below is derived from `(seed, label, role)`. */
  readonly label: 'a' | 'b';
  readonly orgId: string;
  readonly orgSlug: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly users: { readonly owner: FixtureUser; readonly member: FixtureUser };
  readonly tasks: {
    /** `draft`, LOW — a legal human edge (`draft → ready`) is available on this row. */
    readonly draft: string;
    /** `ready`, LOW — `POST /run` is reachable on this row. */
    readonly ready: string;
    /** `ready`, HIGH — carries a PENDING request and a live APPROVED grant. */
    readonly high: string;
    /** `succeeded`, with the full execution history below. */
    readonly executed: string;
  };
  readonly approvals: {
    /** PENDING, requested by `member` — the queue item a decision attacks. */
    readonly pending: string;
    /** APPROVED, unconsumed, bound to `high` — the grant a run attacks. */
    readonly approved: string;
  };
  readonly workflowRunId: string;
  readonly attemptId: string;
  readonly executionWorkspaceId: string;
  readonly agentRunId: string;
  readonly artifact: {
    readonly id: string;
    readonly checksum: string;
    /** The exact bytes on disk. A test compares digests against this, not against a row. */
    readonly content: string;
    readonly absolutePath: string;
  };
  readonly evidenceId: string;
  readonly auditEventId: string;
  readonly ids: TenancyIds;
}

export interface TenancyPair {
  readonly seed: string;
  readonly artifactRoot: string;
  readonly a: TenancyTenant;
  readonly b: TenancyTenant;
}

export interface CreateTenancyOptions {
  /**
   * The fixture's identity. Two suites must use different seeds: the ids are derived from
   * it, so a shared seed would make two test files fight over the same rows.
   */
  readonly seed: string;
  /** Where artifact bytes are written. Pass the same value to `createTestApp()`. */
  readonly artifactRoot: string;
  /**
   * The argon2 hash for the fixture users' password, so they can sign in through
   * `POST /v1/auth/login`.
   *
   * Deliberately an argument rather than an import: hashing is the API suite's concern,
   * and the worker suite (which never logs in) must be able to build the same graph
   * without dragging `argon2` into its program.
   */
  readonly passwordHash?: string;
}

/**
 * A UUID-shaped id derived from `(seed, label, role)`.
 *
 * UUID-shaped rather than merely unique because the ids travel into contract-validated
 * fields: `EventEnvelope.tenantId`, `.projectId`, `.aggregateId` and `.actor.id` are all
 * parsed as UUIDs by `AuditService`, and a fixture whose ids failed that parse would make
 * every audit-writing assertion fail for a reason that has nothing to do with tenancy.
 */
export function derivedId(seed: string, ...parts: readonly string[]): string {
  const hex = createHash('sha256')
    .update([seed, ...parts].join('/'), 'utf8')
    .digest('hex');
  const digits = hex.slice(0, 32).split('');

  // Version 4, variant 8–b: the shape a reader expects, so an id is never mistaken for a
  // legacy non-UUID column value.
  digits[12] = '4';
  digits[16] = ((Number.parseInt(digits[16] ?? '0', 16) & 0x3) | 0x8).toString(16);

  const value = digits.join('');

  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20, 32),
  ].join('-');
}

/** The reverse map for a pair: id → human name, so a failure message can name the object. */
export function describeId(pair: TenancyPair, id: string): string {
  for (const tenant of [pair.a, pair.b]) {
    for (const [name, candidate] of flatten(tenant.ids)) {
      if (candidate === id) return `tenant ${tenant.label}:${name}`;
    }
  }

  return `unknown id ${id}`;
}

/**
 * The id list, flattened into `[name, id]` pairs.
 *
 * `describeId` walks this, and the tests assert on it, so a new row type added to the
 * fixture is visible in both places or in neither.
 */
function flatten(ids: TenancyIds): ReadonlyArray<readonly [string, string]> {
  return [
    ['org', ids.org],
    ['workspace', ids.workspace],
    ['project', ids.project],
    ['owner', ids.owner],
    ['member', ids.member],
    ['task.draft', ids.tasks.draft],
    ['task.ready', ids.tasks.ready],
    ['task.high', ids.tasks.high],
    ['task.executed', ids.tasks.executed],
    ['approval.pending', ids.approvals.pending],
    ['approval.approved', ids.approvals.approved],
    ['workflowRun', ids.workflowRun],
    ['temporalRun', ids.temporalRun],
    ['attempt', ids.attempt],
    ['executionWorkspace', ids.executionWorkspace],
    ['agentRun', ids.agentRun],
    ['artifact', ids.artifact],
    ['evidence', ids.evidence],
    ['auditEvent', ids.auditEvent],
  ] as const;
}

// `flatten` is the only reader of `TenancyIds`: `describeId` walks it, so a row type added
// to the fixture is visible there or in neither place.
/**
 * Creates (or re-creates) both tenants, with every row in the graph.
 *
 * Reclaims first: an interrupted previous run leaves rows under the same derived ids, and
 * a unique constraint against a corpse is not a useful failure.
 */
export async function createTenancyPair(
  prisma: PrismaClient,
  options: CreateTenancyOptions,
): Promise<TenancyPair> {
  const { seed, artifactRoot } = options;
  const passwordHash = options.passwordHash ?? 'not-a-hash';

  for (const label of ['a', 'b'] as const) {
    await reclaimTenant(prisma, derivedId(seed, 'org', label));
  }

  const a = await createTenant(prisma, { seed, label: 'a', artifactRoot, passwordHash });
  const b = await createTenant(prisma, { seed, label: 'b', artifactRoot, passwordHash });

  return { seed, artifactRoot, a, b };
}

/** The derived ids for one tenant. Split out so both the builder and `createTenant` share one. */
function idsFor(seed: string, label: 'a' | 'b'): TenancyIds {
  const orgId = derivedId(seed, 'org', label);

  return {
    org: orgId,
    workspace: derivedId(seed, 'workspace', label),
    project: derivedId(seed, 'project', label),
    owner: derivedId(seed, 'user', label, 'owner'),
    member: derivedId(seed, 'user', label, 'member'),
    tasks: {
      draft: derivedId(seed, 'task', label, 'draft'),
      ready: derivedId(seed, 'task', label, 'ready'),
      high: derivedId(seed, 'task', label, 'high'),
      executed: derivedId(seed, 'task', label, 'executed'),
    },
    approvals: {
      pending: derivedId(seed, 'approval', label, 'pending'),
      approved: derivedId(seed, 'approval', label, 'approved'),
    },
    workflowRun: derivedId(seed, 'workflow-run', label),
    temporalRun: derivedId(seed, 'temporal-run', label),
    attempt: derivedId(seed, 'attempt', label),
    executionWorkspace: derivedId(seed, 'execution-workspace', label),
    agentRun: derivedId(seed, 'agent-run', label),
    artifact: derivedId(seed, 'artifact', label),
    evidence: derivedId(seed, 'evidence', label),
    auditEvent: derivedId(seed, 'audit-event', label),
  };
}

async function createTenant(
  prisma: PrismaClient,
  input: CreateTenancyOptions & { readonly label: 'a' | 'b' },
): Promise<TenancyTenant> {
  const { seed, label, artifactRoot } = input;
  const passwordHash = input.passwordHash ?? 'not-a-hash';
  const ids = idsFor(seed, label);

  const identity = await createIdentity(prisma, { seed, label, ids, passwordHash });

  const binding: TaskBindingFacts = {
    executionProfile: DEFAULT_EXECUTION_PROFILE,
    sourceRef: null,
    baseCommit: null,
  };

  await createTasks(prisma, { seed, label, ids, ownerId: identity.owner.id, binding });
  await createApprovalGrants(prisma, {
    ids,
    memberId: identity.member.id,
    ownerId: identity.owner.id,
    binding,
  });

  const now = Date.now();

  const artifact = await createExecutionHistory(prisma, {
    seed,
    label,
    ids,
    artifactRoot,
    now,
    ownerId: identity.owner.id,
  });

  return {
    label,
    orgId: ids.org,
    orgSlug: `${seed}-${label}`,
    workspaceId: ids.workspace,
    projectId: ids.project,
    users: identity,
    tasks: { ...ids.tasks },
    approvals: { ...ids.approvals },
    workflowRunId: ids.workflowRun,
    attemptId: ids.attempt,
    executionWorkspaceId: ids.executionWorkspace,
    agentRunId: ids.agentRun,
    artifact,
    evidenceId: ids.evidence,
    auditEventId: ids.auditEvent,
    ids,
  };
}

/** Organisation, workspace, project, and the two accounts with their memberships. */
async function createIdentity(
  prisma: PrismaClient,
  input: {
    readonly seed: string;
    readonly label: 'a' | 'b';
    readonly ids: TenancyIds;
    readonly passwordHash: string;
  },
): Promise<{ readonly owner: FixtureUser; readonly member: FixtureUser }> {
  const { seed, label, ids, passwordHash } = input;
  const orgId = ids.org;

  await prisma.organization.create({
    data: { id: orgId, name: `Gate M ${label}`, slug: `${seed}-${label}` },
  });

  await prisma.workspace.create({
    data: { id: ids.workspace, orgId, name: `Gate M ${label} workspace`, slug: 'main' },
  });

  await prisma.project.create({
    data: {
      id: ids.project,
      orgId,
      workspaceId: ids.workspace,
      key: label.toUpperCase(),
      name: `Gate M ${label} project`,
      environment: 'dev',
    },
  });

  /**
   * Two accounts, because nearly every refusal below has a *role* explanation available to
   * it as well as a tenant one. `owner` is the attacker with the highest privilege available
   * (`OWNER` satisfies every `@Roles` minimum), and `member` is the minimum role that may
   * write. An attack that passes as OWNER cannot be a permission check wearing a tenant
   * check's clothes.
   */
  const users = [
    {
      id: ids.owner,
      email: `${seed}-${label}-owner@example.test`,
      name: `Gate M ${label} owner`,
      role: 'OWNER' as const,
    },
    {
      id: ids.member,
      email: `${seed}-${label}-member@example.test`,
      name: `Gate M ${label} member`,
      role: 'MEMBER' as const,
    },
  ];

  for (const user of users) {
    await prisma.user.create({
      data: { id: user.id, email: user.email, name: user.name, passwordHash },
    });
    await prisma.membership.create({ data: { orgId, userId: user.id, role: user.role } });
  }

  return { owner: users[0] as FixtureUser, member: users[1] as FixtureUser };
}

/** The execution facts the approval grant is bound to. */
interface TaskBindingFacts {
  readonly executionProfile: string;
  readonly sourceRef: string | null;
  readonly baseCommit: string | null;
}

/** Four tasks, one per state a different attack needs to reach. */
async function createTasks(
  prisma: PrismaClient,
  input: {
    readonly seed: string;
    readonly label: 'a' | 'b';
    readonly ids: TenancyIds;
    readonly ownerId: string;
    readonly binding: TaskBindingFacts;
  },
): Promise<void> {
  const { seed, label, ids, ownerId, binding } = input;

  /**
   * The binding every task carries, written the shape `readTaskBinding` reads.
   *
   * Without it the gate falls back to `standard` / no source, which is the same answer —
   * but the grant's hash is only meaningful when the preimage is stated rather than
   * defaulted, and a fixture that leans on a default cannot detect a change to it.
   */
  const riskFactors = {
    signals: [] as string[],
    score: 0,
    operation: 'read',
    repositoryTrust: 'unknown',
    matchedTerms: [] as string[],
    executionProfile: binding.executionProfile,
    policyVersion: RISK_POLICY_VERSION,
    clientRiskClass: null,
    clientAttemptedDowngrade: false,
    clientAttemptedEscalation: false,
    securityEvents: [] as string[],
    // Spread because Prisma's `InputJsonValue` rejects a named interface: it requires an
    // index signature, which a typed set of execution facts deliberately does not have. Same
    // reason and same workaround as `isolation-reporting.e2e-spec.ts`.
    binding: { ...binding },
  };

  /**
   * One task per attack, because a task only refuses a write for the *right* reason when the
   * edge being attempted is otherwise legal:
   *
   *   - `draft` → a `draft → ready` PATCH is a human edge, so a 404 can only be tenancy;
   *   - `ready` → `POST /run` is reachable, so a 404 can only be tenancy;
   *   - `high`  → carries a live grant, so `POST /run` reaches the approval gate;
   *   - `executed` → carries the run/attempt/artifact chain the read attacks walk.
   */
  const tasks: ReadonlyArray<{
    readonly role: keyof TenancyIds['tasks'];
    readonly status: 'draft' | 'ready' | 'succeeded';
    readonly riskClass: 'LOW' | 'HIGH';
  }> = [
    { role: 'draft', status: 'draft', riskClass: 'LOW' },
    { role: 'ready', status: 'ready', riskClass: 'LOW' },
    { role: 'high', status: 'ready', riskClass: 'HIGH' },
    { role: 'executed', status: 'succeeded', riskClass: 'LOW' },
  ];

  for (const task of tasks) {
    await prisma.task.create({
      data: {
        id: ids.tasks[task.role],
        orgId: ids.org,
        projectId: ids.project,
        workspaceId: ids.workspace,
        title: `Gate M ${label} ${task.role} task`,
        goal: `Gate M ${label} ${task.role}: synthetic task, no customer data.`,
        status: task.status,
        riskClass: task.riskClass,
        riskSource: 'server',
        derivedRiskClass: task.riskClass,
        riskPolicyVersion: RISK_POLICY_VERSION,
        riskFactors,
        acceptanceCriteria: [],
        createdById: ownerId,
        idempotencyKey: `${seed}-${label}-${task.role}`,
      },
    });
  }
}

/** A queue item and a live grant on the same HIGH task: the two approval attacks, one each. */
async function createApprovalGrants(
  prisma: PrismaClient,
  input: {
    readonly ids: TenancyIds;
    readonly memberId: string;
    readonly ownerId: string;
    readonly binding: TaskBindingFacts;
  },
): Promise<void> {
  const { ids, memberId, ownerId, binding } = input;

  const highTask = await prisma.task.findUniqueOrThrow({
    where: { id: ids.tasks.high },
    select: { title: true, goal: true, acceptanceCriteria: true, derivedRiskClass: true },
  });

  // Computed the way the API computes it, imported rather than re-implemented: a fixture that
  // reproduced the canonical preimage would only prove the two copies agree.
  const grantHash = computeTaskContentHash({
    title: highTask.title,
    goal: highTask.goal,
    acceptanceCriteria: highTask.acceptanceCriteria,
    riskClass: highTask.derivedRiskClass ?? 'HIGH',
    executionProfile: binding.executionProfile,
    sourceRef: binding.sourceRef,
    baseCommit: binding.baseCommit,
  });

  const now = Date.now();
  const common = {
    orgId: ids.org,
    taskId: ids.tasks.high,
    riskClass: 'HIGH' as const,
    taskContentHash: grantHash,
    riskClassAtApproval: 'HIGH' as const,
    policyVersion: RISK_POLICY_VERSION,
    executionProfile: binding.executionProfile,
    expiresAt: new Date(now + 24 * 3_600_000),
  };

  // Created oldest-first with explicit timestamps: the gate orders grants `createdAt desc`
  // and picks the newest live one, so the order must be a fact of the fixture rather than a
  // tie-break between two rows created in the same millisecond.
  await prisma.approvalRequest.create({
    data: {
      ...common,
      id: ids.approvals.pending,
      status: 'PENDING',
      // Requested by the member and decided by the owner: separation of duties is satisfied
      // for the in-tenant control, and it is *not* what refuses the cross-tenant attempt —
      // the tenant conjunct is. A requester equal to the attacker would let a self-approval
      // 403 explain the refusal instead.
      requestedById: memberId,
      createdAt: new Date(now - 3_600_000),
    },
  });

  await prisma.approvalRequest.create({
    data: {
      ...common,
      id: ids.approvals.approved,
      status: 'APPROVED',
      requestedById: memberId,
      decidedById: ownerId,
      decidedAt: new Date(now - 1_800_000),
      createdAt: new Date(now - 1_800_000),
      // Unconsumed on purpose: this is the grant a cross-tenant `POST /run` must not spend.
      consumedAt: null,
    },
  });
}

/**
 * The run → attempt → workspace → agent run → artifact chain, plus its evidence and audit row.
 *
 * Written in dependency order, which is also the order the worker writes it: the directory
 * exists before the run that used it, the artifact row names the attempt that produced it,
 * and the audit row is the last thing to exist.
 */
async function createExecutionHistory(
  prisma: PrismaClient,
  input: {
    readonly seed: string;
    readonly label: 'a' | 'b';
    readonly ids: TenancyIds;
    readonly artifactRoot: string;
    readonly now: number;
    readonly ownerId: string;
  },
): Promise<TenancyTenant['artifact']> {
  const { seed, label, ids, artifactRoot, now, ownerId } = input;
  const orgId = ids.org;
  const taskId = ids.tasks.executed;

  await prisma.workflowRun.create({
    data: {
      id: ids.workflowRun,
      orgId,
      taskId,
      workflowId: `task-${taskId}`,
      temporalRunId: ids.temporalRun,
      status: 'succeeded',
      startedAt: new Date(now - 600_000),
      finishedAt: new Date(now - 540_000),
    },
  });

  // The directory before the run that used it: `AgentRun.workspaceId` is a real foreign key,
  // and a fixture that sets it to a row that does not exist yet cannot be written.
  const workspaceRoot = join(artifactRoot, 'execution-workspaces', ids.executionWorkspace);
  await mkdir(workspaceRoot, { recursive: true });

  await prisma.executionWorkspace.create({
    data: {
      id: ids.executionWorkspace,
      orgId,
      taskId,
      state: 'completed',
      rootPath: workspaceRoot,
      sourceKind: 'clone',
      readyAt: new Date(now - 620_000),
      cleanedAt: new Date(now - 500_000),
    },
  });

  await prisma.agentRun.create({
    data: {
      id: ids.agentRun,
      orgId,
      workflowRunId: ids.workflowRun,
      runtimeId: 'opencode-cli',
      model: 'synthetic/gate-m',
      status: 'succeeded',
      startedAt: new Date(now - 590_000),
      finishedAt: new Date(now - 540_000),
      attemptNumber: 1,
      workspaceId: ids.executionWorkspace,
      // A real runtime produced this row, so the column says so — `simulated` is never a
      // default in this codebase, and a fixture that left it defaulted would be lying.
      simulated: false,
      providerMeta: { model: 'synthetic/gate-m' },
    },
  });

  await prisma.executionAttempt.create({
    data: {
      id: ids.attempt,
      orgId,
      taskId,
      workflowRunId: ids.workflowRun,
      agentRunId: ids.agentRun,
      attemptNumber: 1,
      runtimeId: 'opencode-cli',
      simulated: false,
      status: 'succeeded',
      startedAt: new Date(now - 590_000),
      finishedAt: new Date(now - 540_000),
      executionProfile: DEFAULT_EXECUTION_PROFILE,
      terminationReason: 'completed',
    },
  });

  await prisma.executionWorkspace.update({
    where: { id: ids.executionWorkspace },
    data: { agentRunId: ids.agentRun },
  });

  // Bytes on disk, because attack 3 is about content: a row-only fixture would let a
  // leaked *path* pass for a leaked artifact.
  const content =
    JSON.stringify({ gate: 'm', seed, tenant: label, kind: 'diff', finding: 'none' }) + '\n';
  const absolutePath = join(artifactRoot, 'artifacts', orgId, taskId, 'diff.patch');
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, 'utf8');

  const checksum = createHash('sha256').update(content, 'utf8').digest('hex');

  await prisma.artifact.create({
    data: {
      id: ids.artifact,
      orgId,
      taskId,
      attemptId: ids.attempt,
      workspaceId: ids.executionWorkspace,
      runtimeId: 'opencode-cli',
      kind: 'diff',
      uri: absolutePath,
      checksum,
      sizeBytes: BigInt(Buffer.byteLength(content, 'utf8')),
      // A `diff` is a git report, not authority: the agent can configure the repository that
      // produced it. Written the way `persistResult` writes it.
      evidenceSource: 'git-in-sandbox',
      authoritative: false,
    },
  });

  await prisma.evidence.create({
    data: {
      id: ids.evidence,
      orgId,
      taskId,
      kind: 'artifact_checksum',
      uri: absolutePath,
      producedBy: 'opencode-cli',
    },
  });

  await prisma.auditEvent.create({
    data: {
      id: ids.auditEvent,
      orgId,
      projectId: ids.project,
      actorType: 'user',
      actorId: ownerId,
      action: 'task.created',
      aggregateType: 'Task',
      aggregateId: taskId,
      eventType: 'task.created.v1',
      correlationId: derivedId(seed, 'audit-correlation', label),
      idempotencyKey: `task.created:${taskId}`,
      payload: { status: 'succeeded', synthetic: true },
      occurredAt: new Date(now - 700_000),
    },
  });

  return { id: ids.artifact, checksum, content, absolutePath };
}

/**
 * Deletes one tenant's rows by organisation id, in dependency order.
 *
 * The order is not cosmetic: `ExecutionAttempt.orgId`, `ExecutionWorkspace.orgId`,
 * `ApprovalRequest.orgId` and `AuditEvent.orgId` are `Restrict`, so the organisation cannot
 * be deleted while those rows exist, and `ApprovalRequest.task` is `Restrict`, so an
 * approval must go before the task it approved. Account rows are deleted last because
 * `Task.createdById` and `ApprovalRequest.requestedById` are `Restrict` on `User`.
 *
 * Idempotent: every statement is a `deleteMany` / `updateMany`, so reclaiming a tenant that
 * is not there — the normal case on a clean database — is a no-op rather than a throw.
 */
export async function reclaimTenant(prisma: PrismaClient, orgId: string): Promise<void> {
  await prisma.toolInvocation.deleteMany({ where: { orgId } });
  await prisma.artifact.deleteMany({ where: { orgId } });
  await prisma.evidence.deleteMany({ where: { orgId } });
  await prisma.executionAttempt.deleteMany({ where: { orgId } });
  await prisma.agentRun.updateMany({ where: { orgId }, data: { workspaceId: null } });
  await prisma.executionWorkspace.deleteMany({ where: { orgId } });
  await prisma.workflowRun.deleteMany({ where: { orgId } });
  await prisma.approvalRequest.deleteMany({ where: { orgId } });
  await prisma.auditEvent.deleteMany({ where: { orgId } });
  // Phase 8.7: before `Task`/`Project`/`User`, because `Plan.createdById` is RESTRICT and
  // `Plan.projectId` follows the project. A plan pruned after its approver would be refused.
  await prisma.plan.deleteMany({ where: { orgId } });
  await prisma.task.deleteMany({ where: { orgId } });
  await prisma.project.deleteMany({ where: { orgId } });
  await prisma.workspace.deleteMany({ where: { orgId } });

  const memberships = await prisma.membership.findMany({
    where: { orgId },
    select: { userId: true },
  });

  await prisma.membership.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });

  if (memberships.length > 0) {
    await prisma.user.deleteMany({
      where: { id: { in: memberships.map((membership) => membership.userId) } },
    });
  }
}

/**
 * Drops every tenant in `tenants`, independently.
 *
 * A bare `for` ends at the first throw, so one foreign-key surprise or lock wait abandons
 * every tenant after it. Each attempt is isolated, every failure is named, and the
 * aggregate is thrown at the end — a residual tenant cannot be reported as a clean teardown.
 */
export async function dropAllTenants(
  prisma: PrismaClient,
  tenants: readonly TenancyTenant[],
): Promise<void> {
  const failures: { readonly orgId: string; readonly error: unknown }[] = [];

  for (const tenant of tenants) {
    try {
      await reclaimTenant(prisma, tenant.orgId);
    } catch (error) {
      failures.push({ orgId: tenant.orgId, error });
      console.error(
        `[tenancy-cleanup] residual tenant ${tenant.label} (${tenant.orgId}) could not be deleted: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `[tenancy-cleanup] ${String(failures.length)} tenant(s) survived teardown: ${failures
        .map((failure) => failure.orgId)
        .join(', ')}`,
    );
  }
}

/**
 * A row-byte snapshot of every row the tenant owns, keyed by table.
 *
 * The assertion "the row is unchanged" is only meaningful if it is the *whole* row: a
 * status that survived while `updatedAt`, `consumedAt` or a foreign key moved is a write
 * that happened. Counts are included because the attack the gate exists for is often a
 * **new** row (a run, an attempt, an audit event) rather than a change to an existing one.
 */
export async function tenantSnapshot(
  prisma: PrismaClient,
  orgId: string,
): Promise<Record<string, string>> {
  const [
    tasks,
    workflowRuns,
    attempts,
    workspaces,
    agentRuns,
    artifacts,
    evidence,
    approvals,
    audits,
    invocations,
  ] = await Promise.all([
    prisma.task.findMany({ where: { orgId }, orderBy: { id: 'asc' } }),
    prisma.workflowRun.findMany({ where: { orgId }, orderBy: { id: 'asc' } }),
    prisma.executionAttempt.findMany({ where: { orgId }, orderBy: { id: 'asc' } }),
    prisma.executionWorkspace.findMany({ where: { orgId }, orderBy: { id: 'asc' } }),
    prisma.agentRun.findMany({ where: { orgId }, orderBy: { id: 'asc' } }),
    prisma.artifact.findMany({ where: { orgId }, orderBy: { id: 'asc' } }),
    prisma.evidence.findMany({ where: { orgId }, orderBy: { id: 'asc' } }),
    prisma.approvalRequest.findMany({ where: { orgId }, orderBy: { id: 'asc' } }),
    prisma.auditEvent.findMany({ where: { orgId }, orderBy: { id: 'asc' } }),
    prisma.toolInvocation.findMany({ where: { orgId }, orderBy: { id: 'asc' } }),
  ]);

  return {
    Task: canonicalJson(tasks),
    WorkflowRun: canonicalJson(workflowRuns),
    ExecutionAttempt: canonicalJson(attempts),
    ExecutionWorkspace: canonicalJson(workspaces),
    AgentRun: canonicalJson(agentRuns),
    Artifact: canonicalJson(artifacts),
    Evidence: canonicalJson(evidence),
    ApprovalRequest: canonicalJson(approvals),
    AuditEvent: canonicalJson(audits),
    ToolInvocation: canonicalJson(invocations),
  };
}

/**
 * JSON with sorted keys, ISO dates and decimal-string bigints.
 *
 * `JSON.stringify` on two Prisma rows is already almost stable, but "almost" is not an
 * equality assertion: key order follows insertion order, `BigInt` throws outright, and
 * `Date` serialises through `toJSON` only by convention. A canonical form makes the
 * comparison between two reads say what it means.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortValue);

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};

    for (const key of Object.keys(record).sort()) sorted[key] = sortValue(record[key]);

    return sorted;
  }

  return value;
}
