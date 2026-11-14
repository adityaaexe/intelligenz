import { requiresApproval } from '@intelligenz/contracts';

import type {
  ValidateTaskActivityInput,
  ValidateTaskActivityResult,
} from '../shared/contracts';
import { computeTaskContentHash, readTaskBinding, resolveBinding } from '../approvals/task-binding';
import { db, nonRetryableWithDetails } from './support';

/**
 * `validateTaskActivity` — contract §16.
 *
 * The gate the API enforces, enforced again where the work actually starts. Two checks
 * that must agree is not redundancy when the second one cannot be bypassed: the API can
 * be wrong, a client can start a workflow directly, and a task can be cancelled or
 * approved in the window between `POST /run` and the first workflow task.
 *
 * Returns a discriminated result rather than throwing for domain outcomes: "this task
 * is already cancelled" is information the workflow acts on, not an exception to
 * retry.
 *
 * ## The approval conditions, and why the worker repeats all of them
 *
 * Until Phase 4 this activity asked one question — "is there an `APPROVED` row?" — while
 * the API asked five. That made the worker's copy of the gate *weaker* than the API's,
 * which is the wrong direction: the worker is the last line of defence, and the caller
 * it defends against is not the API at all. `POST /run` is an HTTP route with a
 * middleware stack; `runTaskWorkflow` is a Temporal workflow that anything holding the
 * frontend address can start. A `PENDING`-to-`APPROVED` flip is not the only way a row
 * can be unusable, and `status` is not the only column that matters.
 *
 * The conditions, and the order in which `evaluateApprovalGrant` applies them:
 *
 *   1. `revokedAt IS NULL` and `status <> 'REVOKED'` — a revocation wins, and a revocation
 *      newer than a grant vetoes it rather than falling back to the older row.
 *   2. `expiresAt` in the future (or absent, which only pre-Phase-4 rows are — and those
 *      are refused as unbound below regardless).
 *   3. `status = 'APPROVED'`.
 *   4. `consumedAt IS NOT NULL` — **the API reservation must already have happened.**
 *      This is the condition that makes a direct Temporal start useless: `POST /run`
 *      spends the grant in a compare-and-swap before it queues the workflow, so a run
 *      that never went through `POST /run` finds an unconsumed grant and is refused.
 *      The worker deliberately does **not** consume here. Consumption is the API's
 *      single-writer responsibility, and a second writer would turn a single-use grant
 *      into two.
 *   5. `taskContentHash` present and equal to the hash of the task **as it is now** —
 *      the same preimage the API hashed, imported rather than re-implemented (see
 *      `../approvals/task-binding`). A grant issued for different content is not a grant
 *      for this content.
 *
 * ## Refusals are exceptions, with a specific code
 *
 * A returned `runnable: false` would be a result the workflow could ignore. A thrown
 * `ApplicationFailure` ends the workflow, and its `type` becomes the audit event's
 * `code`. `APPROVAL_REQUIRED` alone would tell an operator nothing; `APPROVAL_NOT_RESERVED`
 * says "this run did not come through the API", `APPROVAL_STALE` says "the task changed
 * after it was approved", and those are different incidents.
 *
 * ## Residual
 *
 * A row with a hash and a null `expiresAt` — which the API never writes, because it sets
 * the expiry at creation — is treated as unexpired here. The API applies its configured
 * TTL to that shape; the worker does not carry a second copy of that policy, and a row
 * that only manual database access can produce is not worth a divergent constant.
 */
export async function validateTaskActivity(
  input: ValidateTaskActivityInput,
): Promise<ValidateTaskActivityResult> {
  const task = await db().task.findFirst({
    // Tenant scoping: a task id from another organisation resolves to null, exactly as
    // the API's 404 does. There is no path through this activity to a foreign row.
    where: { id: input.taskId, orgId: input.orgId },
    select: {
      id: true,
      orgId: true,
      projectId: true,
      title: true,
      goal: true,
      acceptanceCriteria: true,
      riskClass: true,
      // The derived class is the effective one; `riskClass` is the fallback for fixture
      // and pre-Phase-4 rows, where the two are the same by construction. Using the
      // wrong one here would compute a different hash than the API did.
      derivedRiskClass: true,
      riskFactors: true,
      status: true,
    },
  });

  if (task === null) {
    return {
      runnable: false,
      reason: 'not_found',
      detail: `Task ${input.taskId} does not exist in organisation ${input.orgId}.`,
    };
  }

  if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') {
    return {
      runnable: false,
      reason: 'already_terminal',
      status: task.status,
      projectId: task.projectId,
      detail: `Task ${task.id} is already ${task.status}; nothing to run.`,
    };
  }

  // `ready` is accepted as well as `queued`: a client may start the workflow without
  // going through `POST /run`, which is the only API path that queues the task.
  if (task.status !== 'queued' && task.status !== 'ready') {
    return {
      runnable: false,
      reason: 'not_runnable',
      status: task.status,
      projectId: task.projectId,
      detail: `Task ${task.id} is "${task.status}". Only queued or ready tasks can run.`,
    };
  }

  if (requiresApproval(task.riskClass)) {
    const binding = resolveBinding(readTaskBinding(task.riskFactors), undefined);

    const expectedTaskContentHash = computeTaskContentHash({
      title: task.title,
      goal: task.goal,
      acceptanceCriteria: task.acceptanceCriteria,
      riskClass: task.derivedRiskClass ?? task.riskClass,
      executionProfile: binding.executionProfile,
      sourceRef: binding.sourceRef,
      baseCommit: binding.baseCommit,
    });

    const approvals = await db().approvalRequest.findMany({
      // Tenant scoping, and newest first: after a re-approval the newest grant is the
      // one that applies. Reading only `status: 'APPROVED'` would hide a newer
      // revocation, which is the one row that must be seen.
      where: { orgId: input.orgId, taskId: task.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        taskContentHash: true,
        expiresAt: true,
        consumedAt: true,
        revokedAt: true,
        createdAt: true,
      },
    });

    const refusal = evaluateApprovalGrant({
      approvals,
      expectedTaskContentHash,
      now: Date.now(),
    });

    if (refusal !== null) {
      // **Thrown, not returned.** A caller that started this workflow directly — no
      // API, no `POST /run` — must not be able to distinguish "refused" from "nothing
      // to do": the refusal is an exception that ends the workflow, and the details
      // carry the project id so the workflow can still write the audit event without a
      // second query. The API's own gate is checked first; this is the gate that cannot
      // be bypassed (Phase 3 §7, path 3).
      throw nonRetryableWithDetails(
        refusal.code,
        `Task ${task.id} is ${task.riskClass} and ${refusal.detail}`,
        {
          // `reason` keeps the historical vocabulary (`approval_required`) so an existing
          // consumer switching on it does not break; `code` is the precise answer.
          reason: 'approval_required',
          code: refusal.code,
          taskId: task.id,
          projectId: task.projectId,
          riskClass: task.riskClass,
        },
      );
    }
  }

  return { runnable: true, task };
}

/** Every way an approval can fail to authorise this run. One code per condition. */
export type ApprovalRefusalCode =
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_NOT_RESERVED'
  | 'APPROVAL_REVOKED'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_UNBOUND'
  | 'APPROVAL_STALE';

export interface ApprovalCandidate {
  readonly id: string;
  readonly status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED' | 'EXPIRED' | 'REVOKED';
  readonly taskContentHash: string | null;
  readonly expiresAt: Date | null;
  readonly consumedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

export interface ApprovalRefusal {
  readonly code: ApprovalRefusalCode;
  readonly detail: string;
}

/**
 * The gate itself, as a pure function.
 *
 * Pure so the five conditions can be exercised without a database, and so the order in
 * which they are applied is a thing a reviewer can read in one screen. The caller owns
 * the query and the exception; this owns the decision.
 *
 * ## Newest first, and no fall-through past an `APPROVED` row
 *
 * Rows arrive newest-first. A `REVOKED` or `EXPIRED` row encountered on the way is a hard
 * veto: the newest word on this task's approval history is "no", and an older grant must
 * not override it.
 *
 * The first `APPROVED` row is the **candidate** and its verdict is final. Older
 * `APPROVED` rows are not considered, because under the reservation rule an older one
 * has necessarily been spent already — a comment in the API's gate calls out the same
 * shape ("after a re-approval the newest grant is the one that applies"). Falling through
 * to it would authorise a second execution from a single-use grant, which is the one
 * property consumption exists to guarantee.
 */
export function evaluateApprovalGrant(input: {
  readonly approvals: readonly ApprovalCandidate[];
  readonly expectedTaskContentHash: string;
  readonly now: number;
}): ApprovalRefusal | null {
  for (const approval of input.approvals) {
    if (approval.status === 'REVOKED' || approval.revokedAt !== null) {
      return {
        code: 'APPROVAL_REVOKED',
        detail: `approval ${approval.id} was revoked; a new approval is required`,
      };
    }

    if (approval.status === 'EXPIRED') {
      return {
        code: 'APPROVAL_EXPIRED',
        detail: `approval ${approval.id} expired; a new approval is required`,
      };
    }

    // PENDING, REJECTED and CHANGES_REQUESTED explain nothing that `APPROVAL_REQUIRED`
    // does not already say. They are not live grants, and they do not veto an older
    // approved one: a re-approval request sits in the table as PENDING while the grant
    // it replaces is still the one that applies.
    if (approval.status !== 'APPROVED') continue;

    // From here the answer is about this row. Every failure is a refusal, never a reason
    // to look further down the history.
    if (approval.expiresAt !== null && approval.expiresAt.getTime() <= input.now) {
      return {
        code: 'APPROVAL_EXPIRED',
        detail: `approval ${approval.id} expired at ${approval.expiresAt.toISOString()}; a new approval is required`,
      };
    }

    // The API reservation is what makes the grant spendable. A direct workflow start
    // finds `consumedAt` null and is refused here — the grant is not this caller's to
    // spend, and the worker does not spend it.
    if (approval.consumedAt === null) {
      return {
        code: 'APPROVAL_NOT_RESERVED',
        detail:
          `approval ${approval.id} has not been reserved by the API; a run that did not ` +
          'come through POST /run cannot spend it',
      };
    }

    if (approval.taskContentHash === null) {
      // A Phase 3 row: approved before binding existed. It cannot be proven to be about
      // the content that exists now, so it is not usable. Refusing is the honest option;
      // back-filling a hash would assert something nobody observed.
      return {
        code: 'APPROVAL_UNBOUND',
        detail: `approval ${approval.id} predates content binding and cannot authorise a run`,
      };
    }

    if (approval.taskContentHash !== input.expectedTaskContentHash) {
      return {
        code: 'APPROVAL_STALE',
        detail:
          `approval ${approval.id} was granted for different content, risk class, ` +
          'execution profile or source; a new approval is required',
      };
    }

    return null;
  }

  return {
    code: 'APPROVAL_REQUIRED',
    detail: 'no APPROVED approval request exists for it',
  };
}
