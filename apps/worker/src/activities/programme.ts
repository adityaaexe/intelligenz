import { requiresApproval } from '@intelligenz/contracts';
import { Prisma } from '@intelligenz/database';

import { PROGRAMME_WORKFLOW_ID_PREFIX } from '../config';
import { AGENT_ACTOR_ID } from '../shared/actors';
import { NODE_STATUS_BY_OUTCOME } from '../shared/programme';
import type {
  FinishProgrammeInput,
  FinishProgrammeResult,
  LoadProgrammeActivityInput,
  LoadProgrammeActivityResult,
  RecordProgrammeCheckpointInput,
  RecordProgrammeCheckpointResult,
  ReserveProgrammeTaskInput,
  ReserveProgrammeTaskResult,
} from '../shared/programme';
import { executionWorkflowId } from './claim';
import { deterministicId, executionAttemptIdFor } from './ids';
import { db, nonRetryable } from './support';

/**
 * The programme activities — the only place the scheduler touches the database.
 *
 * Four functions, four questions:
 *
 *   loadProgrammeActivity       what is the graph, and what is its state right now?
 *   reserveProgrammeTaskActivity  may this node be dispatched, and under which attempt?
 *   recordProgrammeCheckpointActivity  what did the scheduler observe?
 *   finishProgrammeActivity     is the programme over, and how did it end?
 *
 * The parent workflow is deterministic and cannot read Postgres, so every fact it acts on
 * arrives through these four. They are deliberately dumb: none of them decides that a task
 * may execute. That decision stays in `validateTaskActivity`, the claim and the approval
 * binding inside `runTaskWorkflow`, untouched.
 *
 * ## Authority: only the programme's own workflow may call these
 *
 * They are registered on the worker's task queue and dispatched by name, so without a
 * check any workflow could mint reservations for arbitrary tasks — a hole Phase 6 spent
 * four review rounds closing on the task side. `requireProgrammeAuthority` therefore
 * requires the calling execution's **workflow id** (read from Temporal's activity context,
 * not from the input) to be exactly `programme-<programmeId>`. A child task workflow runs
 * under a derived id and is refused, which is correct: the parent reserves, the child
 * executes.
 *
 * ## Why reservation moved into the worker, stated plainly
 *
 * `POST /run` mints an `ExecutionAttempt` because the claim needs a reservation to exist
 * before any execution names it. A programme cannot call the API after submission — that
 * would be the polling scheduler this design exists to avoid — so the same reservation is
 * minted here, by the process the platform already trusts to execute work.
 *
 * What that does **not** move: approval consumption. A `HIGH`/`CRITICAL` task needs a
 * grant spent by `POST /run` in the transaction that names the attempt, and this activity
 * will not spend one. It refuses the node with `approval_required`, the scheduler records
 * `waiting_for_approval`, and the dependents block. A programme that spent its own grants
 * would be the programme layer authorising execution — the one thing it must never do.
 */

/** The refusal codes an operator will grep for. */
const PROGRAMME_IDENTITY_UNAVAILABLE = 'PROGRAMME_IDENTITY_UNAVAILABLE';
const PROGRAMME_AUTHORITY_REFUSED = 'PROGRAMME_AUTHORITY_REFUSED';
const PROGRAMME_NOT_FOUND = 'PROGRAMME_NOT_FOUND';

/**
 * Throws unless this activity is running inside `programme-<programmeId>`.
 *
 * The workflow id comes from `Context.current().info.workflowExecution`, which the server
 * sets and an activity input cannot influence — the same control the claim uses.
 */
async function requireProgrammeAuthority(programmeId: string): Promise<string> {
  const workflowId = executionWorkflowId();

  if (workflowId === undefined) {
    throw nonRetryable(
      PROGRAMME_IDENTITY_UNAVAILABLE,
      'A programme activity was invoked outside a workflow execution. The scheduler is a ' +
        'workflow; an activity with no execution identity cannot name the programme it acts for.',
    );
  }

  const expected = `${PROGRAMME_WORKFLOW_ID_PREFIX}${programmeId}`;

  if (workflowId !== expected) {
    throw nonRetryable(
      PROGRAMME_AUTHORITY_REFUSED,
      `This execution ("${workflowId}") is not the scheduler for programme ${programmeId}. ` +
        `Only "${expected}" may reserve attempts or write checkpoints: a reservation is ` +
        'what authorises exactly one execution, and any other caller minting one would ' +
        'reopen the duplicate-execution hole the claim exists to close.',
    );
  }

  return workflowId;
}

/**
 * Where each checkpoint outcome lands the node.
 *
 * `already_succeeded` is stored as `succeeded`: the node is satisfied, and how it got
 * there is in the checkpoint. The table lives in `shared/programme.ts` because the workflow
 * keeps the same state in memory to compute the ready set, and two copies of this mapping
 * would eventually disagree about what "done" means.
 */

// ─── load ────────────────────────────────────────────────────────────────────

/**
 * Reads the graph and its state, and marks the programme `running` on first call.
 *
 * The `pending → running` write is a conditional update, so a retried load cannot move a
 * terminal programme back to running. Nodes are ordered by `taskId`, not `createdAt`: every
 * node of one programme is created in one transaction and therefore shares a timestamp, so
 * `createdAt` is not an order. Task-id order is arbitrary but stable, which is what
 * replay and a resumed scheduler need.
 */
export async function loadProgrammeActivity(
  input: LoadProgrammeActivityInput,
): Promise<LoadProgrammeActivityResult> {
  await requireProgrammeAuthority(input.programmeId);

  const prisma = db();
  const programme = await prisma.programme.findFirst({
    // Tenant scoping: a programme id from another org resolves to null.
    where: { id: input.programmeId, orgId: input.orgId },
    select: { id: true, projectId: true, objective: true, status: true },
  });

  if (programme === null) {
    throw nonRetryable(
      PROGRAMME_NOT_FOUND,
      `Programme ${input.programmeId} does not exist in organisation ${input.orgId}.`,
    );
  }

  if (programme.status === 'pending') {
    await prisma.programme.updateMany({
      where: { id: programme.id, orgId: input.orgId, status: 'pending' },
      data: { status: 'running', startedAt: new Date() },
    });
  }

  const [rows, checkpoints] = await Promise.all([
    prisma.programmeTask.findMany({
      where: { programmeId: programme.id, orgId: input.orgId },
      orderBy: { taskId: 'asc' },
      select: {
        taskId: true,
        dependsOn: true,
        status: true,
        attemptCount: true,
        task: { select: { acceptanceCriteria: true, status: true } },
      },
    }),
    prisma.programmeCheckpoint.findMany({
      where: { programmeId: programme.id, orgId: input.orgId },
      orderBy: { sequence: 'asc' },
      select: { taskId: true, outcome: true },
    }),
  ]);

  return {
    programme: {
      id: programme.id,
      projectId: programme.projectId,
      objective: programme.objective,
      status: programme.status === 'pending' ? 'running' : programme.status,
    },
    nodes: rows.map((row) => ({
      taskId: row.taskId,
      dependsOn: row.dependsOn,
      acceptanceCriteria: row.task.acceptanceCriteria,
      status: row.status,
      attemptCount: row.attemptCount,
      taskStatus: row.task.status,
    })),
    checkpointCount: checkpoints.length,
    checkpoints: checkpoints.map((checkpoint) => ({
      taskId: checkpoint.taskId,
      outcome: checkpoint.outcome,
    })),
  };
}

// ─── reserve ─────────────────────────────────────────────────────────────────

/** Thrown inside the reservation transaction so a lost task CAS rolls the whole thing back. */
class ReservationLost extends Error {}

/**
 * Reserves exactly one execution for one node, or explains why it will not.
 *
 * The rows and the ids mirror `TaskService.run` — a `queued` `WorkflowRun`, one `queued`
 * `ExecutionAttempt` naming it, and the task moved `ready → queued` in the same
 * transaction. What is deliberately absent is the approval spend; see the module header.
 *
 * ## Idempotent by construction
 *
 * `workflowRunId` is derived from `(programmeTask id, attemptNumber)`, and the attempt id
 * from the run id. A retried activity re-computes the same ids, finds the committed rows
 * and reports `reserved` again instead of reserving a second execution. `attemptCount` is
 * assigned, never incremented, for the same reason.
 *
 * The task compare-and-swap is what arbitrates against everything else: if another
 * execution already moved the task out of `ready`, the transaction rolls back and the
 * answer is `not_runnable` — no run row, no attempt, nothing to clean up.
 */
export async function reserveProgrammeTaskActivity(
  input: ReserveProgrammeTaskInput,
): Promise<ReserveProgrammeTaskResult> {
  await requireProgrammeAuthority(input.programmeId);

  const prisma = db();

  const programme = await prisma.programme.findFirst({
    where: { id: input.programmeId, orgId: input.orgId },
    select: { projectId: true },
  });

  if (programme === null) {
    throw nonRetryable(
      PROGRAMME_NOT_FOUND,
      `Programme ${input.programmeId} does not exist in organisation ${input.orgId}.`,
    );
  }

  const node = await prisma.programmeTask.findFirst({
    // Tenant and programme scoping: a node of another programme is not this node.
    where: { programmeId: input.programmeId, orgId: input.orgId, taskId: input.taskId },
    select: { id: true },
  });

  if (node === null) {
    throw nonRetryable(
      'PROGRAMME_NODE_NOT_FOUND',
      `Task ${input.taskId} is not a node of programme ${input.programmeId}.`,
    );
  }

  const task = await prisma.task.findFirst({
    // The programme's project is part of the predicate: a task from another project in
    // the same org is not this programme's work.
    where: { id: input.taskId, orgId: input.orgId, projectId: programme.projectId },
    select: { id: true, status: true, riskClass: true },
  });

  if (task === null) return { outcome: 'not_found' };

  if (task.status === 'succeeded') return { outcome: 'already_succeeded' };

  if (task.status === 'failed' || task.status === 'cancelled') {
    return {
      outcome: 'not_runnable',
      taskStatus: task.status,
      detail: `Task ${task.id} is already ${task.status}; nothing to dispatch.`,
    };
  }

  if (task.status !== 'ready') {
    return {
      outcome: 'not_runnable',
      taskStatus: task.status,
      detail:
        `Task ${task.id} is "${task.status}". A programme dispatches only "ready" tasks: ` +
        '"queued" or "running" means another execution already holds it.',
    };
  }

  // Before anything is written: a grant is spent by `POST /run`, and this layer must not
  // become a second spender. The node waits for a human, and its dependents wait with it.
  if (requiresApproval(task.riskClass)) {
    return { outcome: 'approval_required' };
  }

  const workflowRunId = deterministicId(`programme-run:${node.id}:${String(input.attemptNumber)}`);
  const attemptId = executionAttemptIdFor(workflowRunId, 1);

  // A committed reservation from an earlier invocation of this same activity. Reported as
  // success rather than re-created: the run and the attempt are the same execution.
  const [existingRun, existingAttempt] = await Promise.all([
    prisma.workflowRun.findFirst({
      where: { id: workflowRunId, orgId: input.orgId },
      select: { id: true },
    }),
    prisma.executionAttempt.findFirst({
      where: { id: attemptId, orgId: input.orgId, taskId: input.taskId },
      select: { id: true },
    }),
  ]);

  if (existingRun !== null && existingAttempt !== null) {
    return { outcome: 'reserved', attemptId, workflowRunId };
  }

  try {
    await prisma.$transaction(async (transaction) => {
      // The arbitration, first. Nothing below it can commit unless this matched, so a
      // task already taken leaves no run row and no attempt behind.
      const claimed = await transaction.task.updateMany({
        where: { id: task.id, orgId: input.orgId, status: 'ready' },
        data: { status: 'queued' },
      });

      if (claimed.count === 0) throw new ReservationLost();

      await transaction.workflowRun.create({
        data: {
          id: workflowRunId,
          orgId: input.orgId,
          taskId: task.id,
          // The workflow the child will run under. `recordStartActivity` adopts this row
          // through its "newest active run for the task" fallback and rewrites the status.
          workflowId: `task-${task.id}`,
          status: 'queued',
        },
      });

      await transaction.executionAttempt.create({
        data: {
          id: attemptId,
          orgId: input.orgId,
          taskId: task.id,
          workflowRunId,
          attemptNumber: 1,
          // Same vocabulary `POST /run` writes: the adapter is chosen by the worker at
          // dispatch, and `startAttempt` replaces this when the run is adopted.
          runtimeId: 'unassigned',
          simulated: true,
          status: 'queued',
        },
      });

      await transaction.programmeTask.updateMany({
        where: { programmeId: input.programmeId, orgId: input.orgId, taskId: task.id },
        data: {
          status: 'running',
          // Assigned from the workflow's deterministic number, never incremented, so a
          // retried activity cannot inflate it.
          attemptCount: input.attemptNumber,
          startedAt: new Date(),
        },
      });

      // The transition `POST /run` records for the same edge. The id is derived from the
      // run, so a retried activity collides with itself instead of appending history.
      await transaction.auditEvent.create({
        data: {
          id: deterministicId(`programme-task-reserved:${workflowRunId}`),
          orgId: input.orgId,
          projectId: programme.projectId,
          actorType: 'agent',
          actorId: AGENT_ACTOR_ID,
          action: 'task.status_changed',
          aggregateType: 'Task',
          aggregateId: task.id,
          eventType: 'task.status_changed.v1',
          correlationId: input.correlationId,
          idempotencyKey: `task.status_changed.v1:${task.id}:${workflowRunId}:queued`,
          payload: {
            from: 'ready',
            to: 'queued',
            cause: 'programme_dispatch',
            programmeId: input.programmeId,
            programmeTaskId: node.id,
            workflowRunId,
            attemptId,
          },
          occurredAt: new Date(),
        },
      });
    });
  } catch (error) {
    if (error instanceof ReservationLost) {
      const current = await prisma.task.findFirst({
        where: { id: task.id, orgId: input.orgId },
        select: { status: true },
      });

      return {
        outcome: 'not_runnable',
        taskStatus: current?.status ?? 'unknown',
        detail:
          `Task ${task.id} left "ready" while the programme was reserving it; another ` +
          'execution holds it now.',
      };
    }

    // A unique collision means this reservation already exists (a concurrent duplicate of
    // this activity). That is the outcome, not a failure.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const attempt = await prisma.executionAttempt.findFirst({
        where: { id: attemptId, orgId: input.orgId },
        select: { id: true },
      });

      if (attempt !== null) return { outcome: 'reserved', attemptId, workflowRunId };
    }

    throw error;
  }

  return { outcome: 'reserved', attemptId, workflowRunId };
}

// ─── checkpoint ──────────────────────────────────────────────────────────────

/**
 * Appends a checkpoint and moves the node to its terminal state, in one transaction.
 *
 * `(programmeId, sequence)` unique is the idempotency key: a retried write upserts the
 * same row. The node update is restricted to `pending`/`running`, so a retry cannot move a
 * node that has already been settled — and a second, different write for the same node
 * would be refused by the state predicate rather than silently overwriting.
 */
export async function recordProgrammeCheckpointActivity(
  input: RecordProgrammeCheckpointInput,
): Promise<RecordProgrammeCheckpointResult> {
  await requireProgrammeAuthority(input.programmeId);

  const prisma = db();
  const evidence =
    input.evidence === null ? Prisma.DbNull : (input.evidence as unknown as Prisma.InputJsonObject);

  await prisma.$transaction(async (transaction) => {
    await transaction.programmeCheckpoint.upsert({
      where: {
        programmeId_sequence: { programmeId: input.programmeId, sequence: input.sequence },
      },
      create: {
        id: deterministicId(`programme-checkpoint:${input.programmeId}:${String(input.sequence)}`),
        orgId: input.orgId,
        programmeId: input.programmeId,
        sequence: input.sequence,
        taskId: input.taskId,
        outcome: input.outcome,
        evidence,
      },
      update: { outcome: input.outcome, evidence },
    });

    await transaction.programmeTask.updateMany({
      where: {
        programmeId: input.programmeId,
        orgId: input.orgId,
        taskId: input.taskId,
        status: { in: ['pending', 'running'] },
      },
      data: {
        status: NODE_STATUS_BY_OUTCOME[input.outcome],
        finishedAt: new Date(),
      },
    });
  });

  return { sequence: input.sequence };
}

// ─── finish ──────────────────────────────────────────────────────────────────

/**
 * Moves the programme to its terminal status, once.
 *
 * Conditional on `pending`/`running`, so a retried activity — or a late checkpoint racing
 * the finish — cannot reopen or re-close a finished programme. `failureReason` is written
 * only for a non-success: a succeeded programme has no reason to record.
 */
export async function finishProgrammeActivity(
  input: FinishProgrammeInput,
): Promise<FinishProgrammeResult> {
  await requireProgrammeAuthority(input.programmeId);

  const prisma = db();
  const finishedAt = new Date();

  const changed = await prisma.programme.updateMany({
    where: {
      id: input.programmeId,
      orgId: input.orgId,
      status: { in: ['pending', 'running'] },
    },
    data: {
      status: input.status,
      finishedAt,
      failureReason: input.status === 'succeeded' ? null : input.reason,
    },
  });

  if (changed.count > 0) {
    await prisma.auditEvent
      .create({
        data: {
          id: deterministicId(`programme-finished:${input.programmeId}`),
          orgId: input.orgId,
          actorType: 'agent',
          actorId: AGENT_ACTOR_ID,
          action: 'programme.finished',
          aggregateType: 'Programme',
          aggregateId: input.programmeId,
          eventType: 'programme.finished.v1',
          correlationId: deterministicId(`programme-correlation:${input.programmeId}`),
          idempotencyKey: `programme.finished.v1:${input.programmeId}`,
          payload: {
            status: input.status,
            reason: input.reason,
            finishedAt: finishedAt.toISOString(),
          },
          occurredAt: finishedAt,
        },
      })
      .catch((error: unknown) => {
        // The programme is finished either way; a duplicate audit row is already refused
        // by the deterministic id. Anything else is surfaced rather than swallowed.
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
          throw error;
        }
      });
  }

  const current = await prisma.programme.findFirst({
    where: { id: input.programmeId, orgId: input.orgId },
    select: { status: true },
  });

  return { status: current?.status ?? input.status, changed: changed.count > 0 };
}
