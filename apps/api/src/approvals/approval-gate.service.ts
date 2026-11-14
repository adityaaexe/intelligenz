import { Inject, Injectable } from '@nestjs/common';
import type { RiskClass } from '@intelligenz/contracts';
import type { Prisma, PrismaClient } from '@intelligenz/database';

import { AuditService } from '../audit/audit.service';
import { AppError, type ErrorCode } from '../common/errors';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { PRISMA_CLIENT } from '../database/database.module';
import {
  computeTaskContentHash,
  diffBinding,
  readTaskBinding,
  resolveBinding,
} from './approval-binding';

/**
 * The execution gate: may this task spend an approval right now?
 *
 * ## One place, three callers
 *
 * `POST /run`, `PATCH → queued` and (in the worker, another unit) the execution
 * activity all need the same answer. A gate implemented twice is a gate that will
 * disagree with itself, so the checks live here and the callers differ only in whether
 * they may **consume**:
 *
 *   - `POST /run` consumes. It is the only path that queues work.
 *   - `PATCH → queued` does **not** consume, and cannot: the edge is system-managed, so
 *     a successful check is followed by `409 TRANSITION_IS_SYSTEM_MANAGED`. Consuming
 *     there would burn a grant on a request that was always going to be refused.
 *
 * ## The five conditions
 *
 *   1. `status = APPROVED`
 *   2. `consumedAt IS NULL`
 *   3. `revokedAt IS NULL`
 *   4. `expiresAt` in the future (a null expiry is treated as `createdAt + TTL`, never
 *      as forever)
 *   5. `taskContentHash` matches the task's content, class, profile and source **as
 *      they are now**
 *
 * ## Consumption is a compare-and-swap, never an update by id
 *
 * `updateMany({ where: { id, orgId, status: 'APPROVED', consumedAt: null, revokedAt:
 * null } })` and `count === 0` means "somebody else got there first" — which is a
 * refusal, not a retry. A plain `update({ where: { id } })` would let two concurrent
 * runs both spend the same grant; the second write would silently succeed and the
 * approval would have authorised two executions.
 *
 * ## Refusals are audited, and they survive a rollback
 *
 * `POST /run` calls this inside the reservation transaction. The refusal audit is
 * therefore written with `AuditService.record` (outside the transaction): an event
 * that rolls back with the request is not a record that the request was refused. The
 * *consumption* is deliberately inside the transaction — if the reservation fails,
 * nothing was authorised and the grant must not be spent.
 */

/** The task facts the gate needs. Deliberately a narrow structural type. */
export interface ApprovalGateTask {
  readonly id: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly title: string;
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
  /** The effective class. Callers pass `derivedRiskClass ?? riskClass`. */
  readonly riskClass: RiskClass;
  readonly riskPolicyVersion: string | null;
  readonly riskFactors: unknown;
}

export interface ApprovalAssertion {
  readonly executionProfile?: string;
  readonly sourceRef?: string;
  readonly baseCommit?: string;
}

export interface ApprovalGateResult {
  readonly approvalId: string;
  readonly riskClassAtApproval: RiskClass;
  readonly policyVersion: string | null;
}

export interface ApprovalGateParams {
  readonly task: ApprovalGateTask;
  readonly correlationId: string;
  readonly actorId: string;
  /** `true` for `POST /run`; `false` for a read-only precondition check. */
  readonly consume: boolean;
  /**
   * The attempt that spends the grant, when it already exists. `null`/absent means
   * "not yet attributable": `POST /run` happens before the worker creates the attempt.
   * `consumedAt` still makes the grant spent; the worker fills the link in later.
   */
  readonly attemptId?: string | null;
  /** What the execution request asserts it will use. Compared, never trusted blindly. */
  readonly assertion?: ApprovalAssertion;
  /** The caller's transaction, so a failed reservation does not spend the grant. */
  readonly transaction?: Prisma.TransactionClient;
}

type ApprovalWriteClient = Pick<Prisma.TransactionClient, 'approvalRequest'>;

@Injectable()
export class ApprovalGateService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async requireLiveApproval(params: ApprovalGateParams): Promise<ApprovalGateResult> {
    const { task, correlationId, actorId, consume } = params;

    const recorded = readTaskBinding(task.riskFactors);
    const effective = resolveBinding(recorded, params.assertion);
    const expectedHash = computeTaskContentHash({
      title: task.title,
      goal: task.goal,
      acceptanceCriteria: task.acceptanceCriteria,
      riskClass: task.riskClass,
      executionProfile: effective.executionProfile,
      sourceRef: effective.sourceRef,
      baseCommit: effective.baseCommit,
    });

    const approvals = await this.prisma.approvalRequest.findMany({
      // Tenant scoping: an approval from another org can never satisfy this gate, even
      // if its `taskId` were guessed.
      where: { orgId: task.orgId, taskId: task.id },
      // Newest first: after a re-approval the newest grant is the one that applies.
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        riskClass: true,
        taskContentHash: true,
        policyVersion: true,
        expiresAt: true,
        consumedAt: true,
        revokedAt: true,
        createdAt: true,
      },
    });

    const now = Date.now();
    const ttlMs = this.config.approvalTtlHours * 60 * 60 * 1_000;

    let refusal: ErrorCode | null = null;
    let refusalDetails: Record<string, string[]> | undefined;

    for (const approval of approvals) {
      if (approval.status === 'REVOKED' || approval.revokedAt !== null) {
        refusal ??= 'APPROVAL_REVOKED';
        continue;
      }

      if (approval.status === 'EXPIRED') {
        refusal ??= 'APPROVAL_EXPIRED';
        continue;
      }

      // PENDING, REJECTED and CHANGES_REQUESTED explain nothing that
      // `APPROVAL_REQUIRED` does not already say. They are not live grants.
      if (approval.status !== 'APPROVED') continue;

      if (approval.consumedAt !== null) {
        refusal ??= 'APPROVAL_CONSUMED';
        continue;
      }

      if (approval.taskContentHash === null) {
        // A Phase 3 row: approved before binding existed. It cannot be proven to be
        // about the content that exists now, so it is not usable. Refusing is the
        // honest option; back-filling a hash would assert something nobody observed.
        refusal ??= 'APPROVAL_UNBOUND';
        continue;
      }

      const effectiveExpiry =
        approval.expiresAt?.getTime() ?? approval.createdAt.getTime() + ttlMs;

      if (effectiveExpiry <= now) {
        // Commit the flip before refusing. If this were inside the caller's rolled-back
        // transaction, the row would stay APPROVED and the same dead grant would be
        // re-evaluated on every attempt.
        await this.markExpired(task, approval.id, correlationId);
        refusal ??= 'APPROVAL_EXPIRED';
        continue;
      }

      if (approval.taskContentHash !== expectedHash) {
        refusal ??= 'APPROVAL_STALE';
        // Name what changed, without naming the values. The comparison is against the
        // *asserted* binding, so a profile/source change is reported precisely rather
        // than as a generic content edit.
        const changed = diffBinding(recorded, effective);
        refusalDetails = { approval: changed.length > 0 ? changed : ['taskContent'] };
        continue;
      }

      if (!consume) {
        return {
          approvalId: approval.id,
          riskClassAtApproval: approval.riskClass,
          policyVersion: approval.policyVersion,
        };
      }

      const client: ApprovalWriteClient = params.transaction ?? this.prisma;
      const consumedAt = new Date();

      const consumed = await client.approvalRequest.updateMany({
        // The CAS. Every one of these predicates is load-bearing:
        //   id + orgId       → tenant scope;
        //   status           → a REVOKED/EXPIRED row cannot be spent;
        //   consumedAt null  → single use;
        //   revokedAt null   → a revocation that arrived between the read and here wins.
        where: {
          id: approval.id,
          orgId: task.orgId,
          status: 'APPROVED',
          consumedAt: null,
          revokedAt: null,
        },
        data: { consumedAt, consumedByAttemptId: params.attemptId ?? null },
      });

      if (consumed.count === 0) {
        // Lost the race. Not an error in this request — it is the second run of one
        // approval, and the correct answer is "this grant is gone".
        refusal ??= 'APPROVAL_CONSUMED';
        continue;
      }

      await this.recordConsumed({
        task,
        approvalId: approval.id,
        consumedAt,
        attemptId: params.attemptId ?? null,
        correlationId,
        actorId,
        transaction: params.transaction,
      });

      return {
        approvalId: approval.id,
        riskClassAtApproval: approval.riskClass,
        policyVersion: approval.policyVersion,
      };
    }

    await this.recordRefusal({
      task,
      ...(refusal === null ? { code: 'APPROVAL_REQUIRED' as const } : { code: refusal }),
      correlationId,
      actorId,
    });

    throw this.refusalError(refusal ?? 'APPROVAL_REQUIRED', task, refusalDetails);
  }

  private refusalError(
    code: ErrorCode,
    task: ApprovalGateTask,
    details: Record<string, string[]> | undefined,
  ): AppError {
    const risk = task.riskClass;

    switch (code) {
      case 'APPROVAL_STALE':
        return new AppError(
          409,
          'APPROVAL_STALE',
          'The approval was granted for different content, risk class, execution profile or source. Request a new approval.',
          details,
        );
      case 'APPROVAL_CONSUMED':
        return new AppError(
          409,
          'APPROVAL_CONSUMED',
          'The approval for this task has already been used. A second run needs a new approval.',
        );
      case 'APPROVAL_EXPIRED':
        return new AppError(
          409,
          'APPROVAL_EXPIRED',
          'The approval for this task has expired. Request a new approval.',
        );
      case 'APPROVAL_REVOKED':
        return new AppError(
          409,
          'APPROVAL_REVOKED',
          'The approval for this task was revoked. Request a new approval.',
        );
      case 'APPROVAL_UNBOUND':
        return new AppError(
          409,
          'APPROVAL_UNBOUND',
          'This approval predates content binding and cannot authorise a run. Request a new approval.',
        );
      default:
        return new AppError(
          409,
          'APPROVAL_REQUIRED',
          `A ${risk} task requires an approved request before it can be queued.`,
          { approval: [`No live APPROVED approval request exists for task ${task.id}.`] },
        );
    }
  }

  /**
   * `APPROVED` → `EXPIRED`, guarded so a row that was consumed or revoked in the
   * meantime is left alone. The audit event is written only when the flip happened.
   */
  private async markExpired(
    task: ApprovalGateTask,
    approvalId: string,
    correlationId: string,
  ): Promise<void> {
    const flipped = await this.prisma.approvalRequest.updateMany({
      where: {
        id: approvalId,
        orgId: task.orgId,
        status: 'APPROVED',
        consumedAt: null,
        revokedAt: null,
      },
      data: { status: 'EXPIRED' },
    });

    if (flipped.count === 0) return;

    await this.audit.record({
      orgId: task.orgId,
      projectId: task.projectId,
      actor: { type: 'system', id: SYSTEM_ACTOR_ID },
      action: 'approval.expired',
      eventType: 'approval.expired.v1',
      aggregateType: 'ApprovalRequest',
      aggregateId: approvalId,
      correlationId,
      idempotencyKey: `approval.expired:${approvalId}`,
      payload: { taskId: task.id, reason: 'expires_at_passed' },
    });
  }

  private async recordConsumed(params: {
    task: ApprovalGateTask;
    approvalId: string;
    consumedAt: Date;
    attemptId: string | null;
    correlationId: string;
    actorId: string;
    transaction: Prisma.TransactionClient | undefined;
  }): Promise<void> {
    const event = {
      orgId: params.task.orgId,
      projectId: params.task.projectId,
      actor: { type: 'user' as const, id: params.actorId },
      action: 'approval.consumed',
      eventType: 'approval.consumed.v1',
      aggregateType: 'ApprovalRequest',
      aggregateId: params.approvalId,
      correlationId: params.correlationId,
      idempotencyKey: `approval.consumed:${params.approvalId}`,
      payload: {
        taskId: params.task.id,
        consumedAt: params.consumedAt.toISOString(),
        consumedByAttemptId: params.attemptId,
      },
    };

    if (params.transaction !== undefined) {
      await this.audit.recordWithin(params.transaction, event);
      return;
    }

    await this.audit.record(event);
  }

  private async recordRefusal(params: {
    task: ApprovalGateTask;
    code: ErrorCode;
    correlationId: string;
    actorId: string;
  }): Promise<void> {
    // Outside any transaction on purpose: the caller's transaction is about to roll
    // back, and "the run was refused" must still be on the record.
    await this.audit.record({
      orgId: params.task.orgId,
      projectId: params.task.projectId,
      actor: { type: 'user', id: params.actorId },
      action: 'task.transition_refused',
      eventType: 'task.transition_refused.v1',
      aggregateType: 'Task',
      aggregateId: params.task.id,
      correlationId: params.correlationId,
      payload: {
        to: 'queued',
        riskClass: params.task.riskClass,
        // The historical snake_case reason is kept: `task.transition_refused.v1`
        // already carries it and a consumer switching on it must not break. `code`
        // is the precise error code for anything new.
        reason: params.code.toLowerCase(),
        code: params.code,
      },
    });
  }
}

/** Same system actor id the task service uses. A fixed v5-shaped UUID. */
const SYSTEM_ACTOR_ID = '00000000-0000-5000-8000-000000000000';
