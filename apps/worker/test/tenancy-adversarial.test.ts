import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ExecutionResult } from '@intelligenz/agent-runtime';
import type { PrismaClient } from '@intelligenz/database';

import { activities } from '../src/activities';
import { claimExecution } from '../src/activities/claim';
import { resetWorkerConfig } from '../src/config';
import { resetAgentRuntime } from '../src/runtime';
import type { RunTaskWorkflowResult } from '../src/shared/contracts';
import {
  canonicalJson,
  createTenancyPair,
  dropAllTenants,
  tenantSnapshot,
  type TenancyPair,
  type TenancyTenant,
} from '../../api/test/helpers/tenancy';
import { testDatabaseUrl, useTestDatabase } from './helpers/database';
import {
  createExecutionHarness,
  temporalReachable,
  type ExecutionHarness,
  type ExecutionSession,
} from './helpers/execution-harness';

/**
 * Gate M — the multi-tenant adversarial suite, execution surface.
 *
 * ## Why these two attacks are not in the API suite
 *
 * Attack 5 and attack 7 are about code the HTTP layer never reaches: the worker's
 * activities, dispatched **by name** from a workflow. `requireExecutionClaim` refuses an
 * attempt that is not `(id, orgId, taskId)`, and `validateTaskActivity` scopes the task read
 * the same way. Proving that needs an execution identity the Temporal server minted —
 * without one, `executionIdentity()` is `undefined` and every call is refused for a reason
 * that has nothing to do with tenancy. So these run through a real worker, which lives in
 * this package because `@temporalio/worker` and the workflow bundle do.
 *
 * The **fixtures** are shared: `apps/api/test/helpers/tenancy.ts` owns the two tenants and
 * their cleanup guarantee, and this file imports it rather than growing a second, drifting
 * definition of the same graph. The seed differs from the API suite's, so the two files can
 * never collide on an id even if they are run at the same time.
 *
 * ## What "refused" has to mean here
 *
 * A refusal is not enough on its own. `EXECUTION_CLAIM_REFUSED` also covers "this attempt
 * has not been claimed yet", so a cross-tenant call that names an attempt which happens to
 * be unclaimed would be refused for the wrong reason and the assertion would pass with the
 * tenant conjunct deleted. The fixtures therefore arrange the foreign attempt to be
 * **claimed by another execution**, which makes the two outcomes distinguishable:
 *
 *   - tenant conjunct present → the attempt is invisible → `EXECUTION_CLAIM_REFUSED`
 *     ("does not exist for this task in this organisation");
 *   - tenant conjunct deleted → the attempt is visible and held by somebody else →
 *     `EXECUTION_ALREADY_CLAIMED`.
 *
 * The tests assert the first and would fail on the second, which is the whole point of
 * arranging state the passing case never touches.
 */

const databaseUrl = testDatabaseUrl();
const databaseEnabled = databaseUrl !== undefined;

const TEMPORAL_ADDRESS = process.env['TEMPORAL_ADDRESS']?.trim() || 'localhost:7233';
const TEMPORAL_NAMESPACE = process.env['TEMPORAL_NAMESPACE']?.trim() || 'default';
const WORKFLOW_PATH = fileURLToPath(new URL('../src/workflows/run-task.ts', import.meta.url));

const SEED = 'gate-m-701-worker';

/**
 * A refusal that must never reach a row: `persistResultActivity` is refused before it reads
 * the result, so the value only has to be a shape the workflow can serialise.
 */
const REFUSED_RESULT = {
  status: 'succeeded',
  summary: 'gate-m: a cross-tenant persistence attempt that must never be written',
  artifacts: [],
  events: [],
  usage: {},
  runtimeId: 'local-simulated',
  simulated: true,
} as const satisfies ExecutionResult;

interface Reservation {
  readonly taskId: string;
  /** The database `WorkflowRun.id` — a foreign key, not the claim identity. */
  readonly workflowRunId: string;
  readonly attemptId: string;
}

let client: PrismaClient;
let pair: TenancyPair;
let artifactRoot: string;
let harness: ExecutionHarness;
let session: ExecutionSession;

/** The caller's own reservation: a real execution, holding a real claim on its own attempt. */
let aReservation: Reservation;
/** B's attempt, claimed by somebody else — the shape that makes a dropped conjunct visible. */
let bClaimed: Reservation;
/** B's attempt, still unclaimed — the shape a forged workflow would adopt if it could see it. */
let bUnclaimed: Reservation;

const enabled = databaseEnabled && (await temporalReachable());

if (!enabled) {
  console.warn(
    `[gate-m-worker] suite skipped — ${
      databaseEnabled
        ? `Temporal not reachable at ${TEMPORAL_ADDRESS}`
        : 'TEST_DATABASE_URL is not set'
    }`,
  );
}

/**
 * The row shape `POST /run` leaves behind: a `queued` run and one `queued` attempt.
 *
 * Deliberately not built through the API. These tests are about the worker's own gate, and
 * a helper that reproduced the API would only prove the two agree.
 */
async function reserve(tenant: TenancyTenant, taskId: string, label: string): Promise<Reservation> {
  const run = await client.workflowRun.create({
    data: {
      orgId: tenant.orgId,
      taskId,
      workflowId: `task-${taskId}`,
      temporalRunId: `gate-m-${label}-${randomUUID()}`,
      status: 'queued',
    },
    select: { id: true },
  });

  const attempt = await client.executionAttempt.create({
    data: {
      orgId: tenant.orgId,
      taskId,
      workflowRunId: run.id,
      attemptNumber: 1,
      // The API's reservation value: an adapter will run it, which one is not yet known.
      runtimeId: 'unassigned',
      simulated: true,
      status: 'queued',
    },
    select: { id: true },
  });

  return { taskId, workflowRunId: run.id, attemptId: attempt.id };
}

/** Writes the claim the way `validateTaskActivity` does, under a stated identity. */
async function claimAs(
  tenant: TenancyTenant,
  reservation: Reservation,
  executionRunId: string,
): Promise<void> {
  await claimExecution({
    orgId: tenant.orgId,
    taskId: reservation.taskId,
    projectId: tenant.projectId,
    attemptId: reservation.attemptId,
    workflowRunId: executionRunId,
    correlationId: randomUUID(),
  });
}

/**
 * The activity failure a step produced, or `undefined` if it resolved.
 *
 * `ApplicationFailure` is what crosses the proxy boundary; its `type` is the machine-readable
 * code the workflow itself switches on, so it is the honest thing to assert.
 */
async function failureOf(steps: Parameters<ExecutionSession['run']>[0]): Promise<unknown> {
  return session.run(steps).then(
    () => undefined,
    (error: unknown) => error,
  );
}

function expectClaimRefusal(failure: unknown, taskId: string, arm: string): void {
  const refusal = failure as { type?: unknown; nonRetryable?: unknown; message?: unknown };

  // `EXECUTION_CLAIM_REFUSED` and never `EXECUTION_ALREADY_CLAIMED`: the attempt is held by
  // another execution, so a caller that could see it would be told exactly that. It cannot,
  // because it names A and the row says B.
  expect(refusal?.type).toBe('EXECUTION_CLAIM_REFUSED');
  expect(refusal?.nonRetryable).toBe(true);
  expect(String(refusal?.message)).toContain(taskId);
  expect(String(refusal?.message)).toContain(arm);
}

beforeAll(async () => {
  if (!databaseEnabled) return;

  process.env['DATABASE_URL'] = databaseUrl;
  artifactRoot = await mkdtemp('/tmp/opencode/gate-m-worker-');
  process.env['ARTIFACT_ROOT'] = artifactRoot;
  process.env['AGENT_RUNTIME'] = 'local-simulated';
  process.env['AGENT_STEP_DELAY_MS'] = '0';
  delete process.env['WORKER_FAULT_INJECT'];
  delete process.env['WORKER_RESOURCE_PROFILE'];
  delete process.env['LOCAL_SIMULATED_OUTCOME'];

  resetWorkerConfig();
  resetAgentRuntime();

  client = useTestDatabase().client;

  pair = await createTenancyPair(client, { seed: SEED, artifactRoot });

  // Three reservations, each arranged for a different lesson. Created before every baseline
  // snapshot, so "nothing was written" is a statement about the attacks and not about setup.
  aReservation = await reserve(pair.a, pair.a.tasks.ready, 'a-own');
  bClaimed = await reserve(pair.b, pair.b.tasks.ready, 'b-claimed');
  bUnclaimed = await reserve(pair.b, pair.b.tasks.ready, 'b-unclaimed');

  if (enabled) {
    harness = await createExecutionHarness({
      address: TEMPORAL_ADDRESS,
      namespace: TEMPORAL_NAMESPACE,
    });
    session = await harness.session();

    // The caller is a legitimate execution of tenant A: it holds the claim on its own
    // attempt, so a refusal below cannot be explained by the caller lacking authority.
    await claimAs(pair.a, aReservation, session.runId);

    // B's attempt belongs to somebody else. If the tenant conjunct is ever dropped, the
    // caller finds this row and reports `EXECUTION_ALREADY_CLAIMED` instead.
    await claimAs(pair.b, bClaimed, `execution-b-holder-${randomUUID()}`);
  }
}, 120_000);

afterAll(async () => {
  if (!databaseEnabled) return;

  try {
    await session?.stop().catch(() => undefined);
    await harness?.close();
    if (pair !== undefined) await dropAllTenants(client, [pair.a, pair.b]);
    if (artifactRoot !== undefined) await rm(artifactRoot, { recursive: true, force: true });
  } finally {
    await client?.$disconnect().catch(() => undefined);
  }
}, 120_000);

// ─── 5. Cross-tenant attempt and claim ──────────────────────────────────────

describe.skipIf(!enabled)(
  'attack 5 — an activity called across tenants refuses and writes nothing',
  () => {
    it('executeAgentActivity refuses B’s task and attempt, and creates no execution', async () => {
      const beforeA = await tenantSnapshot(client, pair.a.orgId);
      const beforeB = await tenantSnapshot(client, pair.b.orgId);

      const failure = await failureOf([
        {
          op: 'execute',
          input: {
            taskId: bClaimed.taskId,
            orgId: pair.a.orgId,
            correlationId: randomUUID(),
            workflowRunId: bClaimed.workflowRunId,
            attemptId: bClaimed.attemptId,
          },
        },
      ]);

      expectClaimRefusal(failure, bClaimed.taskId, 'does not exist for task');

      // "Zero rows" is not "no agent run": the executor would have leased a workspace, opened a
      // cgroup and written an `AgentRun`. The snapshot is of every table the tenant owns.
      expect(await tenantSnapshot(client, pair.a.orgId)).toEqual(beforeA);
      expect(await tenantSnapshot(client, pair.b.orgId)).toEqual(beforeB);
    }, 120_000);

    it('persistResultActivity refuses B’s task and attempt, and writes no record of a run', async () => {
      const beforeA = await tenantSnapshot(client, pair.a.orgId);
      const beforeB = await tenantSnapshot(client, pair.b.orgId);

      const failure = await failureOf([
        {
          op: 'persist',
          input: {
            taskId: bClaimed.taskId,
            orgId: pair.a.orgId,
            attemptId: bClaimed.attemptId,
            result: REFUSED_RESULT,
          },
        },
      ]);

      expectClaimRefusal(failure, bClaimed.taskId, 'does not exist for task');

      // The rows this activity owns: `AgentRun`, the attempt link, `Artifact`, `Evidence`,
      // `ToolInvocation` and the terminal `WorkflowRun` state. All of them are in the snapshot.
      expect(await tenantSnapshot(client, pair.a.orgId)).toEqual(beforeA);
      expect(await tenantSnapshot(client, pair.b.orgId)).toEqual(beforeB);
    }, 120_000);

    it('completeTaskActivity refuses B’s task and attempt, and leaves B’s task untouched', async () => {
      const beforeA = await tenantSnapshot(client, pair.a.orgId);
      const beforeB = await tenantSnapshot(client, pair.b.orgId);
      const taskBefore = await client.task.findUniqueOrThrow({ where: { id: bClaimed.taskId } });

      const failure = await failureOf([
        {
          op: 'complete',
          input: {
            taskId: bClaimed.taskId,
            orgId: pair.a.orgId,
            status: 'failed',
            error: { code: 'FORGED', message: 'gate-m: cross-tenant terminal write' },
            attemptId: bClaimed.attemptId,
            workflowRunId: bClaimed.workflowRunId,
          },
        },
      ]);

      /**
       * A *different* arm of the same guard, and that is the finding rather than a wrinkle:
       * `completeTaskActivity` cannot see B's attempt either, so the claim arm has nothing to
       * read and the write falls to the pre-dispatch arm — which then refuses because this
       * execution's workflow id is `probe-…`, not `task-<B's task>`. Two independent controls
       * (`requireExecutionWriteAuthority`'s lookup and the workflow-id derivation) refuse the
       * same call. With the production workflow id the same input is refused one layer later
       * by `completeTask`'s own `(id, orgId)` lookup, as `TASK_NOT_FOUND`.
       */
      expectClaimRefusal(
        failure,
        bClaimed.taskId,
        "without a claim by an execution that is not this task's own",
      );

      const taskAfter = await client.task.findUniqueOrThrow({ where: { id: bClaimed.taskId } });

      expect(taskAfter.status).toBe('ready');
      expect(canonicalJson(taskAfter)).toBe(canonicalJson(taskBefore));
      expect(await tenantSnapshot(client, pair.a.orgId)).toEqual(beforeA);
      expect(await tenantSnapshot(client, pair.b.orgId)).toEqual(beforeB);
    }, 120_000);

    it('the foreign attempt is still held by its own execution', async () => {
      // The arrangement is the argument, so it is asserted rather than assumed: if B's attempt
      // had lost its claim, the refusals above would be indistinguishable from "unclaimed".
      const held = await client.executionAttempt.findUniqueOrThrow({
        where: { id: bClaimed.attemptId },
        select: { status: true, claimedByWorkflowRunId: true },
      });

      expect(held.status).toBe('queued');
      expect(held.claimedByWorkflowRunId).not.toBeNull();
      expect(held.claimedByWorkflowRunId).not.toBe(session.runId);

      // And the caller's own claim is intact — this execution was never refused for being
      // unauthorised.
      const own = await client.executionAttempt.findUniqueOrThrow({
        where: { id: aReservation.attemptId },
        select: { claimedByWorkflowRunId: true },
      });

      expect(own.claimedByWorkflowRunId).toBe(session.runId);
    });
  },
);

// ─── 7. Forged workflow input ───────────────────────────────────────────────

describe.skipIf(!enabled)(
  'attack 7 — a forged workflow input is refused before any side effect',
  () => {
    interface RunTaskWorker {
      /** Starts `runTaskWorkflow` under the id production uses, and waits for its verdict. */
      forge(input: {
        readonly orgId: string;
        readonly taskId: string;
        readonly attemptId?: string;
      }): Promise<RunTaskWorkflowResult>;
      close(): Promise<void>;
    }

    let runTaskWorker: RunTaskWorker | undefined;

    beforeAll(async () => {
      const taskQueue = `intelligenz-gate-m-${randomUUID().slice(0, 8)}`;
      const nativeConnection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS });

      // The production workflow and the production activity registry: a probe that registered
      // copies would be testing the harness.
      const worker = await Worker.create({
        connection: nativeConnection,
        namespace: TEMPORAL_NAMESPACE,
        taskQueue,
        workflowsPath: WORKFLOW_PATH,
        activities,
      });

      const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
      const client = new Client({ connection, namespace: TEMPORAL_NAMESPACE });

      // `run()` never resolves while the worker is healthy; the rejection is captured so a dead
      // worker surfaces as a failed test rather than a hang on `result()`.
      let workerFailure: unknown;
      const running = worker.run().catch((error: unknown) => {
        workerFailure = error;
      });

      runTaskWorker = {
        async forge(input) {
          if (workerFailure !== undefined) {
            throw new Error(`gate-m worker died before the start: ${String(workerFailure)}`);
          }

          const handle = await client.workflow.start('runTaskWorkflow', {
            taskQueue,
            // The id production uses, so the pre-dispatch arm's workflow-id control sees the
            // shape it was built for rather than a test-only one.
            workflowId: `task-${input.taskId}`,
            args: [
              {
                taskId: input.taskId,
                orgId: input.orgId,
                correlationId: randomUUID(),
                ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
              },
            ],
          });

          return (await withDeadline(handle.result(), 60_000)) as RunTaskWorkflowResult;
        },
        async close() {
          worker.shutdown();
          await running.catch(() => undefined);
          await connection.close().catch(() => undefined);
          await nativeConnection.close().catch(() => undefined);
        },
      };

      // Resolve once the worker is polling: a start issued before registration would be
      // retried by the server, not refused, and the test would measure a race.
      await new Promise((resolve) => setTimeout(resolve, 250));
    }, 120_000);

    afterAll(async () => {
      await runTaskWorker?.close();
    }, 120_000);

    it('a B taskId under A’s orgId is “not found”, not executed', async () => {
      const beforeA = await tenantSnapshot(client, pair.a.orgId);
      const beforeB = await tenantSnapshot(client, pair.b.orgId);

      const result = await runTaskWorker!.forge({
        orgId: pair.a.orgId,
        taskId: pair.b.tasks.high,
      });

      // The refusal is the *not-found* branch, which is the one that writes nothing at all —
      // not a `TASK_NOT_RUNNABLE` or a claim refusal, both of which are downstream of having
      // found the row.
      expect(result.status).toBe('failed');
      expect(result.summary).toBe(
        `Task ${pair.b.tasks.high} does not exist in organisation ${pair.a.orgId}.`,
      );

      expect(await tenantSnapshot(client, pair.a.orgId)).toEqual(beforeA);
      expect(await tenantSnapshot(client, pair.b.orgId)).toEqual(beforeB);
      expect(await client.workflowRun.count({ where: { taskId: pair.b.tasks.high } })).toBe(0);
    }, 120_000);

    it('naming B’s real attempt does not make the forged task reachable', async () => {
      const beforeA = await tenantSnapshot(client, pair.a.orgId);
      const beforeB = await tenantSnapshot(client, pair.b.orgId);

      const result = await runTaskWorker!.forge({
        orgId: pair.a.orgId,
        taskId: pair.b.tasks.ready,
        attemptId: bUnclaimed.attemptId,
      });

      expect(result.status).toBe('failed');
      expect(result.summary).toBe(
        `Task ${pair.b.tasks.ready} does not exist in organisation ${pair.a.orgId}.`,
      );

      // The attempt named is genuine, `queued` and **unclaimed** — the exact shape a dropped
      // conjunct would let this execution adopt, because `claimExecution` keys on the task row
      // it found. It is still unclaimed, and no run recorded it.
      const attempt = await client.executionAttempt.findUniqueOrThrow({
        where: { id: bUnclaimed.attemptId },
        select: { status: true, claimedByWorkflowRunId: true, agentRunId: true },
      });

      expect(attempt.claimedByWorkflowRunId).toBeNull();
      expect(attempt.status).toBe('queued');
      expect(attempt.agentRunId).toBeNull();

      expect(await tenantSnapshot(client, pair.a.orgId)).toEqual(beforeA);
      expect(await tenantSnapshot(client, pair.b.orgId)).toEqual(beforeB);
    }, 120_000);

    it('A’s own taskId reaches the claim gate, so the refusal is the tenant and not the workflow', async () => {
      // The control. Without it, "the workflow refused" is compatible with the workflow being
      // broken for every input — which is how a tenancy suite ends up asserting nothing.
      //
      // A's own task, no attempt named: validation finds the row and then refuses for want of a
      // reservation (`EXECUTION_CLAIM_REFUSED`). A different code with a different message from
      // the not-found branch above, produced by the same workflow and the same activity.
      const result = await runTaskWorker!.forge({
        orgId: pair.a.orgId,
        taskId: aReservation.taskId,
      });

      expect(result.status).toBe('failed');
      expect(result.summary).toContain('EXECUTION_CLAIM_REFUSED');
      expect(result.summary).toContain(aReservation.taskId);
      expect(result.summary).not.toContain('does not exist in organisation');
    }, 120_000);
  },
);

/** A deadline for the forged start, so a wedged worker fails the test instead of the suite. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      timer.unref();
    }),
  ]);
}
