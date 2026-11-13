import { WORKFLOW_ID_PREFIX } from '../config';
import type {
  RecordStartActivityInput,
  RecordStartActivityResult,
} from '../shared/contracts';
import { db, nonRetryable } from './support';

/**
 * `recordStartActivity` — contract §16.
 *
 * ## Two writers, one row
 *
 * The API creates the `WorkflowRun` at `POST /run` with `temporalRunId` already set, so
 * that a client sees a run row the instant the request returns 202. The worker must
 * therefore **adopt** that row, not create a second one — hence the lookup by
 * `temporalRunId` first, with a fallback that covers the path where a workflow was
 * started directly through Temporal (no API, no row).
 *
 * Idempotent: a retried activity finds the row it created and updates it again, and the
 * task transition is a guarded `updateMany`, so a second attempt is a no-op rather than
 * a second `queued → running` edge.
 */
export async function recordStartActivity(
  input: RecordStartActivityInput,
): Promise<RecordStartActivityResult> {
  const prisma = db();
  const now = new Date();

  const existing =
    (await prisma.workflowRun.findFirst({
      // Tenant scoping plus the Temporal run id, which is unique per execution.
      where: { temporalRunId: input.workflowRunId, orgId: input.orgId },
      select: { id: true, startedAt: true },
    })) ??
    (await prisma.workflowRun.findFirst({
      // Fallback: the API created the row but could not record the run id (it failed
      // between the start RPC and its second transaction). The newest active run for
      // this task is the one this workflow owns.
      where: { orgId: input.orgId, taskId: input.taskId, status: { in: ['queued', 'running'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, startedAt: true },
    }));

  let workflowRunId: string;

  if (existing === null) {
    const created = await prisma.workflowRun.create({
      data: {
        orgId: input.orgId,
        taskId: input.taskId,
        workflowId: `${WORKFLOW_ID_PREFIX}${input.taskId}`,
        temporalRunId: input.workflowRunId,
        status: 'running',
        startedAt: now,
      },
      select: { id: true },
    });

    workflowRunId = created.id;
  } else {
    const updated = await prisma.workflowRun.updateMany({
      // `orgId` is in the predicate even though `id` is unique: the row was resolved
      // under a tenant filter, and every write in this codebase says which tenant it
      // belongs to (contract §5).
      where: { id: existing.id, orgId: input.orgId },
      data: {
        status: 'running',
        // Preserve the first start time: a retry did not start the run again.
        startedAt: existing.startedAt ?? now,
        temporalRunId: input.workflowRunId,
      },
    });

    if (updated.count === 0) {
      throw nonRetryable(
        'WORKFLOW_RUN_VANISHED',
        `WorkflowRun ${existing.id} disappeared while recording the start of task ${input.taskId}.`,
      );
    }

    workflowRunId = existing.id;
  }

  const guarded = await prisma.task.updateMany({
    where: {
      id: input.taskId,
      orgId: input.orgId,
      status: { in: ['queued', 'ready'] },
    },
    data: { status: 'running' },
  });

  const current = await prisma.task.findFirst({
    where: { id: input.taskId, orgId: input.orgId },
    select: { status: true },
  });

  if (current === null) {
    throw nonRetryable(
      'TASK_NOT_FOUND',
      `Task ${input.taskId} disappeared while recording the start of its run.`,
    );
  }

  return {
    workflowRunId,
    temporalRunId: input.workflowRunId,
    taskStatus: current.status,
    // `false` means the task was already terminal (a cancellation landed first). The
    // workflow treats that as "stop", not as an error.
    started: guarded.count > 0,
  };
}
