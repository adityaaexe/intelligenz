import { ApplicationFailure } from '@temporalio/activity';
import { getPrismaClient } from '@intelligenz/database';
import type { PrismaClient } from '@intelligenz/database';

/**
 * Shared activity plumbing.
 *
 * One Prisma client per process: a client owns a connection pool, and a second one per
 * activity invocation would exhaust Postgres under concurrency (see
 * `packages/database/src/index.ts`). `getPrismaClient()` is the documented singleton.
 */

export function db(): PrismaClient {
  return getPrismaClient();
}

/**
 * A rejection that a retry cannot fix: the task does not exist, is in the wrong state,
 * or needs something this deployment does not have. ADR-003 is explicit — retrying a
 * deterministic rejection three times delays the truth and, for a real runtime, spends
 * money.
 */
export function nonRetryable(type: string, message: string): ApplicationFailure {
  return ApplicationFailure.create({ message, type, nonRetryable: true });
}

/**
 * A non-retryable rejection that also carries machine-readable context across the
 * activity boundary.
 *
 * `ApplicationFailure.details` survives the proxy and is how `runTaskWorkflow` learns,
 * for example, which project a refused task belonged to — without the activity
 * returning a value the workflow must interpret, and without a second database read in
 * the workflow sandbox (which has no Prisma).
 */
export function nonRetryableWithDetails(
  type: string,
  message: string,
  details: Record<string, unknown>,
): ApplicationFailure {
  return ApplicationFailure.create({
    message,
    type,
    nonRetryable: true,
    details: [details],
  });
}

/** A failure that is worth another attempt. `maximumAttempts: 3` still applies. */
export function retryable(type: string, message: string): ApplicationFailure {
  return ApplicationFailure.create({ message, type, nonRetryable: false });
}
