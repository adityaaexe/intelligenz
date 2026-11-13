import { Inject, Injectable } from '@nestjs/common';
import type { CreateProjectInput, Environment } from '@intelligenz/contracts';
import type { PrismaClient } from '@intelligenz/database';

import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/errors';
import { toConflict } from '../common/prisma-errors';
import { PRISMA_CLIENT } from '../database/database.module';

export interface ProjectResponse {
  readonly id: string;
  readonly orgId: string;
  readonly workspaceId: string;
  readonly key: string;
  readonly name: string;
  readonly environment: Environment;
  readonly taskCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(orgId: string, workspaceId: string): Promise<ProjectResponse[]> {
    await this.assertWorkspace(orgId, workspaceId);

    const projects = await this.prisma.project.findMany({
      // ## Tenant scoping
      // Every read carries `orgId`, not only the guard's membership check. If the
      // guard were bypassed, this query still cannot return another org's project —
      // and `workspaceId` alone would happily match one, because ids are opaque.
      where: { orgId, workspaceId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        orgId: true,
        workspaceId: true,
        key: true,
        name: true,
        environment: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { tasks: true } },
      },
    });

    return projects.map(toProjectResponse);
  }

  async create(
    orgId: string,
    workspaceId: string,
    input: CreateProjectInput,
    correlationId: string,
    actorId: string,
  ): Promise<ProjectResponse> {
    await this.assertWorkspace(orgId, workspaceId);

    try {
      const project = await this.prisma.project.create({
        // `orgId` and `workspaceId` come from the authenticated path, never from the
        // body: `CreateProjectInput` has no tenant field at all (`.strict()`).
        data: {
          orgId,
          workspaceId,
          key: input.key,
          name: input.name,
          environment: input.environment,
        },
        select: {
          id: true,
          orgId: true,
          workspaceId: true,
          key: true,
          name: true,
          environment: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { tasks: true } },
        },
      });

      await this.audit.record({
        orgId,
        projectId: project.id,
        actor: { type: 'user', id: actorId },
        action: 'project.created',
        eventType: 'project.created.v1',
        aggregateType: 'Project',
        aggregateId: project.id,
        correlationId,
        payload: { key: project.key, environment: project.environment },
      });

      return toProjectResponse(project);
    } catch (error) {
      const conflict = toConflict(
        error,
        `A project with the key "${input.key}" already exists in this workspace.`,
      );
      if (conflict !== undefined) throw conflict;
      throw error;
    }
  }

  /**
   * The workspace must belong to the organisation in the path. Without this check,
   * `POST /v1/orgs/{mine}/workspaces/{someone-elses}/projects` would create a
   * project in a foreign workspace, because the project's `orgId` and the
   * workspace's `orgId` are independent columns.
   *
   * 404, not 403: the caller is asking about a workspace they cannot see, and 403
   * would confirm the id exists.
   */
  private async assertWorkspace(orgId: string, workspaceId: string): Promise<void> {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, orgId },
      select: { id: true },
    });

    if (workspace === null) throw AppError.notFound('Workspace');
  }
}

interface ProjectRow {
  id: string;
  orgId: string;
  workspaceId: string;
  key: string;
  name: string;
  environment: Environment;
  createdAt: Date;
  updatedAt: Date;
  _count: { tasks: number };
}

function toProjectResponse(project: ProjectRow): ProjectResponse {
  return {
    id: project.id,
    orgId: project.orgId,
    workspaceId: project.workspaceId,
    key: project.key,
    name: project.name,
    environment: project.environment,
    taskCount: project._count.tasks,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}
