import { Module } from '@nestjs/common';

import { ProgrammesModule } from '../programmes/programmes.module';
import { TasksModule } from '../tasks/tasks.module';
import { HttpLlmPlannerProvider, PLANNER_PROVIDER } from './planner-provider';
import { PlansController } from './plans.controller';
import { PlansService } from './plans.service';

/**
 * The proposal layer.
 *
 * ## Why `ProgrammesModule` and `TasksModule` are imported
 *
 * Submission materialises through the *existing* services rather than writing `Task` and
 * `Programme` rows itself. That is the whole boundary: the plan layer decides **whether**
 * work happens, and the task/programme layers decide **what the work is**. A second writer
 * of `Task.riskClass` or `ProgrammeTask.dependsOn` would be a second place for those rules
 * to be forgotten.
 *
 * ## The planner token
 *
 * `PLANNER_PROVIDER` is bound to the single HTTP implementation. A test binds a stub by
 * overriding this provider; production has no code path that selects a different planner
 * from request data. `AuditModule` is global.
 */
@Module({
  imports: [TasksModule, ProgrammesModule],
  controllers: [PlansController],
  providers: [
    PlansService,
    { provide: PLANNER_PROVIDER, useClass: HttpLlmPlannerProvider },
  ],
  exports: [PlansService],
})
export class PlansModule {}
