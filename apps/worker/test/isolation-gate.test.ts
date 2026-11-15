import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionIsolation } from '@intelligenz/contracts';
import type { PrismaClient } from '@intelligenz/database';

import { executeAgentActivity } from '../src/activities/execute-agent';
import { persistResultActivity } from '../src/activities/persist-result';
import { resetWorkerConfig } from '../src/config';
import { resetAgentRuntime } from '../src/runtime';
import type { ExecuteAgentActivityInput } from '../src/shared/contracts';
import {
  createTask,
  createTenant,
  dropTenant,
  testDatabaseUrl,
  useTestDatabase,
  type TenantFixture,
} from './helpers/database';

/**
 * The isolation gate, in the real execution path (ADR D-007, AG-504).
 *
 * The gap this suite closes: D-007 decided that a profile requiring a virtual machine must
 * fail closed *before the agent is launched*, and nothing enforced it — a `grep` for
 * `requiresVm|isolationTier|vm-isolated` matched no code at all. These tests are the
 * enforcement's evidence, and they are written against the activity rather than against a
 * helper so that "nothing else happened" is provable from the database:
 *
 *   - one `ExecutionAttempt`, `failed`, carrying `ISOLATION_TIER_UNAVAILABLE`;
 *   - **zero** `AgentRun` rows — nothing ran, so no run may claim to have;
 *   - **zero** `ExecutionWorkspace` rows — no checkout was provisioned;
 *   - and, for the positive control, a normal run that records
 *     `restricted-shared-kernel` as its effective tier.
 *
 * The requirement reaches the gate through `WORKER_RESOURCE_PROFILE=VM` because that is
 * the only way a deployment can say "this needs a virtual machine": it is operator
 * configuration, not a request field. The forgery tests below prove that neither the
 * environment nor an extra activity input can lower it, and that a claim of availability
 * is not consulted.
 *
 * The suite never truncates: it owns a randomly-suffixed tenant per test, because the root
 * test run executes other packages' integration files against the same database.
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

/**
 * Runs `work` with `WORKER_RESOURCE_PROFILE` set (or unset), and restores the environment
 * afterwards. `resetWorkerConfig()` is what makes the change visible: the config is a lazy
 * singleton, so a new environment is only read after the memo is dropped.
 */
async function withResourceProfile<T>(
  name: string | undefined,
  work: () => Promise<T>,
): Promise<T> {
  const previous = process.env['WORKER_RESOURCE_PROFILE'];

  if (name === undefined) delete process.env['WORKER_RESOURCE_PROFILE'];
  else process.env['WORKER_RESOURCE_PROFILE'] = name;

  resetWorkerConfig();

  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env['WORKER_RESOURCE_PROFILE'];
    else process.env['WORKER_RESOURCE_PROFILE'] = previous;

    resetWorkerConfig();
  }
}

/** The thrown failure, so its Temporal `type` (the typed code) can be asserted. */
async function attemptFailure(input: ExecuteAgentActivityInput): Promise<unknown> {
  return executeAgentActivity(input).then(
    () => undefined,
    (error: unknown) => error,
  );
}

beforeAll(async () => {
  if (!enabled) return;

  const database = useTestDatabase();
  client = database.client;
  artifactRoot = await mkdtemp(join(tmpdir(), 'intelligenz-isolation-test-'));

  process.env['DATABASE_URL'] = database.url;
  process.env['ARTIFACT_ROOT'] = artifactRoot;
  process.env['AGENT_RUNTIME'] = 'local-simulated';
  process.env['AGENT_STEP_DELAY_MS'] = '0';
  delete process.env['WORKER_FAULT_INJECT'];
  delete process.env['WORKER_RESOURCE_PROFILE'];

  resetWorkerConfig();
  resetAgentRuntime();
});

afterAll(async () => {
  if (!enabled) return;

  for (const fixture of tenants) await dropTenant(client, fixture);
  await client.$disconnect();
});

describe.skipIf(!enabled)('isolation tier gate', () => {
  it('refuses a vm profile, ends the attempt failed, and launches nothing', async () => {
    const fixture = await tenant('isolation-vm');
    const task = await createTask(client, fixture, { title: 'Requires a virtual machine' });

    const failure = await withResourceProfile('VM', () =>
      attemptFailure({
        taskId: task.taskId,
        orgId: fixture.orgId,
        correlationId: 'isolation-vm',
        workflowRunId: task.workflowRunId,
      }),
    );

    // The typed refusal: `type` is the ApplicationFailure code the workflow and an operator
    // filter on, and it is the same string the attempt records.
    expect(failure).toBeInstanceOf(Error);
    expect((failure as { type?: string }).type).toBe('ISOLATION_TIER_UNAVAILABLE');
    expect((failure as Error).message).toContain('/dev/kvm');

    const attempts = await client.executionAttempt.findMany({
      where: { orgId: fixture.orgId },
      select: {
        status: true,
        executionProfile: true,
        terminationReason: true,
        error: true,
        agentRunId: true,
        startedAt: true,
        finishedAt: true,
      },
    });

    // One row: the attempt the run is attributable to, and no phantom second attempt from
    // the retirement path.
    expect(attempts).toHaveLength(1);

    const [attempt] = attempts;

    expect(attempt?.status).toBe('failed');
    expect(attempt?.executionProfile).toBe('vm');
    expect(attempt?.terminationReason).toBe('isolation_unavailable');
    expect(attempt?.agentRunId).toBeNull();
    expect(attempt?.startedAt).not.toBeNull();
    expect(attempt?.finishedAt).not.toBeNull();
    expect(attempt?.error).toMatchObject({
      code: 'ISOLATION_TIER_UNAVAILABLE',
      retryable: false,
      isolation: { required: 'vm', effective: null, refused: true, vmAvailable: false },
    });

    // The three things a launch creates, all absent. The broker connection lives inside the
    // adapter, which is only reachable through `runtime.execute` — after this gate.
    expect(await client.agentRun.count({ where: { orgId: fixture.orgId } })).toBe(0);
    expect(await client.executionWorkspace.count({ where: { orgId: fixture.orgId } })).toBe(0);
    expect(await client.toolInvocation.count({ where: { orgId: fixture.orgId } })).toBe(0);
  }, 30_000);

  it('ignores forged environment claims that vm is available', async () => {
    const fixture = await tenant('isolation-forged-env');
    const task = await createTask(client, fixture, { title: 'Forged availability' });

    const forged = ['WORKER_VM_AVAILABLE', 'KVM_AVAILABLE', 'VM_AVAILABLE', 'ISOLATION_TIER'];
    const previous = forged.map((name) => [name, process.env[name]] as const);

    let failure: unknown;

    try {
      for (const name of forged) process.env[name] = '1';

      failure = await withResourceProfile('VM', () =>
        attemptFailure({
          taskId: task.taskId,
          orgId: fixture.orgId,
          correlationId: 'isolation-forged-env',
          workflowRunId: task.workflowRunId,
        }),
      );
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }

    // An environment variable is a wish. The capability is a measurement of `/dev/kvm`.
    expect((failure as { type?: string }).type).toBe('ISOLATION_TIER_UNAVAILABLE');
    expect(await client.agentRun.count({ where: { orgId: fixture.orgId } })).toBe(0);

    const attempt = await client.executionAttempt.findFirstOrThrow({
      where: { orgId: fixture.orgId },
    });

    expect(attempt.status).toBe('failed');
  }, 30_000);

  it('cannot be downgraded by a forged activity input field', async () => {
    const fixture = await tenant('isolation-forged-input');
    const task = await createTask(client, fixture, { title: 'Forged input field' });

    // Every field a client-side model might try: a tier, a boolean, and a whole report.
    // None of them is read — the requirement is `profile.isolation`, chosen server-side.
    const forged = {
      taskId: task.taskId,
      orgId: fixture.orgId,
      correlationId: 'isolation-forged-input',
      workflowRunId: task.workflowRunId,
      isolationTier: 'restricted-shared-kernel',
      requiresVm: false,
      isolation: { required: 'restricted-shared-kernel', effective: 'restricted-shared-kernel' },
    } as unknown as ExecuteAgentActivityInput;

    const failure = await withResourceProfile('VM', () => attemptFailure(forged));

    expect((failure as { type?: string }).type).toBe('ISOLATION_TIER_UNAVAILABLE');

    const attempt = await client.executionAttempt.findFirstOrThrow({
      where: { orgId: fixture.orgId },
    });

    expect(attempt.status).toBe('failed');
    expect(attempt.error).toMatchObject({ code: 'ISOLATION_TIER_UNAVAILABLE' });
    expect(await client.agentRun.count({ where: { orgId: fixture.orgId } })).toBe(0);
    expect(await client.executionWorkspace.count({ where: { orgId: fixture.orgId } })).toBe(0);
  }, 30_000);

  it('proceeds under restricted-shared-kernel and records the effective tier', async () => {
    const fixture = await tenant('isolation-restricted');
    // `[simulate:ok]` is the documented goal marker (`local-simulated.ts`, "Forcing the
    // failure bucket"), not a retry or a weakened assertion. Without it this fixture is a
    // coin flip: the simulated adapter fails `hash(taskId + goal) % 1000 < 150`, and the
    // task id is a fresh UUID, so ~15% of runs land in the failure bucket and the
    // `succeeded` assertion below fails for a reason that has nothing to do with the
    // isolation tier. The marker makes the outcome a property of the fixture instead.
    const task = await createTask(client, fixture, {
      title: 'Ordinary restricted run',
      goal: 'Fix the failing test in src/sum.js and prove it passes. [simulate:ok]',
    });

    const result = await withResourceProfile(undefined, () =>
      executeAgentActivity({
        taskId: task.taskId,
        orgId: fixture.orgId,
        correlationId: 'isolation-restricted',
        workflowRunId: task.workflowRunId,
      }),
    );

    expect(result.status).toBe('succeeded');

    const isolation = result.providerMeta?.['isolation'] as ExecutionIsolation | undefined;

    expect(isolation?.required).toBe('restricted-shared-kernel');
    expect(isolation?.effective).toBe('restricted-shared-kernel');
    expect(isolation?.refused).toBe(false);
    // The controls the tier does not provide are part of the record, not a footnote.
    expect(isolation?.controlsUnavailable).toContain('kernel-isolation');

    // Persisted, so the API can report it without re-deriving anything.
    const persisted = await persistResultActivity({
      taskId: task.taskId,
      orgId: fixture.orgId,
      result,
    });

    const run = await client.agentRun.findUniqueOrThrow({
      where: { id: persisted.agentRunId },
      select: { providerMeta: true, simulated: true },
    });

    // `simulated` is untouched by this phase: the simulated adapter still labels itself.
    expect(run.simulated).toBe(true);
    expect((run.providerMeta as Record<string, unknown>)['isolation']).toMatchObject({
      required: 'restricted-shared-kernel',
      effective: 'restricted-shared-kernel',
      refused: false,
    });

    const attempt = await client.executionAttempt.findFirstOrThrow({
      where: { orgId: fixture.orgId, taskId: task.taskId },
    });

    expect(attempt.status).toBe('succeeded');
    expect(attempt.executionProfile).not.toBe('vm');
  }, 30_000);
});
