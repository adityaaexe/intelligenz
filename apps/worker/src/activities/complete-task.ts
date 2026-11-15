import type { RunStatus } from '@intelligenz/database';

import type { CompleteTaskActivityInput, CompleteTaskActivityResult } from '../shared/contracts';
import { executionIdentity, requireCompletionAuthority } from './claim';
import { db, nonRetryable, nonRetryableWithDetails } from './support';

/** A terminal task status implies a terminal run status; the vocabularies differ only in name. */
const TERMINAL_RUN_STATUS: Record<CompleteTaskActivityInput['status'], RunStatus> = {
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
};

/**
 * A task cannot be `succeeded` when the attempt it names did not succeed — F-G18.
 *
 * Authority answers "may this execution write the terminal state"; it does not answer "is
 * the state true". Before this, the second question had no owner: an attempt recorded
 * `failed` with `EVIDENCE_MISSING` could be completed as `succeeded` — measured, accepted,
 * task `succeeded` — because the only thing preventing it was the workflow propagating
 * `result.status` faithfully. A guard that lives in one caller is not an invariant, and the
 * task status is the row an operator reads.
 *
 * Only `succeeded` is checked, and only against **terminal** attempt statuses, because the
 * other direction is legitimate: a task cancelled by the API while an attempt was failing
 * records `cancelled` on a `failed` attempt, and refusing that would turn a real
 * cancellation into a stuck task. "Nothing failed while the task passed" is the direction
 * that cannot be true under any reading.
 *
 * The read is scoped by tenant and task, like every other read of this row: an attempt id
 * from another task cannot be used to change this decision.
 */
async function refuseContradictorySuccess(input: CompleteTaskActivityInput): Promise<void> {
  if (input.status !== 'succeeded' || input.attemptId === undefined) return;

  const attempt = await db().executionAttempt.findFirst({
    where: { id: input.attemptId, orgId: input.orgId, taskId: input.taskId },
    select: { status: true },
  });

  // No row: the claim arm already decided this execution may write, and an absent attempt
  // is not a contradiction — the pre-dispatch path has no attempt by construction.
  if (attempt === null) return;

  // Still in flight, or succeeded: nothing to refuse. `queued`/`running` are not terminal,
  // and the terminal write itself is guarded by the status predicate in `completeTask`.
  if (attempt.status === 'succeeded' || attempt.status === 'queued' || attempt.status === 'running') {
    return;
  }

  throw nonRetryableWithDetails(
    'COMPLETION_CONTRADICTS_ATTEMPT',
    `Task ${input.taskId} was asked to record "succeeded" for attempt ${input.attemptId}, ` +
      `which is "${attempt.status}". An attempt that did not succeed cannot produce a ` +
      'successful task: the task row is what an operator reads, and a status that outlives ' +
      'the record contradicting it is the failure this gate exists to prevent. The terminal ' +
      'status is derived from the attempt result; a caller that disagrees with it has ' +
      'already lost the run.',
    {
      reason: 'completion',
      code: 'COMPLETION_CONTRADICTS_ATTEMPT',
      taskId: input.taskId,
      attemptId: input.attemptId,
      attemptStatus: attempt.status,
      requestedStatus: input.status,
    },
  );
}

/**
 * `completeTaskActivity` — contract §16.
 *
 * The terminal write. Three behaviours matter and none of them is obvious:
 *
 * 1. **It cannot overwrite a terminal state.** `POST /cancel` may already have set
 *    `cancelled` while the workflow was finishing. The update is guarded by
 *    `status IN (queued, running, verifying)`, so a late `succeeded` cannot resurrect a
 *    cancelled task and a cancellation cannot erase a real success.
 * 2. **It reports whether it changed anything.** The cancellation path needs that bit:
 *    if the API already cancelled, the workflow must not emit a second
 *    `task.cancelled.v1` (see `emit-event.ts`).
 * 3. **It can record an error without an `AgentRun`.** A pre-dispatch failure (validation
 *    refused, or the activity path itself failed) has no runtime result to persist.
 *    Fabricating an `AgentRun` with a fake runtime id would put a lie in the UI; writing
 *    the error onto `WorkflowRun` is where it belongs.
 */
export async function completeTaskActivity(
  input: CompleteTaskActivityInput,
): Promise<CompleteTaskActivityResult> {
  // ── Authority before the first read, let alone the first write — N4 ─────────
  //
  // Same class as F1 and the same answer: this activity is dispatched by name, so any
  // workflow on the task queue could reach it. Two arms, because this activity has two
  // legitimate shapes: an execution that ran (a claim exists and must be this one) and an
  // execution that was refused before anything was authorised (no claim exists by
  // construction, so the workflow-id and held-by-nobody checks decide). See
  // `requireCompletionAuthority`.
  const authority = await requireCompletionAuthority({
    orgId: input.orgId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    executionRunId: executionIdentity(),
    workflowRunId: input.workflowRunId,
    // N8: the status is part of the guard. The pre-dispatch arm admits only the two
    // statuses a refusal path legitimately writes; `succeeded` without a claim is refused.
    status: input.status,
  });

  // F-G18: authority answers "may this execution write"; this answers "is the write true".
  // Runs before the write and after the authority check, so a caller who is not allowed to
  // write at all learns that first — and the contradiction is still refused before any row
  // changes.
  await refuseContradictorySuccess(input);

  // The arm that authorised the write goes back to the caller: "this execution held the
  // claim" and "this execution was refused before any claim existed" are different facts
  // about the same terminal state, and the workflow's own record should not have to infer
  // which one it was.
  return { ...(await completeTask(input)), authority: authority.authority };
}

/** The terminal write itself, with no authority check — reachable only through the guard. */
async function completeTask(
  input: CompleteTaskActivityInput,
): Promise<Omit<CompleteTaskActivityResult, 'authority'>> {
  const prisma = db();

  const before = await prisma.task.findFirst({
    // Tenant scoping.
    where: { id: input.taskId, orgId: input.orgId },
    select: { status: true, projectId: true },
  });

  if (before === null) {
    throw nonRetryable('TASK_NOT_FOUND', `Task ${input.taskId} does not exist in this org.`);
  }

  const updated = await prisma.task.updateMany({
    where: {
      id: input.taskId,
      orgId: input.orgId,
      // The guard: only a non-terminal status may be completed. A self-transition is not
      // an edge in the state machine either (contract §6).
      status: { in: ['queued', 'running', 'verifying'] },
    },
    data: { status: input.status },
  });

  // The run is finalised here as well as in `persistResultActivity`, because the two
  // paths that do not persist a result — a pre-dispatch refusal and a worker-owned
  // cancellation — would otherwise leave `WorkflowRun` at `running` for ever. The API
  // only closes the run on the cancellation path it initiated itself.
  const run = await prisma.workflowRun.findFirst({
    where: { orgId: input.orgId, taskId: input.taskId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, finishedAt: true },
  });

  if (run !== null) {
    await prisma.workflowRun.updateMany({
      where: { id: run.id, orgId: input.orgId },
      data: {
        status: TERMINAL_RUN_STATUS[input.status],
        // Preserve the first finish time: a repeated completion is not a later finish.
        ...(run.finishedAt === null ? { finishedAt: new Date() } : {}),
        ...(input.error === undefined ? {} : { error: { ...input.error } }),
      },
    });
  }

  const after = await prisma.task.findFirst({
    where: { id: input.taskId, orgId: input.orgId },
    select: { status: true, projectId: true },
  });

  if (after === null) {
    throw nonRetryable('TASK_NOT_FOUND', `Task ${input.taskId} disappeared during completion.`);
  }

  return {
    changed: updated.count > 0,
    previousStatus: before.status,
    status: after.status,
    projectId: after.projectId,
  };
}
