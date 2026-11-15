import type { RunStatus } from '@intelligenz/database';

import type { CompleteTaskActivityInput, CompleteTaskActivityResult } from '../shared/contracts';
import { executionIdentity, requireCompletionAuthority } from './claim';
import { db, nonRetryable } from './support';

/** A terminal task status implies a terminal run status; the vocabularies differ only in name. */
const TERMINAL_RUN_STATUS: Record<CompleteTaskActivityInput['status'], RunStatus> = {
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
};

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
