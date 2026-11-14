import { Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { PaginationQuery, type PaginationQuery as PaginationQueryType } from '@intelligenz/contracts';

import { Roles } from '../auth/auth.decorators';
import { CorrelationId, CurrentUser } from '../common/decorators/request.decorators';
import { ZodBody, ZodQuery } from '../common/pipes/zod-validation.pipe';
import type { AuthenticatedUser } from '../common/request-context';
import { ApprovalDecisionInput } from './approval.dto';
import { ApprovalsService, type ApprovalListItem, type ApprovalPage } from './approvals.service';

@Controller('v1/orgs/:orgId/approvals')
export class ApprovalsController {
  constructor(@Inject(ApprovalsService) private readonly approvals: ApprovalsService) {}

  /**
   * Readable by every member, including a VIEWER: seeing what is waiting for
   * approval is not a privileged action, and hiding the queue is how work stalls
   * silently.
   */
  @Get()
  async list(
    @Param('orgId') orgId: string,
    @ZodQuery(PaginationQuery) page: PaginationQueryType,
  ): Promise<ApprovalPage> {
    return this.approvals.listPending(orgId, page);
  }

  /**
   * ADMIN+ (contract §6). The decision is audited with `approval.decided.v1`, which
   * is also the event the Overview's "recent decisions" region reads.
   *
   * `403 SELF_APPROVAL_FORBIDDEN` when the approver is the requester: four eyes means
   * two people (D-001 / D-006). The escape hatch is compiled in, empty, and documented
   * in `org-policy.ts`.
   */
  @Roles('ADMIN')
  @Post(':approvalId/decision')
  @HttpCode(200)
  async decide(
    @Param('orgId') orgId: string,
    @Param('approvalId') approvalId: string,
    @ZodBody(ApprovalDecisionInput) input: ApprovalDecisionInput,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
  ): Promise<{ data: ApprovalListItem }> {
    return {
      data: await this.approvals.decide({
        orgId,
        approvalId,
        input,
        correlationId,
        actorId: user.userId,
      }),
    };
  }

  /**
   * Withdraws an approved grant. ADMIN+ because it changes who may execute: an admin
   * withdrawing a grant is an incident-response act, not a review act.
   *
   * Idempotent for an already-revoked row (`200`), so the button does not require the
   * caller to know current state. `409 APPROVAL_NOT_REVOCABLE` for anything that was
   * never a grant (PENDING/REJECTED/CHANGES_REQUESTED/EXPIRED).
   */
  @Roles('ADMIN')
  @Post(':approvalId/revoke')
  @HttpCode(200)
  async revoke(
    @Param('orgId') orgId: string,
    @Param('approvalId') approvalId: string,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
  ): Promise<{ data: ApprovalListItem }> {
    return {
      data: await this.approvals.revoke({
        orgId,
        approvalId,
        correlationId,
        actorId: user.userId,
      }),
    };
  }
}
