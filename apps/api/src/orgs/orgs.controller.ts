import { Controller, Get, Inject } from '@nestjs/common';

import { NoOrgScope } from '../auth/auth.decorators';
import { CurrentUser } from '../common/decorators/request.decorators';
import type { AuthenticatedUser } from '../common/request-context';
import { OrgsService, type OrgSummary } from './orgs.service';

@Controller('v1/orgs')
export class OrgsController {
  constructor(@Inject(OrgsService) private readonly orgs: OrgsService) {}

  /**
   * The caller's organisations. This is the only authenticated route without an
   * `X-Org-Id`, because its whole purpose is to tell the client which ids it may
   * send. Workspaces are nested in the response so the client can build
   * `/v1/orgs/:orgId/workspaces/:workspaceId/projects` without a second call.
   */
  @NoOrgScope()
  @Get()
  async list(@CurrentUser() user: AuthenticatedUser): Promise<{ data: OrgSummary[] }> {
    return { data: await this.orgs.listForUser(user.userId) };
  }
}
