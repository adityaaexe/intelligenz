import { WORKSPACE_SLUG, apiGet, authorizationFor } from './api';
import type { Session } from '../../src/lib/session';
import type {
  ExecutionAttempt,
  ExecutionAttemptDetail,
  Project,
  Task,
} from '../../src/lib/types';

/**
 * Execution-history facts, read from the API rather than from the page.
 *
 * The specs assert that what is on screen exists in the database; the only way
 * to make that check meaningful is to ask the database through a second path.
 * This module is that second path, and it is deliberately small.
 */

export function executionsPath(taskId: string): string {
  return `/${WORKSPACE_SLUG}/tasks/${taskId}`;
}

export interface AttemptWithDetail {
  readonly attempt: ExecutionAttempt;
  readonly detail: ExecutionAttemptDetail;
}

/** The first task in the workspace that has recorded at least one attempt. */
export async function taskWithAttempts(session: Session): Promise<string | null> {
  const tasks = await tasksWithAttempts(session);
  return tasks[0] ?? null;
}

/**
 * The first task in the workspace whose attempts carry **both** a tool trace and
 * artifacts.
 *
 * The spec that asserts the timeline cannot search by "has an attempt" alone: a
 * simulated attempt records no tool calls (it calls no tools), so a task that
 * happens to be the newest would make the assertions vacuous. This walks the
 * candidates until it finds evidence, and the caller skips explicitly if the
 * workspace has none.
 */
export async function taskWithTrace(
  session: Session,
): Promise<{ readonly taskId: string; readonly entries: readonly AttemptWithDetail[] } | null> {
  for (const taskId of await tasksWithAttempts(session)) {
    const entries = await attemptsWithDetail(session, taskId);
    const hasEvidence = entries.some(
      (entry) =>
        entry.detail.toolInvocations.length > 0 && entry.detail.artifacts.length > 0,
    );
    if (hasEvidence) {
      return { taskId, entries };
    }
  }
  return null;
}

/** Every task in the workspace that has at least one recorded attempt. */
async function tasksWithAttempts(session: Session): Promise<readonly string[]> {
  const { orgId, workspaceId } = scopeFor(session);
  const headers = authorizationFor(session);
  const projects = await apiGet<readonly Project[]>(
    `/v1/orgs/${orgId}/workspaces/${workspaceId}/projects`,
    headers,
  );

  const found: string[] = [];
  for (const project of projects.slice(0, 5)) {
    const tasks = await apiGet<readonly Task[]>(
      `/v1/orgs/${orgId}/projects/${project.id}/tasks?limit=100`,
      headers,
    );
    for (const task of tasks) {
      const attempts = await apiGet<readonly ExecutionAttempt[]>(
        `/v1/orgs/${orgId}/tasks/${task.id}/executions`,
        headers,
      );
      if (attempts.length > 0) {
        found.push(task.id);
      }
    }
  }
  return found;
}

/** The first task in the workspace with no recorded attempt at all. */
export async function taskWithoutAttempts(session: Session): Promise<string | null> {
  const { orgId, workspaceId } = scopeFor(session);
  const headers = authorizationFor(session);
  const projects = await apiGet<readonly Project[]>(
    `/v1/orgs/${orgId}/workspaces/${workspaceId}/projects`,
    headers,
  );

  for (const project of projects.slice(0, 5)) {
    const tasks = await apiGet<readonly Task[]>(
      `/v1/orgs/${orgId}/projects/${project.id}/tasks?limit=100`,
      headers,
    );
    for (const task of tasks) {
      const attempts = await apiGet<readonly ExecutionAttempt[]>(
        `/v1/orgs/${orgId}/tasks/${task.id}/executions`,
        headers,
      );
      if (attempts.length === 0) {
        return task.id;
      }
    }
  }
  return null;
}

/**
 * Every attempt of a task with its detail, newest first (the API's order).
 *
 * Bounded to eight attempts: a task with a pathological retry history does not
 * need to turn one assertion into a hundred requests.
 */
export async function attemptsWithDetail(
  session: Session,
  taskId: string,
): Promise<readonly AttemptWithDetail[]> {
  const { orgId } = scopeFor(session);
  const headers = authorizationFor(session);
  const attempts = await apiGet<readonly ExecutionAttempt[]>(
    `/v1/orgs/${orgId}/tasks/${taskId}/executions`,
    headers,
  );

  const out: AttemptWithDetail[] = [];
  for (const attempt of attempts.slice(0, 8)) {
    const detail = await apiGet<ExecutionAttemptDetail>(
      `/v1/orgs/${orgId}/tasks/${taskId}/executions/${attempt.id}`,
      headers,
    );
    out.push({ attempt, detail });
  }
  return out;
}

/** The attempt carrying the most evidence, so the assertions are not vacuous. */
export function richestAttempt(
  entries: readonly AttemptWithDetail[],
): AttemptWithDetail | null {
  let best: AttemptWithDetail | null = null;
  let score = -1;
  for (const entry of entries) {
    const value = entry.detail.toolInvocations.length * 10 + entry.detail.artifacts.length;
    if (value > score) {
      score = value;
      best = entry;
    }
  }
  return best;
}

function scopeFor(session: Session): { readonly orgId: string; readonly workspaceId: string } {
  for (const membership of session.memberships) {
    for (const workspace of membership.workspaces) {
      if (workspace.slug === WORKSPACE_SLUG) {
        return { orgId: membership.orgId, workspaceId: workspace.id };
      }
    }
  }
  throw new Error(`The seeded session has no membership for workspace "${WORKSPACE_SLUG}".`);
}
