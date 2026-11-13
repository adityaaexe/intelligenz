import type { Role } from '@intelligenz/contracts';

import { CORRELATION_HEADER, resolveCorrelationId } from './nest-logger';

/**
 * The request shape the guards and controllers actually use.
 *
 * `express` is not a dependency of this package (it is reached through
 * `@nestjs/platform-express`), so request/response objects are described
 * structurally instead of imported. That keeps `strict` honest without an
 * undeclared dependency: if a property is used, it is declared here.
 */
export interface AuthenticatedUser {
  readonly userId: string;
  readonly email: string;
}

export interface OrgContext {
  readonly orgId: string;
  readonly role: Role;
  readonly membershipId: string;
}

export interface ApiRequest {
  correlationId: string;
  auth?: AuthenticatedUser;
  org?: OrgContext;
  /**
   * Set by `LoginRateLimitGuard` on the login route only: the exact key it
   * incremented, so a successful sign-in can clear that counter.
   */
  loginRateLimitKey?: string;
  /** Socket address. Read instead of `X-Forwarded-For` (see `login-rate-limit.ts`). */
  readonly ip?: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly params: Record<string, string | undefined>;
  body?: unknown;
  query?: unknown;
  readonly method: string;
  readonly url: string;
}

export interface ApiResponse {
  status(code: number): ApiResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

/**
 * Correlation id middleware. Runs before `pino-http`, which reads the value with
 * `genReqId` so the HTTP access log and the response body share one id.
 */
export function correlationMiddleware(
  request: ApiRequest,
  _response: unknown,
  next: () => void,
): void {
  request.correlationId = resolveCorrelationId(request.headers[CORRELATION_HEADER]);

  next();
}
