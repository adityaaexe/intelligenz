import { SetMetadata } from '@nestjs/common';
import type { Role } from '@intelligenz/contracts';

/**
 * Route-level metadata. Two decorators only, because two is all the guard layer
 * needs: `@Public()` opts out of authentication entirely, `@Roles()` sets the
 * minimum role for a route that already passed org scoping.
 */
export const IS_PUBLIC_KEY = 'auth:public';
export const MINIMUM_ROLE_KEY = 'auth:minimum-role';
export const NO_ORG_SCOPE_KEY = 'auth:no-org-scope';

/** `/health*` and `/v1/auth/login`. Also opts out of org scoping. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Authenticated, but not scoped to one organisation. Exactly one route uses this:
 * `GET /v1/orgs`, which lists the organisations the caller belongs to. Every other
 * authenticated route is org-scoped by default, so forgetting a decorator fails
 * closed with a 403 instead of silently serving unscoped data.
 */
export const NoOrgScope = (): MethodDecorator & ClassDecorator =>
  SetMetadata(NO_ORG_SCOPE_KEY, true);

/**
 * Minimum role, honouring the hierarchy `OWNER > ADMIN > MEMBER > VIEWER`
 * (contract §5). `@Roles('ADMIN')` means "ADMIN or OWNER" — a decorator that
 * required an exact match would forbid an owner from acting, which is never what
 * is meant.
 */
export const Roles = (minimum: Role): MethodDecorator & ClassDecorator =>
  SetMetadata(MINIMUM_ROLE_KEY, minimum);

export const ROLE_RANK: Record<Role, number> = {
  VIEWER: 0,
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};

export function satisfiesRole(actual: Role, minimum: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[minimum];
}
