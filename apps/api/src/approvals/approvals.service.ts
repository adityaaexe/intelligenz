import { Inject, Injectable } from '@nestjs/common';
import type { PaginationQuery, RiskClass, TaskStatus } from '@intelligenz/contracts';
import type { ApprovalStatus, Prisma, PrismaClient } from '@intelligenz/database';

import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/errors';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { PRISMA_CLIENT } from '../database/database.module';
import type { PageMeta } from '../tasks/tasks.response';
import { computeTaskContentHash, readTaskBinding, resolvePolicyVersion } from './approval-binding';
import { allowsSelfApproval } from './org-policy';
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
  /**
   * Phase 4 lifetime fields. Exposed so the approvals screen can show "expires in 3 h"
   * and "used at 14:02" instead of presenting a spent grant as pending. Null on every
   * row written before Phase 4 — which is itself information, not a gap to fill in.
   */
  readonly expiresAt: string | null;
  readonly consumedAt: string | null;
  readonly revokedAt: string | null;
  readonly task: ApprovalTaskSummary | null;
  readonly requestedBy: ApprovalUserSummary | null;
  readonly decidedBy: ApprovalUserSummary | null;
}

export interface ApprovalPage {
  readonly data: ApprovalListItem[];
  readonly meta: PageMeta;
}

const APPROVAL_LIST_SELECT = {
  id: true,
  taskId: true,
  riskClass: true,
  status: true,
  createdAt: true,
  decidedAt: true,
  decisionNote: true,
  expiresAt: true,
  consumedAt: true,
  revokedAt: true,
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
} as const satisfies Prisma.ApprovalRequestSelect;

type ApprovalListRow = Prisma.ApprovalRequestGetPayload<{ select: typeof APPROVAL_LIST_SELECT }>;

@Injectable()
export class ApprovalsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
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
      select: APPROVAL_LIST_SELECT,
    });

    const hasMore = rows.length > page.limit;
    const pageRows = hasMore ? rows.slice(0, page.limit) : rows;

    return {
      data: pageRows.map(toApprovalListItem),
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
   * ## Binding happens here, at the moment of the decision
   *
   * Approving is the act of saying "yes, to this". So the grant is bound to the task's
   * content, derived class, policy version, execution profile and source **as the
   * approver saw them on this request**, not as they were when the request was opened.
   * An approval created before Phase 4 keeps a null hash (`APPROVAL_UNBOUND` at
   * execution): back-filling would claim a review that never happened.
   *
   * ## Separation of duties
   *
   * `requestedById === actorId` on an `approve` decision is `403
   * SELF_APPROVAL_FORBIDDEN` unless the org has an explicit compiled-in override
   * (`ORG_POLICY`, empty by default — see `org-policy.ts`). Rejecting or requesting
   * changes on your own request is allowed: the control is about granting.
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
        requestedById: true,
        createdAt: true,
        task: {
          select: {
            id: true,
            title: true,
            goal: true,
            acceptanceCriteria: true,
            riskClass: true,
            derivedRiskClass: true,
            riskPolicyVersion: true,
            riskFactors: true,
            projectId: true,
          },
        },
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

    if (
      input.decision === 'approve' &&
      approval.requestedById === actorId &&
      !allowsSelfApproval(orgId)
    ) {
      await this.audit.record({
        orgId,
        projectId: approval.task.projectId,
        actor: { type: 'user', id: actorId },
        action: 'approval.self_approval_refused',
        eventType: 'approval.self_approval_refused.v1',
        aggregateType: 'ApprovalRequest',
        aggregateId: approvalId,
        correlationId,
        payload: { taskId: approval.taskId, requestedById: approval.requestedById },
      });

      throw new AppError(
        403,
        'SELF_APPROVAL_FORBIDDEN',
        'A request may not be approved by the person who raised it. Ask another admin to review it.',
      );
    }

    const decidedStatus = DECISION_TO_STATUS[input.decision];

    // The binding is computed before the write, from the row as it exists now. For a
    // rejection there is nothing to bind: the row will never authorise anything.
    const binding =
      decidedStatus === 'APPROVED' ? this.buildBinding(approval.task) : undefined;

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
          ...(binding === undefined
            ? {}
            : {
                taskContentHash: binding.taskContentHash,
                riskClassAtApproval: binding.riskClassAtApproval,
                policyVersion: binding.policyVersion,
                executionProfile: binding.executionProfile,
                expiresAt: binding.expiresAt,
              }),
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
          ...(binding === undefined
            ? {}
            : {
                riskClassAtApproval: binding.riskClassAtApproval,
                policyVersion: binding.policyVersion,
                executionProfile: binding.executionProfile,
                expiresAt: binding.expiresAt.toISOString(),
              }),
        },
      });

      const current = await transaction.approvalRequest.findFirst({
        where: { id: approvalId, orgId },
        select: APPROVAL_LIST_SELECT,
      });

      if (current === null) throw AppError.notFound('Approval request');

      return current;
    });

    return toApprovalListItem(decided);
  }

  /**
   * Withdraws an approved grant (`POST …/approvals/:approvalId/revoke`, `ADMIN+`).
   *
   * ## Revocation is not retroactive
   *
   * A consumed approval can still be revoked. The row becomes `REVOKED` and
   * `revokedAt`/`revokedById` are set, but `consumedAt` stays — so the record reads
   * "granted, spent at T, withdrawn at T+1", which is the truth. Nothing can make the
   * run that already happened unauthorised, and pretending otherwise would be a worse
   * audit story than admitting the grant existed. What revocation does control is
   * **future** use, which for a consumed single-use grant is already nothing.
   *
   * Revoking an already-revoked row is idempotent (`200`, unchanged): incident response
   * should not have to check current state before pressing the button.
   *
   * Only `APPROVED` can be revoked. A `PENDING` request is not a grant yet — it is
   * withdrawn by rejecting it, which is a different decision with its own audit event.
   */
  async revoke(params: {
    orgId: string;
    approvalId: string;
    correlationId: string;
    actorId: string;
  }): Promise<ApprovalListItem> {
    const { orgId, approvalId, correlationId, actorId } = params;

    const approval = await this.prisma.approvalRequest.findFirst({
      // Tenant scoping: another org's id is 404, never 403.
      where: { id: approvalId, orgId },
      select: { id: true, taskId: true, status: true, consumedAt: true, task: { select: { projectId: true } } },
    });

    if (approval === null) throw AppError.notFound('Approval request');

    if (approval.status !== 'REVOKED') {
      if (approval.status !== 'APPROVED') {
        throw new AppError(
          409,
          'APPROVAL_NOT_REVOCABLE',
          `An approval in status ${approval.status} cannot be revoked. Only an APPROVED grant can be withdrawn.`,
        );
      }

      const revoked = await this.prisma.$transaction(async (transaction) => {
        const updated = await transaction.approvalRequest.updateMany({
          where: { id: approvalId, orgId, status: 'APPROVED' },
          data: { status: 'REVOKED', revokedAt: new Date(), revokedById: actorId },
        });

        if (updated.count === 0) {
          throw new AppError(
            409,
            'CONFLICT',
            'The approval changed while this request was in flight. Reload and try again.',
          );
        }

        await this.audit.recordWithin(transaction, {
          orgId,
          projectId: approval.task.projectId,
          actor: { type: 'user', id: actorId },
          action: 'approval.revoked',
          eventType: 'approval.revoked.v1',
          aggregateType: 'ApprovalRequest',
          aggregateId: approvalId,
          correlationId,
          idempotencyKey: `approval.revoked:${approvalId}`,
          payload: {
            taskId: approval.taskId,
            // True when the grant had already been spent: recorded so the trail says
            // "revoked after use" rather than implying the run is undone.
            consumed: approval.consumedAt !== null,
            consumedAt: approval.consumedAt?.toISOString() ?? null,
          },
        });

        const current = await transaction.approvalRequest.findFirst({
          where: { id: approvalId, orgId },
          select: APPROVAL_LIST_SELECT,
        });

        if (current === null) throw AppError.notFound('Approval request');

        return current;
      });

      return toApprovalListItem(revoked);
    }

    const current = await this.prisma.approvalRequest.findFirst({
      where: { id: approvalId, orgId },
      select: APPROVAL_LIST_SELECT,
    });

    if (current === null) throw AppError.notFound('Approval request');

    return toApprovalListItem(current);
  }

  /**
   * The grant's binding: content hash, the class the approver saw, the policy that
   * produced it, the profile it authorises, and a deadline counted from the decision.
   */
  private buildBinding(task: {
    readonly title: string;
    readonly goal: string;
    readonly acceptanceCriteria: readonly string[];
    readonly riskClass: RiskClass;
    readonly derivedRiskClass: RiskClass | null;
    readonly riskPolicyVersion: string | null;
    readonly riskFactors: unknown;
  }): {
    taskContentHash: string;
    riskClassAtApproval: RiskClass;
    policyVersion: string;
    executionProfile: string;
    expiresAt: Date;
  } {
    const execution = readTaskBinding(task.riskFactors);
    // The derived class is authoritative. Falling back to `riskClass` covers fixture
    // and pre-Phase-4 rows, where the two are the same value by construction.
    const riskClassAtApproval = task.derivedRiskClass ?? task.riskClass;

    return {
      taskContentHash: computeTaskContentHash({
        title: task.title,
        goal: task.goal,
        acceptanceCriteria: task.acceptanceCriteria,
        riskClass: riskClassAtApproval,
        executionProfile: execution.executionProfile,
        sourceRef: execution.sourceRef,
        baseCommit: execution.baseCommit,
      }),
      riskClassAtApproval,
      policyVersion: resolvePolicyVersion(task.riskPolicyVersion),
      executionProfile: execution.executionProfile,
      expiresAt: new Date(Date.now() + this.config.approvalTtlHours * 60 * 60 * 1_000),
    };
  }
}

function toApprovalListItem(row: ApprovalListRow): ApprovalListItem {
  return {
    id: row.id,
    taskId: row.taskId,
    riskClass: row.riskClass,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    consumedAt: row.consumedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    task: row.task,
    requestedBy: row.requestedBy,
    decidedBy: row.decidedBy,
  };
}
