import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkflowNotFoundError } from '@temporalio/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@intelligenz/database';
import { workspacePath, type WorkspaceState } from '@intelligenz/workspace-manager';

import {
  classifyProbeError,
  runReaperPass,
  type ReaperDeps,
  type ReaperResult,
  type WorkflowLiveness,
} from '../src/reaper';
import { executionAttemptIdFor, executionWorkspaceIdFor } from '../src/activities/ids';
import { setWorkerLogger } from '../src/log';
import type { WorkerLogger } from '../src/logger';
import {
  createTask,
  createTenant,
  dropTenant,
  testDatabaseUrl,
  useTestDatabase,
  type TaskFixture,
  type TenantFixture,
} from './helpers/database';

/**
 * The reaper, measured on the filesystem and in the row.
 *
 * A reaper is the one component that deletes a user's work, so every test here is either
 * a proof that it acted for the right reason or a **negative control**: an active lease,
 * a live workflow, an unreachable Temporal, a second tenant, an unproven path. Those are
 * the cases where the correct behaviour is to do nothing, and doing nothing is the
 * property that makes the positive cases acceptable.
 *
 * The suite runs against a real Postgres (`TEST_DATABASE_URL`) and disposable temp roots:
 * every path assertion is inside a `mkdtemp` directory, and the reaper's `workspaceRoot`
 * is that directory. Nothing outside it can be reached by a test, because `reclaimWorkspace`
 * re-derives the path from ids and refuses a path it cannot prove.
 *
 * ## Why assertions are per-workspace, not `scanned === 1`
 *
 * `runReaperPass` scans every expired lease in the database by design — a reaper that
 * only saw its own worker's rows would not be a reaper. Other suites in this package run
 * concurrently against the same test database, so a global count is not a stable
 * assertion. What is stable is the row and the directory this test owns.
 */

const databaseUrl = testDatabaseUrl();
const enabled = databaseUrl !== undefined;

/** Mirrors `safeSegment`; only used to avoid deriving a path from an unsafe id. */
const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

/** Two intervals; a lease must be older than this to be a candidate. */
const INTERVAL_MS = 1_000;

const silentLogger: WorkerLogger = {
  child: () => silentLogger,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

let client: PrismaClient;
let workspaceRoot: string;
let artifactRoot: string;
let scratchRoot: string;
const tenants: TenantFixture[] = [];

interface Seeded {
  readonly tenant: TenantFixture;
  readonly task: TaskFixture;
  readonly workspaceId: string;
  readonly rootPath: string;
  /** The four-level path the workspace manager derives. */
  readonly derivedPath: string;
}

interface SeedOptions {
  readonly label: string;
  /** Overrides `executionWorkspaceIdFor`; used to inject an id that is not a segment. */
  readonly workspaceId?: string;
  /** Overrides the row's `rootPath`. Never used as the deletion target. */
  readonly rootPath?: string;
  readonly state?: WorkspaceState;
  /** Milliseconds from *now*; negative is expired, positive is a live lease. */
  readonly leaseOffsetMs?: number | null;
  readonly cleanupAttempts?: number;
  /** `null` creates no attempt row. */
  readonly attemptStatus?: 'running' | 'failed' | null;
}

async function tenantFor(label: string): Promise<TenantFixture> {
  const created = await createTenant(client, label);
  tenants.push(created);
  return created;
}

async function seed(options: SeedOptions): Promise<Seeded> {
  const tenant = await tenantFor(options.label);
  const task = await createTask(client, tenant, { title: options.label });

  const workspaceId = options.workspaceId ?? executionWorkspaceIdFor(task.workflowRunId, 1);
  const derivedPath = SEGMENT.test(workspaceId)
    ? workspacePath(workspaceRoot, {
        orgId: tenant.orgId,
        taskId: task.taskId,
        workspaceId,
      })
    : join(workspaceRoot, 'no-derived-path');

  const leaseOffsetMs = options.leaseOffsetMs === undefined ? -60_000 : options.leaseOffsetMs;

  await client.executionWorkspace.create({
    data: {
      id: workspaceId,
      orgId: tenant.orgId,
      taskId: task.taskId,
      rootPath: options.rootPath ?? derivedPath,
      sourceKind: 'empty',
      state: options.state ?? 'executing',
      ...(leaseOffsetMs === null ? {} : { leaseExpiresAt: new Date(Date.now() + leaseOffsetMs) }),
      leaseOwner: 'test-worker:reaper:1',
      cleanupAttempts: options.cleanupAttempts ?? 0,
    },
  });

  if (options.attemptStatus !== null) {
    await client.executionAttempt.create({
      data: {
        id: executionAttemptIdFor(task.workflowRunId, 1),
        orgId: tenant.orgId,
        taskId: task.taskId,
        workflowRunId: task.workflowRunId,
        attemptNumber: 1,
        runtimeId: 'local-simulated',
        status: options.attemptStatus ?? 'running',
        startedAt: new Date(Date.now() - 60_000),
      },
    });
  }

  return { tenant, task, workspaceId, rootPath: options.rootPath ?? derivedPath, derivedPath };
}

function deps(overrides: Partial<ReaperDeps> & { liveness?: WorkflowLiveness } = {}): ReaperDeps {
  const { liveness = 'absent', ...rest } = overrides;

  return {
    prisma: client,
    probe: {
      status: async () => liveness,
      // The claim-release pass asks about one execution by run id. In these tests every
      // workspace candidate is owned by a `running` attempt, so no claim is ever a
      // candidate; reporting the same answer keeps the fake honest rather than clever.
      execution: async () => liveness,
    },
    workspaceRoot,
    // A cgroup root that does not exist: `listProcesses` treats ENOENT as "no members".
    // The reaper must never be pointed at the host's real cgroup tree from a test.
    cgroupRoot: join(scratchRoot, 'cgroups'),
    artifactRoot,
    intervalMs: INTERVAL_MS,
    report: () => undefined,
    batchSize: 200,
    ...rest,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** The action this test caused, or `undefined` when the reaper (correctly) skipped it. */
function actionFor(result: ReaperResult, workspaceId: string) {
  return result.actions.find((action) => action.workspaceId === workspaceId);
}

async function writeWorkspaceTree(root: string, files: Record<string, string> = {}): Promise<void> {
  const entries = Object.entries(files);

  if (entries.length === 0) {
    await mkdir(join(root, 'repo'), { recursive: true });
    await writeFile(join(root, 'repo', 'sum.js'), 'export const sum = (a, b) => a + b;\n');

    return;
  }

  for (const [relative, content] of entries) {
    const path = join(root, relative);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content);
  }
}

beforeAll(async () => {
  if (!enabled) return;

  setWorkerLogger(silentLogger);

  const database = useTestDatabase();
  client = database.client;

  workspaceRoot = await mkdtemp(join(tmpdir(), 'intelligenz-reaper-workspaces-'));
  artifactRoot = await mkdtemp(join(tmpdir(), 'intelligenz-reaper-artifacts-'));
  scratchRoot = await mkdtemp(join(tmpdir(), 'intelligenz-reaper-scratch-'));

  process.env['DATABASE_URL'] = database.url;
  process.env['WORKSPACE_ROOT'] = workspaceRoot;
});

afterAll(async () => {
  setWorkerLogger(undefined);

  if (!enabled) return;

  for (const fixture of tenants) await dropTenant(client, fixture);
  await client.$disconnect();

  await Promise.all(
    [workspaceRoot, artifactRoot, scratchRoot].map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});


/**
 * `classifyProbeError` — the classifier the release path rests on. Re-review N2 / N6.
 *
 * The five F4 tests inject a fake probe, so the classification the shipped probe performs
 * had **no** coverage — and that is exactly how the failure survived: `describe()` does not
 * surface gRPC `NOT_FOUND`, it converts it into `WorkflowNotFoundError`, which carries
 * `workflowId`/`runId` and neither `code` nor a coded `cause`. The old classifier looked
 * only at `code`, so a genuinely missing execution was reported `unknown` and the `absent`
 * arm was dead. Release therefore only ever worked for terminal runs; a run deleted or aged
 * out of retention stranded its claim for ever.
 *
 * These are pure: no server, no database. The real error class from the SDK is used, not a
 * shape-alike, because the shape-alike is what would have hidden the defect.
 */
describe('classifyProbeError (pure)', () => {
  it('reads a deleted or aged-out execution as absent — the SDK error, not a code', () => {
    // The exact constructor `WorkflowClient.rethrowGrpcError` uses for a NOT_FOUND:
    // `new WorkflowNotFoundError(err.details ?? 'Workflow not found', workflowId, runId)`.
    const error = new WorkflowNotFoundError('workflow not found', 'task-1', 'run-1');

    expect(Object.prototype.hasOwnProperty.call(error, 'code')).toBe(false);
    expect(error.cause).toBeUndefined();
    expect(classifyProbeError(error)).toBe('absent');
  });

  it('reads a bare gRPC NOT_FOUND as absent as well, for a caller that keeps the status', () => {
    expect(classifyProbeError(Object.assign(new Error('not found'), { code: 5 }))).toBe('absent');
    // Wrapped, which is how a `ServiceError` carries it.
    expect(classifyProbeError(new Error('rpc failed', { cause: { code: 5 } }))).toBe('absent');
  });

  it('keeps every other failure at unknown, so the pass skips instead of guessing', () => {
    expect(classifyProbeError(new Error('connection refused'))).toBe('unknown');
    expect(classifyProbeError(Object.assign(new Error('deadline'), { code: 4 }))).toBe('unknown');
    // gRPC 3 is INVALID_ARGUMENT — a malformed run id, which is a wrong claim, not an
    // absent execution. This is the case the re-review observed and it must stay unknown.
    expect(classifyProbeError(Object.assign(new Error('Invalid RunId.'), { code: 3 }))).toBe(
      'unknown',
    );
    expect(classifyProbeError(undefined)).toBe('unknown');
    expect(classifyProbeError('not an error')).toBe('unknown');
  });

  it('recognises the marker the SDK writes, so a second copy of the library still works', () => {
    // `SymbolBasedInstanceOfError('WorkflowNotFoundError')` writes this symbol on the
    // prototype. A copy of the SDK in another realm shares the symbol but not the class.
    const marker = Symbol.for('__temporal_isWorkflowNotFoundError');
    const foreign = Object.assign(new Error('workflow not found'), { [marker]: true });

    expect(classifyProbeError(foreign)).toBe('absent');
  });
});

describe.skipIf(!enabled)('reaper', () => {
  it('reaps an abandoned attempt: attempt failed/crashed, workspace cleaned, bytes gone', async () => {
    const seeded = await seed({ label: 'reaper-abandoned' });
    await writeWorkspaceTree(seeded.derivedPath);

    const result = await runReaperPass(deps());
    const action = actionFor(result, seeded.workspaceId);

    // 1. The evidence: an expired lease and no running workflow.
    expect(action?.outcome).toBe('reaped');
    expect(action?.reason).toContain('no workflow is running');

    // 2. The attempt is closed as crashed, not as a failure the agent caused.
    const attempt = await client.executionAttempt.findFirstOrThrow({
      where: { orgId: seeded.tenant.orgId, taskId: seeded.task.taskId },
    });

    expect(attempt.status).toBe('failed');
    expect(attempt.terminationReason).toBe('crashed');
    expect(attempt.cleanupState).toBe('pending');
    expect(attempt.finishedAt).not.toBeNull();
    expect((attempt.error as { code?: string } | null)?.code).toBe('ATTEMPT_ABANDONED');

    // 3. The workspace went cleanup_pending → cleaned and the directory is gone.
    const row = await client.executionWorkspace.findUniqueOrThrow({
      where: { id: seeded.workspaceId },
    });

    expect(row.state).toBe('cleaned');
    expect(row.cleanedAt).not.toBeNull();
    expect(row.cleanupAttempts).toBe(1);
    expect(row.leaseExpiresAt).toBeNull();
    expect(row.leaseOwner).toBeNull();
    expect(await exists(seeded.derivedPath)).toBe(false);

    // 4. The reaping is auditable, and the audit says what happened.
    const audit = await client.auditEvent.findFirst({
      where: { orgId: seeded.tenant.orgId, action: 'workspace.reaped' },
    });

    expect(audit?.eventType).toBe('workspace.reaped.v1');
    expect((audit?.payload as { cleanupState?: string } | null)?.cleanupState).toBe('done');
  }, 30_000);

  it('reclaims a workspace a crashed worker already queued as cleanup_pending', async () => {
    // The row below is what a worker leaves behind if it dies between recording
    // `cleanup_pending` and removing the directory. The state must be accepted, not
    // re-asserted: `cleanup_pending → cleanup_pending` is deliberately not an edge.
    const seeded = await seed({ label: 'reaper-queued', state: 'cleanup_pending' });
    await writeWorkspaceTree(seeded.derivedPath);

    const result = await runReaperPass(deps());
    const action = actionFor(result, seeded.workspaceId);

    expect(action?.outcome).toBe('reaped');

    const row = await client.executionWorkspace.findUniqueOrThrow({
      where: { id: seeded.workspaceId },
    });

    expect(row.state).toBe('cleaned');
    expect(row.cleanupAttempts).toBe(1);
    expect(await exists(seeded.derivedPath)).toBe(false);
  }, 30_000);

  describe('negative controls: the reaper does not delete', () => {
    it('leaves a workspace alone while its workflow is still running', async () => {
      const seeded = await seed({ label: 'reaper-live' });
      await writeWorkspaceTree(seeded.derivedPath);

      const result = await runReaperPass(deps({ liveness: 'active' }));
      const action = actionFor(result, seeded.workspaceId);

      expect(action?.outcome).toBe('skipped_live');
      expect(await exists(seeded.derivedPath)).toBe(true);

      const row = await client.executionWorkspace.findUniqueOrThrow({
        where: { id: seeded.workspaceId },
      });

      // The lease is extended, not reaped: a paused worker resumes on a warm workspace.
      expect(row.state).toBe('executing');
      expect(row.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
      expect(row.cleanupAttempts).toBe(0);

      const attempt = await client.executionAttempt.findFirstOrThrow({
        where: { orgId: seeded.tenant.orgId, taskId: seeded.task.taskId },
      });

      expect(attempt.status).toBe('running');
      expect(attempt.terminationReason).toBeNull();
    }, 30_000);

    it('leaves a workspace alone when its lease is still current', async () => {
      // A fresh lease never reaches the loop: the candidate query requires
      // `leaseExpiresAt < now - 2×interval`. That SQL predicate *is* the control.
      const seeded = await seed({ label: 'reaper-fresh', leaseOffsetMs: 60_000 });
      await writeWorkspaceTree(seeded.derivedPath);

      const result = await runReaperPass(deps());

      expect(actionFor(result, seeded.workspaceId)).toBeUndefined();
      expect(await exists(seeded.derivedPath)).toBe(true);

      const row = await client.executionWorkspace.findUniqueOrThrow({
        where: { id: seeded.workspaceId },
      });

      expect(row.state).toBe('executing');
      expect(row.cleanupAttempts).toBe(0);
    }, 30_000);

    it('refuses to reap when Temporal does not answer', async () => {
      const seeded = await seed({ label: 'reaper-unknown' });
      await writeWorkspaceTree(seeded.derivedPath);

      const result = await runReaperPass(deps({ liveness: 'unknown' }));
      const action = actionFor(result, seeded.workspaceId);

      expect(action?.outcome).toBe('skipped_unknown');
      expect(await exists(seeded.derivedPath)).toBe(true);

      const row = await client.executionWorkspace.findUniqueOrThrow({
        where: { id: seeded.workspaceId },
      });

      expect(row.state).toBe('executing');
      expect(row.cleanupAttempts).toBe(0);
    }, 30_000);

    it('never touches a sibling workspace under another orgId', async () => {
      const reaped = await seed({ label: 'reaper-org-a' });
      await writeWorkspaceTree(reaped.derivedPath);

      const sibling = await seed({ label: 'reaper-org-b', leaseOffsetMs: 60_000 });
      await writeWorkspaceTree(sibling.derivedPath);
      await writeFile(join(sibling.derivedPath, 'repo', 'do-not-delete.txt'), 'sibling\n');

      const result = await runReaperPass(deps());

      expect(actionFor(result, reaped.workspaceId)?.outcome).toBe('reaped');
      expect(actionFor(result, sibling.workspaceId)).toBeUndefined();

      // The sibling's row and bytes are intact, and it is under a different tenant.
      expect(await exists(join(sibling.derivedPath, 'repo', 'do-not-delete.txt'))).toBe(true);

      const siblingRow = await client.executionWorkspace.findUniqueOrThrow({
        where: { id: sibling.workspaceId },
      });

      expect(siblingRow.orgId).toBe(sibling.tenant.orgId);
      expect(siblingRow.state).toBe('executing');
      expect(siblingRow.cleanupAttempts).toBe(0);
    }, 30_000);
  });

  describe('containment: an unprovable path is quarantined, never deleted', () => {
    it('quarantines a workspace id that is not a single path segment', async () => {
      // The id comes from a database row, so it is attacker-writable in principle.
      // `..` must be refused by `safeSegment` before any path is touched.
      const victim = join(scratchRoot, 'dotdot-victim');
      await mkdir(victim, { recursive: true });
      await writeFile(join(victim, 'keep.txt'), 'must survive\n');

      const seeded = await seed({
        label: 'reaper-dotdot',
        // Not a single path segment, and unique per run so the primary key is free.
        workspaceId: `../dotdot-${String(Date.now())}`,
        rootPath: victim,
      });

      const result = await runReaperPass(deps());
      const action = actionFor(result, seeded.workspaceId);

      expect(action?.outcome).toBe('quarantined');
      expect(action?.reason).toContain('Unsafe path segment');

      const row = await client.executionWorkspace.findUniqueOrThrow({
        where: { id: seeded.workspaceId },
      });

      expect(row.state).toBe('quarantined');
      expect((row.cleanupError as { code?: string } | null)?.code).toBe('CONTAINMENT_UNPROVEN');
      expect(await exists(join(victim, 'keep.txt'))).toBe(true);
    }, 30_000);

    it('refuses a workspace reached through a symlinked ancestor', async () => {
      // `root/<orgId> -> decoy` is the classic shape: a `realpath` containment check can
      // pass while the deletion lands outside the root. The reaper must call it a
      // containment failure and quarantine.
      const tenant = await tenantFor('reaper-symlink');
      const task = await createTask(client, tenant, { title: 'reaper symlink' });

      const decoy = join(scratchRoot, 'symlink-decoy');
      const derived = join(workspaceRoot, tenant.orgId, task.taskId, 'ws-symlink');
      const decoyWorkspace = join(decoy, task.taskId, 'ws-symlink');

      await mkdir(join(decoyWorkspace, 'repo'), { recursive: true });
      await writeFile(join(decoyWorkspace, 'repo', 'keep.txt'), 'survive\n');
      await symlink(decoy, join(workspaceRoot, tenant.orgId));

      await client.executionWorkspace.create({
        data: {
          id: 'ws-symlink',
          orgId: tenant.orgId,
          taskId: task.taskId,
          rootPath: derived,
          sourceKind: 'empty',
          state: 'executing',
          leaseExpiresAt: new Date(Date.now() - 60_000),
          leaseOwner: 'test-worker:reaper:1',
        },
      });

      const result = await runReaperPass(deps());
      const action = actionFor(result, 'ws-symlink');

      expect(action?.outcome).toBe('quarantined');
      expect(action?.reason).toContain('symbolic link');
      expect(await exists(join(decoyWorkspace, 'repo', 'keep.txt'))).toBe(true);

      const row = await client.executionWorkspace.findUniqueOrThrow({
        where: { id: 'ws-symlink' },
      });
      expect(row.state).toBe('quarantined');
    }, 30_000);

    it('refuses a row whose rootPath disagrees with the path its ids derive', async () => {
      const elsewhere = join(scratchRoot, 'mismatch-victim');
      await mkdir(elsewhere, { recursive: true });
      await writeFile(join(elsewhere, 'keep.txt'), 'must survive\n');

      const seeded = await seed({ label: 'reaper-mismatch', rootPath: elsewhere });
      await writeWorkspaceTree(seeded.derivedPath);

      const result = await runReaperPass(deps());
      const action = actionFor(result, seeded.workspaceId);

      expect(action?.outcome).toBe('quarantined');
      expect(action?.reason).toContain('does not match');

      // Neither the recorded path nor the derived path is removed.
      expect(await exists(join(elsewhere, 'keep.txt'))).toBe(true);
      expect(await exists(seeded.derivedPath)).toBe(true);
    }, 30_000);
  });

  it('is idempotent: a second pass changes nothing, and a crash after queueing resumes cleanly', async () => {
    const seeded = await seed({ label: 'reaper-idempotent' });
    await writeWorkspaceTree(seeded.derivedPath);

    const first = await runReaperPass(deps());
    expect(actionFor(first, seeded.workspaceId)?.outcome).toBe('reaped');

    const afterFirst = await client.executionWorkspace.findUniqueOrThrow({
      where: { id: seeded.workspaceId },
    });

    // Second pass: `cleaned` is terminal, so the row is not even a candidate.
    const second = await runReaperPass(deps());

    expect(actionFor(second, seeded.workspaceId)).toBeUndefined();

    const afterSecond = await client.executionWorkspace.findUniqueOrThrow({
      where: { id: seeded.workspaceId },
    });

    expect(afterSecond.state).toBe('cleaned');
    expect(afterSecond.cleanupAttempts).toBe(afterFirst.cleanupAttempts);

    // Now the crash window: the worker queued the row and died before removing anything.
    // The reaper must find nothing to delete, count the attempt, and still reach `cleaned`.
    await client.executionWorkspace.update({
      where: { id: seeded.workspaceId },
      data: {
        state: 'cleanup_pending',
        cleanedAt: null,
        leaseExpiresAt: new Date(Date.now() - 60_000),
      },
    });

    const third = await runReaperPass(deps());
    const action = actionFor(third, seeded.workspaceId);

    expect(action?.outcome).toBe('reaped');
    expect(action?.artifactsPreserved).toBe(false);

    const afterThird = await client.executionWorkspace.findUniqueOrThrow({
      where: { id: seeded.workspaceId },
    });

    expect(afterThird.state).toBe('cleaned');
    expect(afterThird.cleanupAttempts).toBe(afterFirst.cleanupAttempts + 1);
  }, 30_000);

  it('gives up after three failed removals and records why', async () => {
    const seeded = await seed({ label: 'reaper-three-failures' });
    await writeWorkspaceTree(seeded.derivedPath);

    // A directory the process owns but cannot traverse: `rm -r` fails with EACCES, which
    // is a transient-looking error (not a containment refusal), so the reaper retries.
    const blocked = join(seeded.derivedPath, 'repo', 'blocked');
    await mkdir(blocked, { recursive: true });
    await writeFile(join(blocked, 'stuck.txt'), 'stuck\n');
    await chmod(blocked, 0o000);

    const outcomes: (string | undefined)[] = [];

    try {
      for (let pass = 0; pass < 3; pass += 1) {
        const result = await runReaperPass(deps());
        outcomes.push(actionFor(result, seeded.workspaceId)?.outcome);
      }
    } finally {
      await chmod(blocked, 0o755).catch(() => undefined);
    }

    expect(outcomes).toEqual(['failed', 'failed', 'cleanup_failed']);

    const row = await client.executionWorkspace.findUniqueOrThrow({
      where: { id: seeded.workspaceId },
    });

    expect(row.state).toBe('cleanup_failed');
    expect(row.cleanupAttempts).toBe(3);

    const cleanupError = row.cleanupError as { stage?: string; code?: string; message?: string };
    expect(cleanupError.code).toBe('RECLAIM_FAILED');
    expect(cleanupError.stage).toBe('reclaim');
    expect(cleanupError.message).toContain('EACCES');
  }, 30_000);

  it('copies artifacts/ into the artifact store before removing the workspace', async () => {
    const seeded = await seed({ label: 'reaper-artifacts' });
    const report = '{"attempt":1,"result":"tests pass"}\n';
    await writeWorkspaceTree(seeded.derivedPath, {
      'repo/sum.js': 'export const sum = (a, b) => a + b;\n',
      'artifacts/report.json': report,
    });

    const result = await runReaperPass(deps());
    const action = actionFor(result, seeded.workspaceId);

    expect(action?.outcome).toBe('reaped');
    expect(action?.artifactsPreserved).toBe(true);
    expect(action?.artifactsBytes).toBeGreaterThanOrEqual(report.length);

    // Source gone, evidence present at the destination, byte-identical.
    expect(await exists(seeded.derivedPath)).toBe(false);

    const copy = join(
      artifactRoot,
      'reaped',
      seeded.tenant.orgId,
      seeded.task.taskId,
      seeded.workspaceId,
      'report.json',
    );

    expect(await readFile(copy, 'utf8')).toBe(report);
  }, 30_000);

  it('keeps artifacts in place and quarantines when the copy fails', async () => {
    // The one path where the directory survives the pass: losing the copy must not lose
    // the bytes. `<artifactRoot>/reaped` is a file, so `cp` fails with ENOTDIR.
    const blockedArtifactRoot = join(scratchRoot, 'blocked-artifact-root');
    await mkdir(blockedArtifactRoot, { recursive: true });
    await writeFile(join(blockedArtifactRoot, 'reaped'), 'not a directory\n');

    const seeded = await seed({ label: 'reaper-artifact-failure' });
    await writeWorkspaceTree(seeded.derivedPath, {
      'repo/sum.js': 'export const sum = (a, b) => a + b;\n',
      'artifacts/report.json': '{"result":"tests pass"}\n',
    });

    const result = await runReaperPass(
      deps({ artifactRoot: blockedArtifactRoot, cgroupRoot: join(scratchRoot, 'cgroups') }),
    );
    const action = actionFor(result, seeded.workspaceId);

    expect(action?.outcome).toBe('quarantined');
    expect(action?.reason).toContain('artifact preservation failed');

    const row = await client.executionWorkspace.findUniqueOrThrow({
      where: { id: seeded.workspaceId },
    });

    expect(row.state).toBe('quarantined');
    expect(await readFile(join(seeded.derivedPath, 'artifacts', 'report.json'), 'utf8')).toContain(
      'tests pass',
    );
  }, 30_000);
});
