import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { connect } from 'node:net';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ExecutionResult } from '@intelligenz/agent-runtime';
import type { PrismaClient } from '@intelligenz/database';

import { completeTaskActivity } from '../src/activities/complete-task';
import { executeAgentActivity } from '../src/activities/execute-agent';
import { executionWorkspaceIdFor } from '../src/activities/ids';
import { persistResultActivity } from '../src/activities/persist-result';
import { validateTaskActivity } from '../src/activities/validate-task';
import { claimExecution, requireExecutionClaim } from '../src/activities/claim';
import { startAttempt } from '../src/activities/attempts';
import { getWorkerConfig, resetWorkerConfig } from '../src/config';
import { resetAgentRuntime } from '../src/runtime';
import { createExecutionHarness, type ExecutionHarness } from './helpers/execution-harness';
import {
  createTask,
  createTenant,
  dropTenant,
  testDatabaseUrl,
  useTestDatabase,
  type TenantFixture,
} from './helpers/database';

/**
 * Execution identity has exactly one source — Phase 6, AG-603.
 *
 * ## The defect these tests fail on
 *
 * `executionIdentity` read `Context.current().info.workflowExecution.runId` and, when there
 * was no workflow execution, fell back to a caller-supplied `workflowRunId` from the
 * activity input. An activity dispatched as a **standalone activity** (`Client.activity`)
 * has an activity context but no workflow execution, so it took the fallback — and the
 * launch-site claim was then satisfied by an input field.
 *
 * The re-review ran it. With the victim already adopted it created attempt 2 under the
 * victim's claim and ran concurrently with attempt 1; with the victim not yet adopted it
 * spent attempt 1, so the legitimate execution that arrived later was refused. Both ids it
 * needed are plaintext in workflow history, which is the register's own O1 precondition.
 *
 * ## What each group below proves
 *
 * 1. **No context ⇒ no identity.** All four guarded activities refuse
 *    `EXECUTION_IDENTITY_UNAVAILABLE` when called as plain functions, with zero writes.
 * 2. **The reviewer's reproduction now fails.** A *real* standalone activity, executed by
 *    a *real* worker created the way production creates one, carrying the victim's run id
 *    and attempt id, is refused and creates **no** attempt. Both variants are covered:
 *    victim unadopted and victim adopted.
 * 3. **The identity a running activity sees is the server's.** A real workflow's activities
 *    claim under that workflow's run id — and no test, script or input can name a different
 *    one, because there is no longer a field to name it in.
 * 4. **The operational script says what is missing** instead of failing three activities
 *    later (N3).
 *
 * Everything is measured against real PostgreSQL and a real Temporal server; the suite
 * skips when either is absent, like the other integration suites.
 */

const databaseUrl = testDatabaseUrl();
const databaseEnabled = databaseUrl !== undefined;

const TEMPORAL_ADDRESS = process.env['TEMPORAL_ADDRESS']?.trim() || 'localhost:7233';
const DRIVE_RUN = fileURLToPath(new URL('../scripts/drive-run.ts', import.meta.url));
const TSX = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url));

const execFileAsync = promisify(execFile);

let temporalReachable = false;
let temporalReason = `Temporal not reachable at ${TEMPORAL_ADDRESS}`;

if (databaseEnabled) {
  const probe = await probeTcp(TEMPORAL_ADDRESS);
  temporalReachable = probe.ok;
  temporalReason = probe.reason;
}

const enabled = databaseEnabled;
const temporalEnabled = databaseEnabled && temporalReachable;

let client: PrismaClient;
let harness: ExecutionHarness;
const tenants: TenantFixture[] = [];
let artifactRoot: string;

async function tenant(label: string): Promise<TenantFixture> {
  const created = await createTenant(client, label);
  tenants.push(created);
  return created;
}

interface Reservation {
  readonly orgId: string;
  readonly projectId: string;
  readonly taskId: string;
  /** The database `WorkflowRun.id` — a foreign key, not the claim identity. */
  readonly workflowRunId: string;
  readonly attemptId: string;
}

/** A `queued` reservation with no claim: the state `POST /run` leaves behind. */
async function reservation(fixture: TenantFixture, label: string): Promise<Reservation> {
  const task = await createTask(client, fixture, { title: label, status: 'ready' });

  const attempt = await client.executionAttempt.create({
    data: {
      orgId: fixture.orgId,
      taskId: task.taskId,
      workflowRunId: task.workflowRunId,
      attemptNumber: 1,
      runtimeId: 'unassigned',
      simulated: true,
      status: 'queued',
    },
    select: { id: true },
  });

  return {
    orgId: fixture.orgId,
    projectId: fixture.projectId,
    taskId: task.taskId,
    workflowRunId: task.workflowRunId,
    attemptId: attempt.id,
  };
}

/** The victim's claim, written the way `validateTaskActivity` writes it. */
async function victimClaim(reservation: Reservation, victimRunId: string): Promise<void> {
  await claimExecution({
    orgId: reservation.orgId,
    taskId: reservation.taskId,
    projectId: reservation.projectId,
    attemptId: reservation.attemptId,
    workflowRunId: victimRunId,
    correlationId: randomUUID(),
  });
}

/** The victim has already adopted: `running`, still claimed by the victim's run id. */
async function victimAdopted(reservation: Reservation, victimRunId: string): Promise<void> {
  await victimClaim(reservation, victimRunId);

  await startAttempt({
    orgId: reservation.orgId,
    taskId: reservation.taskId,
    workflowRunId: reservation.workflowRunId,
    runtimeId: 'local-simulated',
    simulated: true,
    startedAt: new Date(),
    executionRunId: victimRunId,
  });
}

/** Adoption, without going through the executor: `running`, claim unchanged. */
async function closeAttemptToRunning(reservationRow: Reservation, owner: string): Promise<void> {
  await client.executionAttempt.updateMany({
    where: { id: reservationRow.attemptId, claimedByWorkflowRunId: owner },
    data: { status: 'running', startedAt: new Date() },
  });
}

async function attemptRows(
  reservation: Reservation,
): Promise<readonly { status: string; claimedByWorkflowRunId: string | null }[]> {
  return client.executionAttempt.findMany({
    where: { orgId: reservation.orgId, taskId: reservation.taskId },
    orderBy: { attemptNumber: 'asc' },
    select: { status: true, claimedByWorkflowRunId: true },
  });
}

/**
 * Nothing a launch would create exists.
 *
 * Counted per tenant, so a concurrent suite cannot influence it; the cgroup directory is
 * named after the derived workspace id and is checked directly because a refused launch
 * must not reach the isolation gate either.
 */
async function assertNoExecutionSideEffects(reservation: Reservation): Promise<void> {
  expect(await client.agentRun.count({ where: { orgId: reservation.orgId } })).toBe(0);
  expect(await client.executionWorkspace.count({ where: { orgId: reservation.orgId } })).toBe(0);
  expect(await client.toolInvocation.count({ where: { orgId: reservation.orgId } })).toBe(0);

  const cgroupRoot = getWorkerConfig().resources.cgroupRoot;
  const workspaceId = executionWorkspaceIdFor(reservation.workflowRunId, 1);
  const entries = await readdir(cgroupRoot).catch(() => [] as string[]);

  expect(entries).not.toContain(workspaceId);
}

/**
 * A shape-valid result for the persistence guard.
 *
 * `persistResultActivity` must refuse before this value is read, so the value's contents
 * are irrelevant — but constructing a real one keeps the failure unambiguous: if the guard
 * ever moved behind the first write, the test would fail on the *guard* assertion rather
 * than on a malformed fixture.
 */
const UNUSED_RESULT: ExecutionResult = {
  status: 'succeeded',
  summary: 'never persisted: the activity has no execution identity',
  artifacts: [],
  events: [],
  usage: { tokensIn: 0, tokensOut: 0, usd: 0 },
  runtimeId: 'local-simulated',
  simulated: true,
};

beforeAll(async () => {
  if (!databaseEnabled) return;

  const database = useTestDatabase();
  client = database.client;
  artifactRoot = `/tmp/intelligenz-identity-test-${randomUUID().slice(0, 8)}`;

  process.env['DATABASE_URL'] = database.url;
  process.env['ARTIFACT_ROOT'] = artifactRoot;
  process.env['AGENT_RUNTIME'] = 'local-simulated';
  process.env['AGENT_STEP_DELAY_MS'] = '0';
  delete process.env['WORKER_FAULT_INJECT'];
  delete process.env['WORKER_RESOURCE_PROFILE'];
  delete process.env['LOCAL_SIMULATED_OUTCOME'];

  resetWorkerConfig();
  resetAgentRuntime();

  if (temporalReachable) harness = await createExecutionHarness();
});

afterAll(async () => {
  if (!databaseEnabled) return;

  // `close()` does not throw, and the fixtures are dropped even if it did: a tenant left in
  // the shared test database is not this suite's business to leave behind, and
  // `packages/database`'s seed test counts rows globally.
  await harness?.close();

  for (const fixture of tenants) await dropTenant(client, fixture);
  await client.$disconnect();
});

if (!enabled) {
  console.warn(
    `[execution-identity] suite skipped — ${
      databaseEnabled ? temporalReason : 'TEST_DATABASE_URL is not set'
    }`,
  );
}

// ─── 1. No activity context ⇒ no identity ───────────────────────────────────

describe.skipIf(!enabled)('N1 — an activity with no execution context has no identity', () => {
  it('refuses the launch site before it reads the task, and writes nothing', async () => {
    const fixture = await tenant('n1-executor');
    const reservationRow = await reservation(fixture, 'executor-no-context');

    // The field that used to satisfy the gate. It is not part of the input type any more,
    // so the call is built as an untyped record: the refusal must survive it, which is the
    // difference between "we deleted the field" and "the field decides nothing".
    const forged = {
      taskId: reservationRow.taskId,
      orgId: fixture.orgId,
      correlationId: randomUUID(),
      workflowRunId: reservationRow.workflowRunId,
      attemptId: reservationRow.attemptId,
      executionRunId: `execution-${randomUUID()}`,
    } as unknown as Parameters<typeof executeAgentActivity>[0];

    await expect(executeAgentActivity(forged)).rejects.toMatchObject({
      type: 'EXECUTION_IDENTITY_UNAVAILABLE',
      nonRetryable: true,
    });

    await assertNoExecutionSideEffects(reservationRow);

    expect(await attemptRows(reservationRow)).toEqual([
      { status: 'queued', claimedByWorkflowRunId: null },
    ]);
  }, 30_000);

  it('refuses validation, so a direct call cannot spend a reservation', async () => {
    const fixture = await tenant('n1-validate');
    const reservationRow = await reservation(fixture, 'validate-no-context');

    await expect(
      validateTaskActivity({
        taskId: reservationRow.taskId,
        orgId: fixture.orgId,
        attemptId: reservationRow.attemptId,
        correlationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ type: 'EXECUTION_IDENTITY_UNAVAILABLE', nonRetryable: true });

    // The reservation is untouched: no claim, no claim event, no side effect.
    expect(await attemptRows(reservationRow)).toEqual([
      { status: 'queued', claimedByWorkflowRunId: null },
    ]);
    expect(
      await client.auditEvent.count({
        where: {
          orgId: fixture.orgId,
          aggregateId: reservationRow.attemptId,
          eventType: 'execution.claim_granted.v1',
        },
      }),
    ).toBe(0);
  }, 30_000);

  it('refuses result persistence, so no AgentRun can be written without an execution', async () => {
    const fixture = await tenant('n1-persist');
    const reservationRow = await reservation(fixture, 'persist-no-context');

    await expect(
      persistResultActivity({
        taskId: reservationRow.taskId,
        orgId: fixture.orgId,
        result: UNUSED_RESULT,
        attemptId: reservationRow.attemptId,
      }),
    ).rejects.toMatchObject({ type: 'EXECUTION_IDENTITY_UNAVAILABLE', nonRetryable: true });

    expect(await client.agentRun.count({ where: { orgId: fixture.orgId } })).toBe(0);
  }, 30_000);

  it('refuses task completion, so terminal state cannot be written without an execution', async () => {
    const fixture = await tenant('n1-complete');
    const reservationRow = await reservation(fixture, 'complete-no-context');

    await expect(
      completeTaskActivity({
        taskId: reservationRow.taskId,
        orgId: fixture.orgId,
        status: 'failed',
        error: { code: 'FORGED', message: 'not from an execution' },
      }),
    ).rejects.toMatchObject({ type: 'EXECUTION_IDENTITY_UNAVAILABLE', nonRetryable: true });

    const task = await client.task.findUniqueOrThrow({
      where: { id: reservationRow.taskId },
      select: { status: true },
    });

    expect(task.status).toBe('ready');
  }, 30_000);
});

// ─── 1b. The gate's decision, without a server ──────────────────────────────

/**
 * `requireExecutionClaim`'s decisions, exercised without Temporal.
 *
 * The function takes the identity as an argument, and that is legitimate *for it*: it is an
 * internal guard whose only production caller (`executeAgentActivity`) derives the value
 * from the activity context. Nothing reachable from Temporal can choose the argument — the
 * dispatch-level proof of that is the standalone-activity group below, and the structural
 * test at the end. Keeping the decisions here means CI, which has no Temporal service,
 * still covers "no claim is refused", "another execution's claim is refused" and "this
 * execution's claim proceeds".
 */
describe.skipIf(!enabled)('N1 — the claim gate decides the same way without a server', () => {
  it('refuses an attempt that holds no claim', async () => {
    const fixture = await tenant('identity-no-claim');
    const reservationRow = await reservation(fixture, 'gate-no-claim');

    await expect(
      requireExecutionClaim({
        orgId: fixture.orgId,
        taskId: reservationRow.taskId,
        attemptId: reservationRow.attemptId,
        executionRunId: `execution-${randomUUID()}`,
        workflowRunId: reservationRow.workflowRunId,
      }),
    ).rejects.toMatchObject({ type: 'EXECUTION_CLAIM_REFUSED', nonRetryable: true });
  });

  it('refuses an attempt claimed by a different execution', async () => {
    const fixture = await tenant('identity-foreign-claim');
    const reservationRow = await reservation(fixture, 'gate-foreign');
    const owner = `execution-owner-${randomUUID()}`;

    await victimClaim(reservationRow, owner);

    await expect(
      requireExecutionClaim({
        orgId: fixture.orgId,
        taskId: reservationRow.taskId,
        attemptId: reservationRow.attemptId,
        executionRunId: `execution-intruder-${randomUUID()}`,
        workflowRunId: reservationRow.workflowRunId,
      }),
    ).rejects.toMatchObject({ type: 'EXECUTION_ALREADY_CLAIMED', nonRetryable: true });
  });

  it('admits the holder, including a retry after adoption', async () => {
    const fixture = await tenant('identity-holder');
    const reservationRow = await reservation(fixture, 'gate-holder');
    const owner = `execution-owner-${randomUUID()}`;

    // Before adoption…
    await victimClaim(reservationRow, owner);

    await expect(
      requireExecutionClaim({
        orgId: fixture.orgId,
        taskId: reservationRow.taskId,
        attemptId: reservationRow.attemptId,
        executionRunId: owner,
        workflowRunId: reservationRow.workflowRunId,
      }),
    ).resolves.toMatchObject({ attemptId: reservationRow.attemptId, executionRunId: owner });

    // …and after it, which is the crash-retry case: the row is `running`, the claim is
    // still the same execution's, and refusing here would make a worker restart fatal.
    await closeAttemptToRunning(reservationRow, owner);

    await expect(
      requireExecutionClaim({
        orgId: fixture.orgId,
        taskId: reservationRow.taskId,
        attemptId: reservationRow.attemptId,
        executionRunId: owner,
      }),
    ).resolves.toMatchObject({ attemptId: reservationRow.attemptId });
  });

  it('refuses an attempt that belongs to another database run than the one named', async () => {
    const fixture = await tenant('identity-run-mismatch');
    const reservationRow = await reservation(fixture, 'gate-run-mismatch');
    const owner = `execution-owner-${randomUUID()}`;

    await victimClaim(reservationRow, owner);

    const other = await client.workflowRun.create({
      data: {
        orgId: fixture.orgId,
        taskId: reservationRow.taskId,
        workflowId: `task-${reservationRow.taskId}-other`,
        temporalRunId: randomUUID(),
        status: 'queued',
      },
      select: { id: true },
    });

    await expect(
      requireExecutionClaim({
        orgId: fixture.orgId,
        taskId: reservationRow.taskId,
        attemptId: reservationRow.attemptId,
        executionRunId: owner,
        workflowRunId: other.id,
      }),
    ).rejects.toMatchObject({ type: 'EXECUTION_CLAIM_REFUSED', nonRetryable: true });
  });
});

// ─── 2. The reviewer's standalone-activity reproduction ─────────────────────

describe.skipIf(!temporalEnabled)(
  'N1 — a standalone activity cannot impersonate an execution',
  () => {
    it('is refused when the victim has not adopted, and spends no reservation', async () => {
      const fixture = await tenant('n1-standalone-unadopted');
      const reservationRow = await reservation(fixture, 'standalone-unadopted');
      const victimRunId = `execution-victim-${randomUUID()}`;

      await victimClaim(reservationRow, victimRunId);

      // The exact shape from the re-review: a real standalone activity, on the production
      // worker's task queue, naming the victim's attempt and the victim's run id in the
      // input field that no longer exists.
      await expect(
        harness.executeStandalone('executeAgentActivity', [
          {
            taskId: reservationRow.taskId,
            orgId: fixture.orgId,
            correlationId: randomUUID(),
            workflowRunId: reservationRow.workflowRunId,
            attemptId: reservationRow.attemptId,
            executionRunId: victimRunId,
          },
        ]),
      ).rejects.toMatchObject({ type: 'EXECUTION_IDENTITY_UNAVAILABLE', nonRetryable: true });

      // Before AG-603 this call adopted the attempt and ran. Now: one row, still the
      // victim's, still `queued` — the reservation the legitimate execution needs is intact.
      expect(await attemptRows(reservationRow)).toEqual([
        { status: 'queued', claimedByWorkflowRunId: victimRunId },
      ]);
      await assertNoExecutionSideEffects(reservationRow);
    }, 60_000);

    it('is refused when the victim has adopted, and creates no second attempt', async () => {
      const fixture = await tenant('n1-standalone-adopted');
      const reservationRow = await reservation(fixture, 'standalone-adopted');
      const victimRunId = `execution-victim-${randomUUID()}`;

      await victimAdopted(reservationRow, victimRunId);

      await expect(
        harness.executeStandalone('executeAgentActivity', [
          {
            taskId: reservationRow.taskId,
            orgId: fixture.orgId,
            correlationId: randomUUID(),
            workflowRunId: reservationRow.workflowRunId,
            attemptId: reservationRow.attemptId,
            executionRunId: victimRunId,
          },
        ]),
      ).rejects.toMatchObject({ type: 'EXECUTION_IDENTITY_UNAVAILABLE', nonRetryable: true });

      // The re-review observed "attempt 2: succeeded" here. One attempt, and it is still
      // the victim's running row.
      expect(await attemptRows(reservationRow)).toEqual([
        { status: 'running', claimedByWorkflowRunId: victimRunId },
      ]);
      expect(await client.agentRun.count({ where: { orgId: fixture.orgId } })).toBe(0);
    }, 60_000);

    it('cannot claim an unclaimed reservation either, so it cannot pre-empt the victim', async () => {
      const fixture = await tenant('n1-standalone-claim');
      const reservationRow = await reservation(fixture, 'standalone-claim');
      const victimRunId = `execution-victim-${randomUUID()}`;

      // Validation is the claim writer, and it is reachable by name too.
      await expect(
        harness.executeStandalone('validateTaskActivity', [
          {
            taskId: reservationRow.taskId,
            orgId: fixture.orgId,
            attemptId: reservationRow.attemptId,
            correlationId: randomUUID(),
            workflowRunId: victimRunId,
          },
        ]),
      ).rejects.toMatchObject({ type: 'EXECUTION_IDENTITY_UNAVAILABLE', nonRetryable: true });

      expect(await attemptRows(reservationRow)).toEqual([
        { status: 'queued', claimedByWorkflowRunId: null },
      ]);
    }, 60_000);
  },
);

// ─── 3. The identity a running activity sees is the server's ────────────────

describe.skipIf(!temporalEnabled)('N1 — inside a workflow the identity is the run id', () => {
  it('claims under the run id the server minted for that execution', async () => {
    const fixture = await tenant('n1-worker-identity');
    const reservationRow = await reservation(fixture, 'worker-identity');

    const session = await harness.session();

    try {
      const [validated] = await session.run([
        {
          op: 'validate',
          input: {
            taskId: reservationRow.taskId,
            orgId: fixture.orgId,
            attemptId: reservationRow.attemptId,
            correlationId: randomUUID(),
          },
        },
      ]);

      expect(validated).toMatchObject({ runnable: true });

      const claimed = await attemptRows(reservationRow);

      // The value the activity wrote is the value the server minted. Nothing was passed in
      // that could have named a different one — the session's run id is the only identity
      // in play, and the test learned it from the server, not the other way round.
      expect(claimed).toEqual([{ status: 'queued', claimedByWorkflowRunId: session.runId }]);
    } finally {
      await session.stop();
    }
  }, 60_000);
});

// ─── 4. The shape of the code, without a server ─────────────────────────────

/**
 * A structural guard, runnable in CI where no Temporal service exists.
 *
 * The behavioural proofs above need a server. These do not, and they are the ones that
 * would have caught N1 as a *design*: an identity parameter on `executionIdentity`, an
 * identity field on an activity input, or a guard that is not the first thing the launch
 * site does. Each of them is one line away from a demo that passes and a boundary that
 * does not exist.
 */
describe('N1 — the shape of the code leaves no way to supply an identity', () => {
  const CLAIM = fileURLToPath(new URL('../src/activities/claim.ts', import.meta.url));
  const CONTRACTS = fileURLToPath(new URL('../src/shared/contracts.ts', import.meta.url));
  const EXECUTOR = fileURLToPath(new URL('../src/activities/execute-agent.ts', import.meta.url));
  const PERSIST = fileURLToPath(new URL('../src/activities/persist-result.ts', import.meta.url));
  const COMPLETE = fileURLToPath(new URL('../src/activities/complete-task.ts', import.meta.url));

  it('executionIdentity takes no argument at all', async () => {
    const code = stripComments(await readFile(CLAIM, 'utf8'));

    expect(code).toContain('export function executionIdentity(): string | undefined');
    // The old signature, verbatim. A future edit that restores it fails here.
    expect(code).not.toMatch(/executionIdentity\(\s*input/);
    expect(code).not.toMatch(/function executionIdentity\(\s*\w/);
  });

  it('no activity input carries an execution identity', async () => {
    const code = stripComments(await readFile(CONTRACTS, 'utf8'));

    // An input field is a parameter, and a parameter is forgeable by anything that can
    // dispatch the activity. The run id comes from the activity context only.
    expect(code).not.toMatch(/readonly executionRunId/);

    // Validation carried a `workflowRunId` that was *only* ever the identity — it was the
    // fallback's field, and it is gone.
    const validate = interfaceBody(code, 'ValidateTaskActivityInput');

    expect(validate).not.toBe('');
    expect(validate).not.toMatch(/readonly workflowRunId/);

    // `ExecuteAgentActivityInput.workflowRunId` survives on purpose and is a different
    // thing: the database `WorkflowRun.id`, checked against the attempt's foreign key. It
    // buys nothing on its own — the claim still has to be held by the context's run id —
    // and the comment on the field says so.
    const execute = interfaceBody(code, 'ExecuteAgentActivityInput');

    expect(execute).toContain('readonly workflowRunId?: string');
  });

  it('the claim is the first act of the launch site, before anything can be created', async () => {
    const code = stripComments(await readFile(EXECUTOR, 'utf8'));

    const guard = code.indexOf('requireExecutionClaim(');
    const runtime = code.indexOf('getAgentRuntime(');
    const adopt = code.indexOf('startAttempt(');
    const launch = code.indexOf('runtime.execute(');

    expect(guard).toBeGreaterThan(-1);
    // Ordering, not adjacency: the guard sits above the runtime, adoption and the launch.
    expect(guard).toBeLessThan(runtime);
    expect(guard).toBeLessThan(adopt);
    expect(guard).toBeLessThan(launch);
  });

  it('both terminal writes check authority before they write', async () => {
    const persist = stripComments(await readFile(PERSIST, 'utf8'));
    const complete = stripComments(await readFile(COMPLETE, 'utf8'));

    // N4: the wrapper must guard *then* delegate, in that order. Prettier decides how the
    // call is wrapped, so the assertion is on the two names, not on a line of source.
    const persistGuard = persist.indexOf('requireExecutionClaim(');
    const persistBody = persist.indexOf('persistResult(input)');

    expect(persistGuard).toBeGreaterThan(-1);
    expect(persistBody).toBeGreaterThan(-1);
    expect(persistGuard).toBeLessThan(persistBody);

    const completeGuard = complete.indexOf('requireCompletionAuthority(');
    const completeBody = complete.indexOf('completeTask(input)');

    expect(completeGuard).toBeGreaterThan(-1);
    expect(completeBody).toBeGreaterThan(-1);
    expect(completeGuard).toBeLessThan(completeBody);
  });
});

/** Removes block and line comments so a rule quoted in prose is not a false positive. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** The body of `interface Name { … }`, or `''` if the interface is not there. */
function interfaceBody(source: string, name: string): string {
  const start = source.indexOf(`interface ${name} {`);
  if (start === -1) return '';

  const end = source.indexOf('\n}', start);

  return end === -1 ? '' : source.slice(start, end);
}

// ─── 5. N3 — the operational script names what is missing ───────────────────

describe('N3 — drive-run.ts refuses a start without an attempt id', () => {
  it('names the missing attempt id and exits 2, without starting anything', async () => {
    const failure = await runDriveRun(['start', `task-${randomUUID()}`, 'org-1']);

    expect(failure.code).toBe(2);
    expect(failure.stderr).toContain('an attempt id is required');
    // The message says what to supply, not merely that something was refused.
    expect(failure.stderr).toContain('POST /run');
    expect(failure.stdout).toBe('');
  }, 60_000);

  it('keeps the usage line honest for a start that names only a task', async () => {
    const failure = await runDriveRun(['start', `task-${randomUUID()}`]);

    expect(failure.code).toBe(2);
    expect(failure.stderr).toContain('drive-run.ts start <taskId> <orgId> <attemptId>');
  }, 60_000);
});

async function runDriveRun(args: readonly string[]): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  try {
    const result = await execFileAsync(TSX, [DRIVE_RUN, ...args], {
      cwd: fileURLToPath(new URL('../../..', import.meta.url)),
      env: { ...process.env },
      timeout: 45_000,
    });

    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

function probeTcp(address: string): Promise<{ ok: boolean; reason: string }> {
  const [host, rawPort] = address.split(':');
  const port = Number.parseInt(rawPort ?? '7233', 10);

  return new Promise((resolve) => {
    const socket = connect({ host: host ?? 'localhost', port });

    const finish = (ok: boolean, reason: string): void => {
      socket.destroy();
      resolve({ ok, reason });
    };

    socket.setTimeout(1_500);
    socket.once('connect', () => finish(true, `Temporal reachable at ${address}`));
    socket.once('timeout', () => finish(false, `Temporal timed out at ${address}`));
    socket.once('error', (error) =>
      finish(false, `Temporal unreachable at ${address}: ${error.message}`),
    );
  });
}
