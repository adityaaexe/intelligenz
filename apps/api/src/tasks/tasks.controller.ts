import { Controller, Get, Headers, HttpCode, Inject, Param, Patch, Post, Res } from '@nestjs/common';
import {
  CreateTaskInput,
  PaginationQuery,
  UpdateTaskStatusInput,
  type PaginationQuery as PaginationQueryType,
} from '@intelligenz/contracts';

import { Roles } from '../auth/auth.decorators';
import { CorrelationId, CurrentUser } from '../common/decorators/request.decorators';
import { ZodBody, ZodQuery } from '../common/pipes/zod-validation.pipe';
import type { ApiResponse, AuthenticatedUser } from '../common/request-context';
import { TasksService } from './tasks.service';
import type { CancelResponse, RunResponse, TaskDetailResponse, TaskPage, TaskResponse } from './tasks.response';

/**
 * Two controllers because the paths genuinely differ: tasks are created and listed
 * under their project (where the project id is part of the resource path), and
 * mutated under the org (where the task id is globally unique). Flattening them into
 * one controller with absolute paths would hide that.
 *
 * Roles: reads are open to any member (a VIEWER must be able to see the board);
 * creation and every state change require MEMBER or higher. Approval decisions are
 * the only ADMIN+ action, and they live in `ApprovalsController`.
 */
@Controller('v1/orgs/:orgId/projects/:projectId/tasks')
export class ProjectTasksController {
  constructor(@Inject(TasksService) private readonly tasks: TasksService) {}

  @Get()
  async list(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @ZodQuery(PaginationQuery) page: PaginationQueryType,
  ): Promise<TaskPage> {
    return this.tasks.list({ orgId, projectId, page });
  }

  /**
   * `Idempotency-Key` is optional at the HTTP level but always present in the
   * database: when it is absent the service generates one, which makes the request
   * non-idempotent (it did not ask to be). When it is present, a duplicate returns
   * the original task with `200` instead of a second row with `201` (contract §6).
   */
  @Roles('MEMBER')
  @Post()
  async create(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @ZodBody(CreateTaskInput) input: CreateTaskInput,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: ApiResponse,
  ): Promise<{ data: TaskResponse; meta: { created: boolean } }> {
    const result = await this.tasks.create({
      orgId,
      projectId,
      input,
      idempotencyKey,
      correlationId,
      actorId: user.userId,
    });

    response.status(result.created ? 201 : 200);

    return { data: result.task, meta: { created: result.created } };
  }
}

@Controller('v1/orgs/:orgId/tasks')
export class TasksController {
  constructor(@Inject(TasksService) private readonly tasks: TasksService) {}

  @Get(':taskId')
  async detail(
    @Param('orgId') orgId: string,
    @Param('taskId') taskId: string,
  ): Promise<{ data: TaskDetailResponse }> {
    return { data: await this.tasks.detail(orgId, taskId) };
  }

  @Roles('MEMBER')
  @Patch(':taskId')
  async updateStatus(
    @Param('orgId') orgId: string,
    @Param('taskId') taskId: string,
    @ZodBody(UpdateTaskStatusInput) input: UpdateTaskStatusInput,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
  ): Promise<{ data: TaskResponse }> {
    return {
      data: await this.tasks.updateStatus({
        orgId,
        taskId,
        input,
        correlationId,
        actorId: user.userId,
      }),
    };
  }

  /**
   * `202 Accepted`: the workflow has been created, not completed. Returning `201`
   * would imply the run is a resource that exists in its final form.
   */
  @Roles('MEMBER')
  @Post(':taskId/run')
  @HttpCode(202)
  async run(
    @Param('orgId') orgId: string,
    @Param('taskId') taskId: string,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
  ): Promise<{ data: RunResponse }> {
    return {
      data: await this.tasks.run({ orgId, taskId, correlationId, actorId: user.userId }),
    };
  }

  @Roles('MEMBER')
  @Post(':taskId/cancel')
  @HttpCode(200)
  async cancel(
    @Param('orgId') orgId: string,
    @Param('taskId') taskId: string,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
  ): Promise<{ data: CancelResponse }> {
    return {
      data: await this.tasks.cancel({ orgId, taskId, correlationId, actorId: user.userId }),
    };
  }
}
