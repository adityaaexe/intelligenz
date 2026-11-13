import { ApiError } from './api';
import type { ApiClient } from './api';
import type { AgentRunSummary, Approval, HealthReady, Project, Task, TaskDetail } from './types';

/**
 * Overview data assembly and derivation.
 *
 * Contract §15 A6 binds every region to a declared source. This module is the
 * only place a number on the Overview can come from, and each function states
 * which records it reads. There are no fixtures and no sample values here: if a
 * source is missing the snapshot carries an error and the region says so.
 *
 * Two regions are *derived* rather than read directly, and the derivation is
 * visible in the UI:
 * - agent runs: the API has no `AgentRun` list endpoint. `GET /tasks/:taskId`
 *   returns `latestRun.agentRuns`, so the newest `DETAIL_BUDGET` tasks are read
 *   individually and their latest runs collected.
 * - task queues / usage: computed from those records, labelled `Derived`.
 */

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ApiError };

/** How many task details are read to assemble agent activity. */
export const DETAIL_BUDGET = 10;

/** An approval that has waited longer than this is reported as an alert. */
export const OVERDUE_APPROVAL_MS = 24 * 60 * 60 * 1000;

/** An agent run joined to the task that produced it. */
export interface AgentRunRow extends AgentRunSummary {
  readonly taskId: string;
  readonly taskTitle: string;
  readonly taskStatus: string;
  readonly projectKey: string;
}

export interface OverviewSnapshot {
  readonly fetchedAt: number;
  readonly health: Result<HealthReady>;
  readonly approvals: Result<readonly Approval[]>;
  readonly projects: Result<readonly Project[]>;
  readonly tasks: Result<readonly Task[]>;
  readonly agentRuns: Result<readonly AgentRunRow[]>;
  readonly detailsAttempted: number;
  readonly detailFailures: number;
  readonly taskListFailures: number;
}

export function toResultError(cause: unknown): ApiError {
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

export interface LoadOverviewOptions {
  readonly client: ApiClient;
  readonly orgId: string;
  readonly workspaceId: string;
  readonly now?: number;
}

/**
 * One refresh. Regions are captured independently: a failing approvals call must
 * not blank the task ledger (Overview §6 "Partial failure is normal and must not
 * cascade").
 */
export async function loadOverview({
  client,
  orgId,
  workspaceId,
  now = Date.now(),
}: LoadOverviewOptions): Promise<OverviewSnapshot> {
  const [health, approvals, projects] = await Promise.all([
    capture(() => client.health()),
    capture(() => client.listApprovals(orgId, 50).then((page) => page.data)),
    capture(() => client.listProjects(orgId, workspaceId)),
  ]);

  // Tasks across every project in the workspace, capped so one enormous
  // workspace cannot turn the Overview into a hundred requests.
  let tasks: Result<readonly Task[]> = { ok: false, error: new ApiError('UNKNOWN', 0, 'No projects could be read.') };
  let taskListFailures = 0;
  if (projects.ok) {
    const settled = await Promise.allSettled(
      projects.value.slice(0, 5).map((project) => client.listTasks(orgId, project.id, 100)),
    );
    const merged = new Map<string, Task>();
    for (const entry of settled) {
      if (entry.status === 'fulfilled') {
        for (const task of entry.value.data) {
          merged.set(task.id, task);
        }
      } else {
        taskListFailures += 1;
      }
    }
    if (settled.length === 0) {
      tasks = { ok: true, value: [] };
    } else if (merged.size === 0 && taskListFailures === settled.length) {
      tasks = { ok: false, error: toResultError((settled[0] as PromiseRejectedResult).reason) };
    } else {
      tasks = { ok: true, value: [...merged.values()] };
    }
  } else {
    tasks = { ok: false, error: projects.error };
  }

  // Agent activity: task detail is the only route to an AgentRun.
  let agentRuns: Result<readonly AgentRunRow[]> = { ok: false, error: new ApiError('UNKNOWN', 0, 'No tasks to read runs from.') };
  let detailFailures = 0;
  let detailsAttempted = 0;
  if (tasks.ok) {
    const candidates = [...tasks.value]
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, DETAIL_BUDGET);
    detailsAttempted = candidates.length;
    if (candidates.length === 0) {
      agentRuns = { ok: true, value: [] };
    } else {
      const settled = await Promise.allSettled(candidates.map((task) => client.getTask(orgId, task.id)));
      const rows: AgentRunRow[] = [];
      let firstError: ApiError | null = null;
      for (const entry of settled) {
        if (entry.status === 'fulfilled') {
          rows.push(...runsFromDetail(entry.value));
        } else {
          detailFailures += 1;
          firstError ??= toResultError(entry.reason);
        }
      }
      if (detailFailures === settled.length && firstError !== null) {
        agentRuns = { ok: false, error: firstError };
      } else {
        agentRuns = { ok: true, value: rows };
      }
    }
  } else {
    agentRuns = { ok: false, error: tasks.error };
  }

  return {
    fetchedAt: now,
    health,
    approvals,
    projects,
    tasks,
    agentRuns,
    detailsAttempted,
    detailFailures,
    taskListFailures,
  };
}

function runsFromDetail(detail: TaskDetail): AgentRunRow[] {
  if (detail.latestRun === null) {
    return [];
  }
  return detail.latestRun.agentRuns.map((run) => ({
    ...run,
    taskId: detail.id,
    taskTitle: detail.title,
    taskStatus: detail.status,
    projectKey: detail.project.key,
  }));
}

/* ---------------------------------------------------------------------------
 * Queue counts — `Task` grouped by status (contract §15 A6)
 * ------------------------------------------------------------------------- */

const QUEUE_ORDER = [
  'draft',
  'ready',
  'queued',
  'running',
  'verifying',
  'blocked',
  'failed',
  'succeeded',
  'cancelled',
] as const;

export interface QueueBucket {
  readonly status: string;
  readonly label: string;
  readonly count: number;
}

const QUEUE_LABELS: Readonly<Record<string, string>> = {
  draft: 'Draft',
  ready: 'Ready',
  queued: 'Queued',
  running: 'Running',
  verifying: 'Verifying',
  blocked: 'Blocked',
  failed: 'Failed',
  succeeded: 'Succeeded',
  cancelled: 'Cancelled',
};

/** Every status appears, including zeros, so the function is total and the UI
 *  can decide what to hide. Unknown statuses are appended, never dropped. */
export function queueCounts(tasks: readonly Task[]): QueueBucket[] {
  const counts = new Map<string, number>();
  for (const status of QUEUE_ORDER) {
    counts.set(status, 0);
  }
  for (const task of tasks) {
    counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  }
  return [...counts.entries()].map(([status, count]) => ({
    status,
    label: QUEUE_LABELS[status] ?? status,
    count,
  }));
}

/* ---------------------------------------------------------------------------
 * Posture — derived, with the rule stated on screen
 * ------------------------------------------------------------------------- */

export type Posture = 'nominal' | 'degraded' | 'failed' | 'offline' | 'unknown';

export interface PostureView {
  readonly posture: Posture;
  readonly label: string;
  readonly reason: string;
  readonly tone: 'completed' | 'degraded' | 'failed' | 'offline' | 'neutral';
}

const POSTURE_LABELS: Readonly<Record<Posture, string>> = {
  nominal: 'Nominal',
  degraded: 'Degraded',
  failed: 'Failed',
  offline: 'Offline',
  unknown: 'Unknown',
};

const POSTURE_TONES: Readonly<Record<Posture, PostureView['tone']>> = {
  nominal: 'completed',
  degraded: 'degraded',
  failed: 'failed',
  offline: 'offline',
  unknown: 'neutral',
};

/** Rule, in the order applied. Rendered verbatim in the posture cell's help. */
export const POSTURE_RULE =
  'Offline when the API cannot be reached; Failed when any task is in a failed state; ' +
  'Degraded when a dependency is down or an approval has waited more than 24 hours; ' +
  'Unknown when the task or approval read failed; otherwise Nominal.';

export function derivePosture(input: {
  readonly health: Result<HealthReady>;
  readonly tasks: Result<readonly Task[]>;
  readonly approvals: Result<readonly Approval[]>;
  readonly now: number;
}): PostureView {
  const build = (posture: Posture, reason: string): PostureView => ({
    posture,
    label: POSTURE_LABELS[posture],
    reason,
    tone: POSTURE_TONES[posture],
  });

  if (!input.health.ok) {
    if (input.health.error.isNetwork) {
      return build('offline', 'The API could not be reached, so no value on this page is current.');
    }
    return build('unknown', `Dependency health is unavailable: ${input.health.error.message}`);
  }

  if (input.health.value.status !== 'ready') {
    const down = Object.entries(input.health.value.checks)
      .filter(([, check]) => check.status !== 'up')
      .map(([name]) => name);
    const named = down.length > 0 ? down.join(', ') : 'an unnamed dependency';
    return build('degraded', `${named} reported not ready. New runs may queue rather than start.`);
  }

  if (input.tasks.ok) {
    const failed = input.tasks.value.filter((task) => task.status === 'failed').length;
    if (failed > 0) {
      return build('failed', `${failed} task${failed === 1 ? '' : 's'} in a failed state.`);
    }
  }

  // A posture word is a claim. Without these two reads the claim cannot be made,
  // so it is not made: "Nominal" would assert "no failed tasks" from no data.
  if (!input.tasks.ok) {
    return build('unknown', 'Task status could not be read, so posture cannot be asserted.');
  }
  if (!input.approvals.ok) {
    return build('unknown', 'The approval queue could not be read, so posture cannot be asserted.');
  }

  if (input.approvals.ok) {
    const overdue = input.approvals.value.filter(
      (approval) => approval.status === 'PENDING' && input.now - Date.parse(approval.createdAt) > OVERDUE_APPROVAL_MS,
    ).length;
    if (overdue > 0) {
      return build('degraded', `${overdue} approval${overdue === 1 ? '' : 's'} waiting more than 24 hours.`);
    }
  }

  return build('nominal', 'All dependencies up, no failed tasks, no approval older than 24 hours.');
}

/* ---------------------------------------------------------------------------
 * Usage — aggregate of AgentRun usage (contract §15 A6)
 * ------------------------------------------------------------------------- */

export interface UsageTotals {
  readonly runs: number;
  readonly tasks: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
  /** True when every reported cost is zero or absent: the simulated runtime. */
  readonly reportedZeroCost: boolean;
  readonly simulatedRuns: number;
}

export function sumUsage(runs: readonly AgentRunRow[]): UsageTotals {
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  let simulatedRuns = 0;
  let nonZeroCost = false;
  const tasks = new Set<string>();

  for (const run of runs) {
    tokensIn += run.tokensIn;
    tokensOut += run.tokensOut;
    const cost = run.costUsd === null ? null : Number.parseFloat(run.costUsd);
    if (cost !== null && Number.isFinite(cost) && cost !== 0) {
      costUsd += cost;
      nonZeroCost = true;
    }
    if (run.runtimeId.toLowerCase().includes('simulat')) {
      simulatedRuns += 1;
    }
    tasks.add(run.taskId);
  }

  return {
    runs: runs.length,
    tasks: tasks.size,
    tokensIn,
    tokensOut,
    costUsd,
    reportedZeroCost: runs.length > 0 && !nonZeroCost,
    simulatedRuns,
  };
}

/* ---------------------------------------------------------------------------
 * Critical alerts — failed runs + overdue approvals (contract §15 A6)
 * ------------------------------------------------------------------------- */

export interface Alert {
  readonly id: string;
  readonly kind: 'failed-task' | 'overdue-approval' | 'failed-run';
  readonly severity: 'critical' | 'high';
  readonly title: string;
  readonly detail: string;
  readonly at: string;
}

/**
 * `failed-run` exists in the type because contract A6 names failed *runs*. No
 * endpoint lists `WorkflowRun`, so nothing produces that kind today; the region
 * states it rather than silently narrowing the contract.
 */
export function criticalAlerts(
  tasks: readonly Task[],
  approvals: readonly Approval[],
  now: number,
  limit = 6,
): Alert[] {
  const alerts: Alert[] = [];

  for (const task of tasks) {
    if (task.status === 'failed') {
      alerts.push({
        id: `task:${task.id}`,
        kind: 'failed-task',
        severity: 'high',
        title: task.title,
        detail: `Task failed · risk ${task.riskClass.toLowerCase()}`,
        at: task.updatedAt,
      });
    }
  }

  for (const approval of approvals) {
    if (approval.status !== 'PENDING') {
      continue;
    }
    const age = now - Date.parse(approval.createdAt);
    if (age > OVERDUE_APPROVAL_MS) {
      alerts.push({
        id: `approval:${approval.id}`,
        kind: 'overdue-approval',
        severity: approval.riskClass === 'CRITICAL' ? 'critical' : 'high',
        title: approval.task.title,
        detail: `Awaiting approval for ${Math.floor(age / (60 * 60 * 1000))}h · risk ${approval.riskClass.toLowerCase()}`,
        at: approval.createdAt,
      });
    }
  }

  const rank: Record<Alert['severity'], number> = { critical: 0, high: 1 };
  return alerts
    .sort((left, right) => {
      const bySeverity = rank[left.severity] - rank[right.severity];
      if (bySeverity !== 0) {
        return bySeverity;
      }
      return Date.parse(left.at) - Date.parse(right.at);
    })
    .slice(0, limit);
}
