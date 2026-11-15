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
 * with the grant. When no reserved attempt exists — a retry after a previous attempt was
 * adopted or finalized — it allocates `max + 1`, which is the Phase 3 behaviour and is
 * correct for that case. (A direct Temporal start with no reservation no longer reaches
 * this module: `validateTaskActivity` refuses it and `requireExecutionClaim` refuses it
 * again at the launch site, Phase 6 F3.)
 *
 * ## Why the adopted row is claimed with a compare-and-swap
 *
 * Two executions of one workflow run can reach this function with the same reservation.
 * The `updateMany` predicate (`status: 'queued'`, `agentRunId: null`,
 * `claimedByWorkflowRunId = thisRun`) makes exactly one of them win; the loser throws
 * before anything is provisioned. Falling through to a new attempt there would be the
 * residual this closes: one grant, two agents.
 *
 * Phase 6 added the claim conjunct. The first two predicates say "nobody has adopted
 * this row"; the claim says "and this row is *mine* to adopt". Without it, an execution
 * that reached this function without validating could adopt a row another execution had
 * claimed — the row would finish still naming its first claimant.
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
  /**
   * The Temporal run id of the execution that is starting this attempt — the same value
   * the claim was granted under.
   *
   * **Required, and load-bearing.** Adoption is a compare-and-swap over
   * `(status: 'queued', agentRunId: null)` *and* `claimedByWorkflowRunId = thisRun`.
   * Without the last conjunct an attempt claimed by execution X could be adopted and run
   * by execution Y: one reservation, two agents, with the row still naming X afterwards.
   * A default of `undefined` would silently restore exactly that, so there is no default.
   */
  readonly executionRunId: string;
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
          // This execution's claim, carried onto the new row. The alternative — a row
          // that ran with `claimedByWorkflowRunId` NULL — is what made `claimedAt`
          // unusable as an audit truth: an executing attempt would be indistinguishable
          // from one nobody ever authorised. The execution reached here only by holding
          // this task's claim (`requireExecutionClaim`), so stamping it asserts nothing
          // that was not already verified.
          claimedByWorkflowRunId: input.executionRunId,
          claimedAt: input.startedAt,
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
 * Claims the attempt `POST /run` reserved and this execution has already claimed, if
 * there is one.
 *
 * Returns `null` when this workflow run has no queued reservation — which is the honest
 * description of a retry after a previous attempt was adopted or finalized, and lets the
 * caller use the allocation path unchanged.
 *
 * A reservation that exists but cannot be claimed is **not** `null`: the only ways to lose
 * this compare-and-swap are another execution adopting the same row and this execution
 * naming a row it does not hold a claim on, and the correct answer to both is a refusal,
 * not a second attempt.
 */
async function adoptReservedAttempt(input: {
  readonly orgId: string;
  readonly taskId: string;
  readonly workflowRunId: string;
  readonly runtimeId: string;
  readonly simulated: boolean;
  readonly startedAt: Date;
  readonly executionRunId: string;
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
      // The claim is **deliberately not** in the read predicate, only in the write below.
      // If it were here, an execution that does not hold the reservation would simply not
      // find it — and would then fall through to allocating a fresh attempt, which is the
      // wrong answer: it would turn "this row is not yours" into "you have no row" and let
      // a non-owner run *something*. Finding the row and failing the CAS refuses instead.
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
      // The CAS. Every predicate is load-bearing: `status` stops a second adoption,
      // `agentRunId` stops adoption of an attempt that already produced a run, and
      // `claimedByWorkflowRunId` stops an execution taking a row it does not hold — the
      // `findFirst` above is a hint, this write is the decision.
      status: 'queued',
      agentRunId: null,
      claimedByWorkflowRunId: input.executionRunId,
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
