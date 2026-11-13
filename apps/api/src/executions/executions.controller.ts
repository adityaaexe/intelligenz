import { Controller, Get, Inject, Param } from '@nestjs/common';
import type { ExecutionAttemptSummary } from '@intelligenz/contracts';

import { ExecutionsService, type ExecutionAttemptDetailResponse } from './executions.service';

/**
 * Execution history routes — the API surface for "what actually happened".
 *
 * Both are reads and any member may call them: a VIEWER must be able to audit a run.
 * Tenant scoping is in the service queries, not here; the guards on `:orgId` decide
 * membership, and `orgId` is threaded into every `where`.
 *
 * The list is intentionally not paginated. Attempts per task are bounded by retry
 * policy (three per activity, a handful of activities per run), so a page cursor would
 * be ceremony around a list that is already small. If that stops being true, the shape
 * changes with evidence rather than pre-emptively.
 */
@Controller('v1/orgs/:orgId/tasks/:taskId/executions')
export class ExecutionsController {
  constructor(@Inject(ExecutionsService) private readonly executions: ExecutionsService) {}

  @Get()
  async list(
    @Param('orgId') orgId: string,
    @Param('taskId') taskId: string,
  ): Promise<{ data: ExecutionAttemptSummary[] }> {
    return { data: await this.executions.list(orgId, taskId) };
  }

  @Get(':attemptId')
  async detail(
    @Param('orgId') orgId: string,
    @Param('taskId') taskId: string,
    @Param('attemptId') attemptId: string,
  ): Promise<{ data: ExecutionAttemptDetailResponse }> {
    return { data: await this.executions.detail(orgId, taskId, attemptId) };
  }
}
