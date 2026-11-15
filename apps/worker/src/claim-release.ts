import type { PrismaClient } from '@intelligenz/database';

import { deterministicId } from './activities/ids';
import { workerIdentity } from './identity';
import { workerLogger } from './log';

/**
 * Releasing a stranded execution claim — Phase 6, F4.
 *
 * ## The state this exists for
 *
 * `validateTaskActivity` claims an attempt (`queued` + `claimedByWorkflowRunId`), and
 * `startAttempt` adopts it moments later. A worker that dies in between — or a workflow
 * that is terminated after validation — leaves the attempt `queued` **and claimed** by a
 * workflow run that no longer exists.
 *
 * Phase 6 made that state worse on purpose. Before the fix, adoption ignored the claim,
 * so a second execution could still pick the row up; that "recovery" was the F2 bypass.
 * Once adoption requires the claim, nothing can adopt a stranded row — so without a
 * release path, fixing F2 would convert a bypass into a permanent wedge. This module is
 * the release path, and it ships with the fix, not after it.
 *
 * ## When it may release, and when it may not
 *
 * **Only when the claim's workflow run is provably gone.** The age of the claim selects
 * *candidates*; it never decides a release. For every candidate, Temporal is asked about
 * that specific execution (`describeWorkflowExecution`, by workflow id **and** run id):
 *
 * | Temporal says | Outcome |
 * |---|---|
 * | not found | release — there is no such execution |
 * | terminal (completed / failed / terminated / timed out / cancelled) | release — it ended without adopting |
 * | running / continued-as-new | **skip** — the execution may still adopt, and reaping a live claim destroys work |
 * | unreachable / other error | **skip** — doubt is not evidence |
 *
 * A timer alone is never sufficient: a slow workflow is not an absent one.
 *
 * ## What a release does to the row, and why it is not just "clear the column"
 *
 * The attempt is failed (`ATTEMPT_ABANDONED`, `terminationReason: 'crashed'`) in the same
 * conditional write that clears the claim. Leaving it `queued` and unclaimed would assert
 * that the reservation is still unspent and available — which is a statement about a
 * moment that has passed; the execution it belonged to is gone and the reservation was
 * consumed by `POST /run`. A terminal row is the honest record: one execution was
 * authorised, it never ran, and here is the evidence.
 *
 * `claimedAt` is cleared with the holder. `NULL` in both columns keeps its documented
 * meaning — "never claimed" — with the release recorded in the audit trail instead of
 * disguised as an unclaimed row with a suspicious timestamp.
 *
 * ## Why this is not reachable from the launch path
 *
 * This module is imported by the reaper and by tests, and by nothing under
 * `src/activities/`. It is not an activity, not exported from the activity registry, and
 * the launch path has no reference to it — `test/execution-boundary.test.ts` asserts that
 * structurally, so a future import cannot quietly hand an execution the ability to
 * release its own claim.
 */

/** The two answers this pass needs from the orchestrator. Structurally the reaper's probe. */
export interface ClaimReleaseProbe {
  execution(taskId: string, workflowRunId: string): Promise<WorkflowLivenessLike>;
}

/** Mirrors `WorkflowLiveness`; declared here so this module does not import the reaper. */
export type WorkflowLivenessLike = 'active' | 'finished' | 'absent' | 'unknown';

export interface ClaimReleaseDeps {
  readonly prisma: PrismaClient;
  readonly probe: ClaimReleaseProbe;
  readonly intervalMs: number;
  readonly now?: () => Date;
  readonly batchSize?: number;
}

export type ClaimReleaseOutcome =
  'released' | 'skipped_live' | 'skipped_unknown' | 'skipped_fresh' | 'lost_race';

export interface ClaimReleaseAction {
  readonly attemptId: string;
  readonly taskId: string;
  readonly workflowRunId: string;
  readonly outcome: ClaimReleaseOutcome;
  readonly reason: string;
}

export interface ClaimReleaseResult {
  readonly scanned: number;
  readonly actions: readonly ClaimReleaseAction[];
  readonly errored: number;
}

const DEFAULT_BATCH_SIZE = 50;

/**
 * One pass. Exported so the reaper's tick and the tests can run it synchronously instead
 * of waiting for a timer.
 */
export async function runClaimReleasePass(deps: ClaimReleaseDeps): Promise<ClaimReleaseResult> {
  const now = deps.now ?? ((): Date => new Date());
  const cutoff = new Date(now().getTime() - deps.intervalMs * 2);

  const candidates = await deps.prisma.executionAttempt.findMany({
    where: {
      // Only the stranded shape: reserved, never adopted, still holding a claim.
      status: 'queued',
      claimedByWorkflowRunId: { not: null },
      // A candidate filter, not a decision. A claim younger than two reaper intervals is
      // not even looked at, because the workflow that holds it may not have reached
      // `startAttempt` yet and `describe` on a brand-new execution is not evidence either
      // way.
      claimedAt: { lt: cutoff },
    },
    orderBy: { claimedAt: 'asc' },
    take: deps.batchSize ?? DEFAULT_BATCH_SIZE,
    select: {
      id: true,
      orgId: true,
      taskId: true,
      claimedByWorkflowRunId: true,
      claimedAt: true,
    },
  });

  const actions: ClaimReleaseAction[] = [];
  let errored = 0;

  for (const candidate of candidates) {
    const workflowRunId = candidate.claimedByWorkflowRunId;

    // Narrowed by the query's `not: null`, restated for the type system rather than with
    // a non-null assertion: a schema change that admitted null here would be a bug, not
    // a reason to crash a reaper pass.
    if (workflowRunId === null) continue;

    try {
      const liveness = await deps.probe.execution(candidate.taskId, workflowRunId);

      if (liveness === 'active') {
        actions.push({
          attemptId: candidate.id,
          taskId: candidate.taskId,
          workflowRunId,
          outcome: 'skipped_live',
          reason: `workflow run ${workflowRunId} is still running; the claim may still be adopted`,
        });
        continue;
      }

      if (liveness === 'unknown') {
        actions.push({
          attemptId: candidate.id,
          taskId: candidate.taskId,
          workflowRunId,
          outcome: 'skipped_unknown',
          reason: 'Temporal did not answer; refusing to release a claim on doubt',
        });
        continue;
      }

      const claimedAt = candidate.claimedAt ?? cutoff;
      const executed = await releaseClaim(deps, {
        attemptId: candidate.id,
        orgId: candidate.orgId,
        taskId: candidate.taskId,
        workflowRunId,
        liveness,
        claimedAt,
        now: now(),
      });

      if (executed) {
        actions.push({
          attemptId: candidate.id,
          taskId: candidate.taskId,
          workflowRunId,
          outcome: 'released',
          reason:
            liveness === 'absent'
              ? `Temporal reports no execution for run ${workflowRunId}`
              : `Temporal reports run ${workflowRunId} finished without adopting the attempt`,
        });
      } else {
        // The row moved between the read and the write (adopted, failed elsewhere, or
        // re-claimed). Nothing to do, and nothing to report as a release.
        actions.push({
          attemptId: candidate.id,
          taskId: candidate.taskId,
          workflowRunId,
          outcome: 'lost_race',
          reason: 'the attempt changed after it was read; no release was written',
        });
      }
    } catch (error) {
      errored += 1;
      workerLogger().error(
        {
          attemptId: candidate.id,
          taskId: candidate.taskId,
          workflowRunId,
          err: error instanceof Error ? error.message : String(error),
        },
        'claim release failed for one attempt; continuing',
      );
    }
  }

  return { scanned: candidates.length, actions, errored };
}

/**
 * The release itself: one conditional write, the audit row in the same transaction.
 *
 * The predicate is the whole safety argument. It requires the row to still be `queued`
 * and still be claimed *by the run we just proved absent* — so a claim that moved, or an
 * attempt that was adopted between the read and this write, is a no-op rather than a
 * release of somebody else's authority.
 */
async function releaseClaim(
  deps: ClaimReleaseDeps,
  input: {
    readonly attemptId: string;
    readonly orgId: string;
    readonly taskId: string;
    readonly workflowRunId: string;
    readonly liveness: 'absent' | 'finished';
    readonly claimedAt: Date;
    readonly now: Date;
  },
): Promise<boolean> {
  const released = await deps.prisma.$transaction(async (transaction) => {
    const updated = await transaction.executionAttempt.updateMany({
      where: {
        id: input.attemptId,
        orgId: input.orgId,
        taskId: input.taskId,
        status: 'queued',
        claimedByWorkflowRunId: input.workflowRunId,
      },
      data: {
        status: 'failed',
        finishedAt: input.now,
        terminationReason: 'crashed',
        // Nothing was ever provisioned for a `queued` attempt, so there are no bytes to
        // clean up. `skipped` says that, rather than `pending` promising a sweep.
        cleanupState: 'skipped',
        error: {
          code: 'ATTEMPT_ABANDONED',
          message:
            'The execution that claimed this attempt no longer exists and never adopted ' +
            'it. Recorded by the reaper; no agent process was started.',
          retryable: false,
        },
        claimedByWorkflowRunId: null,
        claimedAt: null,
      },
    });

    if (updated.count !== 1) return false;

    await transaction.auditEvent.create({
      data: {
        id: deterministicId(`execution-claim-released:${input.attemptId}:${input.workflowRunId}`),
        orgId: input.orgId,
        // A system decision: no person and no agent released this claim, the reaper did.
        actorType: 'system',
        actorId: `reaper:${workerIdentity()}`,
        action: 'execution.claim_released',
        aggregateType: 'ExecutionAttempt',
        aggregateId: input.attemptId,
        eventType: 'execution.claim_released.v1',
        correlationId: input.workflowRunId,
        idempotencyKey: `execution.claim_released.v1:${input.attemptId}:${input.workflowRunId}`,
        payload: {
          taskId: input.taskId,
          attemptId: input.attemptId,
          workflowRunId: input.workflowRunId,
          // The evidence for the release, recorded because "the reaper decided so" is not
          // an audit trail. `absent` and `finished` are the only two admitted here.
          liveness: input.liveness,
          claimedAt: input.claimedAt.toISOString(),
          heldForMs: Math.max(0, input.now.getTime() - input.claimedAt.getTime()),
          releasedAt: input.now.toISOString(),
          worker: workerIdentity(),
        },
        occurredAt: input.now,
      },
      select: { id: true },
    });

    return true;
  });

  if (released) {
    workerLogger().warn(
      {
        attemptId: input.attemptId,
        taskId: input.taskId,
        workflowRunId: input.workflowRunId,
        liveness: input.liveness,
      },
      'released a stranded execution claim: the claiming workflow run is gone',
    );
  }

  return released;
}
