import { Inject, type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { z } from 'zod';

import { AppError } from '../common/errors';
import type { ApiRequest } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { IS_PUBLIC_KEY } from './auth.decorators';

/**
 * Bearer authentication, applied globally (contract §5).
 *
 * ## Claims are required, not optional
 *
 * The verifier pins `alg` and `maxAge`, but neither is a substitute for checking
 * that the claims exist:
 *
 *   - `exp` absent means a token that never expires. `jsonwebtoken` only checks
 *     `exp` *when it is present*, so a correctly signed token without `exp` was
 *     accepted for ever.
 *   - `iat` absent defeats `maxAge`, which is computed from `iat`.
 *   - `sub` absent has no user to authenticate.
 *
 * `jsonwebtoken@9` has no `require` verify option (checked: no `requiredClaims`
 * handling in `verify.js`), so the equivalent is enforced here by making all
 * three claims required properties of the parsed payload. The schema is the
 * enforcement point; `maxAge` is a second, independent bound on `iat`.
 *
 * Payload is exactly `{ sub, email, iat, exp }`; anything else in a token is
 * ignored, and a token without a UUID `sub` is rejected rather than trusted.
 * HS256 with the module secret — `verifyAsync` pins the algorithm, so an
 * `alg: none` token cannot pass.
 *
 * Revocation is not modelled as a token blacklist. It does not need to be: role and
 * membership are re-read from the database on every request by `OrgScopeGuard`, so
 * removing a membership revokes access on the next call even while an unexpired
 * token exists. That is the property the contract's "expired/revoked permission is
 * rejected" test actually needs.
 */
export const REQUIRED_ACCESS_TOKEN_CLAIMS = ['exp', 'iat', 'sub'] as const;

const AccessTokenPayload = z.object({
  sub: z.uuid(),
  email: z.email(),
  // All three are non-optional: a missing claim fails `safeParse`, which is the
  // `require` semantics `jsonwebtoken` does not provide.
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
});

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<ApiRequest>();
    const token = extractBearerToken(request.headers['authorization']);

    if (token === undefined) throw AppError.unauthorized();

    let decoded: unknown;
    try {
      // `algorithms` is pinned, not inferred: the module signs HS256, and a verifier
      // that accepts whatever the token header claims is the classic JWT confusion bug.
      //
      // `maxAge` is the signer's TTL: a token whose `iat` is older than 900s is
      // rejected even if its `exp` was forged to be further out. `iat` missing makes
      // this check fail closed ("iat required when maxAge is specified").
      decoded = await this.jwt.verifyAsync(token, {
        algorithms: ['HS256'],
        maxAge: this.config.jwtTtlSeconds,
      });
    } catch {
      // Expired, wrong signature, malformed — one message. Distinguishing them
      // tells an attacker which part of a forged token was closest.
      throw AppError.unauthorized('The access token is missing, invalid or expired.');
    }

    const payload = AccessTokenPayload.safeParse(decoded);

    if (!payload.success) throw AppError.unauthorized('The access token is invalid.');

    request.auth = { userId: payload.data.sub, email: payload.data.email };

    return true;
  }
}

function extractBearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;

  if (value === undefined) return undefined;

  const [scheme, ...rest] = value.trim().split(/\s+/);

  if (scheme?.toLowerCase() !== 'bearer') return undefined;

  const token = rest.join('');
  return token.length > 0 ? token : undefined;
}
