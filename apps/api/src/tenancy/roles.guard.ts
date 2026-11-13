import { Inject, type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@intelligenz/contracts';

import { MINIMUM_ROLE_KEY, satisfiesRole } from '../auth/auth.decorators';
import { AppError } from '../common/errors';
import type { ApiRequest } from '../common/request-context';

/**
 * Role enforcement with the hierarchy `OWNER > ADMIN > MEMBER > VIEWER`.
 *
 * Runs after `OrgScopeGuard`, so the role it reads was loaded from the database for
 * this request, not taken from the token. A route with no `@Roles()` needs only
 * membership — that is the default because most reads are legitimate for a VIEWER.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const minimum = this.reflector.getAllAndOverride<Role | undefined>(MINIMUM_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (minimum === undefined) return true;

    const org = context.switchToHttp().getRequest<ApiRequest>().org;

    if (org === undefined) {
      throw AppError.forbidden('This route requires an organisation context.');
    }

    if (!satisfiesRole(org.role, minimum)) {
      throw AppError.forbidden(`This action requires the ${minimum} role or higher.`);
    }

    return true;
  }
}
