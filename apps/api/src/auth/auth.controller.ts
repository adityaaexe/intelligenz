import { Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { LoginInput } from '@intelligenz/contracts';

import { CorrelationId, LoginRateLimitKey } from '../common/decorators/request.decorators';
import { ZodBody } from '../common/pipes/zod-validation.pipe';
import { Public } from './auth.decorators';
import { AuthService, type LoginResponse } from './auth.service';
import { LoginRateLimitGuard, LoginRateLimiter } from './login-rate-limit';

@Controller('v1/auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(LoginRateLimiter) private readonly rateLimiter: LoginRateLimiter,
  ) {}

  /**
   * `@HttpCode(200)`: a login does not create an addressable resource, and a 201
   * here makes clients look for a `Location` header that will never exist.
   *
   * The body is validated by `LoginInput` from `@intelligenz/contracts` — the same
   * schema the web client imports, so "email is lower-cased at the boundary"
   * (contract §15 A5) cannot be implemented twice and diverge.
   *
   * `LoginRateLimitGuard` counts the attempt *before* the body is validated or a
   * password is hashed, and refuses the sixth in a 15-minute window with
   * `429 RATE_LIMITED` + `Retry-After`. On success the counter is cleared: a
   * correct password is proof the pair is not an attacker guessing.
   */
  @Public()
  @UseGuards(LoginRateLimitGuard)
  @Post('login')
  @HttpCode(200)
  async login(
    @ZodBody(LoginInput) input: LoginInput,
    @CorrelationId() correlationId: string,
    @LoginRateLimitKey() rateLimitKey: string | undefined,
  ): Promise<{ data: LoginResponse }> {
    const session = await this.auth.login(input, correlationId);

    if (rateLimitKey !== undefined) this.rateLimiter.reset(rateLimitKey);

    return { data: session };
  }
}
