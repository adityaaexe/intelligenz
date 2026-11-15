import {
  artifactsPath,
  canTransition,
  createWorkspaceManager,
  workspacePath,
  type WorkspaceHandle,
  type WorkspaceManager,
  type WorkspaceState,
} from '@intelligenz/workspace-manager';
import type { PrismaClient } from '@intelligenz/database';

import type { WorkerConfig } from '../config';
import { workerLogger } from '../log';
import { db } from './support';

/**
 * Workspace lifecycle for one execution attempt.
 *
 * The split of responsibility is the same one `@intelligenz/workspace-manager` was
 * built for: the manager owns paths and transitions, this module owns the database
 * row that makes the lease visible to an operator. Neither owns both.
 *
 * ```
 * requested ──► provisioning ──► ready ──► executing ──► preserving ──► completed
 *                    │                        │
 *                    └──► failed              ├──► failed
 *                                             └──► cancelled
 * ```
 *
 * Every state in that diagram is written to `ExecutionWorkspace.state` *and* driven
 * through `manager.transition()`, so the in-memory machine and the row cannot drift.
 *
 * ## What is deliberately not here
 *
 * - **No cleanup of `artifacts/`.** `cleanup({ keepArtifacts: true })` removes the
 *   checkout and leaves the evidence. A workspace that has been cleaned is still the
 *   only place the run's transcript exists.
 * - **No path building.** `workspacePath()` is the manager's, not a second copy here.
 *   The one exception is the value written on insert: it is computed with the same
 *   function and the manager's own resolved root, so `rootPath` is unique from the
 *   first byte and never a guess.
 */

export interface WorkspaceLease {
  readonly id: string;
  readonly manager: WorkspaceManager;
  readonly handle: WorkspaceHandle;
}

export interface WorkspaceLeaseFailure {
  readonly code: string;
  readonly stage: string;
  readonly message: string;
}

export type WorkspaceOutcome = 'completed' | 'failed' | 'cancelled';

export interface LeaseWorkspaceInput {
  readonly orgId: string;
  readonly taskId: string;
  readonly workflowRunId: string;
  readonly attemptNumber: number;
  readonly workspaceId: string;
  readonly config: WorkerConfig;
  /**
   * Who holds the lease. `host:pid:bootId`, not a foreign key — a worker is a process,
   * and the row must still be readable when that process is gone.
   */
  readonly owner: string;
  /**
   * How long the lease is good for: `2 × wall clock` of the attempt's resource profile.
   * Twice, because one full wall clock of silence is normal (a long model call) and a
   * lease that expires during a healthy run would make the reaper a race.
   */
  readonly leaseMs: number;
}

export type LeaseWorkspaceResult =
  | { readonly ok: true; readonly lease: WorkspaceLease }
  | { readonly ok: false; readonly failure: WorkspaceLeaseFailure };

/**
 * Creates the row, provisions the directory, and brings the row's state along.
 *
 * A provisioning failure is **returned**, not thrown: the caller decides whether it
 * is retryable (a git transport error) or terminal (a source path that does not
 * exist). Either way the row records `failed` with the manager's stage and code, so
 * "why is there no workspace?" is answerable later.
 */
export async function leaseWorkspace(input: LeaseWorkspaceInput): Promise<LeaseWorkspaceResult> {
  const prisma = db();
  const manager = createWorkspaceManager({ root: input.config.workspace.root });
  const rootPath = workspacePath(manager.root, {
    orgId: input.orgId,
    taskId: input.taskId,
    workspaceId: input.workspaceId,
  });
  const sourceRepo = input.config.workspace.sourceRepo;

  const now = Date.now();

  await prisma.executionWorkspace.create({
    data: {
      id: input.workspaceId,
      orgId: input.orgId,
      taskId: input.taskId,
      state: 'requested',
      rootPath,
      sourceKind: sourceRepo === undefined ? 'empty' : 'clone',
      sourceRef: sourceRepo ?? null,
      // The lease is written with the row, not after provisioning: a worker that dies
      // between these two statements would leave a workspace nobody owns, which is the
      // exact orphan the reaper exists for and the one thing it cannot see without a
      // deadline.
      leaseOwner: input.owner,
      leaseExpiresAt: new Date(now + input.leaseMs),
      lastHeartbeatAt: new Date(now),
    },
    select: { id: true },
  });

  await setState(prisma, input.orgId, input.workspaceId, 'provisioning');

  const handle = await manager.provision({
    orgId: input.orgId,
    taskId: input.taskId,
    workspaceId: input.workspaceId,
    source:
      sourceRepo === undefined
        ? { kind: 'empty' }
        : { kind: 'clone', repoPath: sourceRepo },
  });

  if (handle.state !== 'ready') {
    const failure: WorkspaceLeaseFailure = {
      code: handle.error?.code ?? 'WORKSPACE_PROVISION_FAILED',
      stage: handle.error?.stage ?? 'provision',
      message: handle.error?.message ?? 'Workspace provisioning did not reach "ready".',
    };

    await prisma.executionWorkspace.updateMany({
      where: { id: input.workspaceId, orgId: input.orgId },
      data: {
        state: 'failed',
        error: { ...failure },
      },
    });

    return { ok: false, failure };
  }

  await prisma.executionWorkspace.updateMany({
    where: { id: input.workspaceId, orgId: input.orgId },
    data: {
      state: 'ready',
      // Canonical path from the manager, not the value we pre-computed: a root that
      // is a symlink resolves to a different string, and the row must match disk.
      rootPath: handle.rootPath,
      baseCommit: handle.baseCommit,
      branch: handle.branch,
      readyAt: new Date(),
    },
  });

  return { ok: true, lease: { id: input.workspaceId, manager, handle } };
}

/** `ready → executing`, recorded before the adapter is spawned. */
export async function markExecuting(lease: WorkspaceLease, orgId: string): Promise<void> {
  await advance(lease, 'executing');
  await setState(db(), orgId, lease.id, 'executing');
}

/** `executing → preserving`: the run finished; bytes are about to be archived. */
export async function markPreserving(lease: WorkspaceLease, orgId: string): Promise<void> {
  await advance(lease, 'preserving');
  await setState(db(), orgId, lease.id, 'preserving');
}

/**
 * Record the baseline digest on the workspace row.
 *
 * Written immediately after the snapshot, not at the end of the attempt: if the worker
 * dies mid-run, the row must still say what tree the attempt started from. `snapshotAt` is
 * the baseline instant — the *final* instant lives inside the manifest body, so the two
 * facts cannot drift into two columns that disagree.
 *
 * A failure here is logged rather than thrown. The manifest carries both digests anyway;
 * this column exists so "which baseline did attempt 3 use" is answerable without parsing
 * an artifact.
 */
export async function recordInitialSnapshot(input: {
  readonly orgId: string;
  readonly workspaceId: string;
  readonly digest: string;
  readonly capturedAt: string;
}): Promise<void> {
  try {
    await db().executionWorkspace.updateMany({
      where: { id: input.workspaceId, orgId: input.orgId },
      data: {
        initialManifestDigest: input.digest,
        snapshotAt: new Date(input.capturedAt),
      },
    });
  } catch (error) {
    workerLogger().warn(
      { workspaceId: input.workspaceId, reason: error instanceof Error ? error.message : String(error) },
      'Could not record the initial manifest digest on the workspace row',
    );
  }
}

/** Record the digest of the tree the run left behind. Same non-fatal contract. */
export async function recordFinalSnapshot(input: {
  readonly orgId: string;
  readonly workspaceId: string;
  readonly digest: string;
}): Promise<void> {
  try {
    await db().executionWorkspace.updateMany({
      where: { id: input.workspaceId, orgId: input.orgId },
      data: { finalManifestDigest: input.digest },
    });
  } catch (error) {
    workerLogger().warn(
      { workspaceId: input.workspaceId, reason: error instanceof Error ? error.message : String(error) },
      'Could not record the final manifest digest on the workspace row',
    );
  }
}

/**
 * Drives the workspace to its terminal state and removes the checkout.
 *
 * `cleanup({ keepArtifacts: true })` is the only destructive call, and it is
 * deliberately incapable of touching `artifacts/`: a run's evidence costs kilobytes
 * and its working tree costs megabytes, so the cheap half is the half that survives.
 *
 * A failure here is logged by the caller, never thrown: the run's outcome is already
 * decided, and losing it because a `rm` failed would be the wrong trade.
 */
export async function releaseWorkspace(input: {
  readonly lease: WorkspaceLease;
  readonly orgId: string;
  readonly outcome: WorkspaceOutcome;
  readonly error?: unknown;
}): Promise<void> {
  const prisma = db();
  const current = input.lease.manager.get(input.lease.id) ?? input.lease.handle;

  if (input.outcome !== 'completed' && canTransition(current.state, input.outcome)) {
    input.lease.manager.transition(input.lease.id, input.outcome);
  }

  const afterTransition = input.lease.manager.get(input.lease.id) ?? current;

  await input.lease.manager.cleanup(afterTransition, { keepArtifacts: true });

  const finalState: WorkspaceState = input.outcome;

  await prisma.executionWorkspace.updateMany({
    where: { id: input.lease.id, orgId: input.orgId },
    data: {
      state: finalState,
      // Only a cleanup that actually ran counts as cleaned. A cancelled workspace is
      // kept whole on purpose, so `cleanedAt` stays null rather than claiming a sweep.
      ...(input.outcome === 'cancelled' ? {} : { cleanedAt: new Date() }),
      ...(input.error === undefined ? {} : { error: serialiseFailure(input.error) }),
      // The lease ends with the run. Leaving it set would make the next reaper pass
      // treat a finished workspace as abandoned-while-live.
      leaseExpiresAt: null,
      leaseOwner: null,
    },
  });
}

/**
 * Extend the lease. Conditional on the owner: two workers must never both believe they
 * hold one directory, so a heartbeat from a process that lost its lease must not revive
 * it. A zero-row update is reported, not thrown — the caller is mid-execution and the
 * right response is a log line, not a failed run.
 */
export async function heartbeatWorkspace(input: {
  readonly orgId: string;
  readonly workspaceId: string;
  readonly owner: string;
  readonly leaseMs: number;
}): Promise<boolean> {
  const now = Date.now();

  const updated = await db().executionWorkspace.updateMany({
    where: { id: input.workspaceId, orgId: input.orgId, leaseOwner: input.owner },
    data: {
      leaseExpiresAt: new Date(now + input.leaseMs),
      lastHeartbeatAt: new Date(now),
    },
  });

  return updated.count > 0;
}

/**
 * A heartbeat loop as an interval with an off switch.
 *
 * Half the wall clock, so two consecutive heartbeats can be lost before the deadline is
 * reached. `unref()` so a forgotten `stop()` cannot hold the process open — the worker's
 * shutdown path must not depend on a timer that this module owns.
 */
export function startWorkspaceHeartbeat(input: {
  readonly orgId: string;
  readonly workspaceId: string;
  readonly owner: string;
  readonly leaseMs: number;
  readonly onMiss?: (workspaceId: string) => void;
}): () => void {
  const intervalMs = Math.max(1_000, Math.floor(input.leaseMs / 4));
  let stopped = false;

  const timer = setInterval(() => {
    void heartbeatWorkspace(input)
      .then((held) => {
        if (!held && !stopped) input.onMiss?.(input.workspaceId);
      })
      .catch(() => undefined);
  }, intervalMs);

  timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** Exposed so the artifact writer and the tests agree on one path. */
export function workspaceArtifactsDirectory(handle: WorkspaceHandle): string {
  return artifactsPath(handle.rootPath);
}

async function advance(lease: WorkspaceLease, to: WorkspaceState): Promise<void> {
  const current = lease.manager.get(lease.id) ?? lease.handle;

  if (!canTransition(current.state, to)) {
    // Already there, or a state the caller cannot reach from here. Not an error: the
    // row is the record of what happened, and forcing a transition would lie.
    return;
  }

  lease.manager.transition(lease.id, to);
}

async function setState(
  prisma: PrismaClient,
  orgId: string,
  workspaceId: string,
  state: WorkspaceState,
): Promise<void> {
  await prisma.executionWorkspace.updateMany({
    where: { id: workspaceId, orgId },
    data: { state },
  });
}

function serialiseFailure(error: unknown): { message: string; code: string } {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;

    return {
      message: error.message.slice(0, 2000),
      code: typeof code === 'string' ? code : error.name,
    };
  }

  return { message: String(error).slice(0, 2000), code: 'WORKSPACE_ERROR' };
}
