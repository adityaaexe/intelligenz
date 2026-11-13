/**
 * Errors the workspace manager raises. Each carries a stable `code` because the
 * worker persists the failure into `ExecutionWorkspace.error` (`{ stage, message,
 * code }`) and a UI reads `code`, not prose.
 */

export type WorkspaceErrorCode =
  | 'WORKSPACE_PATH_UNSAFE'
  | 'WORKSPACE_ESCAPE'
  | 'WORKSPACE_ILLEGAL_TRANSITION'
  | 'WORKSPACE_NOT_FOUND'
  | 'WORKSPACE_PROVISION_FAILED'
  | 'WORKSPACE_SOURCE_INVALID'
  | 'SANDBOX_UNAVAILABLE'
  | 'SANDBOX_ENV_REJECTED'
  | 'SANDBOX_COMMAND_INVALID';

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;

  constructor(code: WorkspaceErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

/**
 * Raised when an id supplied by a route (`orgId`, `taskId`, `workspaceId`) cannot be
 * used as a path segment. This is the single choke point that makes route-supplied
 * ids safe: everything downstream may assume a segment-shaped value.
 */
export class UnsafeSegmentError extends WorkspaceError {
  readonly value: string;

  constructor(value: string) {
    super(
      'WORKSPACE_PATH_UNSAFE',
      `Unsafe path segment ${JSON.stringify(value)}: expected /^[A-Za-z0-9_-]{1,64}$/`,
    );
    this.name = 'UnsafeSegmentError';
    this.value = value;
  }
}

/** Raised when a resolved path is not inside the root it claims to belong to. */
export class ContainmentError extends WorkspaceError {
  readonly base: string;
  readonly candidate: string;

  constructor(base: string, candidate: string) {
    super('WORKSPACE_ESCAPE', `Path ${candidate} is outside ${base}`);
    this.name = 'ContainmentError';
    this.base = base;
    this.candidate = candidate;
  }
}

/** Raised on an illegal edge in the workspace state machine. */
export class IllegalTransitionError extends WorkspaceError {
  readonly from: string;
  readonly to: string;

  constructor(from: string, to: string) {
    super('WORKSPACE_ILLEGAL_TRANSITION', `Illegal workspace transition ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
  }
}
