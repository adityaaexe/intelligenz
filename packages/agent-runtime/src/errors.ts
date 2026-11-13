import type { ExecutionError } from './types';

/**
 * Typed failures raised by an adapter.
 *
 * Two different things live here and conflating them would be a bug:
 *
 *  - **Dispatch failures** — the adapter could not start, is misconfigured, or lacks
 *    a capability. The activity throws, Temporal decides about retries.
 *  - **`ExecutionResult.status`** — the adapter ran and judged the outcome. That is
 *    data, not an exception. A failing task is not an infrastructure error, and
 *    retrying it three times only delays the truth (ADR-003).
 *
 * `retryable` is the bridge: a thrown `RuntimeError` with `retryable: true` is worth
 * another attempt; `false` must stop immediately.
 */
export class RuntimeError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    options: { retryable: boolean; cause?: unknown } = { retryable: false },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RuntimeError';
    this.code = code;
    this.retryable = options.retryable;
  }
}

/** The adapter cannot reach its backend. Retry — it may come back. */
export class RuntimeUnavailableError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super('RUNTIME_UNAVAILABLE', message, { retryable: true, cause });
    this.name = 'RuntimeUnavailableError';
  }
}

/**
 * The task needs something this adapter does not have. Never retryable: the
 * capability declaration is a constant, so a second attempt fails identically.
 */
export class RuntimeCapabilityError extends RuntimeError {
  constructor(readonly missing: readonly string[], runtimeId: string) {
    super(
      'RUNTIME_CAPABILITY_MISSING',
      `Runtime "${runtimeId}" does not provide: ${missing.join(', ')}.`,
      { retryable: false },
    );
    this.name = 'RuntimeCapabilityError';
  }
}

/** Bad configuration (missing artifact root, unwritable path). Not retryable. */
export class RuntimeConfigurationError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super('RUNTIME_MISCONFIGURED', message, { retryable: false, cause });
    this.name = 'RuntimeConfigurationError';
  }
}

/** The adapter returned something that is not a valid `ExecutionResult`. */
export class RuntimeResultError extends RuntimeError {
  constructor(runtimeId: string, detail: string) {
    super('RUNTIME_RESULT_INVALID', `Runtime "${runtimeId}" returned an invalid result: ${detail}`, {
      retryable: false,
    });
    this.name = 'RuntimeResultError';
  }
}

/**
 * Normalises anything thrown into the wire shape. Unknown errors are retryable
 * (`true`): a bug in an adapter that throws a bare `TypeError` should be retried
 * once before the task is declared failed, because the alternative is recording a
 * transient crash as a permanent outcome.
 */
export function toExecutionError(error: unknown): ExecutionError {
  if (error instanceof RuntimeError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }

  if (error instanceof Error) {
    return { code: 'RUNTIME_ERROR', message: error.message, retryable: true };
  }

  return { code: 'RUNTIME_ERROR', message: String(error), retryable: true };
}

/**
 * Capability gate (ADR-006). `required` is a list of action names a task needs;
 * anything unrecognised is ignored rather than guessed at, because inventing a
 * capability requirement is worse than not checking one.
 */
export const CAPABILITY_ACTIONS = [
  'shell',
  'network',
  'filesystem',
  'browser',
  'mcp',
  'imageInput',
] as const;

export type CapabilityAction = (typeof CAPABILITY_ACTIONS)[number];

export function missingCapabilities(
  capabilities: {
    shell: boolean;
    network: boolean;
    filesystem: 'none' | 'read' | 'write';
    browser: boolean;
    mcp: boolean;
    imageInput: boolean;
  },
  required: readonly string[],
): CapabilityAction[] {
  const missing: CapabilityAction[] = [];

  for (const action of required) {
    if (!isCapabilityAction(action)) continue;

    const satisfied =
      action === 'filesystem' ? capabilities.filesystem !== 'none' : capabilities[action];

    if (!satisfied) missing.push(action);
  }

  return missing;
}

function isCapabilityAction(value: string): value is CapabilityAction {
  return (CAPABILITY_ACTIONS as readonly string[]).includes(value);
}
