import { chmod, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
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
import { workspacePath } from '@intelligenz/workspace-manager';

import { executionWorkspaceIdFor } from '../src/activities/ids';
import { persistResult } from '../src/activities/persist-result';
import { getWorkerConfig, resetWorkerConfig } from '../src/config';
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


/**
 * F-G13 — a manifest that exists but stopped early is not authority, so it is a failure.
 *
 * Before this, only a *missing* manifest failed the attempt (F-G2). A bounded walk is not a
 * throw: one `truncate` to 9 GiB — sparse, a single syscall, no blocks written — made the
 * final snapshot `complete: false`, the manifest `authoritative: false`, and the task still
 * `succeeded`. Nothing consumed the flag, so the cheapest way to make evidence unusable was
 * no longer to delete it (that fails) but to bound it (that succeeded).
 *
 * The invariant is now the same one F-G2 states, in the other direction: **if a baseline
 * exists, a final manifest that is not authoritative fails the attempt too.** The code is
 * distinct — `EVIDENCE_INCOMPLETE`, not `EVIDENCE_MISSING` — because "there is no report"
 * and "there is a report that says it stopped at 8 GiB" are different facts for an operator
 * filtering on them. The manifest is still written and still attached: what was seen is
 * evidence, it just is not authority.
 */
class TruncatingRuntime implements AgentRuntime {
  readonly id = 'truncating-workspace-runtime';

  /** The control: the same adapter without the one syscall that bounds the walk. */
  constructor(private readonly truncates: boolean) {}

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
      throw new Error('TruncatingRuntime requires a workspaceRoot');
    }

    const repoPath = req.allowedPaths[0] ?? join(req.workspaceRoot, 'repo');

    // A real, describable change first, so the run is not failed for "nothing happened".
    await writeFile(join(repoPath, 'written-by-the-run.txt'), 'visible\n');

    if (this.truncates) {
      // 9 GiB, one truncate, no blocks written: past `DEFAULT_MAX_TOTAL_BYTES` (8 GiB), so
      // the walk stops with `max-total-bytes` instead of hashing it. `writeFile` first
      // because `truncate` refuses a path that does not exist.
      //
      // Named so it sorts *after* the file above: the walk is ordered by path bytes, and a
      // hog that sorted first would stop the walk before a single entry was counted, which
      // would make the "counts reached" assertion vacuous.
      const hog = join(repoPath, 'zzz-sparse-hog.bin');
      await writeFile(hog, '');
      await truncate(hog, 9 * 1024 * 1024 * 1024);
    }

    return {
      status: 'succeeded',
      summary: this.truncates ? 'wrote a file and bounded the walk' : 'wrote one file',
      artifacts: [],
      events: [],
      usage: { usd: 0 },
      runtimeId: this.id,
      simulated: false,
    };
  }
}

describe.skipIf(!temporalEnabled)('F-G13 — an incomplete final manifest fails the attempt', () => {
  it('does not report success, and records the stop reason and the counts reached', async () => {
    setAgentRuntime(new TruncatingRuntime(true));

    const fixture = await tenant('evidence-incomplete');
    const { result, attemptId, taskStatus } = await runAttempt(fixture, 'bounds its own walk', {
      finish: true,
    });

    // ── The outcome ────────────────────────────────────────────────────────
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('EVIDENCE_INCOMPLETE');
    // The distinctness is not cosmetic: an operator looking for runs with *no* report must
    // not also get runs whose report says it stopped early.
    expect(result.error?.code).not.toBe('EVIDENCE_MISSING');
    expect(result.error?.retryable).toBe(false);

    // ── The manifest exists, and is not authority ──────────────────────────
    expect(result.evidence).toBeDefined();
    expect(result.evidence?.authoritative).toBe(false);
    expect(result.evidence?.complete).toBe(false);
    expect(result.evidence?.stopReason).toBe('final-incomplete');

    // ── The durable record carries *why* and *how far* ────────────────────
    const event = await client.auditEvent.findFirst({
      where: {
        orgId: fixture.orgId,
        eventType: 'attempt.evidence_failed.v1',
        aggregateId: attemptId,
      },
    });

    expect(event).not.toBeNull();
    expect(event?.payload).toMatchObject({
      attemptId,
      phase: 'final',
      code: 'SNAPSHOT_INCOMPLETE',
      // The manifest's own reason, the walk's reason, and the counts the bounded walk
      // actually reached. Without these the record says "incomplete" and nothing else.
      stopReason: 'final-incomplete',
      snapshotStopReason: 'max-total-bytes',
    });

    const payload = event?.payload as {
      readonly entryCount: number;
      readonly totalBytes: number;
      readonly changeCount: number;
    };

    expect(payload.entryCount).toBeGreaterThan(0);
    // Stopped at the ceiling, not at zero: the number is the evidence that the bound is the
    // byte budget and not an empty tree.
    expect(payload.totalBytes).toBeGreaterThan(0);
    expect(payload.changeCount).toBeGreaterThan(0);

    // ── And persistence grants it no authority ────────────────────────────
    expect(taskStatus).toBe('failed');
    expect(
      await client.artifact.count({ where: { orgId: fixture.orgId, authoritative: true } }),
    ).toBe(0);
    // The row exists — this is a claim about authority, not about a missing row.
    expect(
      await client.artifact.count({ where: { orgId: fixture.orgId, kind: 'change-manifest' } }),
    ).toBe(1);
  }, 120_000);

  it('control: the same adapter without the bound still succeeds', async () => {
    // If this failed, the test above would be evidence that the gate fails every run
    // rather than that it catches a bounded one.
    setAgentRuntime(new TruncatingRuntime(false));

    const fixture = await tenant('evidence-complete-walk');
    const { result, attemptId, taskStatus } = await runAttempt(fixture, 'leaves the walk alone', {
      finish: true,
    });

    expect(result.status).toBe('succeeded');
    expect(result.evidence?.authoritative).toBe(true);
    expect(result.evidence?.complete).toBe(true);
    expect(taskStatus).toBe('succeeded');

    expect(
      await client.auditEvent.count({
        where: {
          orgId: fixture.orgId,
          eventType: 'attempt.evidence_failed.v1',
          aggregateId: attemptId,
        },
      }),
    ).toBe(0);
  }, 120_000);
});

/**
 * F-G19 — a baseline that could not be taken is an evidence failure, not a warning.
 *
 * The F-G2 invariant was scoped "if a baseline exists", and the `else` branch was a log
 * line: an attempt whose baseline walk threw had no manifest and no failure, so it could
 * report success with nothing to review.
 *
 * The arrangement is the agent-reachable shape. A Temporal retry of the same attempt reuses
 * the same workspace (the id is derived from `(workflowRunId, attemptNumber)`), so a
 * directory the *first* invocation's agent left at mode `000` is in the tree before the
 * second invocation's baseline; the baseline's `readdir` then fails with `EACCES` and the
 * walk throws. Nothing here is a privilege the agent lacks — `chmod` is an ordinary file
 * operation, and the checkout is the one read-write mount. The same shape appears when the
 * clone source already carries such a directory.
 */
describe.skipIf(!temporalEnabled)('F-G19 — a failed baseline fails the attempt', () => {
  it('does not report success when the baseline could not be taken, and records it', async () => {
    setAgentRuntime(new HidingRuntimeWithoutTheHide());

    const fixture = await tenant('evidence-baseline-failed');
    const task = await createTask(client, fixture, { title: 'has no baseline', status: 'queued' });

    // The exact lease the executor will use, so the arrangement is the one it meets.
    const workspaceId = executionWorkspaceIdFor(task.workflowRunId, 1);
    const rootPath = workspacePath(getWorkerConfig().workspace.root, {
      orgId: fixture.orgId,
      taskId: task.taskId,
      workspaceId,
    });

    const hidden = join(rootPath, 'repo', 'left-unreadable');

    // A directory the baseline cannot enumerate. Created before the lease, because that is
    // when a previous attempt would have left it: the baseline precedes the agent, so an
    // unreadable tree at baseline time is always pre-existing state.
    await mkdir(hidden, { recursive: true });
    await chmod(hidden, 0o000);

    const session = await (harness?.session() ?? Promise.reject(new Error('no harness')));
    let result: ExecuteAgentActivityResult;
    let attemptId: string;

    try {
      const claim = await reserveAndClaim(client, fixture, task, session.runId);
      attemptId = claim.attemptId;

      result = await session.call<ExecuteAgentActivityResult>({
        op: 'execute',
        input: {
          taskId: task.taskId,
          orgId: fixture.orgId,
          correlationId: 'evidence-baseline-failed-1',
          workflowRunId: task.workflowRunId,
          attemptId: claim.attemptId,
        },
      });
    } finally {
      await session.stop();
      // Remove the mode before anything tries to clean the tree up.
      await chmod(hidden, 0o700).catch(() => undefined);
    }

    // ── The adapter said it succeeded; the platform's answer is no ─────────
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('EVIDENCE_BASELINE_FAILED');
    expect(result.error?.code).not.toBe('EVIDENCE_MISSING');
    expect(result.error?.retryable).toBe(false);
    // No summary: there is nothing to attach, and an empty one would be a claim.
    expect(result.evidence).toBeUndefined();

    // ── The record names the phase that failed ─────────────────────────────
    const event = await client.auditEvent.findFirst({
      where: {
        orgId: fixture.orgId,
        eventType: 'attempt.evidence_failed.v1',
        aggregateId: attemptId,
      },
    });

    expect(event).not.toBeNull();
    expect(event?.payload).toMatchObject({
      attemptId,
      phase: 'initial',
      code: 'BASELINE_CAPTURE_FAILED',
      // There is no tree to name, so the anchor is explicitly absent rather than invented.
      initialManifestDigest: null,
    });

    const attempt = await client.executionAttempt.findFirstOrThrow({
      where: { id: attemptId, orgId: fixture.orgId },
      select: { status: true, error: true },
    });

    expect(attempt.status).toBe('failed');
    expect(attempt.error).toMatchObject({ code: 'EVIDENCE_BASELINE_FAILED' });

    expect(
      await client.artifact.count({ where: { orgId: fixture.orgId, authoritative: true } }),
    ).toBe(0);
  }, 120_000);
});

/**
 * F-G18 — the terminal write cannot contradict the attempt it names.
 *
 * Measured before the fix: an attempt recorded `failed` with `EVIDENCE_MISSING`, then
 * `complete` with `succeeded`, was **accepted** and the task became `succeeded`. The only
 * thing preventing that in production was the workflow deriving the status from
 * `result.status` faithfully — a guard in one caller, not an invariant. The task row is
 * what an operator reads.
 *
 * The arrangement is the F-G2 run without its terminal write, so the task is still
 * non-terminal when the contradiction is attempted: a `failed` task would make the write a
 * no-op for a reason unrelated to this defect, and the test would pass blind.
 */
describe.skipIf(!temporalEnabled)('F-G18 — `succeeded` cannot be recorded for a failed attempt', () => {
  it('refuses the write and leaves the task where the run left it', async () => {
    const runtime = new HidingRuntime();
    setAgentRuntime(runtime);

    const fixture = await tenant('completion-contradiction');
    const task = await createTask(client, fixture, {
      title: 'fails, then is called a success',
      status: 'queued',
    });
    const session = await (harness?.session() ?? Promise.reject(new Error('no harness')));
    let hidden: string | undefined;
    let attemptId: string;

    try {
      const claim = await reserveAndClaim(client, fixture, task, session.runId);
      attemptId = claim.attemptId;

      // Execute, then ask the terminal write to say `succeeded` — in one execution, because
      // that is where the hole was: the same caller that just recorded the failure.
      await expect(
        session.run([
          {
            op: 'execute',
            input: {
              taskId: task.taskId,
              orgId: fixture.orgId,
              correlationId: 'evidence-completion-contradiction-1',
              workflowRunId: task.workflowRunId,
              attemptId: claim.attemptId,
            },
          },
          {
            op: 'complete',
            input: {
              taskId: task.taskId,
              orgId: fixture.orgId,
              status: 'succeeded',
              attemptId: claim.attemptId,
              workflowRunId: task.workflowRunId,
            },
          },
        ]),
      ).rejects.toMatchObject({
        type: 'COMPLETION_CONTRADICTS_ATTEMPT',
        nonRetryable: true,
      });

      hidden = runtime.hiddenDirectory;
    } finally {
      await session.stop();
      if (hidden !== undefined) await chmod(hidden, 0o700).catch(() => undefined);
    }

    // The attempt was failed for the reason F-G2 gives…
    const attempt = await client.executionAttempt.findFirstOrThrow({
      where: { id: attemptId, orgId: fixture.orgId },
      select: { status: true, error: true },
    });

    expect(attempt.status).toBe('failed');
    expect(attempt.error).toMatchObject({ code: 'EVIDENCE_MISSING' });

    // …and the task did not outlive it as a success.
    const after = await client.task.findFirstOrThrow({
      where: { id: task.taskId, orgId: fixture.orgId },
      select: { status: true },
    });

    expect(after.status).not.toBe('succeeded');
    // Still non-terminal: the refusal happened before `completeTask`'s status predicate
    // could turn the write into a silent no-op, so this is the attempt guard and not the
    // "already terminal" guard doing the work.
    expect(after.status).toBe('queued');

    const run = await client.workflowRun.findUniqueOrThrow({
      where: { id: task.workflowRunId },
      select: { status: true },
    });

    expect(run.status).not.toBe('succeeded');
  }, 120_000);
});

/**
 * F-G14 — a metadata anomaly reaches a durable record, not just the digest.
 *
 * The anomaly was already inside the canonical body, so it changed the digest — but a
 * reviewer reads an artifact summary: `authoritative: true, changeCount: 0`. An
 * authoritative manifest with a symlinked hooks directory was therefore indistinguishable
 * from a clean tree, and *supplying* the agent with a way to look clean is the defect.
 *
 * The arrangement is exactly that manifest: `rm -rf .git/hooks && ln -s /etc .git/hooks`.
 * The hooks directory is metadata, excluded from content, so `changeCount` is 0 and the
 * manifest is authoritative — and the swap must still be findable. It is, as an
 * `attempt.evidence_anomaly.v1` event naming both endpoints, written whether or not the
 * manifest has authority.
 *
 * The anomaly deliberately does **not** downgrade `authoritative`: that would hand the
 * agent a switch that turns evidence off, which is the shape of the defect the gate
 * removes. It is recorded instead.
 */
class GitAnomalyRuntime implements AgentRuntime {
  readonly id = 'git-anomaly-runtime';

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
      throw new Error('GitAnomalyRuntime requires a workspaceRoot');
    }

    const repoPath = req.allowedPaths[0] ?? join(req.workspaceRoot, 'repo');

    await mkdir(join(repoPath, '.git', 'hooks'), { recursive: true });
    await rm(join(repoPath, '.git', 'hooks'), { recursive: true, force: true });
    await symlink('/etc', join(repoPath, '.git', 'hooks'));

    return {
      status: 'succeeded',
      summary: 'pointed the hooks directory outside the workspace',
      artifacts: [],
      events: [],
      usage: { usd: 0 },
      runtimeId: this.id,
      simulated: false,
    };
  }
}

describe.skipIf(!temporalEnabled)('F-G14 — a metadata anomaly is recorded durably', () => {
  it('writes the anomaly even when the manifest is authoritative and nothing changed', async () => {
    setAgentRuntime(new GitAnomalyRuntime());

    const fixture = await tenant('evidence-anomaly');
    const task = await createTask(client, fixture, {
      title: 'swaps its hooks directory',
      status: 'queued',
    });
    const session = await (harness?.session() ?? Promise.reject(new Error('no harness')));
    let result: ExecuteAgentActivityResult;
    let attemptId: string;

    try {
      const claim = await reserveAndClaim(client, fixture, task, session.runId);
      attemptId = claim.attemptId;

      result = await session.call<ExecuteAgentActivityResult>({
        op: 'execute',
        input: {
          taskId: task.taskId,
          orgId: fixture.orgId,
          correlationId: 'evidence-anomaly-1',
          workflowRunId: task.workflowRunId,
          attemptId: claim.attemptId,
        },
      });
    } finally {
      await session.stop();
    }

    // The manifest itself is authority and reports no content change — the exact pair that
    // used to hide the anomaly completely.
    expect(result.status).toBe('succeeded');
    expect(result.evidence?.authoritative).toBe(true);
    expect(result.evidence?.changeCount).toBe(0);
    expect(result.evidence?.gitAnomalies).toContain('hooks-directory-link:/etc');

    // The durable record. Bound to the attempt, written by the worker, and naming the
    // baseline list as well as the final one so an anomaly that *disappeared* is visible.
    const event = await client.auditEvent.findFirst({
      where: {
        orgId: fixture.orgId,
        eventType: 'attempt.evidence_anomaly.v1',
        aggregateId: attemptId,
      },
    });

    expect(event).not.toBeNull();
    expect(event?.aggregateType).toBe('ExecutionAttempt');
    expect(event?.payload).toMatchObject({ attemptId });
    expect((event?.payload as { finalAnomalies: string[] }).finalAnomalies).toContain(
      'hooks-directory-link:/etc',
    );
  }, 120_000);

  it('records a nested `.git` — now that it is walked — in the same durable record', async () => {
    // F-G11 made a nested `.git` content, so its presence is no longer invisible. F-G14 is
    // the other half: "this workspace contains a second repository" must be findable
    // without parsing a digest, because a nested repository is a place an agent can write.
    setAgentRuntime(new NestedGitRuntime());

    const fixture = await tenant('evidence-nested-git');
    const task = await createTask(client, fixture, {
      title: 'writes inside a nested repository',
      status: 'queued',
    });
    const session = await (harness?.session() ?? Promise.reject(new Error('no harness')));
    let result: ExecuteAgentActivityResult;
    let attemptId: string;

    try {
      const claim = await reserveAndClaim(client, fixture, task, session.runId);
      attemptId = claim.attemptId;

      result = await session.call<ExecuteAgentActivityResult>({
        op: 'execute',
        input: {
          taskId: task.taskId,
          orgId: fixture.orgId,
          correlationId: 'evidence-nested-git-1',
          workflowRunId: task.workflowRunId,
          attemptId: claim.attemptId,
        },
      });
    } finally {
      await session.stop();
    }

    // The write is a content change now, which is what F-G11 fixed…
    expect(result.status).toBe('succeeded');
    expect(result.evidence?.changeCount).toBeGreaterThan(0);
    // …and the nested repository is named as an anomaly too.
    expect(result.evidence?.gitAnomalies).toContain('nested-git:sub/.git');

    const event = await client.auditEvent.findFirst({
      where: {
        orgId: fixture.orgId,
        eventType: 'attempt.evidence_anomaly.v1',
        aggregateId: attemptId,
      },
    });

    expect(event).not.toBeNull();
    expect((event?.payload as { finalAnomalies: string[] }).finalAnomalies).toContain(
      'nested-git:sub/.git',
    );
  }, 120_000);

  it('control: a clean run writes no anomaly record', async () => {
    setAgentRuntime(new HidingRuntimeWithoutTheHide());

    const fixture = await tenant('evidence-no-anomaly');
    const task = await createTask(client, fixture, {
      title: 'leaves .git alone',
      status: 'queued',
    });
    const session = await (harness?.session() ?? Promise.reject(new Error('no harness')));

    try {
      const claim = await reserveAndClaim(client, fixture, task, session.runId);

      await session.call<ExecuteAgentActivityResult>({
        op: 'execute',
        input: {
          taskId: task.taskId,
          orgId: fixture.orgId,
          correlationId: 'evidence-no-anomaly-1',
          workflowRunId: task.workflowRunId,
          attemptId: claim.attemptId,
        },
      });
    } finally {
      await session.stop();
    }

    // If this failed, the record above would be evidence that every run writes one, not
    // that the anomaly is recorded.
    expect(
      await client.auditEvent.count({
        where: { orgId: fixture.orgId, eventType: 'attempt.evidence_anomaly.v1' },
      }),
    ).toBe(0);
  }, 120_000);
});

/** An adapter that writes inside a nested repository: content now that F-G11 walks it. */
class NestedGitRuntime implements AgentRuntime {
  readonly id = 'nested-git-runtime';

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
      throw new Error('NestedGitRuntime requires a workspaceRoot');
    }

    const repoPath = req.allowedPaths[0] ?? join(req.workspaceRoot, 'repo');
    await mkdir(join(repoPath, 'sub', '.git'), { recursive: true });
    await writeFile(join(repoPath, 'sub', '.git', 'payload.bin'), 'nested\n');

    return {
      status: 'succeeded',
      summary: 'wrote inside a nested repository',
      artifacts: [],
      events: [],
      usage: { usd: 0 },
      runtimeId: this.id,
      simulated: false,
    };
  }
}
