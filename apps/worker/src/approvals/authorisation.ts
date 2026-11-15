import { requiresApproval, type RiskClass, type TaskStatus } from '@intelligenz/contracts';

import { db, nonRetryableWithDetails } from '../activities/support';
import { computeTaskContentHash, readTaskBinding, resolveBinding } from './task-binding';

/**
 * The approval-and-risk gate, as **one** function with **two** call sites.
 *
 * ## Why this module exists
 *
 * Until Phase 6 the gate existed only inside `validateTaskActivity`. That was enough
 * while validation was unavoidable, and it stopped being enough the moment the phase
 * record claimed the reservation was honoured "by the execution path": the executor is
 * a separate, separately-dispatchable activity (`activities/index.ts`), so a workflow on
 * the worker's task queue can call it without ever calling validation. Copying the gate
 * into the executor would have produced two gates that agree until one is edited —
 * exactly the failure `../approvals/task-binding.ts` exists to prevent for the hash.
 *
 * So the checks live here and both activities import them:
 *
 *   - `validateTaskActivity` — `altitude: 'reservation'`, before anything has run.
 *   - `executeAgentActivity` — `altitude: 'launch'`, at the only path to `runtime.execute`.
 *
 * ## The conditions, and the order `selectApprovalGrant` applies them
 *
 *   1. `revokedAt IS NULL` and `status <> 'REVOKED'` — a revocation wins, and a revocation
 *      newer than a grant vetoes it rather than falling back to the older row.
 *   2. `expiresAt` in the future (or absent — only pre-Phase-4 rows, refused as unbound
 *      below).
 *   3. `status = 'APPROVED'`.
 *   4. `consumedAt IS NOT NULL` — the API reservation must already have happened.
 *   5. `taskContentHash` present and equal to the hash of the task **as it is now**.
 *   6. **The grant names this attempt** (`consumedByAttemptId === attemptId`) and, at
 *      reservation altitude, that attempt is still `queued`.
 *
 * ## Why condition 6's `queued` clause is altitude-dependent
 *
 * The clause is a *proxy* for "no second execution has taken this reservation". At
 * reservation altitude nothing has run yet and the proxy is exact. At launch altitude it
 * is wrong in the one case that must keep working: a Temporal retry of the executor for
 * an execution that already adopted its attempt (the row is `running`), or that crashed
 * after finalizing it (the row is terminal). The execution claim — verified by
 * `requireExecutionClaim` before this function is called — is the *exact* control for
 * "one attempt authorises one execution", so at launch altitude the grant→attempt link
 * is checked without the status proxy. This is a narrowing of the check, not a removal:
 * a different execution cannot reach this point at all, because it cannot hold the claim.
 *
 * ## Refusals are exceptions with a specific code
 *
 * A returned `{ runnable: false }` would be a result a caller could ignore. A thrown
 * `ApplicationFailure` ends the workflow, its `type` becomes the audit event's `code`,
 * and its `details` carry the project id so the workflow can write that event without a
 * second query.
 */

/** The task fields the gate reads. A subset of the row; never the goal's output. */
export interface AuthorisableTask {
  readonly id: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly title: string;
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
  readonly riskClass: RiskClass;
  /**
   * The derived class is the effective one; `riskClass` is the fallback for fixture and
   * pre-Phase-4 rows, where the two are the same by construction. Using the wrong one
   * would compute a different hash than the API did.
   */
  readonly derivedRiskClass: RiskClass | null;
  readonly riskFactors: unknown;
  readonly status: TaskStatus;
}

/**
 * Which invariant the caller is enforcing.
 *
 * `reservation` — validation, before dispatch: the attempt must still be `queued`.
 * `launch` — execution, at the only launch site: the claim has already proved this
 * execution owns the attempt, so only the grant→attempt link is re-checked.
 */
export type AuthorisationAltitude = 'reservation' | 'launch';

export interface TaskAuthorisationInput {
  readonly task: AuthorisableTask;
  readonly attemptId: string | undefined;
  readonly altitude: AuthorisationAltitude;
  /** Injectable clock, for the pure decisions' tests. Production reads the wall clock. */
  readonly now?: number;
}

/**
 * Throws the typed refusal when the task's current state is not authorised to run, and
 * returns silently when it is. Never returns a "veto" value: a gate whose answer can be
 * ignored is not a gate.
 */
export async function assertTaskAuthorised(input: TaskAuthorisationInput): Promise<void> {
  // The class that decides whether a grant is needed is the same one validation uses —
  // the stored class, which the API derives server-side. The hash below uses the
  // derived class, exactly as the API did when it minted the grant.
  if (!requiresApproval(input.task.riskClass)) return;

  const binding = resolveBinding(readTaskBinding(input.task.riskFactors), undefined);

  const expectedTaskContentHash = computeTaskContentHash({
    title: input.task.title,
    goal: input.task.goal,
    acceptanceCriteria: input.task.acceptanceCriteria,
    riskClass: input.task.derivedRiskClass ?? input.task.riskClass,
    executionProfile: binding.executionProfile,
    sourceRef: binding.sourceRef,
    baseCommit: binding.baseCommit,
  });

  const approvals = await db().approvalRequest.findMany({
    // Tenant scoping, and newest first: after a re-approval the newest grant is the one
    // that applies. Reading only `status: 'APPROVED'` would hide a newer revocation,
    // which is the one row that must be seen.
    where: { orgId: input.task.orgId, taskId: input.task.id },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      status: true,
      taskContentHash: true,
      expiresAt: true,
      consumedAt: true,
      // Phase 5: who the grant was spent by — the column the API fills in the same
      // transaction it creates the attempt.
      consumedByAttemptId: true,
      revokedAt: true,
      createdAt: true,
    },
  });

  const selection = selectApprovalGrant({
    approvals,
    expectedTaskContentHash,
    now: input.now ?? Date.now(),
  });

  if ('refusal' in selection) throw refusalFailure(selection.refusal, input.task);

  // A blank id is "named nothing", not "named something that does not exist": the two
  // produce different refusal codes, and whitespace is not an identifier.
  const named = input.attemptId?.trim();
  const attemptId = named === undefined || named.length === 0 ? undefined : named;

  const attempt =
    attemptId === undefined
      ? undefined
      : await db().executionAttempt.findFirst({
          // Tenant scoping plus the task: an attempt id from another organisation or
          // another task is not this execution's reservation.
          where: { id: attemptId, orgId: input.task.orgId, taskId: input.task.id },
          select: { status: true },
        });

  const bindingRefusal = decideGrantBinding({
    approvalId: selection.approval.id,
    consumedByAttemptId: selection.approval.consumedByAttemptId ?? null,
    attemptId,
    // `undefined` = not named (checked before the query); `null` = named but not found.
    attemptStatus: attempt === undefined ? undefined : (attempt?.status ?? null),
    altitude: input.altitude,
  });

  if (bindingRefusal !== null) throw refusalFailure(bindingRefusal, input.task);
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
  readonly status:
    'PENDING' | 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED' | 'EXPIRED' | 'REVOKED';
  readonly taskContentHash: string | null;
  readonly expiresAt: Date | null;
  readonly consumedAt: Date | null;
  /**
   * Phase 5: which attempt spent the grant. Optional in the type because the pure
   * selection below does not depend on it — the binding check is a separate decision
   * (`decideGrantBinding`) that the caller makes once it knows which attempt this run
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

/**
 * Phase 5: is the grant this task is holding bound to **this** attempt?
 *
 * The reservation-altitude question, unchanged since Phase 5 and still the one
 * `validateTaskActivity` asks. `decideGrantBinding` below carries the altitude; this
 * wrapper keeps the Phase 5 name, signature and tests intact.
 */
export function decideAttemptBinding(input: {
  readonly approvalId: string;
  readonly consumedByAttemptId: string | null;
  readonly attemptId: string | undefined;
  readonly attemptStatus: string | null | undefined;
}): ApprovalRefusal | null {
  return decideGrantBinding({ ...input, altitude: 'reservation' });
}

/**
 * The decision itself, as a pure function: one code per way the binding can fail.
 *
 * `attemptStatus` is `undefined` when no id was supplied and `null` when an id was
 * supplied but no attempt matched it. The distinction matters — "you named nothing" and
 * "you named something that does not exist here" are different incidents.
 */
export function decideGrantBinding(input: {
  readonly approvalId: string;
  readonly consumedByAttemptId: string | null;
  readonly attemptId: string | undefined;
  readonly attemptStatus: string | null | undefined;
  readonly altitude: AuthorisationAltitude;
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

  if (input.altitude === 'reservation' && input.attemptStatus !== 'queued') {
    // The reservation holder is already running, or has already run. A second execution
    // naming the same attempt is a replay of a spent reservation, not a retry.
    //
    // Not applied at launch altitude: the execution that reaches the launch site has
    // already proved it holds the claim, and a retry of that same execution legitimately
    // re-enters with the attempt `running` or terminal. The claim is the exact control
    // there; this status test is the reservation-altitude proxy for it.
    return {
      code: 'APPROVAL_ATTEMPT_MISMATCH',
      detail:
        `attempt ${input.attemptId} is "${input.attemptStatus}"; the reservation has ` +
        'already been taken, so this is a second execution of one grant',
    };
  }

  return null;
}

/** The refusal as the exception the caller sees, with the details it needs to audit it. */
export function refusalFailure(
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
