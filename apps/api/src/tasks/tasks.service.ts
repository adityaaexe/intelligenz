import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import {
  type CreateTaskInput,
  type PaginationQuery,
  type RiskClass,
  type TaskStatus,
  type UpdateTaskStatusInput,
  canTransition,
  requiresApproval,
  transitionRequiresReason,
} from '@intelligenz/contracts';
import type { Prisma, PrismaClient } from '@intelligenz/database';
import type { Logger } from 'pino';

import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/errors';
import { LOGGER } from '../common/logger';
import { isUniqueConstraintError } from '../common/prisma-errors';
import { PRISMA_CLIENT } from '../database/database.module';
import {
  OrchestratorService,
  OrchestratorUnavailableError,
  WORKFLOW_ID_PREFIX,
  isWorkflowAlreadyStartedError,
} from '../orchestrator/orchestrator.service';
import { isHumanTransition } from './human-transitions';
import type {
  CancelResponse,
  RunResponse,
  TaskDetailResponse,
  TaskPage,
  TaskResponse,
} from './tasks.response';

/**
 * Task lifecycle.
 *
 * ## Tenant scoping, stated once here and repeated at each query
 *
 * Every statement below carries `orgId` in its `where` clause — including the
 * updates, which use `updateMany` rather than `update` for exactly that reason:
 * `update({ where: { id } })` can only be scoped by a unique key, and `id` alone is
 * not a tenant boundary. A guard that is bypassed, a future background job, a bug in
 * a controller: none of them can reach another organisation's row through this
 * service.
 *
 * ## Cross-tenant reads are 404
 *
 * `AppError.notFound` for a task that exists in another org. A 403 would confirm the
 * id is real, which is the one bit of information an attacker wants from a
 * guessing loop.
 */

const TASK_SELECT = {
  id: true,
  orgId: true,
  projectId: true,
  workspaceId: true,
  title: true,
  goal: true,
  status: true,
  riskClass: true,
  priority: true,
  acceptanceCriteria: true,
  createdById: true,
  idempotencyKey: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.TaskSelect;

type TaskRow = Prisma.TaskGetPayload<{ select: typeof TASK_SELECT }>;

const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

@Injectable()
export class TasksService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OrchestratorService) private readonly orchestrator: OrchestratorService,
  ) {}

  /**
   * Creates a task, or returns the one a previous identical POST created.
   *
   * `(projectId, idempotencyKey)` is unique in the schema, so the database — not a
   * read-then-write check — is what makes the duplicate impossible. The insert is
   * attempted first and the collision is caught; that is the only version of this
   * that is correct under concurrency.
   *
   * The task, its approval request (HIGH/CRITICAL only) and both audit events are
   * one transaction. A task without its `task.created.v1` row would be a state whose
   * history is missing, which is the one thing an audit trail must never be.
   */
  async create(params: {
    orgId: string;
    projectId: string;
    input: CreateTaskInput;
    idempotencyKey: string | undefined;
    correlationId: string;
    actorId: string;
  }): Promise<{ task: TaskResponse; created: boolean }> {
    const { orgId, projectId, input, correlationId, actorId } = params;

    const project = await this.prisma.project.findFirst({
      // Tenant scoping: the project must belong to this org. Without the predicate a
      // valid project id from another tenant would be accepted and the task would be
      // created with this org's id pointing at a foreign project.
      where: { id: projectId, orgId },
      select: { id: true, workspaceId: true },
    });

    if (project === null) throw AppError.notFound('Project');

    const idempotencyKey = normaliseIdempotencyKey(params.idempotencyKey);

    try {
      const task = await this.prisma.$transaction(async (transaction) => {
        const created = await transaction.task.create({
          data: {
            orgId,
            projectId: project.id,
            // Denormalised from the project inside the same transaction, so it cannot
            // disagree with the project's workspace.
            workspaceId: project.workspaceId,
            title: input.title,
            goal: input.goal,
            riskClass: input.riskClass,
            // Undefined lets the column default ('normal') decide, so the default
            // exists in one place.
            priority: input.priority ?? undefined,
            acceptanceCriteria: [...input.acceptanceCriteria],
            createdById: actorId,
            idempotencyKey,
          },
          select: TASK_SELECT,
        });

        // Contract §15 A3: a HIGH or CRITICAL task needs an APPROVED request before
        // it can be queued. Creating the PENDING request here is what puts it in the
        // queue the approvals screen reads — without it, the gate would only ever be
        // satisfiable by seed data.
        if (requiresApproval(input.riskClass)) {
          const approval = await transaction.approvalRequest.create({
            data: {
              orgId,
              taskId: created.id,
              riskClass: input.riskClass,
              requestedById: actorId,
            },
            select: { id: true },
          });

          await this.audit.recordWithin(transaction, {
            orgId,
            projectId: created.projectId,
            actor: { type: 'user', id: actorId },
            action: 'approval.requested',
            eventType: 'approval.requested.v1',
            aggregateType: 'ApprovalRequest',
            aggregateId: approval.id,
            correlationId,
            payload: { taskId: created.id, riskClass: input.riskClass },
          });
        }

        await this.audit.recordWithin(transaction, {
          orgId,
          projectId: created.projectId,
          actor: { type: 'user', id: actorId },
          action: 'task.created',
          eventType: 'task.created.v1',
          aggregateType: 'Task',
          aggregateId: created.id,
          correlationId,
          idempotencyKey: `task.created:${created.id}`,
          payload: { title: created.title, riskClass: created.riskClass, status: created.status },
        });

        return created;
      });

      return { task: toTaskResponse(task), created: true };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;

      // A duplicate POST: return the row the first request created. The payload is
      // deliberately not compared — the contract says a duplicate returns the
      // existing task, and a client retrying after a timeout may legitimately have
      // rebuilt its body from the same form.
      const existing = await this.prisma.task.findFirst({
        // Tenant scoping on the read-back as well: the unique key is
        // `(projectId, idempotencyKey)`, and the project was already resolved inside
        // this org, so this predicate is redundant for correctness but not for
        // intent — every task read in this file names the org.
        where: { projectId, idempotencyKey, orgId },
        select: TASK_SELECT,
      });

      if (existing === null) throw error;

      return { task: toTaskResponse(existing), created: false };
    }
  }

  async list(params: {
    orgId: string;
    projectId: string;
    page: PaginationQuery;
  }): Promise<TaskPage> {
    const { orgId, projectId, page } = params;

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, orgId },
      select: { id: true },
    });

    if (project === null) throw AppError.notFound('Project');

    if (page.cursor !== undefined) {
      // A cursor that is not in this project (or not in this org) would otherwise
      // let Prisma position the page relative to a foreign row, and would leak the
      // existence of an id through a differing result set.
      const cursor = await this.prisma.task.findFirst({
        where: { id: page.cursor, orgId, projectId },
        select: { id: true },
      });

      if (cursor === null) {
        throw new AppError(400, 'INVALID_CURSOR', 'The cursor does not belong to this task list.');
      }
    }

    const rows = await this.prisma.task.findMany({
      // Tenant scoping.
      where: { orgId, projectId },
      select: TASK_SELECT,
      // `id` is the tiebreaker: two tasks created in the same millisecond must still
      // have one deterministic order, or a cursor page can repeat or skip a row.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: page.limit + 1,
      ...(page.cursor === undefined ? {} : { cursor: { id: page.cursor }, skip: 1 }),
    });

    const hasMore = rows.length > page.limit;
    const pageRows = hasMore ? rows.slice(0, page.limit) : rows;

    return {
      data: pageRows.map(toTaskResponse),
      meta: {
        limit: page.limit,
        hasMore,
        nextCursor: hasMore ? (pageRows[pageRows.length - 1]?.id ?? null) : null,
      },
    };
  }

  async detail(orgId: string, taskId: string): Promise<TaskDetailResponse> {
    const task = await this.prisma.task.findFirst({
      // Tenant scoping. A task id from another org resolves to null and becomes 404.
      where: { id: taskId, orgId },
      select: {
        ...TASK_SELECT,
        project: { select: { id: true, key: true, name: true } },
        workspace: { select: { id: true, name: true, slug: true } },
        workflowRuns: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            workflowId: true,
            temporalRunId: true,
            status: true,
            startedAt: true,
            finishedAt: true,
            error: true,
            createdAt: true,
            agentRuns: {
              orderBy: { createdAt: 'desc' },
              take: 5,
              select: {
                id: true,
                runtimeId: true,
                model: true,
                status: true,
                startedAt: true,
                finishedAt: true,
                tokensIn: true,
                tokensOut: true,
                costUsd: true,
              },
            },
          },
        },
        artifacts: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            kind: true,
            uri: true,
            checksum: true,
            sizeBytes: true,
            runtimeId: true,
            createdAt: true,
          },
        },
        approvalRequests: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            status: true,
            riskClass: true,
            requestedById: true,
            decidedById: true,
            decisionNote: true,
            createdAt: true,
            decidedAt: true,
          },
        },
      },
    });

    if (task === null) throw AppError.notFound('Task');

    const [latestRun] = task.workflowRuns;

    return {
      ...toTaskResponse(task),
      project: task.project,
      workspace: task.workspace,
      latestRun:
        latestRun === undefined
          ? null
          : {
              id: latestRun.id,
              workflowId: latestRun.workflowId,
              temporalRunId: latestRun.temporalRunId,
              status: latestRun.status,
              startedAt: latestRun.startedAt?.toISOString() ?? null,
              finishedAt: latestRun.finishedAt?.toISOString() ?? null,
              error: latestRun.error,
              createdAt: latestRun.createdAt.toISOString(),
              agentRuns: latestRun.agentRuns.map((agentRun) => ({
                id: agentRun.id,
                runtimeId: agentRun.runtimeId,
                model: agentRun.model,
                status: agentRun.status,
                startedAt: agentRun.startedAt?.toISOString() ?? null,
                finishedAt: agentRun.finishedAt?.toISOString() ?? null,
                tokensIn: agentRun.tokensIn,
                tokensOut: agentRun.tokensOut,
                costUsd: agentRun.costUsd?.toString() ?? null,
              })),
            },
      artifacts: task.artifacts.map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        uri: artifact.uri,
        checksum: artifact.checksum,
        // BigInt does not survive JSON.stringify; bytes are far inside the safe
        // integer range, so a number is the honest representation.
        sizeBytes: Number(artifact.sizeBytes),
        runtimeId: artifact.runtimeId,
        createdAt: artifact.createdAt.toISOString(),
      })),
      approvals: task.approvalRequests.map((approval) => ({
        id: approval.id,
        status: approval.status,
        riskClass: approval.riskClass,
        requestedById: approval.requestedById,
        decidedById: approval.decidedById,
        decisionNote: approval.decisionNote,
        createdAt: approval.createdAt.toISOString(),
        decidedAt: approval.decidedAt?.toISOString() ?? null,
      })),
    };
  }

  /**
   * Status transition, validated by the shared state machine **and** by the
   * narrower human-writable subset in `human-transitions.ts`.
   *
   * `canTransition` alone is not enough here. It answers "may the task reach this
   * state", which the worker also asks; a user asking the same question would be
   * allowed to walk `ready → queued → running → verifying → succeeded` and mint a
   * terminal success with nothing behind it. So a legal edge that the orchestrator
   * owns is refused with `409 TRANSITION_IS_SYSTEM_MANAGED`.
   *
   * The write is a compare-and-swap on `(id, orgId, currentStatus)`. If another
   * request moved the task between our read and our write, the count is zero and the
   * caller gets a 409 instead of a last-writer-wins update that skipped an edge.
   */
  async updateStatus(params: {
    orgId: string;
    taskId: string;
    input: UpdateTaskStatusInput;
    correlationId: string;
    actorId: string;
  }): Promise<TaskResponse> {
    const { orgId, taskId, input, correlationId, actorId } = params;

    const task = await this.prisma.task.findFirst({
      // Tenant scoping.
      where: { id: taskId, orgId },
      select: { id: true, projectId: true, status: true, riskClass: true },
    });

    if (task === null) throw AppError.notFound('Task');

    // 422: the pair is not an edge of the machine at all.
    if (!canTransition(task.status, input.status)) {
      throw AppError.invalidTransition(task.status, input.status);
    }

    // 409: the pair is a real edge, but one that only the orchestrator may take.
    // Refused *before* the reason/approval checks and before any write, so a
    // fabricated success never leaves a half-applied state.
    if (!isHumanTransition(task.status, input.status)) {
      throw new AppError(
        409,
        'TRANSITION_IS_SYSTEM_MANAGED',
        `A task cannot be moved from "${task.status}" to "${input.status}" by a user. ` +
          'The orchestrator owns that transition; use POST /run, POST /cancel, or the approval decision endpoint.',
      );
    }

    // `blocked → ready` is the retry path and needs an explanation (contract §6).
    // `draft → ready` does not, but `UpdateTaskStatusInput` requires a reason for any
    // `ready` target — stricter than the machine, so the retry case can never arrive
    // without one. This check is the service-level backstop for callers that bypass
    // the DTO.
    if (transitionRequiresReason(task.status, input.status) && input.reason === undefined) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'A reason is required when returning a task to ready.',
        { reason: ['A reason is required when a task is moved to ready.'] },
      );
    }

    if (input.status === 'queued' && requiresApproval(task.riskClass)) {
      // Unreachable through this method now that `ready → queued` is
      // system-managed, and kept deliberately: if the human subset is ever widened,
      // the approval gate is already on the path. `POST /run` performs the same
      // check for the transition that actually queues.
      await this.assertApproved(orgId, task, correlationId, actorId, 'queued');
    }

    return this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.task.updateMany({
        // `status: task.status` makes this a compare-and-swap. `orgId` is in the
        // predicate because an update that can only name a unique id is not
        // tenant-scoped, even when the guard ran.
        where: { id: taskId, orgId, status: task.status },
        data: { status: input.status },
      });

      if (updated.count === 0) {
        throw new AppError(
          409,
          'CONFLICT',
          'The task changed while this request was in flight. Reload and try again.',
        );
      }

      const current = await transaction.task.findFirst({
        where: { id: taskId, orgId },
        select: TASK_SELECT,
      });

      if (current === null) throw AppError.notFound('Task');

      await this.audit.recordWithin(transaction, {
        orgId,
        projectId: task.projectId,
        actor: { type: 'user', id: actorId },
        action: 'task.status_changed',
        eventType: 'task.status_changed.v1',
        aggregateType: 'Task',
        aggregateId: taskId,
        correlationId,
        payload: {
          from: task.status,
          to: input.status,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
      });

      return toTaskResponse(current);
    });
  }

  /**
   * Starts `runTaskWorkflow` (contract §16).
   *
   * Order of operations matters and is the reason this is longer than it looks:
   *
   *  1. reserve — task `ready → queued` and a `WorkflowRun` row, in one transaction;
   *  2. start the workflow with the deterministic id. The reuse policy permits replacing
   *     a *closed failed* execution but not a running one, so a retry after a failure can
   *     run while a duplicate of a live run is still refused (`409`);
   *  3. on success, record the Temporal run id;
   *  4. on failure, compensate: the task goes back to `ready` and the run is marked
   *     failed. A task is never left `running` when nothing is running it.
   */
  async run(params: {
    orgId: string;
    taskId: string;
    correlationId: string;
    actorId: string;
  }): Promise<RunResponse> {
    const { orgId, taskId, correlationId, actorId } = params;

    const task = await this.prisma.task.findFirst({
      // Tenant scoping.
      where: { id: taskId, orgId },
      select: { id: true, projectId: true, status: true, riskClass: true },
    });

    if (task === null) throw AppError.notFound('Task');

    if (task.status !== 'ready') {
      throw AppError.invalidTransition(task.status, 'queued');
    }

    if (requiresApproval(task.riskClass)) {
      await this.assertApproved(orgId, task, correlationId, actorId, 'queued');
    }

    const activeRun = await this.prisma.workflowRun.findFirst({
      // Tenant scoping.
      where: { orgId, taskId, status: { in: ['queued', 'running'] } },
      select: { id: true },
    });

    if (activeRun !== null) {
      throw new AppError(409, 'WORKFLOW_ALREADY_RUNNING', 'A run is already active for this task.');
    }

    const workflowId = `${WORKFLOW_ID_PREFIX}${taskId}`;

    const reserved = await this.prisma.$transaction(async (transaction) => {
      const reservedTask = await transaction.task.updateMany({
        where: { id: taskId, orgId, status: 'ready' },
        data: { status: 'queued' },
      });

      if (reservedTask.count === 0) {
        throw new AppError(
          409,
          'CONFLICT',
          'The task changed while it was being started. Reload and try again.',
        );
      }

      const run = await transaction.workflowRun.create({
        // orgId from the request context, taskId from the path — both already
        // resolved inside this tenant.
        data: { orgId, taskId, workflowId, status: 'queued' },
        select: { id: true },
      });

      await this.audit.recordWithin(transaction, {
        orgId,
        projectId: task.projectId,
        actor: { type: 'user', id: actorId },
        action: 'task.status_changed',
        eventType: 'task.status_changed.v1',
        aggregateType: 'Task',
        aggregateId: taskId,
        correlationId,
        payload: { from: 'ready', to: 'queued', cause: 'run_requested' },
      });

      return run;
    });

    try {
      const started = await this.orchestrator.startTaskWorkflow({ taskId, orgId, correlationId });

      await this.prisma.$transaction(async (transaction) => {
        const updated = await transaction.workflowRun.updateMany({
          // Tenant scoping on the write.
          where: { id: reserved.id, orgId },
          data: { temporalRunId: started.runId },
        });

        if (updated.count === 0) {
          this.logger.error({ orgId, taskId, workflowRunId: reserved.id }, 'workflow run vanished');
        }

        await this.audit.recordWithin(transaction, {
          orgId,
          projectId: task.projectId,
          actor: { type: 'user', id: actorId },
          action: 'workflow.started',
          eventType: 'workflow.started.v1',
          aggregateType: 'WorkflowRun',
          aggregateId: reserved.id,
          correlationId,
          payload: { workflowId, temporalRunId: started.runId, taskId },
        });
      });

      return {
        taskId,
        workflowRunId: reserved.id,
        workflowId,
        temporalRunId: started.runId,
        status: 'queued',
      };
    } catch (error) {
      const failure =
        error instanceof OrchestratorUnavailableError
          ? {
              code: 'ORCHESTRATOR_UNAVAILABLE' as const,
              status: 503,
              message: 'The orchestrator is unavailable. Nothing was started.',
            }
          : isWorkflowAlreadyStartedError(error)
            ? {
                code: 'WORKFLOW_ALREADY_RUNNING' as const,
                status: 409,
                message: 'A workflow with this task id already exists.',
              }
            : undefined;

      if (failure === undefined) {
        // Not an orchestration failure: still compensate, then let the filter record
        // a 500 with the stack. Leaving the task queued would strand it.
        await this.compensateFailedStart(orgId, taskId, task.projectId, reserved.id, correlationId, {
          code: 'START_FAILED',
          message: 'The workflow could not be started.',
        });
        throw error;
      }

      await this.compensateFailedStart(
        orgId,
        taskId,
        task.projectId,
        reserved.id,
        correlationId,
        { code: failure.code, message: failure.message },
      );

      throw new AppError(failure.status, failure.code, failure.message);
    }
  }

  async cancel(params: {
    orgId: string;
    taskId: string;
    correlationId: string;
    actorId: string;
  }): Promise<CancelResponse> {
    const { orgId, taskId, correlationId, actorId } = params;

    const task = await this.prisma.task.findFirst({
      // Tenant scoping.
      where: { id: taskId, orgId },
      select: { id: true, projectId: true, status: true },
    });

    if (task === null) throw AppError.notFound('Task');

    if (task.status !== 'queued' && task.status !== 'running') {
      throw new AppError(
        409,
        'TASK_NOT_CANCELLABLE',
        `A task in status "${task.status}" cannot be cancelled.`,
      );
    }

    const activeRun = await this.prisma.workflowRun.findFirst({
      // Tenant scoping.
      where: { orgId, taskId, status: { in: ['queued', 'running'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    // Temporal first: if the orchestrator is unreachable, the task must keep its
    // current status. Marking it cancelled locally while the workflow keeps running
    // would produce a task that is cancelled in the UI and working in the background.
    let orchestrator: 'cancelled' | 'not_found';
    try {
      orchestrator = await this.orchestrator.cancelTaskWorkflow(`${WORKFLOW_ID_PREFIX}${taskId}`);
    } catch (error) {
      if (error instanceof OrchestratorUnavailableError) {
        throw new AppError(
          503,
          'ORCHESTRATOR_UNAVAILABLE',
          'The orchestrator is unavailable. The task was not cancelled.',
        );
      }

      throw error;
    }

    await this.prisma.$transaction(async (transaction) => {
      await transaction.task.updateMany({
        // Tenant scoping, and the status guard keeps the compare-and-swap honest.
        where: { id: taskId, orgId, status: { in: ['queued', 'running'] } },
        data: { status: 'cancelled' },
      });

      if (activeRun !== null) {
        await transaction.workflowRun.updateMany({
          where: { id: activeRun.id, orgId },
          data: { status: 'cancelled', finishedAt: new Date() },
        });
      }

      await this.audit.recordWithin(transaction, {
        orgId,
        projectId: task.projectId,
        actor: { type: 'user', id: actorId },
        action: 'task.cancelled',
        eventType: 'task.cancelled.v1',
        aggregateType: 'Task',
        aggregateId: taskId,
        correlationId,
        payload: {
          from: task.status,
          orchestrator,
          workflowRunId: activeRun?.id ?? null,
        },
      });
    });

    return {
      taskId,
      status: 'cancelled',
      workflowRunId: activeRun?.id ?? null,
      orchestrator,
    };
  }

  /**
   * Contract §15 A3's precondition, in one place.
   *
   * `POST /run` is the only path to queueing, so it is the only caller — and a
   * gate that exists on only one path is not a gate. `updateStatus` keeps an
   * unreachable call on the `queued` branch as defence in depth if the human
   * transition subset is ever widened.
   *
   * The refusal is an audit event as well as a 409 — "the user tried to run a
   * CRITICAL task without approval" is exactly the kind of thing a reviewer needs to
   * see later.
   */
  private async assertApproved(
    orgId: string,
    task: { id: string; projectId: string; status: TaskStatus; riskClass: RiskClass },
    correlationId: string,
    actorId: string,
    target: TaskStatus,
  ): Promise<void> {
    const approval = await this.prisma.approvalRequest.findFirst({
      // Tenant scoping: an approval from another org can never satisfy this gate.
      where: { orgId, taskId: task.id, status: 'APPROVED' },
      select: { id: true },
    });

    if (approval !== null) return;

    await this.audit.record({
      orgId,
      projectId: task.projectId,
      actor: { type: 'user', id: actorId },
      action: 'task.transition_refused',
      eventType: 'task.transition_refused.v1',
      aggregateType: 'Task',
      aggregateId: task.id,
      correlationId,
      payload: {
        from: task.status,
        to: target,
        riskClass: task.riskClass,
        reason: 'approval_required',
      },
    });

    throw new AppError(
      409,
      'APPROVAL_REQUIRED',
      `A ${task.riskClass} task requires an approved request before it can be queued.`,
      { approval: [`No APPROVED approval request exists for task ${task.id}.`] },
    );
  }

  private async compensateFailedStart(
    orgId: string,
    taskId: string,
    projectId: string,
    workflowRunId: string,
    correlationId: string,
    error: { code: string; message: string },
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await transaction.workflowRun.updateMany({
        where: { id: workflowRunId, orgId },
        data: { status: 'failed', finishedAt: new Date(), error: { ...error } },
      });

      // Rollback of the reservation, not a user-visible transition: the task returns
      // to the status it had before the request. Guarded by `status: 'queued'` so it
      // cannot undo a concurrent cancellation.
      await transaction.task.updateMany({
        where: { id: taskId, orgId, status: 'queued' },
        data: { status: 'ready' },
      });

      await this.audit.recordWithin(transaction, {
        orgId,
        projectId,
        actor: { type: 'system', id: SYSTEM_ACTOR_ID },
        action: 'workflow.start_failed',
        eventType: 'workflow.start_failed.v1',
        aggregateType: 'WorkflowRun',
        aggregateId: workflowRunId,
        correlationId,
        payload: { code: error.code, from: 'queued', to: 'ready', taskId },
      });
    });
  }
}

/**
 * A stable id for the system actor in audit events. Not a user row: the actor enum
 * distinguishes `system`, and inventing a user id would misattribute the event.
 * A fixed v5-shaped UUID keeps it greppable and valid for `EventEnvelope.actor.id`.
 */
const SYSTEM_ACTOR_ID = '00000000-0000-5000-8000-000000000000';

function normaliseIdempotencyKey(value: string | undefined): string {
  const key = value?.trim();

  if (key === undefined || key.length === 0) {
    // The column is non-null and part of the uniqueness constraint, so a request
    // without a key still gets one. It is unique per call, which makes such a
    // request non-idempotent — correct, because it did not ask to be.
    return `auto-${randomUUID()}`;
  }

  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'The Idempotency-Key header is too long.',
      { 'Idempotency-Key': [`Must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`] },
    );
  }

  return key;
}

function toTaskResponse(task: TaskRow): TaskResponse {
  return {
    id: task.id,
    orgId: task.orgId,
    projectId: task.projectId,
    workspaceId: task.workspaceId,
    title: task.title,
    goal: task.goal,
    status: task.status,
    riskClass: task.riskClass,
    priority: task.priority,
    acceptanceCriteria: task.acceptanceCriteria,
    createdById: task.createdById,
    idempotencyKey: task.idempotencyKey,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}
