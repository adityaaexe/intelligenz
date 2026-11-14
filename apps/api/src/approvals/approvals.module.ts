import { Module } from '@nestjs/common';

import { ApprovalsController } from './approvals.controller';
import { ApprovalGateService } from './approval-gate.service';
import { ApprovalsService } from './approvals.service';

/**
 * Exports `ApprovalGateService`, not just the decision surface: the gate is consumed
 * by `TasksModule` (`POST /run`, `PATCH → queued`), and a second copy of those checks
 * living in the task service is the failure this module exists to prevent.
 */
@Module({
  controllers: [ApprovalsController],
  providers: [ApprovalsService, ApprovalGateService],
  exports: [ApprovalGateService],
})
export class ApprovalsModule {}
