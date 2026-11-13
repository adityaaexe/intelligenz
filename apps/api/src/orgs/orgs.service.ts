import { Inject, Injectable } from '@nestjs/common';
import type { Role } from '@intelligenz/contracts';
import type { PrismaClient } from '@intelligenz/database';

import { PRISMA_CLIENT } from '../database/database.module';

export interface WorkspaceSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export interface OrgSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly role: Role;
  readonly workspaces: readonly WorkspaceSummary[];
}

@Injectable()
export class OrgsService {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  /**
   * ## Tenant scoping note
   *
   * There is no `orgId` in this query's `where` clause on purpose. The rows are
   * scoped by `userId` — the authenticated caller — which is the *stronger*
   * predicate here: a `membership` row is the only thing that can grant access to an
   * org, so listing by `userId` cannot return an org the caller has no membership
   * in. Applying an `orgId` filter as well is impossible (the query is "all of
   * them") and would be theatre. Every other service in this app filters by `orgId`;
   * this one filters by the identity that defines the set.
   */
  async listForUser(userId: string): Promise<OrgSummary[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      select: {
        role: true,
        orgId: true,
        organization: { select: { id: true, name: true, slug: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (memberships.length === 0) return [];

    const orgIds = memberships.map((membership) => membership.orgId);

    const workspaces = await this.prisma.workspace.findMany({
      // orgId is carried for the same reason: the set is derived from memberships,
      // and `in` is the only correct predicate for "workspaces of my organisations".
      where: { orgId: { in: orgIds } },
      select: { id: true, orgId: true, name: true, slug: true },
      orderBy: { createdAt: 'asc' },
    });

    return memberships.map((membership) => ({
      id: membership.organization.id,
      name: membership.organization.name,
      slug: membership.organization.slug,
      role: membership.role as Role,
      workspaces: workspaces
        .filter((workspace) => workspace.orgId === membership.orgId)
        .map((workspace) => ({ id: workspace.id, name: workspace.name, slug: workspace.slug })),
    }));
  }
}
