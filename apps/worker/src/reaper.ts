import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';
import { Prisma, type PrismaClient } from '@intelligenz/database';
import {
  ContainmentError,
  assertTransition,
  isAbandonable,
  preserveArtifacts,
  reclaimWorkspace,
  type WorkspaceState,
} from '@intelligenz/workspace-manager';

import { cgroupPathFor, killCgroup, listProcesses } from './cgroup';
import { runClaimReleasePass } from './claim-release';
import { WORKFLOW_ID_PREFIX } from './config';
import { workerIdentity } from './identity';
import { workerLogger } from './log';
import { deterministicId } from './activities/ids';

/**
 * The workspace reaper.
 *
 * Phase 3 had no reaper, and the reason was not effort: without a lease there was no way
 * to tell "a live run" from "a directory left behind by a dead worker", and the safe
 * default was to reap nothing. Now there is a lease, so the reaper's evidence is:
 *
 *   1. the row is in a non-terminal state (or terminal with `cleanedAt` null);
 *   2. its `leaseExpiresAt` is in the past by more than **2× the reaper interval**;
 *   3. Temporal says no workflow is running for `task-<taskId>`.
 *
 * Only when all three hold is the attempt declared abandoned. Anything else — an active
 * workflow, an unreachable Temporal, a fresh lease — is a skip, and a skip is always the
 * cheaper mistake: reaping a live run destroys work, skipping a dead one costs disk.
 *
 * ## What it will never do
 *
 * - **Never delete on age alone.** `expiresAt` is not consulted; only the lease and the
 *   workflow liveness are.
 * - **Never match processes by name.** The only processes it kills are the ones listed in
 *   that attempt's `cgroup.procs`, via `cgroup.kill`. A `pkill opencode` would kill a
 *   concurrent run, a developer's editor, or the reaper itself.
 * - **Never remove an unvalidated path.** `reclaimWorkspace` re-derives the path from the
 *   ids, `lstat`s every component, refuses symlinks, and asserts containment; this module
 *   only decides *whether* to remove, never *what*.
 * - **Never destroy evidence.** `<workspace>/artifacts` is copied into the artifact store
 *   before the directory is removed, and a copy that fails moves the row to
 *   `quarantined` rather than losing the bytes.
 */

export type WorkflowLiveness = 'active' | 'finished' | 'absent' | 'unknown';

export interface WorkflowLivenessProbe {
  status(taskId: string): Promise<WorkflowLiveness>;
  /**
   * Liveness of **one specific execution**, identified by the workflow id **and** run id
   * the claim recorded.
   *
   * `status(taskId)` answers "is the workflow for this task running"; this answers "is
   * the execution that holds this claim still there", which is a different question and
   * the only one a claim release may act on. Both ids are supplied by the claim
   * (`ExecutionAttempt.claimedByWorkflowId` / `claimedByWorkflowRunId`), which is why the
   * claimed pair is recorded rather than derived: `describeWorkflowExecution` is keyed by
   * the pair, so asking about `task-<taskId>` plus a run id minted for any other workflow
   * id answers NOT_FOUND for a **live** execution. Phase 6 re-review N7 released a live
   * claim exactly that way; the recorded pair is what makes this question exact.
   *
   * Returns `absent` only when the server says there is no such execution. A claim whose
   * workflow id was never recorded cannot be asked about exactly and must not be probed
   * with a guess — `claim-release.ts` skips it before calling this.
   */
  execution(workflowId: string, workflowRunId: string): Promise<WorkflowLiveness>;
}

/** gRPC "not found": there is no execution, which is a definite answer, not an error. */
const GRPC_NOT_FOUND = 5;

/**
 * What a failed liveness call means — Phase 6 re-review N2.
 *
 * `absent` is the answer the whole release path rests on, and until AG-603 it was
 * **unreachable**. The probe classified only by `error.code === 5`, but `describe()` does
 * not surface the raw gRPC error: `WorkflowClient._describeWorkflowHandler` converts
 * `NOT_FOUND` into `WorkflowNotFoundError`, which carries `workflowId`/`runId` and
 * neither `code` nor a coded `cause`. `grpcStatus()` therefore returned `undefined`, a
 * genuinely missing execution became `unknown`, and the release pass could only ever fire
 * for *terminal* runs. A claim whose run was deleted or aged out of retention was stranded
 * for ever — the exact state F4 exists to prevent.
 *
 * Classification is now by the error's **identity** first, then by the gRPC code, so both
 * shapes are recognised. Everything else stays `unknown`, and `unknown` still means skip:
 * this function is allowed to miss an absence (a stranded claim costs availability) and is
 * not allowed to invent one (a release of a live claim destroys work).
 *
 * The identity check is deliberately over-inclusive in one direction only: a subclass, a
 * second copy of the SDK, and a re-serialized error all still answer `absent` through
 * either `instanceof` (the SDK installs a `Symbol.hasInstance` that survives copies) or
 * the marker symbol the SDK's decorator writes. It is not message-text matching.
 */
export function classifyProbeError(error: unknown): WorkflowLiveness {
  for (const candidate of errorChain(error)) {
    if (isWorkflowNotFound(candidate)) return 'absent';
    if (grpcStatus(candidate) === GRPC_NOT_FOUND) return 'absent';
  }

  return 'unknown';
}

/** The marker `SymbolBasedInstanceOfError` writes, and the name it writes on the prototype. */
const WORKFLOW_NOT_FOUND_MARKER = Symbol.for('__temporal_isWorkflowNotFoundError');

function isWorkflowNotFound(error: unknown): boolean {
  if (error instanceof WorkflowNotFoundError) return true;
  if (typeof error !== 'object' || error === null) return false;

  if ((error as { name?: unknown }).name === 'WorkflowNotFoundError') return true;

  // Belt and braces for a copy of the SDK whose class identity is not shared: the marker
  // is a `Symbol.for`, so it is global across realms and library instances.
  return (error as Record<symbol, unknown>)[WORKFLOW_NOT_FOUND_MARKER] === true;
}

export function createTemporalProbe(options: {
  readonly address: string;
  readonly namespace: string;
}): WorkflowLivenessProbe & { close(): Promise<void> } {
  let connection: Connection | undefined;
  let client: Client | undefined;

  const connect = async (): Promise<Client> => {
    if (client !== undefined) return client;

    connection ??= await Connection.connect({ address: options.address });
    client = new Client({ connection, namespace: options.namespace });

    return client;
  };

  return {
    async status(taskId: string): Promise<WorkflowLiveness> {
      try {
        const described = await (
          await connect()
        ).workflow
          .getHandle(`${WORKFLOW_ID_PREFIX}${taskId}`)
          .describe();

        // Only these two mean "a process may still be doing work". A terminated or
        // timed-out workflow is finished for the reaper's purposes.
        const name = described.status.name;

        return name === 'RUNNING' || name === 'CONTINUED_AS_NEW' ? 'active' : 'finished';
      } catch (error) {
        // An unreachable server is not evidence that the workflow is gone. `unknown`
        // makes the caller skip, which is the whole point of having the value.
        return classifyProbeError(error);
      }
    },

    async execution(workflowId: string, workflowRunId: string): Promise<WorkflowLiveness> {
      try {
        // Both ids on purpose, and both as recorded: the workflow id alone would resolve
        // to whichever execution Temporal currently holds under it, and the run id alone
        // is not a key. Substituting the task's derived id for the recorded one is N7 —
        // it turns a live claim held by a non-canonical execution into `absent`.
        const described = await (
          await connect()
        ).workflow
          .getHandle(workflowId, workflowRunId)
          .describe();

        const name = described.status.name;

        return name === 'RUNNING' || name === 'CONTINUED_AS_NEW' ? 'active' : 'finished';
      } catch (error) {
        return classifyProbeError(error);
      }
    },

    async close(): Promise<void> {
      await connection?.close().catch(() => undefined);
      connection = undefined;
      client = undefined;
    },
  };
}

function errorChain(error: unknown, depth = 0): readonly unknown[] {
  if (depth > 4) return [];

  const chain: unknown[] = [error];
  const cause =
    typeof error === 'object' && error !== null ? (error as { cause?: unknown }).cause : undefined;

  if (cause !== undefined && cause !== error) chain.push(...errorChain(cause, depth + 1));

  return chain;
}

function grpcStatus(error: unknown, depth = 0): number | undefined {
  if (typeof error !== 'object' || error === null || depth > 3) return undefined;

  const code = (error as { code?: unknown }).code;
  if (typeof code === 'number') return code;

  return grpcStatus((error as { cause?: unknown }).cause, depth + 1);
}

export type ReaperOutcome =
  | 'reaped'
  | 'skipped_live'
  | 'skipped_unknown'
  | 'skipped_fresh'
  | 'quarantined'
  | 'cleanup_failed'
  | 'already_clean'
  | 'failed';

export interface ReaperAction {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly outcome: ReaperOutcome;
  readonly reason: string;
  readonly killedPids: number;
  readonly artifactsPreserved: boolean;
  readonly artifactsBytes: number;
}

export interface ReaperResult {
  readonly scanned: number;
  readonly actions: readonly ReaperAction[];
  readonly errored: number;
  /**
   * Stranded execution claims released by the Phase 6 pass. Optional because the two
   * workspace passes have no opinion about claims and their result builders predate it.
   */
  readonly released?: number;
}

export interface ReaperDeps {
  readonly prisma: PrismaClient;
  readonly probe: WorkflowLivenessProbe;
  readonly workspaceRoot: string;
  readonly cgroupRoot: string;
  readonly artifactRoot: string;
  readonly intervalMs: number;
  readonly now?: () => Date;
  /** Max rows per pass. A reaper that scans everything holds the database for a minute. */
  readonly batchSize?: number;
  /** Called for each action; defaults to the worker logger. */
  readonly report?: (action: ReaperAction) => void;
}

const MAX_CLEANUP_ATTEMPTS = 3;

const TERMINAL_STATES: readonly WorkspaceState[] = [
  'completed',
  'failed',
  'cancelled',
  'cleaned',
  'cleanup_failed',
  'quarantined',
];

/**
 * One pass. Exported so `infra/scripts/p4-crash-matrix.ts` and the tests can run it
 * synchronously instead of waiting for a timer.
 */
export async function runReaperPass(deps: ReaperDeps): Promise<ReaperResult> {
  const now = deps.now ?? ((): Date => new Date());
  const report = deps.report ?? defaultReport;
  const batchSize = deps.batchSize ?? 50;
  const grace = deps.intervalMs * 2;
  const cutoff = new Date(now().getTime() - grace);

  const candidates = await deps.prisma.executionWorkspace.findMany({
    where: {
      state: { notIn: [...TERMINAL_STATES] },
      leaseExpiresAt: { lt: cutoff },
    },
    orderBy: { leaseExpiresAt: 'asc' },
    take: batchSize,
    select: {
      id: true,
      orgId: true,
      taskId: true,
      state: true,
      rootPath: true,
      leaseExpiresAt: true,
      leaseOwner: true,
      cleanupAttempts: true,
    },
  });

  const actions: ReaperAction[] = [];
  let errored = 0;

  for (const row of candidates) {
    try {
      const action = await reapOne(deps, {
        workspaceId: row.id,
        orgId: row.orgId,
        taskId: row.taskId,
        state: row.state as WorkspaceState,
        rootPath: row.rootPath,
        cleanupAttempts: row.cleanupAttempts,
        deadline: cutoff,
        now: now(),
      });

      actions.push(action);
      report(action);
    } catch (error) {
      errored += 1;
      workerLogger().error(
        {
          workspaceId: row.id,
          taskId: row.taskId,
          err: error instanceof Error ? error.message : String(error),
        },
        'reaper pass failed for one workspace; continuing',
      );
    }
  }

  return { scanned: candidates.length, actions, errored };
}

interface Candidate {
  readonly workspaceId: string;
  readonly orgId: string;
  readonly taskId: string;
  readonly state: WorkspaceState;
  readonly rootPath: string;
  readonly cleanupAttempts: number;
  readonly deadline: Date;
  readonly now: Date;
}

async function reapOne(deps: ReaperDeps, candidate: Candidate): Promise<ReaperAction> {
  const base = {
    workspaceId: candidate.workspaceId,
    taskId: candidate.taskId,
    killedPids: 0,
    artifactsPreserved: false,
    artifactsBytes: 0,
  } as const;

  // ── 1. Is a workflow still working on this task? ────────────────────────────
  const liveness = await deps.probe.status(candidate.taskId);

  if (liveness === 'active') {
    // The lease is stale but the work is not. Extend the grace rather than reap: the
    // heartbeat will resume if the worker is merely paused, and if it does not, the next
    // pass will see the same evidence and act.
    await deps.prisma.executionWorkspace.updateMany({
      where: { id: candidate.workspaceId, orgId: candidate.orgId },
      data: {
        leaseExpiresAt: new Date(candidate.now.getTime() + deps.intervalMs * 2),
        lastHeartbeatAt: candidate.now,
      },
    });

    return {
      ...base,
      outcome: 'skipped_live',
      reason: `workflow ${WORKFLOW_ID_PREFIX}${candidate.taskId} is still running; lease extended`,
    };
  }

  if (liveness === 'unknown') {
    return {
      ...base,
      outcome: 'skipped_unknown',
      reason: 'Temporal did not answer; refusing to reap on doubt',
    };
  }

  const expiredBy = candidate.now.getTime() - candidate.deadline.getTime();

  if (expiredBy < 0) {
    return { ...base, outcome: 'skipped_fresh', reason: 'lease is inside the grace window' };
  }

  // ── 2. The attempt that owned this workspace is abandoned ───────────────────
  // The attempt row is found by `(orgId, taskId)` and `status = running`: a workspace is
  // 1:1 with an attempt by construction (`executionWorkspaceIdFor` and
  // `executionAttemptIdFor` hash the same pair), and only one attempt per task can be
  // running because the workflow id is unique.
  const attempt = await deps.prisma.executionAttempt.findFirst({
    where: { orgId: candidate.orgId, taskId: candidate.taskId, status: 'running' },
    orderBy: { attemptNumber: 'desc' },
    select: { id: true, attemptNumber: true },
  });

  if (attempt !== null) {
    await deps.prisma.executionAttempt.updateMany({
      where: { id: attempt.id, orgId: candidate.orgId },
      data: {
        status: 'failed',
        finishedAt: candidate.now,
        terminationReason: 'crashed',
        // The bytes are not reclaimed yet; the workspace row below records that.
        cleanupState: 'pending',
        error: {
          code: 'ATTEMPT_ABANDONED',
          message:
            'The worker holding this attempt stopped heartbeating and no workflow is running. ' +
            'Recorded by the reaper; the process tree was not observed exiting.',
          retryable: false,
        },
      },
    });
  }

  // ── 3. Kill only what is demonstrably this attempt's ────────────────────────
  // `cgroupPathFor` validates the id and throws for a value that is not one path
  // segment. That must not abort the pass: the id is a *database* value, reclamation
  // below re-validates it and quarantines the row, and a throw here would leave the row
  // in a non-terminal state forever with only a log line to show for it.
  let killedPids = 0;
  let cgroupPath = 'unresolved';

  try {
    cgroupPath = cgroupPathFor(deps.cgroupRoot, candidate.workspaceId);

    const handle = { path: cgroupPath, id: candidate.workspaceId, root: deps.cgroupRoot };
    const pids = await listProcesses(handle);

    if (pids.length > 0) {
      await killCgroup(handle);
      killedPids = pids.length;
    }
  } catch (error) {
    // No cgroup is normal in `rlimit-only` mode. A kill failure is logged and the pass
    // continues: leaked processes are an operator's problem, a lost directory is worse.
    workerLogger().warn(
      {
        workspaceId: candidate.workspaceId,
        cgroup: cgroupPath,
        err: error instanceof Error ? error.message : String(error),
      },
      'reaper could not kill the attempt cgroup',
    );
  }

  // ── 4. Preserve evidence, then reclaim ──────────────────────────────────────
  let artifactsPreserved = false;
  let artifactsBytes = 0;

  try {
    const preserved = await preserveArtifacts({
      workspaceRootPath: candidate.rootPath,
      destination: reapArtifactDirectory(
        deps.artifactRoot,
        candidate.orgId,
        candidate.taskId,
        candidate.workspaceId,
      ),
    });

    artifactsPreserved = preserved.preserved;
    artifactsBytes = preserved.bytes;
  } catch (error) {
    // Losing the copy must not lose the bytes: the row is quarantined and a human
    // decides. This is the one path where the directory survives the pass.
    await quarantine(deps, candidate, `artifact preservation failed: ${messageOf(error)}`);

    return {
      ...base,
      outcome: 'quarantined',
      reason: `artifact preservation failed: ${messageOf(error)}`,
      killedPids,
    };
  }

  // ── 5. Queue, then remove ───────────────────────────────────────────────────
  if (isAbandonable(candidate.state)) {
    // A legal edge, asserted rather than assigned: a state machine that is only consulted
    // by the happy path is documentation, not a constraint.
    assertTransition(candidate.state, 'cleanup_pending');
  }

  await deps.prisma.executionWorkspace.updateMany({
    where: { id: candidate.workspaceId, orgId: candidate.orgId },
    data: { state: 'cleanup_pending' },
  });

  let result;
  try {
    result = await reclaimWorkspace({
      root: deps.workspaceRoot,
      ids: {
        orgId: candidate.orgId,
        taskId: candidate.taskId,
        workspaceId: candidate.workspaceId,
      },
      recordedRootPath: candidate.rootPath,
      keepArtifacts: !artifactsPreserved,
    });
  } catch (error) {
    return quarantineOrRetry(deps, candidate, error, {
      ...base,
      killedPids,
      artifactsPreserved,
      artifactsBytes,
    });
  }

  const attempts = candidate.cleanupAttempts + 1;

  await deps.prisma.executionWorkspace.updateMany({
    where: { id: candidate.workspaceId, orgId: candidate.orgId },
    data: {
      state: 'cleaned',
      cleanedAt: candidate.now,
      cleanupAttempts: attempts,
      // `Prisma.JsonNull` is the SQL NULL for a `Json?` column; a bare `null` would be
      // the JSON literal `null` and the type refuses it for that reason.
      cleanupError: Prisma.JsonNull,
      // The lease has served its purpose; clearing it keeps the next pass from
      // reconsidering a workspace that is already gone.
      leaseExpiresAt: null,
      leaseOwner: null,
    },
  });

  await recordReaped(deps, candidate, {
    reason: result.artifactsKept
      ? 'abandoned attempt; checkout removed, artifacts kept in place'
      : 'abandoned attempt; workspace removed after artifacts were preserved',
    killedPids,
    artifactsPreserved,
    artifactsBytes,
    cleanupState: 'done',
  });

  return {
    ...base,
    outcome: 'reaped',
    reason: `lease expired ${String(Math.round(expiredBy / 1000))}s ago and no workflow is running`,
    killedPids,
    artifactsPreserved,
    artifactsBytes,
  };
}

/**
 * Containment could not be proven ⇒ quarantine. The `rm` failed ⇒ retry, up to three,
 * then `cleanup_failed`.
 *
 * The distinction is the whole point: a path the reaper cannot prove it owns must never
 * be deleted, and a transient `EBUSY` must not permanently strand a directory.
 */
async function quarantineOrRetry(
  deps: ReaperDeps,
  candidate: Candidate,
  error: unknown,
  base: Omit<ReaperAction, 'outcome' | 'reason'>,
): Promise<ReaperAction> {
  const isContainment =
    error instanceof ContainmentError ||
    (error instanceof Error && error.name === 'ReclaimRefusedError');

  if (isContainment) {
    await quarantine(deps, candidate, messageOf(error));

    return { ...base, outcome: 'quarantined', reason: messageOf(error) };
  }

  const attempts = candidate.cleanupAttempts + 1;
  const exhausted = attempts >= MAX_CLEANUP_ATTEMPTS;
  const state: WorkspaceState = exhausted ? 'cleanup_failed' : 'cleanup_pending';

  await deps.prisma.executionWorkspace.updateMany({
    where: { id: candidate.workspaceId, orgId: candidate.orgId },
    data: {
      state,
      cleanupAttempts: attempts,
      cleanupError: {
        stage: 'reclaim',
        message: messageOf(error).slice(0, 2000),
        code: 'RECLAIM_FAILED',
      },
    },
  });

  await recordReaped(deps, candidate, {
    reason: `cleanup attempt ${String(attempts)}/${String(MAX_CLEANUP_ATTEMPTS)} failed: ${messageOf(error)}`,
    killedPids: base.killedPids,
    artifactsPreserved: base.artifactsPreserved,
    artifactsBytes: base.artifactsBytes,
    cleanupState: exhausted ? 'failed' : 'pending',
  });

  return {
    ...base,
    outcome: exhausted ? 'cleanup_failed' : 'failed',
    reason: `cleanup attempt ${String(attempts)}/${String(MAX_CLEANUP_ATTEMPTS)} failed: ${messageOf(error)}`,
  };
}

async function quarantine(deps: ReaperDeps, candidate: Candidate, reason: string): Promise<void> {
  await deps.prisma.executionWorkspace.updateMany({
    where: { id: candidate.workspaceId, orgId: candidate.orgId },
    data: {
      state: 'quarantined',
      cleanupAttempts: candidate.cleanupAttempts + 1,
      cleanupError: {
        stage: 'reclaim',
        message: reason.slice(0, 2000),
        code: 'CONTAINMENT_UNPROVEN',
      },
    },
  });

  await recordReaped(deps, candidate, {
    reason: `quarantined: ${reason}`,
    killedPids: 0,
    artifactsPreserved: false,
    artifactsBytes: 0,
    cleanupState: 'failed',
  });
}

/**
 * The audit event. Written directly rather than through `emitEventActivity` because the
 * reaper is not a workflow activity — it has no Temporal event history to be replayed
 * from — and because the determinism a replay would give it is provided instead by the
 * id: the same workspace at the same attempt number produces the same row.
 *
 * Immutability: `AuditEvent` has no update path in this codebase, and this is the only
 * writer of `workspace.reaped.v1`. That is a convention, not a database constraint —
 * stated plainly because "immutable" without an enforcement mechanism is a wish.
 */
async function recordReaped(
  deps: ReaperDeps,
  candidate: Candidate,
  detail: {
    readonly reason: string;
    readonly killedPids: number;
    readonly artifactsPreserved: boolean;
    readonly artifactsBytes: number;
    readonly cleanupState: 'pending' | 'done' | 'failed';
  },
): Promise<void> {
  const attemptNumberKey = String(candidate.cleanupAttempts + 1);

  try {
    await deps.prisma.auditEvent.create({
      data: {
        id: deterministicId(`workspace-reaped:${candidate.workspaceId}:${attemptNumberKey}`),
        orgId: candidate.orgId,
        actorType: 'system',
        actorId: `reaper:${workerIdentity()}`,
        action: 'workspace.reaped',
        aggregateType: 'ExecutionWorkspace',
        aggregateId: candidate.workspaceId,
        eventType: 'workspace.reaped.v1',
        correlationId: candidate.workspaceId,
        idempotencyKey: `workspace.reaped.v1:${candidate.workspaceId}:${attemptNumberKey}`,
        payload: {
          workspaceId: candidate.workspaceId,
          taskId: candidate.taskId,
          previousState: candidate.state,
          reason: detail.reason,
          killedPids: detail.killedPids,
          artifactsPreserved: detail.artifactsPreserved,
          artifactsBytes: detail.artifactsBytes,
          cleanupState: detail.cleanupState,
          leaseExpiresAt: candidate.deadline.toISOString(),
          reapedAt: candidate.now.toISOString(),
          worker: workerIdentity(),
        },
        occurredAt: candidate.now,
      },
      select: { id: true },
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') return;

    // An audit write that fails must not undo a reclamation that already happened.
    workerLogger().error(
      {
        workspaceId: candidate.workspaceId,
        err: messageOf(error),
      },
      'workspace.reaped.v1 audit event could not be written',
    );
  }
}

/**
 * The orphan sweep: rows that reached a terminal state but whose process died before it
 * could set `cleanedAt` and clear the lease.
 *
 * `completed` is terminal and cannot transition to `cleanup_pending`, which is why this
 * is a separate pass over `cleanedAt` rather than a state edge. `cancelled` is excluded
 * on purpose: a cancelled workspace is kept whole by design, and `leaseExpiresAt` is
 * null for every workspace whose release ran, so a non-null expired lease is itself
 * evidence that the release did not finish.
 */
export async function runOrphanSweep(deps: ReaperDeps): Promise<ReaperResult> {
  const now = deps.now ?? ((): Date => new Date());
  const cutoff = new Date(now().getTime() - deps.intervalMs * 2);

  const rows = await deps.prisma.executionWorkspace.findMany({
    where: {
      state: { in: ['completed', 'failed'] },
      cleanedAt: null,
      leaseExpiresAt: { lt: cutoff },
    },
    take: deps.batchSize ?? 50,
    select: {
      id: true,
      orgId: true,
      taskId: true,
      state: true,
      rootPath: true,
      cleanupAttempts: true,
    },
  });

  const actions: ReaperAction[] = [];
  let errored = 0;

  for (const row of rows) {
    try {
      const preserved = await preserveArtifacts({
        workspaceRootPath: row.rootPath,
        destination: reapArtifactDirectory(deps.artifactRoot, row.orgId, row.taskId, row.id),
      });

      const result = await reclaimWorkspace({
        root: deps.workspaceRoot,
        ids: { orgId: row.orgId, taskId: row.taskId, workspaceId: row.id },
        recordedRootPath: row.rootPath,
        keepArtifacts: !preserved.preserved,
      });

      await deps.prisma.executionWorkspace.updateMany({
        where: { id: row.id, orgId: row.orgId },
        data: {
          cleanedAt: now(),
          cleanupAttempts: row.cleanupAttempts + 1,
          leaseExpiresAt: null,
          leaseOwner: null,
        },
      });

      actions.push({
        workspaceId: row.id,
        taskId: row.taskId,
        outcome: 'reaped',
        reason: `terminal state ${row.state} with no cleanedAt; bytes reclaimed`,
        killedPids: 0,
        artifactsPreserved: preserved.preserved,
        artifactsBytes: preserved.bytes,
      });

      void result;
    } catch (error) {
      errored += 1;
      workerLogger().warn(
        { workspaceId: row.id, err: messageOf(error) },
        'orphan sweep could not reclaim one workspace',
      );
    }
  }

  return { scanned: rows.length, actions, errored };
}

export interface ReaperHandle {
  stop(): Promise<void>;
  runNow(): Promise<ReaperResult>;
}

/**
 * The periodic task. `unref()`ed so it cannot be the reason the process stays alive, and
 * its first pass is delayed by one interval: a worker restart is exactly when the
 * database is busiest, and a reaper that races the worker's own startup is a reaper that
 * reaps a run that has not started heartbeating yet.
 */
export function startReaper(deps: ReaperDeps, probe: { close?(): Promise<void> }): ReaperHandle {
  let running = false;
  let stopped = false;

  const tick = async (): Promise<ReaperResult> => {
    if (running || stopped) return { scanned: 0, actions: [], errored: 0 };
    running = true;

    try {
      const pass = await runReaperPass(deps);
      const sweep = await runOrphanSweep(deps);
      // Phase 6, F4. Runs last: it only touches rows nothing adopted, so it cannot race
      // a live workspace, and running it after the two reclamation passes keeps the
      // ordering of the older, better-tested paths unchanged.
      const releases = await runClaimReleasePass(deps);

      return {
        scanned: pass.scanned + sweep.scanned + releases.scanned,
        actions: [...pass.actions, ...sweep.actions],
        errored: pass.errored + sweep.errored + releases.errored,
        released: releases.actions.filter((action) => action.outcome === 'released').length,
      };
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick().catch((error: unknown) => {
      workerLogger().error({ err: messageOf(error) }, 'reaper pass threw');
    });
  }, deps.intervalMs);

  timer.unref();

  return {
    runNow: tick,
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await probe.close?.().catch(() => undefined);
    },
  };
}

function reapArtifactDirectory(
  artifactRoot: string,
  orgId: string,
  taskId: string,
  workspaceId: string,
): string {
  return `${artifactRoot}/reaped/${orgId}/${taskId}/${workspaceId}`;
}

function defaultReport(action: ReaperAction): void {
  workerLogger().info(
    {
      workspaceId: action.workspaceId,
      taskId: action.taskId,
      outcome: action.outcome,
      killedPids: action.killedPids,
      artifactsPreserved: action.artifactsPreserved,
      artifactsBytes: action.artifactsBytes,
    },
    `reaper: ${action.outcome} — ${action.reason}`,
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
