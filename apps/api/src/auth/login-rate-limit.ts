import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';

import { AppError } from '../common/errors';
import type { ApiRequest } from '../common/request-context';

/**
 * In-memory fixed-window rate limit for `POST /v1/auth/login`.
 *
 * ## Why here and not Redis
 *
 * Redis is available on this host, but a client dependency for one counter is out
 * of scope for this unit and a network round trip on the login path is its own
 * availability risk. The trade is stated plainly instead of hidden:
 *
 *   - **Single instance.** The window lives in this process. Two API replicas
 *     mean two independent counters, so the effective limit is `N × 5` per
 *     window. Behind a load balancer this must move to a shared store (Redis
 *     `INCR` + `EXPIRE`, or a gateway rule) before it is a real control.
 *   - **Restart resets.** A deploy clears the window. Acceptable: an attacker
 *     cannot deploy.
 *
 * What it does buy today: the login endpoint no longer allows unlimited guesses,
 * and argon2 verification — the expensive part — is not reachable once a pair is
 * over the limit.
 *
 * ## Key
 *
 * `(ip, email)`, not IP alone and not email alone:
 *   - IP alone lets one office NAT lock out every user behind it, and lets an
 *     attacker spread guesses across addresses while staying under one IP's cap.
 *   - Email alone lets anyone lock a known account out from anywhere (a free
 *     denial of service against a specific operator).
 *   - The pair bounds a single attacker's guesses against a single account from a
 *     single address, which is the attack this is for.
 *
 * ## Uniformity
 *
 * `consume` runs before the password is checked, so a known email and an unknown
 * email consume identically and the 429 body/header is derived from the window
 * only. That is what keeps the limiter from becoming an account-existence oracle.
 */

export const LOGIN_RATE_LIMIT = {
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
} as const;

/**
 * Upper bound on tracked pairs. The map is permanently bounded: an unauthenticated
 * endpoint that accepts an attacker-chosen email must not let that attacker choose
 * how much memory the process holds.
 */
const MAX_TRACKED_KEYS = 10_000;

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Seconds until the window resets. Only meaningful when `allowed` is false. */
  readonly retryAfterSeconds: number;
}

interface Window {
  count: number;
  resetAt: number;
}

@Injectable()
export class LoginRateLimiter {
  private readonly windows = new Map<string, Window>();

  /** Tracked pairs. Exposed so a test can prove the map is bounded. */
  get trackedPairs(): number {
    return this.windows.size;
  }

  /**
   * Counts one attempt and answers whether it is allowed.
   *
   * The sixth attempt in a window is refused; the first five are counted even
   * when the password is wrong, which is the point. A refused attempt does not
   * extend the window — otherwise an attacker could keep their own lockout alive
   * indefinitely, and a legitimate user would never be able to retry.
   *
   * A *correct* password arriving after the budget is spent is refused too: the
   * limit is on attempts, not on failures. Letting a success through would mean
   * verifying the password the limiter exists to avoid verifying.
   */
  consume(key: string): RateLimitDecision {
    const now = Date.now();
    const window = this.windows.get(key);

    if (window === undefined || window.resetAt <= now) {
      this.makeRoom(now);
      this.windows.set(key, { count: 1, resetAt: now + LOGIN_RATE_LIMIT.windowMs });

      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (window.count >= LOGIN_RATE_LIMIT.maxAttempts) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
      };
    }

    window.count += 1;

    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** A successful sign-in proves the pair is the account owner; clear the window. */
  reset(key: string): void {
    this.windows.delete(key);
  }

  /**
   * Keeps the map at `MAX_TRACKED_KEYS` without an unbounded sweep.
   *
   * 1. Expired windows are dropped first: free, and the common case on a busy
   *    process.
   * 2. If the map is still full, the oldest-inserted key is evicted. `Map` keeps
   *    insertion order, so this is O(1) — no scan on the request path.
   *
   * The documented consequence of (2): an attacker who can create more than
   * `MAX_TRACKED_KEYS` live pairs inside one 15-minute window can push an older
   * pair's counter out, so the guarantee degrades to "5 per pair among the most
   * recent 10 000 pairs" under that specific flood. That is a deliberate trade:
   * bounded memory on an unauthenticated endpoint matters more than a theoretical
   * loss of precision that still requires the attacker to spend 10 000 requests
   * and still leaves every *recent* counter intact. A shared store with TTLs is
   * the real fix and is already recorded as the multi-replica limitation.
   */
  private makeRoom(now: number): void {
    if (this.windows.size < MAX_TRACKED_KEYS) return;

    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }

    if (this.windows.size < MAX_TRACKED_KEYS) return;

    const oldest = this.windows.keys().next();

    if (!oldest.done) this.windows.delete(oldest.value);
  }
}

/**
 * The limiter key. Email is lower-cased because the login DTO lower-cases it at
 * the boundary (contract §15 A5): `Owner@…` and `owner@…` are one account and must
 * be one counter.
 */
export function loginRateLimitKey(ip: string, email: string): string {
  return `${ip}\u0000${email.trim().toLowerCase()}`;
}

/**
 * Route-level guard, applied only to `POST /v1/auth/login`.
 *
 * Not a global guard on purpose: a limit on every route would turn a shared NAT
 * into a 429 for normal dashboard polling.
 */
@Injectable()
export class LoginRateLimitGuard implements CanActivate {
  constructor(@Inject(LoginRateLimiter) private readonly limiter: LoginRateLimiter) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<ApiRequest>();
    const key = loginRateLimitKey(clientIp(request), submittedEmail(request.body));

    // The key is handed to the controller through the request so the success path
    // resets the exact counter this guard incremented — one derivation, not two.
    request.loginRateLimitKey = key;

    const decision = this.limiter.consume(key);

    if (!decision.allowed) throw AppError.rateLimited(decision.retryAfterSeconds);

    return true;
  }
}

/**
 * `request.ip` is the socket address, which is what we want when the API is
 * reached directly. `X-Forwarded-For` is deliberately not read: without
 * `trust proxy` it is attacker-controlled, and a limiter keyed on a spoofable
 * header is a limiter that can be bypassed with one extra header. If a trusted
 * proxy is introduced, configure Express `trust proxy` rather than parsing the
 * header here.
 */
function clientIp(request: ApiRequest): string {
  return request.ip ?? 'unknown';
}

/**
 * The submitted email, even when it is invalid.
 *
 * Validation runs after guards, so a malformed body reaches this point. Keying
 * those attempts on the empty string is intentional: they cannot be aimed at a
 * specific account, but they still consume the address's budget.
 */
function submittedEmail(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';

  const candidate = (body as { email?: unknown }).email;

  return typeof candidate === 'string' ? candidate : '';
}
