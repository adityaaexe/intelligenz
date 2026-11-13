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
}
