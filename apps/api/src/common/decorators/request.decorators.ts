import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { ApiRequest, AuthenticatedUser, OrgContext } from '../request-context';

/**
 * Typed accessors for what the guards resolved. A controller never reads
 * `request.user` directly, so renaming the attachment point is a one-file change
 * and an unauthenticated handler cannot be written by accident.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<ApiRequest>();

    if (request.auth === undefined) {
      // Unreachable behind JwtAuthGuard; failing loudly beats returning undefined
      // to a service that would then query with `undefined` as a user id.
      throw new Error('CurrentUser used on a route without JwtAuthGuard.');
    }

    return request.auth;
  },
);

export const CurrentOrg = createParamDecorator(
  (_data: unknown, context: ExecutionContext): OrgContext => {
    const request = context.switchToHttp().getRequest<ApiRequest>();

    if (request.org === undefined) {
      throw new Error('CurrentOrg used on a route without OrgScopeGuard.');
    }

    return request.org;
  },
);

export const CorrelationId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    return context.switchToHttp().getRequest<ApiRequest>().correlationId;
  },
);

/**
 * The key `LoginRateLimitGuard` counted. The controller reads it on the success
 * path to clear the window, so the derivation lives in one place.
 */
export const LoginRateLimitKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined => {
    return context.switchToHttp().getRequest<ApiRequest>().loginRateLimitKey;
  },
);
