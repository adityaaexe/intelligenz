/**
 * Application errors.
 *
 * Every failure the client is allowed to see is an `AppError`: one status, one
 * machine-readable code, one message. The HTTP filter turns it into the single
 * error envelope. Anything else that escapes a service is a bug and becomes an
 * opaque 500 — an unexpected Prisma error must not be able to describe a table
 * or a column to the caller.
 *
 * Codes are part of the API contract (`api-contract.md`); the web client switches
 * on them, so they are stable literals, not free text.
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_TRANSITION'
  | 'TRANSITION_IS_SYSTEM_MANAGED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_STALE'
  | 'APPROVAL_CONSUMED'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_REVOKED'
  | 'APPROVAL_UNBOUND'
  | 'APPROVAL_NOT_REVOCABLE'
  | 'SELF_APPROVAL_FORBIDDEN'
  | 'ALREADY_DECIDED'
  | 'TASK_NOT_CANCELLABLE'
  | 'EXECUTION_NOT_FOUND'
  | 'WORKFLOW_ALREADY_RUNNING'
  | 'ORCHESTRATOR_UNAVAILABLE'
  | 'PROGRAMME_GRAPH_INVALID'
  // A programme in a terminal status has nothing left to stop. Distinct from
  // `TASK_NOT_CANCELLABLE` so a client can tell "the programme is already over" from "the
  // task is in a state the state machine does not allow to cancel".
  | 'PROGRAMME_NOT_CANCELLABLE'
  // Phase 8.7. A proposal is data; these are the ways a proposal, a decision about it,
  // or its materialisation can be refused. They are distinct codes because a client (and
  // an operator) must be able to tell "the planner is down" from "the planner answered
  // nonsense" from "this plan may not be approved" from "the approved content changed".
  | 'PLANNER_UNAVAILABLE'
  | 'PLANNER_INVALID_RESPONSE'
  | 'PLAN_NOT_VALID'
  | 'PLAN_NOT_APPROVED'
  | 'PLAN_APPROVAL_EXPIRED'
  | 'PLAN_CONTENT_CHANGED'
  | 'RATE_LIMITED'
  | 'INVALID_CURSOR'
  | 'ARTIFACT_INTEGRITY_FAILED'
  | 'ARTIFACT_GONE'
  | 'INTERNAL_ERROR'
  | 'UNVALIDATED_BODY';

/** Field errors are keyed by dotted path so a form can map them to inputs. */
export type ErrorDetails = Record<string, string[]>;

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: ErrorDetails,
    /**
     * Headers the failure itself must carry. Only `Retry-After` uses it today: a
     * 429 without a retry hint is a 429 a client can only guess its way past.
     * Values are set by `AllExceptionsFilter`, the single place a response is
     * turned into an error.
     */
    readonly headers?: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static unauthorized(message = 'Authentication required.'): AppError {
    return new AppError(401, 'UNAUTHORIZED', message);
  }

  static forbidden(message = 'You do not have access to this organisation.'): AppError {
    return new AppError(403, 'FORBIDDEN', message);
  }

  /**
   * One shape for every 429, whether or not the submitted email exists. The
   * message and the header are derived from the limiter's window only, so the
   * response cannot be used as an account-existence oracle.
   */
  static rateLimited(retryAfterSeconds: number): AppError {
    return new AppError(429, 'RATE_LIMITED', 'Too many sign-in attempts. Try again later.', undefined, {
      'Retry-After': String(retryAfterSeconds),
    });
  }

  /**
   * Cross-tenant access returns 404, never 403: a 403 confirms the record exists.
   * Use this for anything resolved by id inside a tenant.
   */
  static notFound(resource: string): AppError {
    return new AppError(404, 'NOT_FOUND', `${resource} not found.`);
  }

  static invalidTransition(from: string, to: string): AppError {
    return new AppError(422, 'INVALID_TRANSITION', `A task cannot move from "${from}" to "${to}".`, {
      transition: [`${from} → ${to} is not an allowed transition.`],
    });
  }
}
