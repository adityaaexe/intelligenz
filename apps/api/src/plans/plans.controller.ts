import { Controller, Get, Headers, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';

import { Roles } from '../auth/auth.decorators';
import { CorrelationId, CurrentOrg, CurrentUser } from '../common/decorators/request.decorators';
import { ZodBody } from '../common/pipes/zod-validation.pipe';
import type { ApiResponse, AuthenticatedUser, OrgContext } from '../common/request-context';
import { ApprovePlanInput, ProposePlanInput, RejectPlanInput } from './plans.dto';
import type { PlanDecisionBody, PlanResponse, PlanSubmitBody } from './plans.response';
import { PlansService } from './plans.service';

/**
 * The proposal API.
 *
 * ## Four verbs, four different authorities
 *
 *   - `POST /` (`MEMBER`) asks a planner for a proposal. Creating a *proposal* is not
 *     creating work, so the same role that may start a task may ask for one.
 *   - `POST /:id/approve` (`ADMIN`) is the human decision, and it is the only route that
 *     can authorise content. It also applies separation of duties (the proposer cannot
 *     approve their own plan) — see `PlansService.approve` and `approvals/org-policy.ts`.
 *   - `POST /:id/reject` (`ADMIN`) records the other decision.
 *   - `POST /:id/submit` (`MEMBER`) spends the approval. Deliberately *not* ADMIN-only:
 *     once an admin has authorised a specific plan, starting it is ordinary work, and
 *     requiring an admin to click twice would encourage admins to submit their own
 *     proposals in one session rather than hand them off.
 *
 * ## Status codes say what happened
 *
 * A proposal is `201` when a row was created and `200` when an `Idempotency-Key` replay
 * found one. A decision is `200` either way (`meta.created` distinguishes a new decision
 * from a replay). A submission is `202` because the programme exists and nothing has run
 * yet — `201` would imply the work is done — and `200` on a replay.
 *
 * ## No body carries authority
 *
 * No approver, status, hash, programme id, provider or `simulated` flag appears in any
 * DTO. The approver is the verified JWT subject; the hash is computed from the stored
 * proposal; the programme id is written by the service. `.strict()` on every schema makes
 * a body that tries to supply one a `400`.
 */
@Controller('v1/orgs/:orgId/plans')
export class PlansController {
  constructor(@Inject(PlansService) private readonly plans: PlansService) {}

  @Roles('MEMBER')
  @Post()
  async propose(
    @Param('orgId') orgId: string,
    @ZodBody(ProposePlanInput) input: ProposePlanInput,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: ApiResponse,
  ): Promise<PlanDecisionBody> {
    const result = await this.plans.propose({
      orgId,
      input,
      idempotencyKey,
      correlationId,
      actorId: user.userId,
    });

    response.status(result.created ? 201 : 200);

    return { data: result.plan, meta: { created: result.created } };
  }

  @Roles('ADMIN')
  @Post(':planId/approve')
  // A decision is not a created resource: both a new decision and a replay answer `200`,
  // and `meta.created` says which. `201` would imply there is something new to fetch.
  @HttpCode(200)
  async approve(
    @Param('orgId') orgId: string,
    @Param('planId') planId: string,
    @ZodBody(ApprovePlanInput) input: ApprovePlanInput,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentOrg() org: OrgContext,
    @CorrelationId() correlationId: string,
  ): Promise<PlanDecisionBody> {
    const result = await this.plans.approve({
      orgId,
      planId,
      input,
      correlationId,
      actorId: user.userId,
      // From the resolved membership, not the body: an audit row that names a role the
      // caller asserted is not a record of anything.
      actorRole: org.role,
    });

    return { data: result.plan, meta: { created: result.created } };
  }

  @Roles('ADMIN')
  @Post(':planId/reject')
  @HttpCode(200)
  async reject(
    @Param('orgId') orgId: string,
    @Param('planId') planId: string,
    @ZodBody(RejectPlanInput) input: RejectPlanInput,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
  ): Promise<PlanDecisionBody> {
    const result = await this.plans.reject({
      orgId,
      planId,
      input,
      correlationId,
      actorId: user.userId,
    });

    return { data: result.plan, meta: { created: result.created } };
  }

  @Roles('MEMBER')
  @Post(':planId/submit')
  async submit(
    @Param('orgId') orgId: string,
    @Param('planId') planId: string,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: ApiResponse,
  ): Promise<PlanSubmitBody> {
    const result = await this.plans.submit({
      orgId,
      planId,
      correlationId,
      actorId: user.userId,
    });

    // `202` on a new programme: the schedule exists, nothing has run. `200` on a replay.
    response.status(result.created ? 202 : 200);

    return {
      data: { planId: result.planId, programme: result.programme },
      meta: { created: result.created },
    };
  }

  @Roles('MEMBER')
  @Get(':planId')
  async detail(
    @Param('orgId') orgId: string,
    @Param('planId') planId: string,
  ): Promise<{ data: PlanResponse }> {
    return { data: await this.plans.detail(orgId, planId) };
  }
}
