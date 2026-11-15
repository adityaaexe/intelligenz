import { assertTaskAuthorised } from '../approvals/authorisation';
import type { ValidateTaskActivityInput, ValidateTaskActivityResult } from '../shared/contracts';
import {
  EXECUTION_CLAIM_REFUSED,
  EXECUTION_IDENTITY_UNAVAILABLE,
  claimExecution,
  executionIdentity,
  executionWorkflowId,
} from './claim';
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
 * ## Phase 6: conditions 1–6 were a read, and a read cannot arbitrate a race
 *
 * Every condition above is a `SELECT`. Two executions holding the same genuine
 * `attemptId` could therefore both observe `queued` and both pass — the window between
 * the read and anything that spends it was the TOCTOU, and Temporal's workflow-id dedupe
 * was the only thing preventing two agents. The claim (`./claim`) is the write that
 * closes it: one conditional `UPDATE … WHERE status = 'queued' AND claimedByWorkflowRunId
 * IS NULL`, executed last so a refusal never spends the claim, and before any activity
 * that could provision a workspace, create a cgroup, open a broker connection or call
 * `runtime.execute`.
 *
 * The claim's identity is the Temporal run id read from the **activity context**, not
 * from this activity's input: an input field can be set by whoever starts the workflow.
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

  // `ready` is accepted as well as `queued`: `POST /run` is the only API path that queues
  // the task, and a back-office client may start the workflow directly. Since Phase 6 such
  // a start must also name the attempt `POST /run` reserved — the reservation is what
  // authorises the execution, so "no attempt" is refused rather than run unclaimed.
  if (task.status !== 'queued' && task.status !== 'ready') {
    return {
      runnable: false,
      reason: 'not_runnable',
      status: task.status,
      projectId: task.projectId,
      detail: `Task ${task.id} is "${task.status}". Only queued or ready tasks can run.`,
    };
  }

  // The gate decides for itself whether this task's class needs a grant; calling it
  // unconditionally keeps the "does this task need approval" question in one place.
  await assertTaskAuthorised({
    task,
    attemptId: input.attemptId,
    // Nothing has run yet: the attempt must still be `queued`. The launch site re-runs
    // the same gate at `launch` altitude, where the claim — not this status — is the
    // control for "one reservation, one execution".
    altitude: 'reservation',
  });

  // ── Phase 6: the one-shot claim — the last thing that happens here ────────────
  //
  // Deliberately last. Everything above is a gate whose failure must not spend the
  // claim: a run refused for a stale approval, a bad binding or a forged attempt must
  // leave the reservation available to the execution that is entitled to it. And
  // deliberately here rather than in a later activity: this is the first activity the
  // workflow calls, and `executeAgentActivity` is a *separate* activity, so there is no
  // ordering in which provisioning, a cgroup, a broker call or `runtime.execute` can
  // happen before a claim exists.
  //
  // It runs for every execution, not only approval-gated ones. An attempt is the API's
  // reservation of one execution whatever the task's risk class, and the
  // duplicate-execution hole was never approval-specific: `validateTaskActivity` used
  // to read the attempt and check its status only when an approval was involved, so two
  // starts of a LOW task with the same attempt id both passed.
  const attemptId = input.attemptId?.trim();

  if (attemptId === undefined || attemptId.length === 0) {
    // ── Phase 6, F3: an execution with no reservation does not launch ──────────
    //
    // This was a convenience path: a caller could start `runTaskWorkflow` directly,
    // name no attempt, skip the claim entirely, and run. Two such starts of one LOW
    // task ran concurrently — two successes milliseconds apart, one `AgentRun` (keyed
    // to the second), and `claimedAt` NULL on both, so the duplicate was invisible in
    // the execution record as well as unguarded.
    //
    // Refusing here is the deliberate trade: there is no longer a way to execute
    // without a reservation, so "start the workflow by hand" now requires the attempt
    // id `POST /run` minted. `apps/api/api-contract.md` records the removal. The launch
    // site refuses the same case independently (`requireExecutionClaim`), because this
    // activity can be skipped entirely by anything that can dispatch by name.
    throw nonRetryableWithDetails(
      EXECUTION_CLAIM_REFUSED,
      `Task ${task.id} was started without naming a reserved execution attempt. ` +
        'Every execution must name the attempt POST /run created for it: an attempt is ' +
        'the reservation that authorises exactly one execution, and an execution with no ' +
        'reservation cannot be shown to be the only one.',
      {
        reason: 'execution_claim',
        code: EXECUTION_CLAIM_REFUSED,
        taskId: task.id,
        projectId: task.projectId,
      },
    );
  }

  await claimForExecution(task, attemptId, input);

  return { runnable: true, task };
}

/**
 * Claims the attempt this execution named, or throws the typed refusal.
 *
 * The identity resolution is the load-bearing part: `executionIdentity` reads Temporal's
 * run id from the activity context **and from nowhere else**, so an execution cannot
 * choose the name it claims under. A caller that named an attempt but has no execution
 * identity at all — the shape of a direct or standalone invocation, which is how the
 * Phase 6 re-review forged the launch-site gate — is refused
 * (`EXECUTION_IDENTITY_UNAVAILABLE`) before any write.
 */
async function claimForExecution(
  task: { readonly id: string; readonly orgId: string; readonly projectId: string },
  attemptId: string,
  input: ValidateTaskActivityInput,
): Promise<void> {
  const workflowRunId = executionIdentity();

  if (workflowRunId === undefined) {
    throw nonRetryableWithDetails(
      EXECUTION_IDENTITY_UNAVAILABLE,
      `Task ${task.id} names attempt ${attemptId} but this call has no execution ` +
        'identity: an attempt can only be claimed by an execution the orchestrator can ' +
        'name, and an activity invoked outside a workflow has no Temporal run id. There ' +
        'is no input field that stands in for it.',
      {
        reason: 'execution_identity',
        code: EXECUTION_IDENTITY_UNAVAILABLE,
        taskId: task.id,
        projectId: task.projectId,
        attemptId,
      },
    );
  }

  await claimExecution({
    orgId: task.orgId,
    taskId: task.id,
    projectId: task.projectId,
    attemptId,
    workflowRunId,
    // Phase 6 re-review N7: the workflow id is recorded beside the run id, in the same
    // conditional write, so the release pass can later ask Temporal about the exact
    // execution instead of guessing `task-<taskId>` for it. Read from the same
    // server-set context as the run id above; `null` if this call has no workflow
    // context (which the shipped path cannot be — see the module header).
    workflowId: executionWorkflowId(),
    // The request correlation when there is one; otherwise the execution itself, which
    // is a server-side id and the thing a claim is actually about.
    correlationId: input.correlationId ?? workflowRunId,
  });
}
