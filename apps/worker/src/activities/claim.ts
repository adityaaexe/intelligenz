import { Context } from '@temporalio/activity';
import type { Prisma } from '@intelligenz/database';

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
 * The input's `workflowRunId` is consulted **only** when no activity context exists — a
 * direct invocation from a test or an operational script. In production the context is
 * always present, so the field is dead weight there and cannot lower the gate.
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
 *     database error, and the workflow's `task.failed.v1` carries the same code durably.
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
 * The stable execution identity, or `undefined` when there is none to be had.
 *
 * The activity context wins when it exists. `info.workflowExecution` is optional in the
 * SDK's type because an activity *can* be started outside a workflow; in this worker it
 * never is, and the fallback exists for the code paths that call activities directly.
 */
export function executionIdentity(input: { readonly workflowRunId?: string }): string | undefined {
  try {
    const runId = Context.current().info.workflowExecution?.runId;

    if (runId !== undefined && runId.length > 0) return runId;
  } catch {
    // No activity context: a direct call. The caller's explicit id is the only identity
    // available, and there is no server to ask.
  }

  const supplied = input.workflowRunId?.trim();

  return supplied !== undefined && supplied.length > 0 ? supplied : undefined;
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
    throw nonRetryableWithDetails(
      EXECUTION_CLAIM_REFUSED,
      'This execution has no claimable identity: an activity invoked outside a Temporal ' +
        'workflow has no run id, so it cannot be the holder of an execution claim. Only ' +
        'an orchestrated execution may launch an agent.',
      { reason: 'execution_claim', code: EXECUTION_CLAIM_REFUSED, taskId: input.taskId },
    );
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
 * generic activity failure instead of the precise code an operator needs. The workflow's
 * `task.failed.v1` — written from the failure's details — is the durable record.
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
    // code an operator needs. The workflow's `task.failed.v1` carries that code durably.
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
