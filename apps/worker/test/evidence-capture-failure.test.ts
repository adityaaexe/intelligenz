import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AgentRuntime,
  type ExecutionRequest,
  type ExecutionResult,
  type RuntimeCapabilities,
  type RuntimeHealth,
} from '@intelligenz/agent-runtime';
import type { PrismaClient } from '@intelligenz/database';

import { persistResult } from '../src/activities/persist-result';
import { resetWorkerConfig } from '../src/config';
import { resetAgentRuntime, setAgentRuntime } from '../src/runtime';
import type { ExecuteAgentActivityResult } from '../src/shared/contracts';
import {
  createExecutionHarness,
  temporalReachable,
  type ExecutionHarness,
} from './helpers/execution-harness';
import {
  createTask,
  createTenant,
  dropTenant,
  reserveAndClaim,
  testDatabaseUrl,
  useTestDatabase,
  type TenantFixture,
} from './helpers/database';

/**
 * F-G2 — absence of evidence is a failure, not a silence.
 *
 * `takeWorkspaceSnapshot` propagates `EACCES` from `readdir`; `captureFinalEvidence` caught
 * everything and returned `null`; `attachEvidence` then returned the adapter's result
 * unchanged. Measured before the fix: one `chmod 000` on a directory inside the checkout
 * produced **no manifest, no signal, and `succeeded`**. The agent cannot forge the report,
 * but it could delete it, and "no manifest" was indistinguishable from "the agent changed
 * nothing" unless the reader knew to look for an absence.
 *
 * The invariant now: **if an initial snapshot exists for the attempt, a missing final
 * manifest is a failure of the attempt.** The status vocabulary is unchanged — the run is
 * `failed` with `error.code: EVIDENCE_MISSING` — and the failure is recorded as an
 * `attempt.evidence_failed.v1` audit event bound to the attempt.
 *
 * Three tests, and the second and third are controls that stop the first from being a test
 * of "everything fails":
 *
 *   1. an unreadable directory mid-run ⇒ not `succeeded`, a durable record, no authority;
 *   2. complete evidence ⇒ still succeeds, with an authoritative artifact;
 *   3. a runtime that leases no workspace ⇒ still succeeds, and records no evidence failure.
 */

const databaseUrl = testDatabaseUrl();
const enabled = databaseUrl !== undefined;
const temporalEnabled = enabled && (await temporalReachable());

let client: PrismaClient;
let harness: ExecutionHarness | undefined;
let workspaceRoot: string;
const tenants: TenantFixture[] = [];

/**
 * An adapter that needs a workspace, returns success, and hides one of its own directories.
 *
 * The `chmod` is the whole attack and it is available to a real agent: the checkout is the
 * one read-write mount, the run is the same UID as the worker, and `chmod 000` on a
 * directory is an ordinary file operation, not a kernel exploit.
 */
class HidingRuntime implements AgentRuntime {
  readonly id = 'hiding-workspace-runtime';
  hiddenDirectory: string | undefined;

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      shell: false,
      network: false,
      filesystem: 'write',
      browser: false,
      mcp: false,
      imageInput: false,
    };
  }

  async health(): Promise<RuntimeHealth> {
    return { status: 'ok', simulated: false, checkedAt: new Date().toISOString() };
  }

  async cancel(): Promise<void> {}

  async execute(req: ExecutionRequest): Promise<ExecutionResult> {
    if (req.workspaceRoot === undefined) {
      throw new Error('HidingRuntime requires a workspaceRoot');
    }

    const repoPath = req.allowedPaths[0] ?? join(req.workspaceRoot, 'repo');
    const hidden = join(repoPath, 'hidden');

    // A real change, then the evidence path is made unable to see it. The first part
    // matters: the run must not be failed for "nothing happened", it must be failed for
    // "what happened cannot be described".
    await mkdir(hidden, { recursive: true });
    await writeFile(join(hidden, 'secret.txt'), 'content the manifest must not miss\n');
    await chmod(hidden, 0o000);

    this.hiddenDirectory = hidden;

    return {
      status: 'succeeded',
      summary: 'wrote a file and made its directory unreadable',
      artifacts: [],
      events: [],
      usage: { usd: 0 },
      runtimeId: this.id,
      simulated: false,
    };
  }
}

async function tenant(label: string): Promise<TenantFixture> {
  const created = await createTenant(client, label);
  tenants.push(created);
  return created;
}

beforeAll(async () => {
  if (!enabled) return;

  const database = useTestDatabase();
  client = database.client;
  workspaceRoot = await mkdtemp(join(tmpdir(), 'intelligenz-evidence-failure-'));

  process.env['DATABASE_URL'] = database.url;
  process.env['WORKSPACE_ROOT'] = workspaceRoot;
  process.env['ARTIFACT_ROOT'] = join(workspaceRoot, 'artifacts');

  resetWorkerConfig();
  resetAgentRuntime();

  if (temporalEnabled) harness = await createExecutionHarness();
});

afterAll(async () => {
  if (!enabled) return;

  resetAgentRuntime();
  await harness?.close();
  for (const fixture of tenants) await dropTenant(client, fixture);
  await client.$disconnect();
});

/** Run one attempt through the real activity, inside a real execution. */
async function runAttempt(
  fixture: TenantFixture,
  label: string,
  options: { readonly finish?: boolean } = {},
): Promise<{
  readonly result: ExecuteAgentActivityResult;
  readonly attemptId: string;
  /** The task's status after the workflow's terminal write, when `finish` was asked for. */
  readonly taskStatus: string | null;
}> {
  const task = await createTask(client, fixture, {
    title: label,
    // `completeTask` admits only `queued | running | verifying`, and `queued` is what
    // `POST /run` leaves behind. A `ready` fixture would make the terminal write a no-op
    // and the assertion below would read the fixture's status, not the run's.
    status: 'queued',
  });
  const session = await (harness?.session() ?? Promise.reject(new Error('no harness')));

  try {
    const claim = await reserveAndClaim(client, fixture, task, session.runId);

    // One batch, because `attachPreviousAs` carries a value between steps **within** a
    // batch: `persist` has to receive the `ExecutionResult` that `execute` returned, and
    // that value exists only inside this execution.
    const steps = [
      {
        op: 'execute' as const,
        input: {
          taskId: task.taskId,
          orgId: fixture.orgId,
          correlationId: `evidence-failure-${label}`,
          workflowRunId: task.workflowRunId,
          attemptId: claim.attemptId,
        },
      },
      ...(options.finish === true
        ? [
            {
              op: 'persist' as const,
              input: {
                orgId: fixture.orgId,
                taskId: task.taskId,
                // N4: persistence proves the claim for itself; a persist that names no
                // attempt is refused, which is the behaviour `execution-boundary` covers.
                attemptId: claim.attemptId,
              },
              attachPreviousAs: 'result',
            },
          ]
        : []),
    ];

    const [result] = await session.run<ExecuteAgentActivityResult>(steps);

    let taskStatus: string | null = null;

    if (options.finish === true && result !== undefined) {
      // The status the workflow passes on: `run-task.ts` derives the task's terminal status
      // from `result.status` and nothing else (`outcomeOf`). Composed here rather than
      // re-implemented, so "the task did not succeed" is a row read back, not an inference
      // from the activity's return value.
      const terminal = result.status === 'succeeded' ? 'succeeded' : 'failed';

      await session.call({
        op: 'complete',
        input: {
          taskId: task.taskId,
          orgId: fixture.orgId,
          status: terminal,
          attemptId: claim.attemptId,
          workflowRunId: task.workflowRunId,
        },
      });

      taskStatus = (
        await client.task.findFirstOrThrow({
          where: { id: task.taskId, orgId: fixture.orgId },
          select: { status: true },
        })
      ).status;
    }

    return {
      result: result as ExecuteAgentActivityResult,
      attemptId: claim.attemptId,
      taskStatus,
    };
  } finally {
    await session.stop();
  }
}

describe.skipIf(!temporalEnabled)('F-G2 — a missing final manifest fails the attempt', () => {
  it('does not report success when the agent made its own tree unreadable', async () => {
    const runtime = new HidingRuntime();
    setAgentRuntime(runtime);

    const fixture = await tenant('evidence-hidden');
    let hidden: string | undefined;

    try {
      const { result, attemptId, taskStatus } = await runAttempt(
        fixture,
        'hides a directory',
        { finish: true },
      );
      hidden = runtime.hiddenDirectory;

      // ── The outcome ────────────────────────────────────────────────────────
      //
      // The adapter said "succeeded" and did everything it promised. The platform's answer
      // is still no: an attempt whose changes cannot be described has not succeeded, and
      // this is the assertion that used to be `succeeded`.
      expect(result.status).toBe('failed');
      expect(result.status).not.toBe('succeeded');
      expect(result.error?.code).toBe('EVIDENCE_MISSING');
      expect(result.error?.retryable).toBe(false);

      // Nothing was dressed up as evidence: no summary means `attachEvidence` had nothing
      // to attach, so no manifest can be persisted from this run.
      expect(result.evidence).toBeUndefined();

      // ── The durable record ────────────────────────────────────────────────
      //
      // Bound to the attempt, not to the task and not to a log line. This is what makes
      // "no manifest" a fact an operator can find instead of an absence they must suspect.
      const event = await client.auditEvent.findFirst({
        where: {
          orgId: fixture.orgId,
          eventType: 'attempt.evidence_failed.v1',
          aggregateId: attemptId,
        },
      });

      expect(event).not.toBeNull();
      expect(event?.aggregateType).toBe('ExecutionAttempt');
      expect(event?.payload).toMatchObject({
        attemptId,
        phase: 'final',
        code: 'SNAPSHOT_CAPTURE_FAILED',
      });
      // The baseline it failed to compare against is named, so the record has an anchor.
      expect((event?.payload as { initialManifestDigest: string }).initialManifestDigest).toMatch(
        /^[a-f0-9]{64}$/,
      );

      // ── The attempt row ──────────────────────────────────────────────────
      const attempt = await client.executionAttempt.findFirstOrThrow({
        where: { id: attemptId, orgId: fixture.orgId },
        select: { status: true, error: true },
      });

      expect(attempt.status).toBe('failed');
      expect(attempt.error).toMatchObject({ code: 'EVIDENCE_MISSING' });

      // ── And persistence grants nothing authority ──────────────────────────
      //
      // The run was already persisted inside the execution, which is where the authority
      // decision is made. Read it back rather than calling `persistResult` again: a second
      // call would be a different fact from "the workflow persisted this attempt".
      expect(taskStatus).toBe('failed');
      expect(
        await client.artifact.count({
          where: { orgId: fixture.orgId, authoritative: true },
        }),
      ).toBe(0);

      // The bytes are on disk and can be read back, which is what makes the count above a
      // statement about *authority* and not about a missing table.
      expect(
        await client.artifact.count({ where: { orgId: fixture.orgId, kind: 'change-manifest' } }),
      ).toBe(0);
    } finally {
      // Restore the mode so the fixture can be removed. The *capture* already happened
      // while it was 000, which is the only thing the mode was for.
      if (hidden !== undefined) await chmod(hidden, 0o700).catch(() => undefined);
    }
  }, 120_000);

  it('control: complete evidence still succeeds, and keeps its authority', async () => {
    // The same adapter without the chmod. If this did not succeed, the test above would be
    // evidence that the gate is too broad rather than that it works.
    const fixture = await tenant('evidence-complete');
    const task = await createTask(client, fixture, { title: 'leaves the tree readable' });
    const session = await (harness?.session() ?? Promise.reject(new Error('no harness')));

    let result: ExecuteAgentActivityResult;

    try {
      const claim = await reserveAndClaim(client, fixture, task, session.runId);

      // `opencode-cli` is the REAL adapter and is not registered in tests, so a workspace
      // is leased by using any id that is not `local-simulated`. This one writes one file
      // and returns success — the smallest honest run that needs a workspace.
      setAgentRuntime(new HidingRuntimeWithoutTheHide());

      result = await session.call<ExecuteAgentActivityResult>({
        op: 'execute',
        input: {
          taskId: task.taskId,
          orgId: fixture.orgId,
          correlationId: 'evidence-complete-1',
          workflowRunId: task.workflowRunId,
          attemptId: claim.attemptId,
        },
      });
    } finally {
      await session.stop();
    }

    expect(result.status).toBe('succeeded');
    expect(result.evidence).toBeDefined();
    expect(result.evidence?.authoritative).toBe(true);

    // The failure event must not exist on a successful attempt — the gate has to be a
    // measurement, not a habit.
    expect(
      await client.auditEvent.count({
        where: { orgId: fixture.orgId, eventType: 'attempt.evidence_failed.v1' },
      }),
    ).toBe(0);

    await persistResult({ orgId: fixture.orgId, taskId: task.taskId, result });

    const artifact = await client.artifact.findFirst({
      where: { orgId: fixture.orgId, kind: 'change-manifest' },
    });

    expect(artifact?.authoritative).toBe(true);
  }, 120_000);

  it('control: a runtime that leases no workspace produces no evidence and still succeeds', async () => {
    // The path the invariant must not touch: no baseline means no manifest was ever owed.
    const fixture = await tenant('evidence-no-workspace');
    const task = await createTask(client, fixture, {
      title: 'runs without a workspace',
      goal: 'Write a report. [simulate:ok]',
    });

    // The production default: `local-simulated` leases no workspace, so this is the path
    // the invariant must not touch.
    resetAgentRuntime();

    const session = await (harness?.session() ?? Promise.reject(new Error('no harness')));
    let result: ExecuteAgentActivityResult;

    try {
      const claim = await reserveAndClaim(client, fixture, task, session.runId);

      result = await session.call<ExecuteAgentActivityResult>({
        op: 'execute',
        input: {
          taskId: task.taskId,
          orgId: fixture.orgId,
          correlationId: 'evidence-no-workspace-1',
          workflowRunId: task.workflowRunId,
          attemptId: claim.attemptId,
        },
      });
    } finally {
      await session.stop();
    }

    expect(result.status).toBe('succeeded');
    expect(result.evidence).toBeUndefined();

    // No workspace was leased, so there is no evidence directory to be empty and no
    // failure to record.
    expect(
      await client.executionWorkspace.count({ where: { orgId: fixture.orgId } }),
    ).toBe(0);
    expect(
      await client.auditEvent.count({
        where: { orgId: fixture.orgId, eventType: 'attempt.evidence_failed.v1' },
      }),
    ).toBe(0);
  }, 120_000);
});

/** The same adapter, without hiding anything: one write, then a clean return. */
class HidingRuntimeWithoutTheHide implements AgentRuntime {
  readonly id = 'hiding-workspace-runtime';
  hiddenDirectory: string | undefined;

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      shell: false,
      network: false,
      filesystem: 'write',
      browser: false,
      mcp: false,
      imageInput: false,
    };
  }

  async health(): Promise<RuntimeHealth> {
    return { status: 'ok', simulated: false, checkedAt: new Date().toISOString() };
  }

  async cancel(): Promise<void> {}

  async execute(req: ExecutionRequest): Promise<ExecutionResult> {
    if (req.workspaceRoot === undefined) {
      throw new Error('this adapter requires a workspaceRoot');
    }

    const repoPath = req.allowedPaths[0] ?? join(req.workspaceRoot, 'repo');
    await writeFile(join(repoPath, 'written-by-the-run.txt'), 'visible\n');

    return {
      status: 'succeeded',
      summary: 'wrote one file',
      artifacts: [],
      events: [],
      usage: { usd: 0 },
      runtimeId: this.id,
      simulated: false,
    };
  }
}

