import { describe, expect, it } from 'vitest';

import { ApiError } from './api';
import {
  OVERDUE_APPROVAL_MS,
  criticalAlerts,
  derivePosture,
  queueCounts,
  sumUsage,
} from './overview';
import type { AgentRunRow, Result } from './overview';
import type { Approval, HealthReady, Task } from './types';

/**
 * The Overview derivations. Inputs here are test doubles for pure functions;
 * nothing in this file is shipped, and no region of the product reads a fixture
 * (contract §15 A6).
 */
const NOW = Date.parse('2026-11-13T05:00:00.000Z');
const ORG = 'org-1';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    orgId: ORG,
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    title: 'A task',
    goal: 'A goal',
    status: 'ready',
    riskClass: 'LOW',
    priority: 'normal',
    acceptanceCriteria: [],
    createdById: 'user-1',
    idempotencyKey: 'key-1',
    createdAt: '2026-11-13T04:00:00.000Z',
    updatedAt: '2026-11-13T04:30:00.000Z',
    ...overrides,
  };
}

function approval(overrides: Partial<Approval> = {}): Approval {
  const base: Approval = {
    id: 'approval-1',
    taskId: 'task-1',
    riskClass: 'HIGH',
    status: 'PENDING',
    createdAt: '2026-11-13T04:00:00.000Z',
    decidedAt: null,
    decisionNote: null,
    task: {
      id: 'task-1',
      title: 'A task',
      status: 'ready',
      riskClass: 'HIGH',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
    },
    requestedBy: null,
    decidedBy: null,
  };
  return { ...base, ...overrides };
}

function run(overrides: Partial<AgentRunRow> = {}): AgentRunRow {
  return {
    id: 'run-1',
    runtimeId: 'local-simulated',
    model: 'simulated',
    status: 'succeeded',
    startedAt: '2026-11-13T04:00:00.000Z',
    finishedAt: '2026-11-13T04:00:01.000Z',
    tokensIn: 1_000,
    tokensOut: 500,
    costUsd: '0',
    taskId: 'task-1',
    taskTitle: 'A task',
    taskStatus: 'succeeded',
    projectKey: 'CTRL',
    ...overrides,
  };
}

const readyHealth: Result<HealthReady> = {
  ok: true,
  value: {
    status: 'ready',
    service: 'intelligenz-api',
    checks: {
      postgres: { status: 'up', latencyMs: 12 },
      temporal: { status: 'up', latencyMs: 8 },
    },
  },
};

describe('queueCounts', () => {
  it('counts every status, including the ones at zero', () => {
    const buckets = queueCounts([
      task({ id: 'a', status: 'running' }),
      task({ id: 'b', status: 'running' }),
      task({ id: 'c', status: 'failed' }),
    ]);
    expect(buckets.find((bucket) => bucket.status === 'running')?.count).toBe(2);
    expect(buckets.find((bucket) => bucket.status === 'failed')?.count).toBe(1);
    expect(buckets.find((bucket) => bucket.status === 'draft')?.count).toBe(0);
  });

  it('is total over an empty list', () => {
    expect(queueCounts([]).every((bucket) => bucket.count === 0)).toBe(true);
  });

  it('keeps an unknown status instead of dropping the row', () => {
    const buckets = queueCounts([task({ status: 'paused' as Task['status'] })]);
    expect(buckets.some((bucket) => bucket.status === 'paused' && bucket.count === 1)).toBe(true);
  });
});

describe('derivePosture', () => {
  it('is nominal when health is ready, nothing failed and no approval is overdue', () => {
    const posture = derivePosture({
      health: readyHealth,
      tasks: { ok: true, value: [task({ status: 'succeeded' })] },
      approvals: { ok: true, value: [approval()] },
      now: NOW,
    });
    expect(posture.posture).toBe('nominal');
    expect(posture.tone).toBe('completed');
  });

  it('is offline when the API cannot be reached', () => {
    const posture = derivePosture({
      health: { ok: false, error: new ApiError('NETWORK_ERROR', 0, 'down') },
      tasks: { ok: false, error: new ApiError('NETWORK_ERROR', 0, 'down') },
      approvals: { ok: false, error: new ApiError('NETWORK_ERROR', 0, 'down') },
      now: NOW,
    });
    expect(posture.posture).toBe('offline');
    expect(posture.reason).toContain('could not be reached');
  });

  it('is unknown when health fails for a reason other than reachability', () => {
    const posture = derivePosture({
      health: { ok: false, error: new ApiError('INTERNAL_ERROR', 500, 'boom') },
      tasks: { ok: true, value: [] },
      approvals: { ok: true, value: [] },
      now: NOW,
    });
    expect(posture.posture).toBe('unknown');
  });

  it('is failed when a task is failed, even with healthy dependencies', () => {
    const posture = derivePosture({
      health: readyHealth,
      tasks: { ok: true, value: [task({ status: 'failed' })] },
      approvals: { ok: true, value: [] },
      now: NOW,
    });
    expect(posture.posture).toBe('failed');
    expect(posture.reason).toContain('1 task');
  });

  it('does not claim nominal when task status is unreadable', () => {
    const posture = derivePosture({
      health: readyHealth,
      tasks: { ok: false, error: new ApiError('INVALID_RESPONSE', 200, 'no envelope') },
      approvals: { ok: true, value: [] },
      now: NOW,
    });
    expect(posture.posture).toBe('unknown');
    expect(posture.reason).toContain('Task status could not be read');
  });

  it('does not claim nominal when the approval queue is unreadable', () => {
    const posture = derivePosture({
      health: readyHealth,
      tasks: { ok: true, value: [] },
      approvals: { ok: false, error: new ApiError('FORBIDDEN', 403, 'no') },
      now: NOW,
    });
    expect(posture.posture).toBe('unknown');
    expect(posture.reason).toContain('approval queue could not be read');
  });

  it('is degraded when a dependency is not up, and names it', () => {
    const posture = derivePosture({
      health: {
        ok: true,
        value: {
          status: 'not_ready',
          service: 'intelligenz-api',
          checks: {
            postgres: { status: 'up', latencyMs: 12 },
            temporal: { status: 'down', latencyMs: 2001, detail: 'timeout' },
          },
        },
      },
      tasks: { ok: true, value: [] },
      approvals: { ok: true, value: [] },
      now: NOW,
    });
    expect(posture.posture).toBe('degraded');
    expect(posture.reason).toContain('temporal');
  });

  it('is degraded when an approval has waited more than 24 hours', () => {
    const old = new Date(NOW - OVERDUE_APPROVAL_MS - 1).toISOString();
    const posture = derivePosture({
      health: readyHealth,
      tasks: { ok: true, value: [] },
      approvals: { ok: true, value: [approval({ createdAt: old })] },
      now: NOW,
    });
    expect(posture.posture).toBe('degraded');
    expect(posture.reason).toContain('approval');
  });

  it('does not count a decided approval as overdue', () => {
    const old = new Date(NOW - OVERDUE_APPROVAL_MS - 1).toISOString();
    const posture = derivePosture({
      health: readyHealth,
      tasks: { ok: true, value: [] },
      approvals: { ok: true, value: [approval({ createdAt: old, status: 'APPROVED' })] },
      now: NOW,
    });
    expect(posture.posture).toBe('nominal');
  });
});

describe('sumUsage', () => {
  it('sums tokens and cost across runs', () => {
    const usage = sumUsage([
      run({ id: 'a', tokensIn: 100, tokensOut: 50, costUsd: '0.5' }),
      run({ id: 'b', tokensIn: 200, tokensOut: 100, costUsd: '0.25' }),
    ]);
    expect(usage.tokensIn).toBe(300);
    expect(usage.tokensOut).toBe(150);
    expect(usage.costUsd).toBeCloseTo(0.75, 6);
    expect(usage.reportedZeroCost).toBe(false);
  });

  it('flags an all-zero cost as simulated rather than as free', () => {
    const usage = sumUsage([run({ costUsd: '0' }), run({ id: 'b', costUsd: null })]);
    expect(usage.costUsd).toBe(0);
    expect(usage.reportedZeroCost).toBe(true);
    expect(usage.simulatedRuns).toBe(2);
  });

  it('does not claim a zero cost when nothing was read', () => {
    const usage = sumUsage([]);
    expect(usage.runs).toBe(0);
    expect(usage.reportedZeroCost).toBe(false);
  });

  it('counts distinct tasks', () => {
    const usage = sumUsage([run({ id: 'a', taskId: 't1' }), run({ id: 'b', taskId: 't1' }), run({ id: 'c', taskId: 't2' })]);
    expect(usage.tasks).toBe(2);
  });
});

describe('criticalAlerts', () => {
  it('reports a failed task', () => {
    const alerts = criticalAlerts([task({ id: 'broken', status: 'failed', title: 'Broke' })], [], NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'failed-task', severity: 'high', title: 'Broke' });
  });

  it('reports a pending approval older than 24 hours as critical when risk is critical', () => {
    const alerts = criticalAlerts(
      [],
      [
        approval({
          riskClass: 'CRITICAL',
          createdAt: new Date(NOW - OVERDUE_APPROVAL_MS - 60_000).toISOString(),
        }),
      ],
      NOW,
    );
    expect(alerts[0]).toMatchObject({ kind: 'overdue-approval', severity: 'critical' });
  });

  it('does not alert on a young approval', () => {
    expect(criticalAlerts([], [approval({ createdAt: new Date(NOW - 60_000).toISOString() })], NOW)).toHaveLength(0);
  });

  it('does not alert on a decided approval', () => {
    const alerts = criticalAlerts(
      [],
      [approval({ status: 'REJECTED', createdAt: new Date(NOW - OVERDUE_APPROVAL_MS - 60_000).toISOString() })],
      NOW,
    );
    expect(alerts).toHaveLength(0);
  });

  it('orders critical above high, then oldest first', () => {
    const alerts = criticalAlerts(
      [task({ id: 'f1', status: 'failed', updatedAt: '2026-11-13T04:00:00.000Z' })],
      [
        approval({
          id: 'critical',
          riskClass: 'CRITICAL',
          createdAt: new Date(NOW - OVERDUE_APPROVAL_MS - 3_600_000).toISOString(),
        }),
      ],
      NOW,
    );
    expect(alerts.map((alert) => alert.id)).toEqual(['approval:critical', 'task:f1']);
  });

  it('honours the limit', () => {
    const tasks = Array.from({ length: 10 }, (_, index) => task({ id: `f${index}`, status: 'failed' }));
    expect(criticalAlerts(tasks, [], NOW, 3)).toHaveLength(3);
  });
});
