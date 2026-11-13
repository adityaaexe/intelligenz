import { type ExecutionContext } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../src/common/errors';
import type { ApiRequest } from '../src/common/request-context';
import {
  LOGIN_RATE_LIMIT,
  LoginRateLimitGuard,
  LoginRateLimiter,
  loginRateLimitKey,
} from '../src/auth/login-rate-limit';

/**
 * Login guessing is the one attack here that needs no vulnerability: a known
 * email plus a password list. Five attempts per 15 minutes per `(ip, email)`, and
 * the refusal must not depend on whether the email exists.
 */

const EMAIL = 'owner@northwind.test';
const IP = '203.0.113.7';

function contextFor(ip: string, email: string): ExecutionContext {
  const request: ApiRequest = {
    correlationId: 'corr-1',
    headers: {},
    params: {},
    body: { email, password: 'not-a-real-password' },
    ip,
    method: 'POST',
    url: '/v1/auth/login',
  };

  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function attempt(limiter: LoginRateLimiter, ip: string, email: string): AppError | undefined {
  const guard = new LoginRateLimitGuard(limiter);

  try {
    guard.canActivate(contextFor(ip, email));
    return undefined;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
}

describe('LoginRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows five and refuses the sixth with a Retry-After inside the window', () => {
    const limiter = new LoginRateLimiter();
    const key = loginRateLimitKey(IP, EMAIL);

    for (let i = 1; i <= LOGIN_RATE_LIMIT.maxAttempts; i += 1) {
      expect(limiter.consume(key).allowed, `attempt ${i}`).toBe(true);
    }

    const sixth = limiter.consume(key);

    expect(sixth.allowed).toBe(false);
    expect(sixth.retryAfterSeconds).toBe(900);
  });

  it('opens a new window after 15 minutes', () => {
    const limiter = new LoginRateLimiter();
    const key = loginRateLimitKey(IP, EMAIL);

    for (let i = 0; i < LOGIN_RATE_LIMIT.maxAttempts; i += 1) limiter.consume(key);
    expect(limiter.consume(key).allowed).toBe(false);

    vi.advanceTimersByTime(LOGIN_RATE_LIMIT.windowMs);

    expect(limiter.consume(key).allowed).toBe(true);
  });

  it('does not extend the window when a refused attempt keeps trying', () => {
    const limiter = new LoginRateLimiter();
    const key = loginRateLimitKey(IP, EMAIL);

    for (let i = 0; i < LOGIN_RATE_LIMIT.maxAttempts; i += 1) limiter.consume(key);

    vi.advanceTimersByTime(10 * 60 * 1000);
    const refused = limiter.consume(key);
    expect(refused.retryAfterSeconds).toBe(300);

    // Another refusal must not push the reset further out.
    expect(limiter.consume(key).retryAfterSeconds).toBe(300);
  });

  it('clears the counter on success', () => {
    const limiter = new LoginRateLimiter();
    const key = loginRateLimitKey(IP, EMAIL);

    for (let i = 0; i < LOGIN_RATE_LIMIT.maxAttempts - 1; i += 1) limiter.consume(key);
    limiter.reset(key);

    for (let i = 0; i < LOGIN_RATE_LIMIT.maxAttempts; i += 1) {
      expect(limiter.consume(key).allowed, `attempt ${i + 1}`).toBe(true);
    }
  });

  it('keeps separate budgets per (ip, email) pair', () => {
    const limiter = new LoginRateLimiter();

    for (let i = 0; i < LOGIN_RATE_LIMIT.maxAttempts; i += 1) {
      limiter.consume(loginRateLimitKey(IP, EMAIL));
    }

    expect(limiter.consume(loginRateLimitKey(IP, EMAIL)).allowed).toBe(false);
    // Same IP, different account: this is a different pair, not an IP ban.
    expect(limiter.consume(loginRateLimitKey(IP, 'member@northwind.test')).allowed).toBe(true);
    // Same account, different address.
    expect(limiter.consume(loginRateLimitKey('198.51.100.9', EMAIL)).allowed).toBe(true);
  });

  it('treats email case as one account', () => {
    const limiter = new LoginRateLimiter();

    for (let i = 0; i < LOGIN_RATE_LIMIT.maxAttempts; i += 1) {
      limiter.consume(loginRateLimitKey(IP, 'Owner@Northwind.Test'));
    }

    expect(limiter.consume(loginRateLimitKey(IP, EMAIL)).allowed).toBe(false);
  });

  it('keeps the tracked-pair map bounded under a flood of distinct emails', () => {
    const limiter = new LoginRateLimiter();

    // An unauthenticated attacker chooses the email, so the map size must not be
    // attacker-controlled. 12 000 distinct pairs, all live (same fake instant).
    for (let i = 0; i < 12_000; i += 1) {
      limiter.consume(loginRateLimitKey(IP, `flood-${i}@example.test`));
    }

    expect(limiter.trackedPairs).toBeLessThanOrEqual(10_000);
    expect(limiter.trackedPairs).toBeGreaterThan(0);
  });
});

describe('LoginRateLimitGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lets the first five attempts through to the password check', () => {
    const limiter = new LoginRateLimiter();

    for (let i = 0; i < LOGIN_RATE_LIMIT.maxAttempts; i += 1) {
      expect(attempt(limiter, IP, EMAIL)).toBeUndefined();
    }
  });

  it('throws 429 RATE_LIMITED with Retry-After on the sixth attempt', () => {
    const limiter = new LoginRateLimiter();

    for (let i = 0; i < LOGIN_RATE_LIMIT.maxAttempts; i += 1) attempt(limiter, IP, EMAIL);

    const refusal = attempt(limiter, IP, EMAIL);

    expect(refusal).toBeInstanceOf(AppError);
    expect(refusal?.status).toBe(429);
    expect(refusal?.code).toBe('RATE_LIMITED');
    expect(refusal?.headers).toEqual({ 'Retry-After': '900' });
  });

  it('returns the identical refusal for a known and an unknown email', () => {
    const knownLimiter = new LoginRateLimiter();
    const unknownLimiter = new LoginRateLimiter();

    for (let i = 0; i < LOGIN_RATE_LIMIT.maxAttempts; i += 1) {
      attempt(knownLimiter, IP, 'owner@northwind.test');
      attempt(unknownLimiter, IP, 'nobody-at-all@northwind.test');
    }

    const knownRefusal = attempt(knownLimiter, IP, 'owner@northwind.test');
    const unknownRefusal = attempt(unknownLimiter, IP, 'nobody-at-all@northwind.test');

    // The limiter runs before the user lookup, so an attacker cannot tell the two
    // apart by the refusal: same status, code, message and header.
    expect(knownRefusal?.status).toBe(unknownRefusal?.status);
    expect(knownRefusal?.code).toBe(unknownRefusal?.code);
    expect(knownRefusal?.message).toBe(unknownRefusal?.message);
    expect(knownRefusal?.headers).toEqual(unknownRefusal?.headers);
  });

  it('counts a malformed body against the address without aiming it at an account', () => {
    const limiter = new LoginRateLimiter();
    const guard = new LoginRateLimitGuard(limiter);

    const request: ApiRequest = {
      correlationId: 'corr-1',
      headers: {},
      params: {},
      body: { email: 42 },
      ip: IP,
      method: 'POST',
      url: '/v1/auth/login',
    };

    const context = {
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    for (let i = 0; i < LOGIN_RATE_LIMIT.maxAttempts; i += 1) {
      expect(guard.canActivate(context)).toBe(true);
    }

    expect(() => guard.canActivate(context)).toThrow(AppError);
  });
});
