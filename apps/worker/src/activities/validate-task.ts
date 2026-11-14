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
 * The conditions, and the order in which `selectApprovalGrant` applies them:
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
 *   6. **Phase 5: the grant names this attempt.** `consumedByAttemptId` must equal the
 *      `attemptId` this workflow was started with, and that attempt must still be
 *      `queued`. Conditions 1–5 prove a reservation happened; this one proves **this
 *      run** made it. Without it a second workflow started with the same task id would
 *      find a live, consumed grant and proceed — the residual Phase 4 recorded.
 *
 * ## What condition 6 costs, and why the attempt must still be `queued`
 *
 * An attempt is reserved by `POST /run` exactly once and adopted by `startAttempt` when
 * the agent is about to run. A second execution therefore has two ways to be refused: its
 * `attemptId` does not match the grant (or is absent), or the attempt it names has already
 * been adopted. The only execution that passes both is the one holding the reservation
 * before anything has run under it — including a retry after the *workflow* failed before
 * dispatch, which is recovery of an unspent reservation rather than a second execution.
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
        // Phase 5. Who the grant was spent by — the column the API now fills in the same
        // transaction it creates the attempt.
        consumedByAttemptId: true,
        revokedAt: true,
        createdAt: true,
      },
    });

    const selection = selectApprovalGrant({
      approvals,
      expectedTaskContentHash,
      now: Date.now(),
    });

    if ('refusal' in selection) {
      // **Thrown, not returned.** A caller that started this workflow directly — no
      // API, no `POST /run` — must not be able to distinguish "refused" from "nothing
      // to do": the refusal is an exception that ends the workflow, and the details
      // carry the project id so the workflow can still write the audit event without a
      // second query. The API's own gate is checked first; this is the gate that cannot
      // be bypassed (Phase 3 §7, path 3).
      throw refusalFailure(selection.refusal, task);
    }

    const bindingRefusal = await evaluateAttemptBinding({
      orgId: input.orgId,
      taskId: task.id,
      approvalId: selection.approval.id,
      consumedByAttemptId: selection.approval.consumedByAttemptId ?? null,
      attemptId: input.attemptId,
    });

    if (bindingRefusal !== null) throw refusalFailure(bindingRefusal, task);
  }

  return { runnable: true, task };
}

/**
 * Phase 5: does the grant this task is holding name **this** attempt?
 *
 * Reads the attempt row only when one was named, and only inside the tenant and task the
 * workflow already proved it owns. Everything else is decided by the pure
 * `decideAttemptBinding`, so the order of the checks is reviewable in one screen.
 */
async function evaluateAttemptBinding(input: {
  readonly orgId: string;
  readonly taskId: string;
  readonly approvalId: string;
  readonly consumedByAttemptId: string | null;
  readonly attemptId: string | undefined;
}): Promise<ApprovalRefusal | null> {
  const attemptId = input.attemptId?.trim();

  // No attempt named: nothing to look up, and the grant cannot be shown to be this run's.
  // Checked before the query so a forged/absent id costs no database round trip.
  if (attemptId === undefined || attemptId.length === 0) {
    return decideAttemptBinding({
      approvalId: input.approvalId,
      consumedByAttemptId: input.consumedByAttemptId,
      attemptId: undefined,
      attemptStatus: undefined,
    });
  }

  const attempt = await db().executionAttempt.findFirst({
    // Tenant scoping plus the task: an attempt id from another organisation or another
    // task is not this execution's reservation.
    where: { id: attemptId, orgId: input.orgId, taskId: input.taskId },
    select: { status: true },
  });

  return decideAttemptBinding({
    approvalId: input.approvalId,
    consumedByAttemptId: input.consumedByAttemptId,
    attemptId,
    attemptStatus: attempt?.status ?? null,
  });
}

/**
 * The decision itself, as a pure function: one code per way the binding can fail.
 *
 * `attemptStatus` is `undefined` when no id was supplied and `null` when an id was
 * supplied but no attempt matched it. The distinction matters — "you named nothing" and
 * "you named something that does not exist here" are different incidents.
 */
export function decideAttemptBinding(input: {
  readonly approvalId: string;
  readonly consumedByAttemptId: string | null;
  readonly attemptId: string | undefined;
  readonly attemptStatus: string | null | undefined;
}): ApprovalRefusal | null {
  if (input.consumedByAttemptId === null) {
    // A Phase 4 row: consumed with no attempt link, because the attempt did not exist at
    // the time. It proves a reservation happened and nothing about who made it, so it
    // cannot authorise a specific execution. Refusing is the honest answer; inventing a
    // link now would assert an association nobody observed.
    return {
      code: 'APPROVAL_NOT_RESERVED',
      detail:
        `approval ${input.approvalId} was consumed without being bound to an execution ` +
        'attempt (a pre-Phase-5 reservation); a new approval is required',
    };
  }

  if (input.attemptId === undefined) {
    return {
      code: 'APPROVAL_NOT_RESERVED',
      detail:
        `approval ${input.approvalId} is reserved to an execution attempt, but this run ` +
        'named none; only the reservation holder can run it',
    };
  }

  if (input.attemptStatus === null) {
    return {
      code: 'APPROVAL_ATTEMPT_MISMATCH',
      detail:
        `attempt ${input.attemptId} does not exist for this task; approval ` +
        `${input.approvalId} is bound to a different attempt`,
    };
  }

  if (input.consumedByAttemptId !== input.attemptId) {
    return {
      code: 'APPROVAL_ATTEMPT_MISMATCH',
      detail:
        `approval ${input.approvalId} was spent by attempt ${input.consumedByAttemptId}, ` +
        `not by ${input.attemptId}`,
    };
  }

  if (input.attemptStatus !== 'queued') {
    // The reservation holder is already running, or has already run. A second execution
    // naming the same attempt is a replay of a spent reservation, not a retry.
    return {
      code: 'APPROVAL_ATTEMPT_MISMATCH',
      detail:
        `attempt ${input.attemptId} is "${input.attemptStatus}"; the reservation has ` +
        'already been taken, so this is a second execution of one grant',
    };
  }

  return null;
}

/** The refusal as the exception the workflow sees, with the details it needs to audit it. */
function refusalFailure(
  refusal: ApprovalRefusal,
  task: { readonly id: string; readonly projectId: string; readonly riskClass: string },
): Error {
  return nonRetryableWithDetails(
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

/** Every way an approval can fail to authorise this run. One code per condition. */
export type ApprovalRefusalCode =
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_NOT_RESERVED'
  | 'APPROVAL_REVOKED'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_UNBOUND'
  | 'APPROVAL_STALE'
  /**
   * Phase 5. The grant is bound to an attempt, and this run named a different one (or a
   * different attempt's reservation was already taken). Distinct from
   * `APPROVAL_NOT_RESERVED`, which means no attempt link exists at all — an operator
   * fixes the two differently.
   */
  | 'APPROVAL_ATTEMPT_MISMATCH';

export interface ApprovalCandidate {
  readonly id: string;
  readonly status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED' | 'EXPIRED' | 'REVOKED';
  readonly taskContentHash: string | null;
  readonly expiresAt: Date | null;
  readonly consumedAt: Date | null;
  /**
   * Phase 5: which attempt spent the grant. Optional in the type because the pure
   * selection below does not depend on it — the binding check is a separate decision
   * (`decideAttemptBinding`) that the caller makes once it knows which attempt this run
   * is. Absent therefore means "not read", never "no link".
   */
  readonly consumedByAttemptId?: string | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

export interface ApprovalRefusal {
  readonly code: ApprovalRefusalCode;
  readonly detail: string;
}

/**
 * The selection, returning the accepted candidate so the caller can go on to check the
 * Phase 5 attempt binding against it.
 *
 * `evaluateApprovalGrant` below is the same loop with the candidate thrown away; it stays
 * exported because "which grant applies" is a question worth testing on its own, and
 * because a caller that only needs a yes/no should not have to destructure a union.
 */
export function selectApprovalGrant(input: {
  readonly approvals: readonly ApprovalCandidate[];
  readonly expectedTaskContentHash: string;
  readonly now: number;
}): { readonly approval: ApprovalCandidate } | { readonly refusal: ApprovalRefusal } {
  for (const approval of input.approvals) {
    if (approval.status === 'REVOKED' || approval.revokedAt !== null) {
      return {
        refusal: {
          code: 'APPROVAL_REVOKED',
          detail: `approval ${approval.id} was revoked; a new approval is required`,
        },
      };
    }

    if (approval.status === 'EXPIRED') {
      return {
        refusal: {
          code: 'APPROVAL_EXPIRED',
          detail: `approval ${approval.id} expired; a new approval is required`,
        },
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
        refusal: {
          code: 'APPROVAL_EXPIRED',
          detail: `approval ${approval.id} expired at ${approval.expiresAt.toISOString()}; a new approval is required`,
        },
      };
    }

    // The API reservation is what makes the grant spendable. A direct workflow start
    // finds `consumedAt` null and is refused here — the grant is not this caller's to
    // spend, and the worker does not spend it.
    if (approval.consumedAt === null) {
      return {
        refusal: {
          code: 'APPROVAL_NOT_RESERVED',
          detail:
            `approval ${approval.id} has not been reserved by the API; a run that did not ` +
            'come through POST /run cannot spend it',
        },
      };
    }

    if (approval.taskContentHash === null) {
      // A Phase 3 row: approved before binding existed. It cannot be proven to be about
      // the content that exists now, so it is not usable. Refusing is the honest option;
      // back-filling a hash would assert something nobody observed.
      return {
        refusal: {
          code: 'APPROVAL_UNBOUND',
          detail: `approval ${approval.id} predates content binding and cannot authorise a run`,
        },
      };
    }

    if (approval.taskContentHash !== input.expectedTaskContentHash) {
      return {
        refusal: {
          code: 'APPROVAL_STALE',
          detail:
            `approval ${approval.id} was granted for different content, risk class, ` +
            'execution profile or source; a new approval is required',
        },
      };
    }

    return { approval };
  }

  return {
    refusal: {
      code: 'APPROVAL_REQUIRED',
      detail: 'no APPROVED approval request exists for it',
    },
  };
}

/**
 * The gate's verdict as a yes/no.
 *
 * Same conditions, same order, same codes as `selectApprovalGrant` — this is a thin
 * projection of it, not a second implementation.
 */
export function evaluateApprovalGrant(input: {
  readonly approvals: readonly ApprovalCandidate[];
  readonly expectedTaskContentHash: string;
  readonly now: number;
}): ApprovalRefusal | null {
  const selection = selectApprovalGrant(input);

  return 'refusal' in selection ? selection.refusal : null;
}
