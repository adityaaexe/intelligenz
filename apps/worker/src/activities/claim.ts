import { Context } from '@temporalio/activity';
import type { Prisma } from '@intelligenz/database';

import type { CompleteTaskActivityInput } from '../shared/contracts';
import { WORKFLOW_ID_PREFIX } from '../config';
import { workerLogger } from '../log';
import { AGENT_ACTOR_ID } from '../shared/actors';
import { db, nonRetryableWithDetails } from './support';

/**
 * The one-shot execution claim — Phase 6, AG-601.
 *
 * ## The defect this closes
 *
 * `validateTaskActivity` was a **read**: it asked "does the grant name this attempt, and
 * is that attempt still `queued`?" and wrote nothing. Two executions holding the same
 * genuine `attemptId` could therefore both read `queued`, both pass, and both walk
 * toward execution authority. The only thing preventing two agents was Temporal's
 * workflow-id dedupe — a property of the caller's workflow id, not of the attempt.
 *
 * ## The fix: authority is a write, not a read
 *
 * One conditional statement decides it:
 *
 * ```sql
 * UPDATE "ExecutionAttempt"
 *    SET "claimedByWorkflowRunId" = $run, "claimedAt" = $now
 *  WHERE id = $attempt AND "orgId" = $org AND "taskId" = $task
 *    AND status = 'queued' AND "claimedByWorkflowRunId" IS NULL
 * ```
 *
 * `count === 1` is the grant. `count === 0` means somebody else got there first — or the
 * row is not what this caller thinks it is — and the read-back below decides which.
 * There is deliberately no read-then-write anywhere in this module: a read followed by a
 * write is exactly the window the defect lived in.
 *
 * Under PostgreSQL's default READ COMMITTED, the loser of a concurrent pair blocks on the
 * row lock, then re-evaluates the predicate against the *committed* row version
 * (EvalPlanQual) and matches nothing. That is what makes "exactly one winner" a property
 * of the database rather than of the application's timing.
 *
 * ## Identity: the orchestrator's run id, never the caller's word
 *
 * The claim key is Temporal's run id, read from the **activity context**
 * (`Context.current().info.workflowExecution.runId`) — not from an activity input field.
 * An input field is a parameter, and a parameter can be forged by anything that can start
 * a workflow. The context is set by the server that dispatched this activity attempt.
 *
 * It is the right key because it is stable across activity retries within one execution
 * (an activity retry keeps its workflow run) and distinct for a duplicate execution (a
 * second execution is a second run id even when it carries the same workflow id, and
 * certainly when it carries a different one). Process ids, hostnames and activity attempt
 * numbers are none of those things: a retry runs in a new process, and the attempt number
 * *changes* on the retry it is supposed to recognise.
 *
 * **There is no fallback, and this is the Phase 6 re-review's N1.** Until AG-603 this
 * function returned a caller-supplied `workflowRunId` when no activity context existed.
 * That made the launch-site gate satisfiable by an *input field*: a standalone activity
 * (`Client.activity` — no workflow execution, so no context run id) supplied a victim's
 * run id and the gate accepted the claim written under that id. The reviewer ran it twice:
 * with the victim already adopted it created attempt 2 under the victim's claim and ran
 * concurrently; with the victim not yet adopted it spent attempt 1, so the legitimate
 * execution was refused afterwards. Both values are readable from workflow history by
 * anyone with Temporal access, which is the register's own stated O1 precondition.
 *
 * The fallback is gone. A call with no workflow execution has no identity to offer and is
 * refused (`EXECUTION_IDENTITY_UNAVAILABLE`) before it can touch a row. The only things
 * that can produce the value now are the Temporal server and the SDK's context, and
 * neither reads it from the caller's input.
 *
 * ## Idempotency: a retry of the same execution is not a second execution
 *
 * `count === 0` is not automatically a refusal. If the read-back shows
 * `claimedByWorkflowRunId === thisRun`, this execution already holds the claim: an
 * activity retry (Temporal re-runs an activity that failed *after* the claim committed)
 * must proceed, not be told it is a duplicate of itself. `claimedAt` is not rewritten —
 * the claim is write-once, which is what makes `claimedAt` the moment authority was
 * granted rather than the moment it was last observed.
 *
 * ## What it does not try to be
 *
 * The claim does not authenticate the caller. Two genuine holders of one reservation are
 * both legitimate in every other respect; the claim's job is to make sure only one of
 * them runs. Who wins the race is whoever writes first.
 *
 * ## Audit
 *
 * Three outcomes, three event types, all on `ExecutionAttempt`:
 *
 *   - `execution.claim_granted.v1` — written **in the same transaction** as the grant, so
 *     a claim cannot exist without its record and a record cannot exist without the claim.
 *   - `execution.claim_retry.v1` — this run already owned it; carries the original
 *     `claimedAt`, so the moment of the grant survives even if the granted event's own
 *     write was lost to a crash between transactions (it cannot be: they are one).
 *   - `execution.claim_duplicate.v1` / `execution.claim_refused.v1` — a refusal. Written
 *     best-effort: a failing audit write must not turn a precise refusal into a retryable
 *     database error. For a **duplicate** this event is the only durable record: the
 *     workflow's `task.failed.v1` is refused by the pre-dispatch arm, because the attempt
 *     belongs to the other execution (AG-604).
 *
 * Payloads carry server-side ids only — attempt, task, workflow run — plus the claim
 * timestamp. No hostnames, no pids, no user-supplied text.
 */

/** The attempt is (or was) held by a different execution. Non-retryable. */
export const EXECUTION_ALREADY_CLAIMED = 'EXECUTION_ALREADY_CLAIMED';

/**
 * The attempt cannot be claimed for a reason that is not a competing execution: it does
 * not exist under this tenant and task, it has already finished, or the caller named an
 * attempt without naming an execution. Non-retryable.
 */
export const EXECUTION_CLAIM_REFUSED = 'EXECUTION_CLAIM_REFUSED';

/**
 * This call has no execution identity at all — it was not dispatched by a Temporal
 * workflow. Non-retryable, and the reason it is a *separate* code from
 * `EXECUTION_CLAIM_REFUSED` is that the two are different incidents: "an execution that
 * holds no claim tried to act" (an authorisation decision) versus "there is no execution
 * here" (a dispatch that should not have been possible). Conflating them would hide N1
 * inside a normal refusal.
 */
export const EXECUTION_IDENTITY_UNAVAILABLE = 'EXECUTION_IDENTITY_UNAVAILABLE';

export type ExecutionClaimRefusalCode =
  typeof EXECUTION_ALREADY_CLAIMED | typeof EXECUTION_CLAIM_REFUSED;

/** Everything the claim needs. Every field is server-side: two ids and a timestamp. */
export interface ClaimIdentity {
  readonly orgId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly attemptId: string;
  /** Temporal's run id. See `executionIdentity` for where this must come from. */
  readonly workflowRunId: string;
  /**
   * Temporal's **workflow id** for the same execution. See `executionWorkflowId`.
   *
   * Recorded beside the run id so the release pass can ask about the exact execution
   * (Phase 6 re-review N7). Optional only because a test or a back-office caller can
   * legitimately construct a claim without a workflow context; a NULL is then recorded,
   * and the release pass treats such a claim as doubt rather than releasing it.
   */
  readonly workflowId?: string | undefined;
  readonly correlationId: string;
}

export interface ExecutionClaim {
  /**
   * `granted` — this call wrote the claim. `retry` — this execution already held it and
   * is recognised rather than refused. Both mean "proceed"; they differ in what the audit
   * trail says, which is the difference between "authority was taken now" and "authority
   * was taken earlier by this same execution".
   */
  readonly outcome: 'granted' | 'retry';
  readonly attemptId: string;
  readonly workflowRunId: string;
  readonly claimedAt: Date;
}

/**
 * The execution identity, or `undefined` when this call has none.
 *
 * Takes **no arguments on purpose**. There is no parameter to pass because there is
 * nothing a caller could legitimately contribute: the run id is created by the Temporal
 * server when it starts the workflow and is re-stated by the server on every activity
 * task. `Context.current()` throws when the process is not running an activity at all,
 * and `info.workflowExecution` is absent for a **standalone activity** — an activity
 * started by `Client.activity` with no parent workflow.
 *
 * Both of those are `undefined`, and `undefined` is a refusal everywhere it is consumed:
 * `requireExecutionClaim` and `claimExecution`'s only caller (`validateTaskActivity`)
 * turn it into `EXECUTION_IDENTITY_UNAVAILABLE`. Returning a caller-supplied value here
 * instead is exactly the defect AG-603 removed — see the module header.
 */
export function executionIdentity(): string | undefined {
  try {
    const runId = Context.current().info.workflowExecution?.runId;

    return runId !== undefined && runId.length > 0 ? runId : undefined;
  } catch {
    // Not inside an activity: no context object exists to ask. There is no second source.
    return undefined;
  }
}

/**
 * The workflow id the Temporal server dispatched this activity for, or `undefined`.
 *
 * Used by the pre-dispatch completion arm (`requireCompletionAuthority`), where there is
 * no claim to check: the workflow id is derived from the task (`task-<taskId>`), so
 * matching it proves the caller is *the* execution for this task rather than a workflow
 * that borrowed the task id. It is read from the same server-set context as the run id
 * and is therefore equally unforgeable from the activity's input.
 */
export function executionWorkflowId(): string | undefined {
  try {
    const workflowId = Context.current().info.workflowExecution?.workflowId;

    return workflowId !== undefined && workflowId.length > 0 ? workflowId : undefined;
  } catch {
    return undefined;
  }
}

/** The refusal every consumer uses when there is no identity. Non-retryable. */
function identityUnavailable(taskId: string): Error {
  return nonRetryableWithDetails(
    EXECUTION_IDENTITY_UNAVAILABLE,
    'This call has no execution identity: an activity invoked outside a Temporal ' +
      'workflow execution (or as a standalone activity) has no run id, so it cannot be ' +
      'the holder of an execution claim and cannot write execution state. Only an ' +
      'orchestrated execution may do either. Used to be satisfiable by an input field; ' +
      'that path was removed because the field is forgeable from workflow history.',
    { reason: 'execution_identity', code: EXECUTION_IDENTITY_UNAVAILABLE, taskId },
  );
}

/**
 * What a lost compare-and-swap means, as a pure decision.
 *
 * Separated from the write so the order of the checks is reviewable in one screen and
 * testable without a database: the interesting cases are all in the read-back, and the
 * write itself has exactly one branch.
 */
export function classifyLostClaim(input: {
  readonly attemptId: string;
  readonly workflowRunId: string;
  /** `null` when no row matched this tenant and task. */
  readonly status: string | null;
  readonly claimedByWorkflowRunId: string | null;
}):
  | { readonly outcome: 'retry' }
  | {
      readonly outcome: 'refused';
      readonly code: ExecutionClaimRefusalCode;
      readonly detail: string;
    } {
  // Nothing to claim. The row is invisible through the tenant and task filters, which is
  // the same answer for "no such attempt" and "not yours" — deliberately: distinguishing
  // them would confirm the existence of another tenant's row.
  if (input.status === null) {
    return {
      outcome: 'refused',
      code: EXECUTION_CLAIM_REFUSED,
      detail:
        `attempt ${input.attemptId} does not exist for this task in this organisation, so ` +
        'there is no reservation to claim',
    };
  }

  // The exact case the phase closed: a different execution holds the attempt.
  if (
    input.claimedByWorkflowRunId !== null &&
    input.claimedByWorkflowRunId !== input.workflowRunId
  ) {
    return {
      outcome: 'refused',
      code: EXECUTION_ALREADY_CLAIMED,
      detail:
        `attempt ${input.attemptId} is claimed by workflow run ` +
        `${input.claimedByWorkflowRunId}; one reservation authorises one execution`,
    };
  }

  // Same execution, still in flight: an activity retry, not a duplicate.
  if (
    input.claimedByWorkflowRunId === input.workflowRunId &&
    (input.status === 'queued' || input.status === 'running')
  ) {
    return { outcome: 'retry' };
  }

  // `running` with no claim at all: the attempt was adopted before this phase existed,
  // or by a direct call to the executor. Either way it is not this execution's to take.
  if (input.status === 'running') {
    return {
      outcome: 'refused',
      code: EXECUTION_ALREADY_CLAIMED,
      detail:
        `attempt ${input.attemptId} is already running under an execution that recorded no ` +
        'claim; a queued reservation is required to claim it',
    };
  }

  // Terminal. `status = 'queued'` in the predicate already refused it, and nothing may
  // revive it — including this execution, which is why the same-run branch above is
  // limited to `queued` and `running`.
  return {
    outcome: 'refused',
    code: EXECUTION_CLAIM_REFUSED,
    detail: `attempt ${input.attemptId} is "${input.status}"; a finished attempt cannot be claimed`,
  };
}

/**
 * Claims `attemptId` for this execution, or throws.
 *
 * Returns the claim (granted now, or recognised from earlier). Throws
 * `EXECUTION_ALREADY_CLAIMED` / `EXECUTION_CLAIM_REFUSED` — both non-retryable, both
 * carrying `projectId` so the workflow can record the refusal without a second read.
 */
export async function claimExecution(identity: ClaimIdentity): Promise<ExecutionClaim> {
  const prisma = db();
  const claimedAt = new Date();

  const granted = await prisma.$transaction(async (transaction) => {
    const claimed = await transaction.executionAttempt.updateMany({
      where: {
        id: identity.attemptId,
        // Tenant scoping, and the task: an attempt of another task in the same tenant is
        // not this execution's reservation. Both conjuncts narrow the predicate; neither
        // widens it.
        orgId: identity.orgId,
        taskId: identity.taskId,
        // The two predicates that make this a one-shot claim. `status` refuses a terminal
        // or already-adopted attempt; the NULL refuses a second claimant.
        status: 'queued',
        claimedByWorkflowRunId: null,
      },
      data: {
        claimedByWorkflowRunId: identity.workflowRunId,
        // The identity, recorded rather than derived (Phase 6 re-review N7). Written in
        // this same conditional UPDATE, so a claim cannot exist whose release probe has
        // to guess which workflow id it belongs to. `null` when the caller had no
        // workflow context — see `ClaimIdentity.workflowId`.
        claimedByWorkflowId: identity.workflowId ?? null,
        claimedAt,
      },
    });

    if (claimed.count !== 1) return false;

    // Inside the transaction on purpose: the grant and its record commit together, so
    // there is no state in which an attempt is claimed with no event saying so.
    await recordClaimEvent(transaction, identity, 'execution.claim_granted.v1', claimedAt, {
      claimedAt: claimedAt.toISOString(),
    });

    return true;
  });

  // No read-back on the winning path: `count === 1` is the database telling us this row
  // now holds our values, and an extra SELECT would only re-observe what was just written.
  if (granted) {
    return {
      outcome: 'granted',
      attemptId: identity.attemptId,
      workflowRunId: identity.workflowRunId,
      claimedAt,
    };
  }

  const attempt = await prisma.executionAttempt.findFirst({
    // The read-back is scoped exactly like the write. It decides *identity*, never
    // permission: permission was decided by the conditional update above.
    where: { id: identity.attemptId, orgId: identity.orgId, taskId: identity.taskId },
    select: { status: true, claimedByWorkflowRunId: true, claimedAt: true },
  });

  const decision = classifyLostClaim({
    attemptId: identity.attemptId,
    workflowRunId: identity.workflowRunId,
    status: attempt?.status ?? null,
    claimedByWorkflowRunId: attempt?.claimedByWorkflowRunId ?? null,
  });

  if (decision.outcome === 'retry') {
    const claimedAtOfRecord = attempt?.claimedAt ?? claimedAt;

    await recordClaimEventBestEffort(identity, 'execution.claim_retry.v1', claimedAtOfRecord, {
      claimedAt: claimedAtOfRecord.toISOString(),
    });

    return {
      outcome: 'retry',
      attemptId: identity.attemptId,
      workflowRunId: identity.workflowRunId,
      claimedAt: claimedAtOfRecord,
    };
  }

  const eventType =
    decision.code === EXECUTION_ALREADY_CLAIMED
      ? 'execution.claim_duplicate.v1'
      : 'execution.claim_refused.v1';

  await recordClaimEventBestEffort(identity, eventType, new Date(), {
    code: decision.code,
    ...(attempt?.claimedByWorkflowRunId == null
      ? {}
      : { claimedByWorkflowRunId: attempt.claimedByWorkflowRunId }),
    ...(attempt?.claimedAt == null ? {} : { heldSince: attempt.claimedAt.toISOString() }),
  });

  throw nonRetryableWithDetails(
    decision.code,
    `Task ${identity.taskId} cannot be executed: ${decision.detail}`,
    {
      reason: 'execution_claim',
      code: decision.code,
      taskId: identity.taskId,
      projectId: identity.projectId,
      attemptId: identity.attemptId,
      ...(attempt?.claimedByWorkflowRunId == null
        ? {}
        : { claimedByWorkflowRunId: attempt.claimedByWorkflowRunId }),
    },
  );
}

/**
 * Verifies that **this execution** holds the claim on the attempt it names, or throws.
 *
 * ## Why this exists at the launch site
 *
 * `claimExecution` is written by validation. A write nobody reads is a record of
 * authority, not a control over it: `executeAgentActivity` is a separately registered
 * Temporal activity (`activities/index.ts`), dispatched **by name**, so any workflow on
 * the worker's task queue can call it without ever calling `validateTaskActivity`.
 * Before this function existed, that path executed an unapproved HIGH-risk task with no
 * claim at all — validation refused it and the executor ran it anyway.
 *
 * `execute-agent.ts` therefore calls this **first**, before the runtime is constructed,
 * before `startAttempt`, before the cgroup probe, before the workspace lease and before
 * `runtime.execute`. It sits at the same altitude as the isolation gate, and for the
 * same reason: a control one activity upstream of the only launch site is advice.
 *
 * ## What it checks, and what it deliberately does not
 *
 * It checks **identity of the holder**: the named attempt exists in this tenant and
 * task, it carries a claim, and the claim is this execution's run id. Nothing else.
 * Attempt *status* is not part of the test, because the interesting legitimate case is
 * a Temporal retry of this same execution: the first activity attempt adopted the row
 * (`running`) or crashed after finalizing it (`succeeded`/`failed`). The claim is what
 * distinguishes that retry from a second execution, and the claim is stable across
 * retries by construction. Refusing on status here would convert "the worker restarted"
 * into "the task can never run".
 *
 * Approval is re-checked separately and immediately after this, by
 * `assertTaskAuthorised` with `altitude: 'launch'` — the same function validation uses,
 * imported rather than copied.
 */
export async function requireExecutionClaim(input: {
  readonly orgId: string;
  readonly taskId: string;
  readonly attemptId: string | undefined;
  /** Temporal's run id, or `undefined` when this call has no activity context. */
  readonly executionRunId: string | undefined;
  /**
   * The database `WorkflowRun.id` the caller says it is executing under, when it names
   * one. Checked against the attempt's own foreign key: the two are different id spaces
   * (`WorkflowRun.id` vs Temporal's run id), and an activity told to record against one
   * run while holding another run's attempt would allocate a stray attempt under the
   * wrong run. Refusing the disagreement is cheaper than reconciling it later.
   */
  readonly workflowRunId?: string | undefined;
}): Promise<HeldExecutionClaim> {
  const attemptId = input.attemptId?.trim();

  if (input.executionRunId === undefined) {
    // Phase 6 re-review N1. `undefined` here is not "no claim" — it is "no execution",
    // and it used to be the hole: the identity was read from the caller's input when no
    // activity context existed, so a standalone activity could satisfy the claim below by
    // naming its victim's run id. It is refused before the first read.
    throw identityUnavailable(input.taskId);
  }

  if (attemptId === undefined || attemptId.length === 0) {
    throw nonRetryableWithDetails(
      EXECUTION_CLAIM_REFUSED,
      `Task ${input.taskId} was executed without naming a reserved attempt. An attempt is ` +
        'the reservation that authorises one execution; an execution that names none ' +
        'cannot be shown to hold one, and two of them would both run.',
      { reason: 'execution_claim', code: EXECUTION_CLAIM_REFUSED, taskId: input.taskId },
    );
  }

  const attempt = await db().executionAttempt.findFirst({
    // Tenant scoping plus the task, exactly as the claim write is scoped: an attempt id
    // from another organisation or another task is not this execution's reservation.
    where: { id: attemptId, orgId: input.orgId, taskId: input.taskId },
    select: { claimedByWorkflowRunId: true, claimedAt: true, workflowRunId: true },
  });

  if (attempt === null) {
    throw nonRetryableWithDetails(
      EXECUTION_CLAIM_REFUSED,
      `Attempt ${attemptId} does not exist for task ${input.taskId} in this organisation, ` +
        'so there is no reservation authorising this execution.',
      {
        reason: 'execution_claim',
        code: EXECUTION_CLAIM_REFUSED,
        taskId: input.taskId,
        attemptId,
      },
    );
  }

  if (attempt.claimedByWorkflowRunId === null) {
    throw nonRetryableWithDetails(
      EXECUTION_CLAIM_REFUSED,
      `Attempt ${attemptId} holds no execution claim. Validation grants it; an execution ` +
        'that arrives without one has not been authorised to run, whatever it believes.',
      {
        reason: 'execution_claim',
        code: EXECUTION_CLAIM_REFUSED,
        taskId: input.taskId,
        attemptId,
      },
    );
  }

  if (attempt.claimedByWorkflowRunId !== input.executionRunId) {
    throw nonRetryableWithDetails(
      EXECUTION_ALREADY_CLAIMED,
      `Attempt ${attemptId} is claimed by workflow run ${attempt.claimedByWorkflowRunId}; ` +
        'one reservation authorises one execution, and this is not it.',
      {
        reason: 'execution_claim',
        code: EXECUTION_ALREADY_CLAIMED,
        taskId: input.taskId,
        attemptId,
        claimedByWorkflowRunId: attempt.claimedByWorkflowRunId,
        ...(attempt.claimedAt === null ? {} : { heldSince: attempt.claimedAt.toISOString() }),
      },
    );
  }

  if (input.workflowRunId !== undefined && attempt.workflowRunId !== input.workflowRunId) {
    // Same task, same execution, different database run: the attempt belongs to another
    // `WorkflowRun` row. Allowing it would make `startAttempt` allocate an attempt under
    // the run the caller named while the claim stayed on this one — two rows, two run ids,
    // one execution, and an accounting trail that contradicts itself.
    throw nonRetryableWithDetails(
      EXECUTION_CLAIM_REFUSED,
      `Attempt ${attemptId} belongs to workflow run ${attempt.workflowRunId}, not to ` +
        `${input.workflowRunId}. An execution claims the attempt its own run created.`,
      {
        reason: 'execution_claim',
        code: EXECUTION_CLAIM_REFUSED,
        taskId: input.taskId,
        attemptId,
        workflowRunId: attempt.workflowRunId,
      },
    );
  }

  return { attemptId, executionRunId: input.executionRunId };
}

/** What a successful `requireExecutionClaim` proves, for the code that follows it. */
export interface HeldExecutionClaim {
  readonly attemptId: string;
  readonly executionRunId: string;
}

/**
 * Which control authorised a write that changes execution state. Recorded (in the
 * activity's return value and its audit trail) so "this was written by the execution
 * that held the claim" is never confused with "this was written by the execution that was
 * refused before any claim existed".
 */
export type CompletionAuthority = 'execution-claim' | 'pre-dispatch';

/**
 * What a caller intends to write, in the vocabulary the pre-dispatch arm understands —
 * Phase 6 re-review N4 (residual class) and N8.
 *
 * The arm exists because a refused-before-dispatch run has no claim *by construction*,
 * so a claim check can never authorise its writes. The arm must therefore be narrow enough
 * that "no claim" does not become "any write": it names the exact writes that path
 * legitimately performs, and everything else is refused.
 */
export type WriteIntent =
  | { readonly kind: 'terminal'; readonly status: CompleteTaskActivityInput['status'] }
  | { readonly kind: 'start' }
  | { readonly kind: 'event'; readonly eventType: string };

/**
 * The only terminal statuses a run that never held a claim may write — N8.
 *
 * Both legitimate pre-dispatch call sites write a **refusal**: `failed` from
 * `failBeforeExecution` / `recordUnexpectedFailure`, `cancelled` from
 * `recordCancellation` when the cancellation landed before validation claimed anything.
 * `succeeded` is not a refusal, and a run that never executed cannot produce one: before
 * AG-604 the arm accepted it, so a workflow under `task-<taskId>` could mark a task with
 * zero attempts and zero `AgentRun` rows `succeeded`. Bounded only by the shipped registry
 * happening to emit `failed` — a bound that belongs in the control, not in the caller.
 */
const PRE_DISPATCH_TERMINAL_STATUSES: ReadonlySet<string> = new Set(['failed', 'cancelled']);

/**
 * The only audit events a run that never held a claim may write — N4 (residual class).
 *
 * `task.failed.v1` is the durable record of a refusal (`failBeforeExecution`,
 * `recordUnexpectedFailure`, both of which exist because the terminal write itself may be
 * refused); `task.cancelled.v1` is the cancellation record when the cancellation won the
 * race against validation. `task.status_changed.v1` and `task.succeeded.v1` are not
 * refusals and are written only by a run that holds the claim.
 */
const PRE_DISPATCH_EVENT_TYPES: ReadonlySet<string> = new Set([
  'task.failed.v1',
  'task.cancelled.v1',
]);

/**
 * Authority to write execution state — Phase 6 re-review N4, extended by AG-604.
 *
 * ## Why `completeTaskActivity` needs two arms and `persistResultActivity` does not
 *
 * `persistResultActivity` is only ever reached *after* a run, so a claim must exist and
 * it requires one unconditionally. `completeTaskActivity` is also reached **before**
 * anything ran: `validateTaskActivity` refuses an unapproved or non-runnable task, and the
 * workflow must record that the task is dead, or it stays `queued` for ever. In that state
 * no claim exists *by construction* — the claim is deliberately the last thing validation
 * writes, so a refusal never spends a reservation — and therefore no claim check can
 * succeed. Requiring one unconditionally would convert "the approval gate refused this"
 * into "the task is stuck".
 *
 * That is a genuine second case, not a loophole, so it gets its own control rather than a
 * weaker version of the first:
 *
 * | Case | Control |
 * |---|---|
 * | the named attempt carries a claim | `requireExecutionClaim` — the holder, and only the holder |
 * | no attempt carries a claim | the caller must be **the** execution for this task (`task-<taskId>`), **and** write only what that path legitimately writes, **and** no attempt of this task may be running or claimed by anybody else |
 *
 * The pre-dispatch arm is not a relaxation of the claim check — there is nothing for it to
 * relax. Before AG-603 this path had **no** check at all: any workflow on the worker's task
 * queue could mark any task terminal by name. Its conditions are read from the server-set
 * activity context and from the caller's intent, and neither is expressible as a weaker
 * activity input than the write it authorises.
 *
 * ## The intent condition — N8 and the N4 residual class
 *
 * AG-604 made the audit event load-bearing (it is the durable record of a refused run) and
 * left `emitEventActivity` / `recordStartActivity` dispatchable by name with no authority
 * at all. Both now come through here, and the pre-dispatch arm admits only the writes the
 * refusal path actually performs: `failed`/`cancelled` terminal statuses, `task.failed.v1`
 * / `task.cancelled.v1` events, and **no** start. `succeeded` and `task.status_changed.v1`
 * are refused, because neither is a refusal and only an execution that ran may write them.
 *
 * ## Why the workflow id, and why it only applies here
 *
 * `WORKFLOW_ID_PREFIX + taskId` is derived, so matching it proves the caller is *this
 * task's* execution rather than a workflow that merely knows the task id. Temporal's
 * `REJECT_DUPLICATE` means a second execution cannot take that id while one is live. The
 * check cannot be applied to the claim arm, and is not needed there: a claim is a stronger
 * proof than a workflow id, and applying both would refuse a legitimate execution whose
 * activity was replayed into a workflow started under a test or back-office id.
 */
async function requireExecutionWriteAuthority(input: {
  readonly orgId: string;
  readonly taskId: string;
  readonly attemptId: string | undefined;
  readonly executionRunId: string | undefined;
  readonly workflowRunId?: string | undefined;
  readonly intent: WriteIntent;
}): Promise<{ readonly authority: CompletionAuthority; readonly executionRunId: string }> {
  const { executionRunId } = input;

  if (executionRunId === undefined) {
    // Same refusal as the launch site: no identity, no write. This is the arm that makes
    // a standalone `completeTaskActivity` (the reviewer's dispatch shape) inert.
    throw identityUnavailable(input.taskId);
  }

  const attemptId = input.attemptId?.trim();
  const named =
    attemptId === undefined || attemptId.length === 0
      ? null
      : await db().executionAttempt.findFirst({
          where: { id: attemptId, orgId: input.orgId, taskId: input.taskId },
          select: { claimedByWorkflowRunId: true },
        });

  if (named !== null && named.claimedByWorkflowRunId !== null) {
    // A claim exists, so the claim decides. `requireExecutionClaim` re-reads the row under
    // the same tenant and task filters: the read above chooses the arm, it grants nothing.
    const held = await requireExecutionClaim({
      orgId: input.orgId,
      taskId: input.taskId,
      attemptId,
      executionRunId,
      ...(input.workflowRunId === undefined ? {} : { workflowRunId: input.workflowRunId }),
    });

    return { authority: 'execution-claim', executionRunId: held.executionRunId };
  }

  // ── The pre-dispatch arm ────────────────────────────────────────────────────
  const workflowId = executionWorkflowId();
  const expected = `${WORKFLOW_ID_PREFIX}${input.taskId}`;

  if (workflowId !== expected) {
    throw nonRetryableWithDetails(
      EXECUTION_CLAIM_REFUSED,
      `Task ${input.taskId} was asked to ${describeWrite(input.intent)} without a claim by ` +
        `an execution that is not this task's own (workflow id ${workflowId ?? 'none'}, ` +
        `expected ${expected}). A run that never claimed a reservation may only record a ` +
        'refusal for the task it was started for.',
      {
        reason: 'execution_completion',
        code: EXECUTION_CLAIM_REFUSED,
        taskId: input.taskId,
        workflowId: workflowId ?? null,
      },
    );
  }

  // The intent gate: identity alone does not authorise a write this path never performs.
  const refusal = refuseIntent(input.intent);

  if (refusal !== undefined) {
    throw nonRetryableWithDetails(
      EXECUTION_CLAIM_REFUSED,
      `Task ${input.taskId} was asked to ${describeWrite(input.intent)} without a claim. ` +
        `A run that never claimed a reservation may only record a refusal, and ${refusal}. ` +
        'Only an execution that holds the claim may write anything else.',
      {
        reason: 'execution_completion',
        code: EXECUTION_CLAIM_REFUSED,
        taskId: input.taskId,
        workflowId,
        ...intentDetail(input.intent),
      },
    );
  }

  // Something may be executing under a claim even though the attempt named here has none:
  // a retry, or a second reservation of the same task. Completing the task underneath it
  // would end a run that is still working.
  //
  // ## Residual (N9/N11) — an unclaimed `running` attempt is foreign to its own execution
  //
  // `row.status === 'running'` with `claimedByWorkflowRunId IS NULL` makes the predicate
  // below true for **every** caller, including the execution that adopted the row. Such a
  // row is the exact shape left by every attempt adopted before this phase added the claim
  // columns:
  //
  //   ExecutionAttempt {
  //     status                   = 'running'
  //     claimedByWorkflowRunId   = NULL        -- never back-filled, on purpose
  //     claimedAt                = NULL
  //     claimedByWorkflowId      = NULL
  //     agentRunId               = <set>       -- it did run
  //   }
  //
  // It can be neither claimed (`classifyLostClaim` refuses: `running` needs a claim it does
  // not have), nor adopted (`adoptReservedAttempt` requires `status = 'queued'`), nor
  // completed through this arm, nor reaped (`claim-release.ts` only considers `queued`).
  // Its task therefore never reaches a terminal state, and the refusal is swallowed with a
  // log line — the audit event still says the task failed, so task and history disagree.
  //
  // This is **fail-closed and migration-window-only**: the row can only exist for an
  // execution that was mid-run when the column was added. The predicate is deliberately
  // not relaxed to "an unclaimed running attempt belongs to whoever asks" — that would hand
  // every duplicate execution the ability to complete a task somebody else is running,
  // which is the hole this arm exists to close. Recorded as a residual rather than fixed.
  const attempts = await db().executionAttempt.findMany({
    where: {
      orgId: input.orgId,
      taskId: input.taskId,
      OR: [{ status: 'running' }, { claimedByWorkflowRunId: { not: null } }],
    },
    take: 50,
    select: { id: true, status: true, claimedByWorkflowRunId: true },
  });

  const foreign = attempts.find((row) =>
    row.status === 'running'
      ? row.claimedByWorkflowRunId !== executionRunId
      : row.claimedByWorkflowRunId !== null && row.claimedByWorkflowRunId !== executionRunId,
  );

  if (foreign !== undefined) {
    throw nonRetryableWithDetails(
      EXECUTION_ALREADY_CLAIMED,
      `Task ${input.taskId} cannot be completed without a claim: attempt ${foreign.id} is ` +
        `"${foreign.status}" under workflow run ${foreign.claimedByWorkflowRunId ?? 'no claim'}, ` +
        'which is not this execution. A task with a live execution is completed by that execution.',
      {
        reason: 'execution_completion',
        code: EXECUTION_ALREADY_CLAIMED,
        taskId: input.taskId,
        attemptId: foreign.id,
        ...(foreign.claimedByWorkflowRunId === null
          ? {}
          : { claimedByWorkflowRunId: foreign.claimedByWorkflowRunId }),
      },
    );
  }

  return { authority: 'pre-dispatch', executionRunId };
}

/**
 * Authority for the terminal task write — `completeTaskActivity`.
 *
 * The `status` is part of the guard, not decoration: see `PRE_DISPATCH_TERMINAL_STATUSES`
 * (N8). The claim arm ignores it deliberately — the holder of the claim is authorised for
 * all three statuses, and `completeTask`'s own transition guard decides which is legal.
 */
export async function requireCompletionAuthority(input: {
  readonly orgId: string;
  readonly taskId: string;
  readonly attemptId: string | undefined;
  readonly executionRunId: string | undefined;
  readonly workflowRunId?: string | undefined;
  readonly status: CompleteTaskActivityInput['status'];
}): Promise<{ readonly authority: CompletionAuthority; readonly executionRunId: string }> {
  return requireExecutionWriteAuthority({ ...input, intent: { kind: 'terminal', status: input.status } });
}

/**
 * Authority for the audit write — `emitEventActivity`, Phase 6 re-review N4 residual.
 *
 * `emitEventActivity` is registered and dispatched by name, so before AG-604 any workflow
 * on the worker's task queue could write a `task.succeeded.v1` for a task that never ran.
 * AG-604 made that event the *durable record* of a refused run, which raised what forging
 * it is worth. The same two arms as completion apply: the claim decides when one exists,
 * otherwise only this task's own execution may write — and only the refusal events.
 *
 * `attemptId` is the claim the execution holds, forwarded by the workflow. It has to be an
 * input for this activity (the envelope carries no attempt), and it is not trusted: it
 * selects the arm, and `requireExecutionClaim` then checks the claim against the run id
 * from the activity context, which is the part a caller cannot choose.
 */
export async function requireEventAuthority(input: {
  readonly orgId: string;
  readonly taskId: string;
  readonly attemptId: string | undefined;
  readonly executionRunId: string | undefined;
  readonly eventType: string;
}): Promise<{ readonly authority: CompletionAuthority; readonly executionRunId: string }> {
  return requireExecutionWriteAuthority({
    ...input,
    intent: { kind: 'event', eventType: input.eventType },
  });
}

/**
 * Authority for `recordStartActivity`, Phase 6 re-review N4 residual.
 *
 * There is no pre-dispatch case here, on purpose: every legitimate call happens *after*
 * `validateTaskActivity` granted the claim, so the claim arm is the only one that can
 * succeed. Before AG-604 the activity was dispatchable by name and moved a task
 * `queued → running` from a standalone activity; without a claim there is now no way to
 * write that transition at all. `intent: { kind: 'start' }` is never admitted by the
 * pre-dispatch arm, which is what makes that true rather than asserted.
 */
export async function requireStartAuthority(input: {
  readonly orgId: string;
  readonly taskId: string;
  readonly attemptId: string | undefined;
  readonly executionRunId: string | undefined;
}): Promise<{ readonly authority: CompletionAuthority; readonly executionRunId: string }> {
  return requireExecutionWriteAuthority({ ...input, intent: { kind: 'start' } });
}

/** Why the pre-dispatch arm refuses this intent, or `undefined` when it admits it. */
function refuseIntent(intent: WriteIntent): string | undefined {
  if (intent.kind === 'terminal') {
    return PRE_DISPATCH_TERMINAL_STATUSES.has(intent.status)
      ? undefined
      : `"${intent.status}" is a success, and a run that never held a claim never ran anything`;
  }

  if (intent.kind === 'event') {
    return PRE_DISPATCH_EVENT_TYPES.has(intent.eventType)
      ? undefined
      : `"${intent.eventType}" is not a refusal event`;
  }

  // `start` has no pre-dispatch case: the claim is granted *before* the start is recorded,
  // so a start without one is not the refusal path — it is a second execution.
  return 'moving the task to running is not a refusal; it needs the claim that authorises it';
}

/** The intent, in words an operator can act on. Used in every refusal message. */
function describeWrite(intent: WriteIntent): string {
  if (intent.kind === 'terminal') return `record status "${intent.status}"`;
  if (intent.kind === 'event') return `emit "${intent.eventType}"`;

  return 'record the start of this task';
}

/** The intent as audit detail, so a refusal says which write was refused. */
function intentDetail(intent: WriteIntent): Record<string, unknown> {
  if (intent.kind === 'terminal') return { status: intent.status };
  if (intent.kind === 'event') return { eventType: intent.eventType };

  return { write: 'start' };
}

/** The subset of the client an audit write needs — satisfied by the client and by a transaction. */
type AuditWriter = Pick<Prisma.TransactionClient, 'auditEvent'>; /**
 * Writes one claim event.
 *
 * Idempotent on `(orgId, idempotencyKey)` with the same explicit check `emitEventActivity`
 * uses — `AuditEvent.idempotencyKey` has an index, not a unique constraint, so the
 * database will not do this for us. A race on one key is not possible in practice: a
 * retry of one activity is sequential, and two different executions produce different
 * keys because the losing run id is part of it.
 */
async function recordClaimEvent(
  writer: AuditWriter,
  identity: ClaimIdentity,
  eventType: string,
  occurredAt: Date,
  payload: Record<string, unknown>,
): Promise<void> {
  const idempotencyKey = `${eventType}:${identity.attemptId}:${identity.workflowRunId}`;

  const existing = await writer.auditEvent.findFirst({
    where: { orgId: identity.orgId, idempotencyKey },
    select: { id: true },
  });

  if (existing !== null) return;

  await writer.auditEvent.create({
    data: {
      orgId: identity.orgId,
      projectId: identity.projectId,
      // The agent actor, not a user: no person made this decision, the worker did.
      actorType: 'agent',
      actorId: AGENT_ACTOR_ID,
      action: eventType.replace(/\.v\d+$/, ''),
      aggregateType: 'ExecutionAttempt',
      aggregateId: identity.attemptId,
      eventType,
      correlationId: identity.correlationId,
      causationId: null,
      idempotencyKey,
      payload: {
        taskId: identity.taskId,
        attemptId: identity.attemptId,
        workflowRunId: identity.workflowRunId,
        ...payload,
      } as Prisma.InputJsonObject,
      occurredAt,
    },
  });
}

/**
 * The refusal path's audit write.
 *
 * A refusal must survive an audit failure: the alternative is that a duplicate execution
 * is retried three times because the *evidence* write failed, and then reported as a
 * generic activity failure instead of the precise code an operator needs. This event is
 * therefore the durable record — for a duplicate there is no `task.failed.v1` to fall back
 * on, because the pre-dispatch arm refuses that write too (the attempt belongs to another
 * execution, AG-604). If this write fails as well, the refusal survives only in the
 * workflow's own result.
 */
async function recordClaimEventBestEffort(
  identity: ClaimIdentity,
  eventType: string,
  occurredAt: Date,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await recordClaimEvent(db(), identity, eventType, occurredAt, payload);
  } catch (error) {
    // Logged, not thrown. The refusal it accompanies is thrown below either way; turning
    // an evidence-write failure into an activity failure would retry a duplicate
    // execution three times and then report it as a database error instead of the precise
    // code an operator needs. This event is the durable record; a duplicate has no
    // `task.failed.v1` fallback, because that write is refused too (AG-604).
    workerLogger().warn(
      {
        eventType,
        attemptId: identity.attemptId,
        taskId: identity.taskId,
        error: error instanceof Error ? error.message : String(error),
      },
      'execution claim: audit write failed; the refusal itself is unaffected',
    );
  }
}
