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

  await prisma.executionWorkspace.create({
    data: {
      id: input.workspaceId,
      orgId: input.orgId,
      taskId: input.taskId,
      state: 'requested',
      rootPath,
      sourceKind: sourceRepo === undefined ? 'empty' : 'clone',
      sourceRef: sourceRepo ?? null,
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
    },
  });
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
