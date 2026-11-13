import { Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { CreateProjectInput } from '@intelligenz/contracts';

import { Roles } from '../auth/auth.decorators';
import { CorrelationId, CurrentUser } from '../common/decorators/request.decorators';
import { ZodBody } from '../common/pipes/zod-validation.pipe';
import type { AuthenticatedUser } from '../common/request-context';
import { ProjectsService, type ProjectResponse } from './projects.service';

/**
 * Workspace-scoped (contract §15 A2): a project cannot exist outside a workspace,
 * so the workspace id is part of the path rather than a body field. It is also what
 * makes "which workspace does this project belong to" answerable from the URL alone.
 */
@Controller('v1/orgs/:orgId/workspaces/:workspaceId/projects')
export class ProjectsController {
  constructor(@Inject(ProjectsService) private readonly projects: ProjectsService) {}

  @Get()
  async list(
    @Param('orgId') orgId: string,
    @Param('workspaceId') workspaceId: string,
  ): Promise<{ data: ProjectResponse[] }> {
    return { data: await this.projects.list(orgId, workspaceId) };
  }

  /** ADMIN+ (contract §6): creating a project changes the shape of the control plane. */
  @Roles('ADMIN')
  @Post()
  async create(
    @Param('orgId') orgId: string,
    @Param('workspaceId') workspaceId: string,
    @ZodBody(CreateProjectInput) input: CreateProjectInput,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
  ): Promise<{ data: ProjectResponse }> {
    return {
      data: await this.projects.create(orgId, workspaceId, input, correlationId, user.userId),
    };
  }
}
