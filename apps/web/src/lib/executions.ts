import { ApiError } from './api';
import type { ApiClient } from './api';
import type { ExecutionAttempt, ExecutionAttemptDetail, TaskDetail } from './types';

/**
 * Loading for the execution detail route.
 *
 * Two independent reads, deliberately not `Promise.all`-coupled at the failure
 * level: the task header can render while the attempt list is broken, and a
 * failed attempt trace must not blank the list that says which attempts exist.
 *
 * There is no cache here and no fallback to a previous snapshot. The requirement
 * is explicit — "if the API is unreachable, the page says so; no cached values
 * presented as current" — so a failed reload replaces the rendered data with the
 * failure rather than leaving yesterday's numbers on screen under a spinner.
 */

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ApiError };

function toResultError(cause: unknown): ApiError {
  if (cause instanceof ApiError) {
    return cause;
  }
  if (cause instanceof Error) {
    return new ApiError('UNKNOWN', 0, cause.message);
  }
  return new ApiError('UNKNOWN', 0, 'An unexpected error occurred.');
}

async function capture<T>(operation: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (cause) {
    return { ok: false, error: toResultError(cause) };
  }
}

export interface ExecutionHistory {
  readonly task: Result<TaskDetail>;
  readonly attempts: Result<readonly ExecutionAttempt[]>;
}

export interface LoadHistoryOptions {
  readonly client: ApiClient;
  readonly orgId: string;
  readonly taskId: string;
}

/**
 * The task header and its attempts, in one refresh.
 *
 * `GET /tasks/:taskId` is read for the title, the risk class and the approval
 * rows that make `Waiting for approval` observable rather than inferred
 * (`lib/execution-state.ts#taskGateState`).
 */
export async function loadExecutionHistory({
  client,
  orgId,
  taskId,
}: LoadHistoryOptions): Promise<ExecutionHistory> {
  const [task, attempts] = await Promise.all([
    capture(() => client.getTask(orgId, taskId)),
    capture(() => client.listExecutions(orgId, taskId)),
  ]);
  return { task, attempts };
}

export interface LoadAttemptOptions extends LoadHistoryOptions {
  readonly attemptId: string;
}

/** One attempt: its identity, its redacted tool trace, its attributed artifacts. */
export function loadAttemptDetail({
  client,
  orgId,
  taskId,
  attemptId,
}: LoadAttemptOptions): Promise<Result<ExecutionAttemptDetail>> {
  return capture(() => client.getExecution(orgId, taskId, attemptId));
}

/**
 * The API orders attempts newest-first (`createdAt desc`, then `attemptNumber
 * desc`). This app does not re-sort: a client-side sort by `startedAt` would
 * disagree with the server whenever a retry started out of timestamp order, and
 * "newest first" would then be two different claims on two surfaces.
 *
 * The copy exists so a caller cannot mutate the response while sorting.
 */
export function orderAttempts(attempts: readonly ExecutionAttempt[]): readonly ExecutionAttempt[] {
  return [...attempts];
}

/**
 * Which attempt the detail panel opens with.
 *
 * With one attempt, that attempt (`api-contract.md`: the detail opens expanded).
 * With several, the first row — the newest attempt, because the operator's
 * question after a retry is about the latest try, not the first.
 */
export function defaultAttemptId(attempts: readonly ExecutionAttempt[]): string | null {
  return attempts[0]?.id ?? null;
}

/** The API caps a trace; at the cap the UI says so instead of implying completeness. */
export const TIMELINE_ROW_CAP = 200;

export function timelineMayBeTruncated(invocationCount: number): boolean {
  return invocationCount >= TIMELINE_ROW_CAP;
}
