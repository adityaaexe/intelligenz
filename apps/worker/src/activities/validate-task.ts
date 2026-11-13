import { requiresApproval } from '@intelligenz/contracts';

import type {
  ValidateTaskActivityInput,
  ValidateTaskActivityResult,
} from '../shared/contracts';
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
      riskClass: true,
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
    // The same rule as the API (contract §15 A3): an APPROVED request, for this task,
    // in this organisation. A PENDING request is not an approval.
    const approved = await db().approvalRequest.findFirst({
      where: { orgId: input.orgId, taskId: task.id, status: 'APPROVED' },
      select: { id: true },
    });

    if (approved === null) {
      // **Thrown, not returned.** A caller that started this workflow directly — no
      // API, no `POST /run` — must not be able to distinguish "refused" from "nothing
      // to do": the refusal is an exception that ends the workflow, and the details
      // carry the project id so the workflow can still write the audit event without a
      // second query. The API's own gate is checked first; this is the gate that cannot
      // be bypassed (Phase 3 §7, path 3).
      throw nonRetryableWithDetails(
        'APPROVAL_REQUIRED',
        `Task ${task.id} is ${task.riskClass} and has no APPROVED approval request.`,
        {
          reason: 'approval_required',
          taskId: task.id,
          projectId: task.projectId,
          riskClass: task.riskClass,
        },
      );
    }
  }

  return { runnable: true, task };
}
