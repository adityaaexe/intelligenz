import { Inject, Injectable } from '@nestjs/common';
import type { PaginationQuery, RiskClass, TaskStatus } from '@intelligenz/contracts';
import type { ApprovalStatus } from '@intelligenz/database';
import type { PrismaClient } from '@intelligenz/database';

import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/errors';
import { PRISMA_CLIENT } from '../database/database.module';
import type { PageMeta } from '../tasks/tasks.response';
import { DECISION_TO_STATUS, type ApprovalDecisionInput } from './approval.dto';

export interface ApprovalTaskSummary {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly riskClass: RiskClass;
  readonly projectId: string;
  readonly workspaceId: string;
}

export interface ApprovalUserSummary {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export interface ApprovalListItem {
  readonly id: string;
  readonly taskId: string;
  readonly riskClass: RiskClass;
  readonly status: ApprovalStatus;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly task: ApprovalTaskSummary | null;
  readonly requestedBy: ApprovalUserSummary | null;
  readonly decidedBy: ApprovalUserSummary | null;
}

export interface ApprovalPage {
  readonly data: ApprovalListItem[];
  readonly meta: PageMeta;
}

@Injectable()
export class ApprovalsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * The pending queue (contract §15 A3, §15 A6 "awaiting approvals").
   *
   * Risk-ranked: `CRITICAL` before `HIGH` before `MEDIUM` before `LOW`. On Postgres
   * an enum sorts by its declaration order, which the schema declares as
   * `LOW, MEDIUM, HIGH, CRITICAL` — so `desc` is exactly the ranking the design
   * wants, without a CASE expression or an in-memory sort that would break cursor
   * pagination. Within a risk class, the oldest request is first: the one that has
   * been waiting longest is the one blocking someone.
   */
  async listPending(orgId: string, page: PaginationQuery): Promise<ApprovalPage> {
    if (page.cursor !== undefined) {
      const cursor = await this.prisma.approvalRequest.findFirst({
        // Tenant scoping, and the same status predicate as the page: a cursor from
        // the decided list must not be usable here.
        where: { id: page.cursor, orgId, status: 'PENDING' },
        select: { id: true },
      });

      if (cursor === null) {
        throw new AppError(400, 'INVALID_CURSOR', 'The cursor does not belong to this queue.');
      }
    }

    const rows = await this.prisma.approvalRequest.findMany({
      // Tenant scoping.
      where: { orgId, status: 'PENDING' },
      orderBy: [{ riskClass: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: page.limit + 1,
      ...(page.cursor === undefined ? {} : { cursor: { id: page.cursor }, skip: 1 }),
      select: {
        id: true,
        taskId: true,
        riskClass: true,
        status: true,
        createdAt: true,
        decidedAt: true,
        decisionNote: true,
        task: {
          select: {
            id: true,
            title: true,
            status: true,
            riskClass: true,
            projectId: true,
            workspaceId: true,
          },
        },
        requestedBy: { select: { id: true, name: true, email: true } },
        decidedBy: { select: { id: true, name: true, email: true } },
      },
    });

    const hasMore = rows.length > page.limit;
    const pageRows = hasMore ? rows.slice(0, page.limit) : rows;

    return {
      data: pageRows.map((row) => ({
        id: row.id,
        taskId: row.taskId,
        riskClass: row.riskClass,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        decidedAt: row.decidedAt?.toISOString() ?? null,
        decisionNote: row.decisionNote,
        task: row.task,
        requestedBy: row.requestedBy,
        decidedBy: row.decidedBy,
      })),
      meta: {
        limit: page.limit,
        hasMore,
        nextCursor: hasMore ? (pageRows[pageRows.length - 1]?.id ?? null) : null,
      },
    };
  }

  /**
   * Records a decision. Not a task transition: approval is a precondition, not a
   * state (contract §15 A3), so the task stays `ready` until someone runs it.
   *
   * The write is a compare-and-swap on `status: 'PENDING'`. Two admins clicking
   * "approve" and "reject" at the same time produce one decision and one 409, not a
   * row whose status disagrees with its own note.
   */
  async decide(params: {
    orgId: string;
    approvalId: string;
    input: ApprovalDecisionInput;
    correlationId: string;
    actorId: string;
  }): Promise<ApprovalListItem> {
    const { orgId, approvalId, input, correlationId, actorId } = params;

    const approval = await this.prisma.approvalRequest.findFirst({
      // Tenant scoping. An approval id from another org is 404, not 403.
      where: { id: approvalId, orgId },
      select: {
        id: true,
        taskId: true,
        status: true,
        riskClass: true,
        createdAt: true,
        task: { select: { projectId: true } },
      },
    });

    if (approval === null) throw AppError.notFound('Approval request');

    if (approval.status !== 'PENDING') {
      throw new AppError(
        409,
        'ALREADY_DECIDED',
        `This approval request was already decided (${approval.status}).`,
      );
    }

    const decidedStatus = DECISION_TO_STATUS[input.decision];

    const decided = await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.approvalRequest.updateMany({
        // `status: 'PENDING'` is the compare-and-swap; `orgId` is the tenant
        // predicate. Both are required: the first makes concurrent decisions safe,
        // the second makes the write tenant-scoped even if the guard were bypassed.
        where: { id: approvalId, orgId, status: 'PENDING' },
        data: {
          status: decidedStatus,
          decidedById: actorId,
          decidedAt: new Date(),
          decisionNote: input.note ?? null,
        },
      });

      if (updated.count === 0) {
        throw new AppError(
          409,
          'ALREADY_DECIDED',
          'This approval request was decided by someone else a moment ago.',
        );
      }

      await this.audit.recordWithin(transaction, {
        orgId,
        projectId: approval.task.projectId,
        actor: { type: 'user', id: actorId },
        action: 'approval.decided',
        eventType: 'approval.decided.v1',
        aggregateType: 'ApprovalRequest',
        aggregateId: approvalId,
        correlationId,
        idempotencyKey: `approval.decided:${approvalId}`,
        payload: {
          decision: input.decision,
          status: decidedStatus,
          taskId: approval.taskId,
          riskClass: approval.riskClass,
          hasNote: input.note !== undefined,
        },
      });

      const current = await transaction.approvalRequest.findFirst({
        where: { id: approvalId, orgId },
        select: {
          id: true,
          taskId: true,
          riskClass: true,
          status: true,
          createdAt: true,
          decidedAt: true,
          decisionNote: true,
          task: {
            select: {
              id: true,
              title: true,
              status: true,
              riskClass: true,
              projectId: true,
              workspaceId: true,
            },
          },
          requestedBy: { select: { id: true, name: true, email: true } },
          decidedBy: { select: { id: true, name: true, email: true } },
        },
      });

      if (current === null) throw AppError.notFound('Approval request');

      return current;
    });

    return {
      id: decided.id,
      taskId: decided.taskId,
      riskClass: decided.riskClass,
      status: decided.status,
      createdAt: decided.createdAt.toISOString(),
      decidedAt: decided.decidedAt?.toISOString() ?? null,
      decisionNote: decided.decisionNote,
      task: decided.task,
      requestedBy: decided.requestedBy,
      decidedBy: decided.decidedBy,
    };
  }
}
