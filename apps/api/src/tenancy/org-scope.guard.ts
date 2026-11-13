import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PrismaClient, Role } from '@intelligenz/database';

import { IS_PUBLIC_KEY, NO_ORG_SCOPE_KEY } from '../auth/auth.decorators';
import { AppError } from '../common/errors';
import type { ApiRequest } from '../common/request-context';
import { PRISMA_CLIENT } from '../database/database.module';

/**
 * Resolves "which organisation is this request for, and may this user act in it".
 *
 * ## Why the header and the path must agree
 *
 * `orgId` never comes from a body (contract §5, ADR-005) and never from the path
 * alone. The path is client-controlled, so a caller could write another tenant's id
 * into `/v1/orgs/{orgId}/...`; the `X-Org-Id` header is also client-controlled. Both
 * are only useful together because the membership query is keyed on
 * `(header orgId, authenticated userId)` — the header selects a candidate tenant and
 * the database decides whether the caller belongs to it. A path/header mismatch is
 * rejected before any query, so a request can never be interpreted as tenant A by
 * the guard and tenant B by the service.
 *
 * ## Why there is no cache
 *
 * A cached membership is a permission that outlives its revocation. The lookup is a
 * single indexed row on `@@unique([orgId, userId])`; at this scale the read is
 * cheaper than the class of bug a stale cache creates.
 */
@Injectable()
export class OrgScopeGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<ApiRequest>();

    const noOrgScope = this.reflector.getAllAndOverride<boolean>(NO_ORG_SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (noOrgScope === true) return true;

    // Guards run in a fixed order (JwtAuthGuard first). Reaching here without an
    // identity is a wiring bug, and failing closed is the only safe response.
    if (request.auth === undefined) throw AppError.unauthorized();

    const headerOrgId = firstHeaderValue(request.headers['x-org-id']);

    if (headerOrgId === undefined || headerOrgId.length === 0) {
      throw new AppError(403, 'FORBIDDEN', 'The X-Org-Id header is required.');
    }

    const pathOrgId = request.params['orgId'];

    if (pathOrgId !== undefined && pathOrgId !== headerOrgId) {
      throw new AppError(
        403,
        'FORBIDDEN',
        'The X-Org-Id header does not match the organisation in the path.',
      );
    }

    const membership = await this.prisma.membership.findUnique({
      where: { orgId_userId: { orgId: headerOrgId, userId: request.auth.userId } },
      select: { id: true, role: true },
    });

    if (membership === null) {
      // 403, not 404: the caller named an organisation they do not belong to, and
      // no resource inside it is being disclosed.
      throw AppError.forbidden('You are not a member of this organisation.');
    }

    request.org = {
      orgId: headerOrgId,
      role: membership.role as Role,
      membershipId: membership.id,
    };

    return true;
  }
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;

  return raw?.trim();
}
