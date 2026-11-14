import type { RunStatus } from '@intelligenz/database';
import type { ExecutionResult } from '@intelligenz/agent-runtime';

import { executionAttemptIdFor } from './ids';
import { db, nonRetryable } from './support';

/**
 * Execution attempt identity.
 *
 * A Temporal retry re-runs an activity. Before Phase 3 there was no way to tell that
 * second run from an independent one, so "the agent failed three times" and "the agent
 * failed once and the worker retried the write" looked identical. An attempt row fixes
 * that: `(workflowRunId, attemptNumber)` is unique in the schema, and this module is
 * the only writer of that pair.
 *
 * ## Phase 5: the first attempt is reserved by the API, not created here
 *
 * `POST /run` creates the attempt inside the transaction that consumes the approval, so
 * the grant names an attempt before any workflow exists. `startAttempt` therefore
 * **adopts** that row (`queued → running`) instead of inserting attempt #1 beside it;
 * inserting would leave a phantom queued attempt and make the run's accounting disagree
 * with the grant. When no reserved attempt exists — a direct Temporal start, or a retry
 * after a previous attempt was finalized — it falls back to allocating `max + 1`, which
 * is the Phase 3 behaviour and is correct for both of those cases.
 *
 * ## Why the adopted row is claimed with a compare-and-swap
 *
 * Two executions of one workflow run can reach this function with the same reservation.
 * The `updateMany` predicate (`status: 'queued'`, `agentRunId: null`) makes exactly one
 * of them win; the loser throws before anything is provisioned. Falling through to a new
 * attempt there would be the residual this closes: one grant, two agents.
 *
 * ## Why the number is read, not derived from a counter
 *
 * A counter in memory would reset with the worker and collide with an existing row
 * after a restart. Reading `max(attemptNumber)` for the workflow run and inserting
 * `max + 1` is correct across processes; the unique constraint is the authority under
 * a race, and the loop below retries the read instead of failing the activity over a
 * lost coin flip.
 */

export interface WorkflowRunRef {
  readonly id: string;
  readonly startedAt: Date | null;
}

export interface AttemptRef {
  readonly id: string;
  readonly attemptNumber: number;
}

const MAX_ATTEMPT_INSERT_ATTEMPTS = 5;

/** The run this execution belongs to. An explicit id is trusted only inside its tenant. */
export async function resolveWorkflowRun(input: {
  readonly orgId: string;
  readonly taskId: string;
  readonly workflowRunId: string | undefined;
}): Promise<WorkflowRunRef> {
  const prisma = db();

  if (input.workflowRunId !== undefined) {
    const run = await prisma.workflowRun.findFirst({
      // Tenant scoping plus the task: a workflow run id from another task in the same
      // org is not this execution's parent.
      where: { id: input.workflowRunId, orgId: input.orgId, taskId: input.taskId },
      select: { id: true, startedAt: true },
    });

    if (run === null) {
      throw nonRetryable(
        'WORKFLOW_RUN_NOT_FOUND',
        `WorkflowRun ${input.workflowRunId} does not belong to task ${input.taskId}.`,
      );
    }

    return run;
  }

  const run = await prisma.workflowRun.findFirst({
    where: { orgId: input.orgId, taskId: input.taskId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, startedAt: true },
  });

  if (run === null) {
    throw nonRetryable(
      'WORKFLOW_RUN_NOT_FOUND',
      `No WorkflowRun exists for task ${input.taskId}. recordStartActivity must run first.`,
    );
  }

  return run;
}

export async function startAttempt(input: {
  readonly orgId: string;
  readonly taskId: string;
  readonly workflowRunId: string;
  readonly runtimeId: string;
  /** Provisional value: a real adapter starts as "not simulated". */
  readonly simulated: boolean;
  readonly startedAt: Date;
}): Promise<AttemptRef> {
  const prisma = db();

  const adopted = await adoptReservedAttempt(input);
  if (adopted !== null) return adopted;

  for (let attempt = 0; attempt < MAX_ATTEMPT_INSERT_ATTEMPTS; attempt += 1) {
    const previous = await prisma.executionAttempt.findFirst({
      where: { workflowRunId: input.workflowRunId },
      orderBy: { attemptNumber: 'desc' },
      select: { attemptNumber: true },
    });

    const attemptNumber = (previous?.attemptNumber ?? 0) + 1;

    try {
      const created = await prisma.executionAttempt.create({
        data: {
          id: executionAttemptIdFor(input.workflowRunId, attemptNumber),
          orgId: input.orgId,
          taskId: input.taskId,
          workflowRunId: input.workflowRunId,
          attemptNumber,
          runtimeId: input.runtimeId,
          simulated: input.simulated,
          status: 'running',
          startedAt: input.startedAt,
        },
        select: { id: true, attemptNumber: true },
      });

      return created;
    } catch (error) {
      // P2002: another writer claimed this number between our read and our insert.
      // Re-read and try the next number; anything else is a real failure.
      if ((error as { code?: string }).code !== 'P2002') throw error;
    }
  }

  throw nonRetryable(
    'EXECUTION_ATTEMPT_CONTENDED',
    `Could not allocate an attempt number for workflow run ${input.workflowRunId}.`,
  );
}

/**
 * Claims the attempt `POST /run` reserved, if there is one.
 *
 * Returns `null` when this workflow run has no queued reservation — which is the honest
 * description of a direct Temporal start and of a retry after a finalized attempt, and
 * lets the caller use the Phase 3 allocation path unchanged.
 *
 * A reservation that exists but cannot be claimed is **not** `null`: the only way to lose
 * this compare-and-swap is another execution adopting the same row, and the correct answer
 * to that is a refusal, not a second attempt.
 */
async function adoptReservedAttempt(input: {
  readonly orgId: string;
  readonly taskId: string;
  readonly workflowRunId: string;
  readonly runtimeId: string;
  readonly simulated: boolean;
  readonly startedAt: Date;
}): Promise<AttemptRef | null> {
  const prisma = db();

  const reserved = await prisma.executionAttempt.findFirst({
    where: {
      // Tenant scoping, and the run the reservation belongs to: an unstarted attempt for
      // a different run is not this execution's to take.
      orgId: input.orgId,
      taskId: input.taskId,
      workflowRunId: input.workflowRunId,
      status: 'queued',
      agentRunId: null,
    },
    // Deterministic if a run somehow holds more than one: the earliest reservation is
    // the one the grant points at, because attempts are numbered in creation order.
    orderBy: { attemptNumber: 'asc' },
    select: { id: true, attemptNumber: true },
  });

  if (reserved === null) return null;

  const claimed = await prisma.executionAttempt.updateMany({
    where: {
      id: reserved.id,
      orgId: input.orgId,
      // The CAS. Both predicates are load-bearing: `status` stops a second adoption, and
      // `agentRunId` stops adoption of an attempt that already produced a run.
      status: 'queued',
      agentRunId: null,
    },
    data: {
      status: 'running',
      startedAt: input.startedAt,
      // Replace the `unassigned` placeholder the API wrote with the adapter that is
      // actually about to run.
      runtimeId: input.runtimeId,
      simulated: input.simulated,
    },
  });

  if (claimed.count === 0) {
    throw nonRetryable(
      'EXECUTION_ATTEMPT_TAKEN',
      `Attempt ${reserved.id} was already claimed by another execution of workflow run ` +
        `${input.workflowRunId}. One reservation authorises one execution.`,
    );
  }

  return reserved;
}

/**
 * The terminal write for an attempt. Scoped by `orgId` even though the id is unique:
 * every write in this codebase says which tenant it belongs to.
 */
export interface AttemptResources {
  /**
   * What actually bounded this attempt: the profile name (`standard`) when cgroups were
   * enforced, or the literal `rlimit-only` when they were not. Read by an operator as
   * "what was in force", so it is never the profile that was *intended*.
   */
  readonly executionProfile: string;
  /** `cpu.stat usage_usec` → ms. Null when no cgroup existed. */
  readonly cpuTimeMs: number | null;
  /** `memory.peak`. BigInt because a byte count does not fit an Int comfortably. */
  readonly memoryPeakBytes: number | null;
  /** `pids.peak`. Null on a kernel without the file. */
  readonly pidsPeak: number | null;
  /** `completed | timeout | cancelled | oom | pids | cpu | crashed | workspace_error`. */
  readonly terminationReason: string;
}

/**
 * The terminal write for an attempt. Scoped by `orgId` even though the id is unique:
 * every write in this codebase says which tenant it belongs to.
 */
export async function finalizeAttempt(input: {
  readonly orgId: string;
  readonly attemptId: string;
  readonly status: RunStatus;
  readonly simulated: boolean;
  readonly error?: ExecutionResult['error'] | undefined;
  readonly finishedAt?: Date;
  readonly resources?: AttemptResources;
}): Promise<void> {
  await db().executionAttempt.updateMany({
    where: { id: input.attemptId, orgId: input.orgId },
    data: {
      status: input.status,
      simulated: input.simulated,
      finishedAt: input.finishedAt ?? new Date(),
      ...(input.error === undefined ? {} : { error: { ...input.error } }),
      ...(input.resources === undefined
        ? {}
        : {
            executionProfile: input.resources.executionProfile,
            cpuTimeMs: input.resources.cpuTimeMs,
            memoryPeakBytes:
              input.resources.memoryPeakBytes === null
                ? null
                : BigInt(Math.max(0, Math.round(input.resources.memoryPeakBytes))),
            pidsPeak: input.resources.pidsPeak,
            terminationReason: input.resources.terminationReason,
          }),
    },
  });
}

/**
 * Whether this attempt's workspace bytes were reclaimed.
 *
 * Separate from `finalizeAttempt` on purpose: the run's outcome is decided before the
 * cleanup runs, and a cleanup that fails after a successful run must not rewrite the
 * run's status. That is the whole reason the column exists.
 */
export async function markAttemptCleanupState(input: {
  readonly orgId: string;
  readonly attemptId: string;
  readonly cleanupState: 'pending' | 'done' | 'failed' | 'skipped';
}): Promise<void> {
  await db().executionAttempt.updateMany({
    where: { id: input.attemptId, orgId: input.orgId },
    data: { cleanupState: input.cleanupState },
  });
}

/** `ExecutionResult.status` → the schema's `RunStatus`. One mapping, used everywhere. */
export const RUN_STATUS: Readonly<Record<ExecutionResult['status'], RunStatus>> = {
  succeeded: 'succeeded',
  failed: 'failed',
  timeout: 'timed_out',
  cancelled: 'cancelled',
};
