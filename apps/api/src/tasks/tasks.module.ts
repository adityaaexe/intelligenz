import { Module } from '@nestjs/common';

import { ApprovalsModule } from '../approvals/approvals.module';
import { ProjectTasksController, TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  // `ApprovalGateService` comes from here; the task service must not carry a second
  // copy of the gate's checks.
  imports: [ApprovalsModule],
  controllers: [ProjectTasksController, TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
