import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import {
  ProposedPlanV1,
  validateProposedPlan,
  type PlanIssue,
  type ProposedPlanV1 as ProposedPlan,
} from '@intelligenz/contracts';
// The digest lives on a subpath because the root barrel is bundled into the Temporal
// workflow sandbox, which refuses `node:` imports. See `packages/contracts/src/plan-hash.ts`.
import { planContentHash } from '@intelligenz/contracts/plan-hash';
import type { Prisma, PrismaClient } from '@intelligenz/database';
import type { Logger } from 'pino';

import { allowsSelfApproval } from '../approvals/org-policy';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/errors';
import { LOGGER } from '../common/logger';
import { isUniqueConstraintError } from '../common/prisma-errors';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { PRISMA_CLIENT } from '../database/database.module';
import { ProgrammesService } from '../programmes/programmes.service';
import type { ProgrammeResponse } from '../programmes/programmes.response';
import { TasksService } from '../tasks/tasks.service';
import {
  PLANNER_PROVIDER,
  PlannerInvalidResponseError,
  PlannerUnavailableError,
  isPlannerConfigured,
  type PlannerProvider,
} from './planner-provider';
import type { ApprovePlanInput, ProposePlanInput, RejectPlanInput } from './plans.dto';
import { toValidationResponse, type PlanResponse } from './plans.response';

/**
 * The proposal lifecycle.
 *
 * ## The sentence this file implements
 *
 * **The planner proposes; deterministic validation judges; a human authorises; the
 * existing programme workflow executes.**
 *
 * Four methods, each answering one question, and the boundaries between them are the
 * security property:
 *
 *   - `propose` calls the model and writes a **proposal**. It creates no task, no
 *     programme and no attempt. A model response that fails the schema never becomes a
 *     row at all; one that pairs with a valid schema but an unschedulable graph becomes an
 *     `invalid` row, which is a successful *response* carrying a rejected proposal, not a
 *     4xx. That is deliberate: "the model proposed something I cannot accept" is a
 *     normal outcome a reviewer must be able to read, not an error the client retries.
 *   - `approve` records a human decision. It sets the approver from the JWT, hashes the
 *     canonical proposal, and writes one row. **It creates no `Task`, no `Programme` and
 *     no `ExecutionAttempt`** — the test suite asserts exactly that, because it is the
 *     property that makes "approval is not execution" true rather than stated.
 *   - `reject` records the other decision. It is not a separation-of-duties problem: a
 *     proposer may withdraw their own proposal.
 *   - `submit` is the only method that creates work, and it only runs for an `approved`
 *     plan whose stored proposal still hashes to what was approved. It materialises tasks
 *     through `TasksService` (which re-derives the effective risk class — the plan's
 *     `riskClass` is a claim, never authority), promotes them `draft → ready` through the
 *     existing transition path, and submits one programme through `ProgrammesService`.
 *
 * ## Why `submit` recomputes the hash
 *
 * The approval authorises *bytes*. If `proposal` changed after the decision — a bug, a
 * migration, an operator with a SQL client — the approval is for content that no longer
 * exists. Comparing the recomputed hash with `approvedContentHash` is what turns that from
 * an invisible mismatch into `409 PLAN_CONTENT_CHANGED` with nothing created. It is also
 * why the hash is not a request field: a client that could supply it could re-authorise
 * itself.
 *
 * ## Why retries resume instead of duplicating
 *
 * Tasks are created with a deterministic per-task key (`plan:<id>:<key>`) and the
 * programme with `plan:<id>`, so a submission that failed midway can be retried and will
 * find every row it already made instead of making a second one. The plan is moved to
 * `submitted` by a conditional update on `status = 'approved'`, so two concurrent submits
 * produce one programme, not two schedules.
 */

const PLAN_SELECT = {
  id: true,
  orgId: true,
  projectId: true,
  objective: true,
  status: true,
  provider: true,
  providerModel: true,
  simulated: true,
  proposal: true,
  validation: true,
  approvedContentHash: true,
  approvedById: true,
  approvedAt: true,
  approvalExpiresAt: true,
  rejectedById: true,
  decidedAt: true,
  decisionNote: true,
  programmeId: true,
  createdById: true,
  createdAt: true,
} as const satisfies Prisma.PlanSelect;

type PlanRow = Prisma.PlanGetPayload<{ select: typeof PLAN_SELECT }>;

/** Mirrors the task endpoint's limit: the same header, the same rule. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

const HOUR_MS = 60 * 60 * 1_000;

export interface PlanSubmitResult {
  readonly planId: string;
  readonly programme: ProgrammeResponse;
  readonly created: boolean;
}

@Injectable()
export class PlansService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(PLANNER_PROVIDER) private readonly planner: PlannerProvider,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(ProgrammesService) private readonly programmes: ProgrammesService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Ask the planner for a proposal and record it.
   *
   * Order is deliberate: project, then replay, then configuration, then the model. A bad
   * project costs nothing; a retry with the same key costs nothing; an unconfigured
   * planner costs nothing and writes nothing. Only a request that passed all three spends
   * a model call.
   */
  async propose(params: {
    orgId: string;
    input: ProposePlanInput;
    idempotencyKey?: string | undefined;
    correlationId: string;
    actorId: string;
  }): Promise<{ plan: PlanResponse; created: boolean }> {
    const { orgId, input, correlationId, actorId } = params;

    const project = await this.prisma.project.findFirst({
      // Tenant scoping: a project id from another organisation is 404 below.
      where: { id: input.projectId, orgId },
      select: { id: true },
    });

    if (project === null) throw AppError.notFound('Project');

    const idempotencyKey = normaliseIdempotencyKey(params.idempotencyKey);

    const replayed = await this.prisma.plan.findFirst({
      // Scoped by org: another tenant's key is not this tenant's key.
      where: { orgId, idempotencyKey },
      select: PLAN_SELECT,
    });

    if (replayed !== null) return { plan: toPlanResponse(replayed), created: false };

    if (!isPlannerConfigured(this.config.planner)) {
      // No fallback, no heuristic, no row. The feature is off and says so.
      throw new AppError(
        503,
        'PLANNER_UNAVAILABLE',
        'No planner is configured, so no plan was proposed.',
      );
    }

    const { proposal, model } = await this.callPlanner(input);

    const validation = validateProposedPlan(proposal);
    const status = validation.ok ? 'proposed' : 'invalid';

    let created: PlanRow;

    try {
      created = await this.prisma.$transaction(async (transaction) => {
        const row = await transaction.plan.create({
          data: {
            orgId,
            projectId: project.id,
            // The parsed objective, not the raw string: it is what the plan says and it is
            // already trimmed and length-checked by the schema.
            objective: proposal.objective,
            status,
            // Provenance from the provider that was injected, never from the payload.
            provider: this.planner.name,
            // The model id observed on *this* call, returned by the provider with the
            // payload. Not read from a shared field: a concurrent proposal must not be
            // able to attribute its model to this row.
            providerModel: model,
            simulated: this.planner.simulated,
            // Casts: `ProposedPlanV1`/`PlanValidation` are readonly interfaces, and
            // Prisma's `InputJsonValue` requires an index signature. The values are plain
            // JSON by construction (they came from `JSON.parse` + zod).
            proposal: proposal as unknown as Prisma.InputJsonObject,
            validation: validation as unknown as Prisma.InputJsonObject,
            createdById: actorId,
            idempotencyKey,
          },
          select: PLAN_SELECT,
        });

        await this.audit.recordWithin(transaction, {
          orgId,
          projectId: project.id,
          actor: { type: 'user', id: actorId },
          action: 'plan.proposed',
          eventType: 'plan.proposed.v1',
          aggregateType: 'Plan',
          aggregateId: row.id,
          correlationId,
          idempotencyKey: `plan.proposed:${row.id}`,
          // Deliberately no prompt and no raw response. An audit row is a record of the
          // decision, not a transcript; storing model output here would put untrusted text
          // in the table operators query most.
          payload: {
            objective: proposal.objective,
            provider: this.planner.name,
            model,
            simulated: this.planner.simulated,
            status,
            issueCodes: validation.issues.map((issue) => issue.code),
            taskKeys: proposal.tasks.map((task) => task.key),
          },
        });

        return row;
      });
    } catch (error) {
      // Two proposals with the same key racing past the replay lookup. The unique index is
      // the authority; the loser created nothing and answers with the winner.
      if (isUniqueConstraintError(error)) {
        const winner = await this.prisma.plan.findFirst({
          where: { orgId, idempotencyKey },
          select: PLAN_SELECT,
        });

        if (winner !== null) return { plan: toPlanResponse(winner), created: false };
      }

      throw error;
    }

    this.logger.info(
      { orgId, planId: created.id, status, issues: validation.issues.length },
      'plan proposed',
    );

    return { plan: toPlanResponse(created), created: true };
  }

  /**
   * Record an approval. **This creates no work.**
   *
   * The approver is `actorId`, resolved from the verified JWT by the controller; there is
   * no body field for it. The hash is computed here from the stored proposal, so the
   * approval is bound to the content the approver was shown.
   *
   * `submitted` and `approved` replays return the existing row so a retry is harmless.
   * `invalid` is refused (`422 PLAN_NOT_VALID`) — an unschedulable proposal can never be
   * approved, and saying so is more useful than a generic conflict.
   */
  async approve(params: {
    orgId: string;
    planId: string;
    input: ApprovePlanInput;
    correlationId: string;
    actorId: string;
    actorRole: string;
  }): Promise<{ plan: PlanResponse; created: boolean }> {
    const { orgId, planId, input, correlationId, actorId, actorRole } = params;

    const plan = await this.load(orgId, planId);

    // Already materialised: the decision was spent, and repeating the request cannot
    // change that. Returning the row is the honest answer.
    if (plan.status === 'submitted') return { plan: toPlanResponse(plan), created: false };

    // Already approved: same decision, replayed. `created: false` says no new decision.
    if (plan.status === 'approved') return { plan: toPlanResponse(plan), created: false };

    if (plan.status === 'invalid') {
      throw new AppError(
        422,
        'PLAN_NOT_VALID',
        'This proposal failed validation and can never be approved.',
        { validation: validationMessages(plan.validation) },
      );
    }

    if (plan.status === 'rejected') {
      throw new AppError(409, 'ALREADY_DECIDED', 'This plan was already rejected.');
    }

    /**
     * Separation of duties, owned by `apps/api/src/approvals/org-policy.ts`.
     *
     * The rule is the same one `ApprovalsService.decide` applies to a task request: a
     * requester may not approve their own request unless the organisation has an explicit
     * compiled-in override (`ORG_POLICY`, empty by default). It is enforced here as an
     * **additional** condition after `@Roles('ADMIN')`, never instead of it: passing the
     * role check does not entitle an admin to approve their own proposal.
     *
     * There is deliberately no env var, body field or config flag for this. The only
     * override is the reviewed code change in `ORG_POLICY`, which is what makes turning it
     * off visible to whoever reviews the approval surface.
     */
    if (plan.createdById === actorId && !allowsSelfApproval(orgId)) {
      await this.audit.record({
        orgId,
        projectId: plan.projectId,
        actor: { type: 'user', id: actorId },
        action: 'plan.self_approval_refused',
        eventType: 'plan.self_approval_refused.v1',
        aggregateType: 'Plan',
        aggregateId: planId,
        correlationId,
        idempotencyKey: `plan.self_approval_refused:${planId}:${actorId}`,
        payload: { planId, userId: actorId, role: actorRole },
      });

      throw new AppError(
        403,
        'SELF_APPROVAL_FORBIDDEN',
        'A plan may not be approved by the person who proposed it. Ask another admin to review it.',
      );
    }

    const proposal = ProposedPlanV1.safeParse(plan.proposal);

    if (!proposal.success) {
      // Status `proposed` implies it parsed when written. If it no longer does, the stored
      // content is not what was validated, and no human decision can bind to it.
      throw new AppError(
        422,
        'PLAN_NOT_VALID',
        'The stored proposal cannot be read, so it cannot be approved.',
      );
    }

    const hash = planContentHash(proposal.data);

    const decided = await this.prisma.$transaction(async (transaction) => {
      const now = new Date();

      const updated = await transaction.plan.updateMany({
        // `status: 'proposed'` is the compare-and-swap; `orgId` is the tenant predicate.
        // Two admins deciding at once produce one decision and one 409.
        where: { id: planId, orgId, status: 'proposed' },
        data: {
          status: 'approved',
          approvedById: actorId,
          approvedContentHash: hash,
          approvedAt: now,
          approvalExpiresAt: new Date(now.getTime() + this.config.planner.approvalTtlHours * HOUR_MS),
          decidedAt: now,
          decisionNote: input.note ?? null,
        },
      });

      if (updated.count === 0) {
        throw new AppError(
          409,
          'CONFLICT',
          'The plan was decided by someone else a moment ago.',
        );
      }

      await this.audit.recordWithin(transaction, {
        orgId,
        projectId: plan.projectId,
        actor: { type: 'user', id: actorId },
        action: 'plan.approved',
        eventType: 'plan.approved.v1',
        aggregateType: 'Plan',
        aggregateId: planId,
        correlationId,
        idempotencyKey: `plan.approved:${planId}`,
        payload: {
          planId,
          approvedById: actorId,
          contentHash: hash,
          taskKeys: proposal.data.tasks.map((task) => task.key),
          unresolvedCount: proposal.data.unresolved.length,
        },
      });

      return transaction.plan.findUniqueOrThrow({ where: { id: planId }, select: PLAN_SELECT });
    });

    this.logger.info({ orgId, planId, approvedById: actorId }, 'plan approved');

    // Note what is *not* here: no task creation, no programme submission, no orchestrator
    // call. Approval is a decision; submission is a separate, explicit act.
    return { plan: toPlanResponse(decided), created: true };
  }

  /**
   * Record a rejection. Idempotent on an already-rejected plan.
   *
   * Rejecting your own proposal is allowed: the control is about granting authority, and
   * withdrawing a proposal grants nothing.
   */
  async reject(params: {
    orgId: string;
    planId: string;
    input: RejectPlanInput;
    correlationId: string;
    actorId: string;
  }): Promise<{ plan: PlanResponse; created: boolean }> {
    const { orgId, planId, input, correlationId, actorId } = params;

    const plan = await this.load(orgId, planId);

    if (plan.status === 'rejected') return { plan: toPlanResponse(plan), created: false };

    if (plan.status === 'submitted') {
      throw new AppError(
        409,
        'ALREADY_DECIDED',
        'This plan was already approved and submitted; a rejection would not undo the programme.',
      );
    }

    if (plan.status === 'approved') {
      throw new AppError(
        409,
        'ALREADY_DECIDED',
        'This plan was already approved. Rejecting an approval is not a supported decision.',
      );
    }

    const decided = await this.prisma.$transaction(async (transaction) => {
      const now = new Date();

      const updated = await transaction.plan.updateMany({
        // `proposed` and `invalid` are the two states a rejection is a decision about.
        where: { id: planId, orgId, status: { in: ['proposed', 'invalid'] } },
        data: {
          status: 'rejected',
          rejectedById: actorId,
          decidedAt: now,
          decisionNote: input.note,
        },
      });

      if (updated.count === 0) {
        throw new AppError(409, 'CONFLICT', 'The plan changed while this request was in flight.');
      }

      await this.audit.recordWithin(transaction, {
        orgId,
        projectId: plan.projectId,
        actor: { type: 'user', id: actorId },
        action: 'plan.rejected',
        eventType: 'plan.rejected.v1',
        aggregateType: 'Plan',
        aggregateId: planId,
        correlationId,
        idempotencyKey: `plan.rejected:${planId}`,
        payload: { planId, rejectedById: actorId, note: input.note },
      });

      return transaction.plan.findUniqueOrThrow({ where: { id: planId }, select: PLAN_SELECT });
    });

    this.logger.info({ orgId, planId, rejectedById: actorId }, 'plan rejected');

    return { plan: toPlanResponse(decided), created: true };
  }

  /**
   * Spend the approval: create the tasks, promote them, submit one programme.
   *
   * Every refusal happens before the first write:
   *
   *   - not `approved` → `422 PLAN_NOT_APPROVED` (submitted replays return the existing
   *     programme instead);
   *   - expired → `422 PLAN_APPROVAL_EXPIRED`;
   *   - stored proposal no longer hashes to `approvedContentHash` → `409
   *     PLAN_CONTENT_CHANGED`;
   *   - stored proposal no longer validates → `422 PLAN_NOT_VALID`.
   *
   * Then, in order, each step idempotent: tasks (per-task keys), `draft → ready` through
   * the existing transition path, the programme (`plan:<planId>`), and finally the plan's
   * conditional move to `submitted`. A failure after tasks exist leaves the plan
   * `approved`, so a retry resumes rather than duplicating.
   */
  async submit(params: {
    orgId: string;
    planId: string;
    correlationId: string;
    actorId: string;
  }): Promise<PlanSubmitResult> {
    const { orgId, planId, correlationId, actorId } = params;

    const plan = await this.load(orgId, planId);

    if (plan.status === 'submitted') {
      if (plan.programmeId === null) {
        // Only reachable if a row was edited by hand. Refusing is better than inventing a
        // programme reference.
        throw new AppError(
          409,
          'CONFLICT',
          'This plan is marked submitted but names no programme.',
        );
      }

      const programme = await this.programmes.detail(orgId, plan.programmeId);

      return { planId, programme, created: false };
    }

    if (plan.status !== 'approved') {
      throw new AppError(
        422,
        'PLAN_NOT_APPROVED',
        `A plan must be approved before it can be submitted (it is "${plan.status}").`,
      );
    }

    if (plan.approvalExpiresAt === null || plan.approvalExpiresAt.getTime() <= Date.now()) {
      throw new AppError(
        422,
        'PLAN_APPROVAL_EXPIRED',
        'The approval for this plan has expired. It must be approved again.',
      );
    }

    const proposal = ProposedPlanV1.safeParse(plan.proposal);

    if (!proposal.success) {
      throw new AppError(
        409,
        'PLAN_CONTENT_CHANGED',
        'The stored proposal is not the content that was approved.',
      );
    }

    const hash = planContentHash(proposal.data);

    if (plan.approvedContentHash === null || hash !== plan.approvedContentHash) {
      throw new AppError(
        409,
        'PLAN_CONTENT_CHANGED',
        'The stored proposal is not the content that was approved. Approve it again.',
      );
    }

    // Defence in depth: the approval authorised *valid* content. If the validator's rules
    // have tightened since the decision, the plan is re-checked rather than assumed.
    const validation = validateProposedPlan(proposal.data);

    if (!validation.ok) {
      throw new AppError(
        422,
        'PLAN_NOT_VALID',
        'The approved proposal no longer passes validation and cannot be submitted.',
        { validation: validation.issues.map((issue) => issue.message) },
      );
    }

    // The approver authored the work; the submitter is acting on their decision. Prefer the
    // approver for task authorship so the task's `createdById` names the person who
    // authorised it, and fall back to the submitter only if a row is somehow unbound.
    const taskActorId = plan.approvedById ?? actorId;

    const taskIdsByKey = await this.materialiseTasks({
      plan,
      proposal: proposal.data,
      correlationId,
      actorId: taskActorId,
    });

    const programme = await this.programmes.submit({
      orgId,
      input: {
        projectId: plan.projectId,
        objective: proposal.data.objective,
        tasks: proposal.data.tasks.map((task) => ({
          taskId: requireMappedKey(taskIdsByKey, task.key),
          dependsOn: task.dependsOn.map((dependency) => requireMappedKey(taskIdsByKey, dependency)),
        })),
      },
      // The plan id is the submission identity. A retry after a partial failure finds the
      // programme the first attempt created instead of starting a second schedule.
      idempotencyKey: `plan:${planId}`,
      correlationId,
      actorId,
    });

    const marked = await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.plan.updateMany({
        // Conditional on `approved`: a concurrent double-submit cannot write two
        // programme ids, and the loser below reads the winner's.
        where: { id: planId, orgId, status: 'approved' },
        data: { status: 'submitted', programmeId: programme.programme.programmeId },
      });

      if (updated.count === 0) return false;

      await this.audit.recordWithin(transaction, {
        orgId,
        projectId: plan.projectId,
        actor: { type: 'user', id: actorId },
        action: 'plan.submitted',
        eventType: 'plan.submitted.v1',
        aggregateType: 'Plan',
        aggregateId: planId,
        correlationId,
        idempotencyKey: `plan.submitted:${planId}`,
        payload: {
          programmeId: programme.programme.programmeId,
          taskIds: [...taskIdsByKey.values()],
          taskKeys: proposal.data.tasks.map((task) => task.key),
          contentHash: hash,
        },
      });

      return true;
    });

    if (!marked) {
      // Another submission won the compare-and-swap. Its programme is the one schedule for
      // this plan, and answering with it is the idempotent outcome.
      const current = await this.load(orgId, planId);

      if (current.status === 'submitted' && current.programmeId !== null) {
        const existing = await this.programmes.detail(orgId, current.programmeId);

        return { planId, programme: existing, created: false };
      }

      throw new AppError(409, 'CONFLICT', 'The plan changed while submission was in flight.');
    }

    this.logger.info(
      {
        orgId,
        planId,
        programmeId: programme.programme.programmeId,
        tasks: taskIdsByKey.size,
      },
      'plan submitted',
    );

    return {
      planId,
      programme: programme.programme,
      created: programme.created,
    };
  }

  /** Org-scoped read. A plan id from another organisation resolves to null and becomes 404. */
  async detail(orgId: string, planId: string): Promise<PlanResponse> {
    return toPlanResponse(await this.load(orgId, planId));
  }

  private async load(orgId: string, planId: string): Promise<PlanRow> {
    const plan = await this.prisma.plan.findFirst({
      // Tenant scoping. Cross-tenant reads are 404, never 403: a 403 confirms the id.
      where: { id: planId, orgId },
      select: PLAN_SELECT,
    });

    if (plan === null) throw AppError.notFound('Plan');

    return plan;
  }

  /**
   * Ask the provider, and translate its failures into the API's vocabulary.
   *
   * The provider is a seam, so the service does not trust it blindly: the payload is
   * parsed again here. A stub (or a future provider) that returns something other than a
   * `ProposedPlanV1` is an invalid response, not a plan with missing fields.
   */
  private async callPlanner(
    input: ProposePlanInput,
  ): Promise<{ proposal: ProposedPlan; model: string | null }> {
    let result: { raw: unknown; model: string | null };

    try {
      result = await this.planner.propose({
        objective: input.objective,
        projectId: input.projectId,
      });
    } catch (error) {
      if (error instanceof PlannerUnavailableError) {
        throw new AppError(
          503,
          'PLANNER_UNAVAILABLE',
          'The planner is unavailable, so no plan was proposed.',
        );
      }

      if (error instanceof PlannerInvalidResponseError) {
        throw new AppError(
          503,
          'PLANNER_INVALID_RESPONSE',
          'The planner answered with something that is not a usable plan.',
        );
      }

      throw error;
    }

    const parsed = ProposedPlanV1.safeParse(result.raw);

    if (!parsed.success) {
      // Never repaired, never partially accepted. A truncated plan that "mostly" validates
      // would be executed as if it were whole.
      throw new AppError(
        503,
        'PLANNER_INVALID_RESPONSE',
        'The planner answered with something that is not a usable plan.',
      );
    }

    return { proposal: parsed.data, model: result.model };
  }

  /**
   * Create the tasks and move them out of `draft`, idempotently.
   *
   * The plan's `riskClass` is passed as the *claimed* class, exactly as a human client's
   * would be: `TasksService.create` derives the effective class server-side and records
   * the disagreement. Nothing in this method chooses an effective class, opens a grant or
   * consumes one.
   */
  private async materialiseTasks(params: {
    plan: PlanRow;
    proposal: ProposedPlan;
    correlationId: string;
    actorId: string;
  }): Promise<Map<string, string>> {
    const { plan, proposal, correlationId, actorId } = params;
    const taskIds = new Map<string, string>();

    for (const task of proposal.tasks) {
      const created = await this.tasks.create({
        orgId: plan.orgId,
        projectId: plan.projectId,
        input: {
          title: task.title,
          goal: task.goal,
          acceptanceCriteria: [...task.acceptanceCriteria],
          // A claim. The server's classifier decides the effective class (D-006).
          riskClass: task.riskClass,
        },
        idempotencyKey: `plan:${plan.id}:${task.key}`,
        correlationId,
        actorId,
      });

      taskIds.set(task.key, created.task.id);

      if (created.task.status !== 'draft') continue;

      try {
        await this.tasks.updateStatus({
          orgId: plan.orgId,
          taskId: created.task.id,
          input: { status: 'ready', reason: `Approved plan ${plan.id}` },
          correlationId,
          actorId,
        });
      } catch (error) {
        // A concurrent submit may have promoted the same task between our create-replay
        // and this call. Its `updateMany` is a compare-and-swap, so one of us wins and the
        // other gets a conflict; if the row is now `ready`, the intent is satisfied.
        if (error instanceof AppError && error.code === 'CONFLICT') {
          const current = await this.prisma.task.findFirst({
            where: { id: created.task.id, orgId: plan.orgId },
            select: { status: true },
          });

          if (current?.status === 'ready') continue;
        }

        throw error;
      }
    }

    return taskIds;
  }

}

function requireMappedKey(ids: ReadonlyMap<string, string>, key: string): string {
  const id = ids.get(key);

  if (id === undefined) {
    // Unreachable: `validateProposedPlan` rejected unknown dependencies, so every key the
    // programme graph names was created above. Failing loudly beats submitting a graph with
    // an `undefined` id.
    throw new AppError(
      500,
      'INTERNAL_ERROR',
      `The plan's task ${key} was not materialised.`,
    );
  }

  return id;
}

function toPlanResponse(row: PlanRow): PlanResponse {
  const proposal = ProposedPlanV1.safeParse(row.proposal);
  const now = Date.now();

  return {
    id: row.id,
    projectId: row.projectId,
    objective: row.objective,
    status: row.status,
    provider: row.provider,
    providerModel: row.providerModel,
    simulated: row.simulated,
    validation: toValidationResponse(row.validation),
    // A stored proposal that no longer parses yields an empty task list rather than an
    // error: the status and the validation report already say something is wrong, and
    // submission refuses it.
    tasks: proposal.success ? proposal.data.tasks.map(toTaskResponse) : [],
    assumptions: proposal.success ? proposal.data.assumptions : [],
    unresolved: proposal.success ? proposal.data.unresolved : [],
    createdBy: row.createdById,
    approvedBy: row.approvedById,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    approvalExpiresAt: row.approvalExpiresAt?.toISOString() ?? null,
    approvalExpired: row.approvalExpiresAt !== null && row.approvalExpiresAt.getTime() <= now,
    rejectedBy: row.rejectedById,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    programmeId: row.programmeId,
    createdAt: row.createdAt.toISOString(),
  };
}

function toTaskResponse(task: ProposedPlan['tasks'][number]): PlanResponse['tasks'][number] {
  return {
    key: task.key,
    title: task.title,
    goal: task.goal,
    acceptanceCriteria: [...task.acceptanceCriteria],
    dependsOn: [...task.dependsOn],
    riskClass: task.riskClass,
  };
}

/** The validation report as field errors, for a caller that wants them keyed. */
function validationMessages(validation: unknown): string[] {
  return toValidationResponse(validation).issues.map((issue: PlanIssue) => issue.message);
}

/** The task endpoint's key rules, applied to the same header on this endpoint. */
function normaliseIdempotencyKey(value: string | undefined): string {
  const key = value?.trim();

  if (key === undefined || key.length === 0) return `auto-${randomUUID()}`;

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
