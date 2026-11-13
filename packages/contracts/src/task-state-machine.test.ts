import { describe, expect, it } from 'vitest';

import { TaskStatus } from './enums';
import { canTransition, TASK_TRANSITIONS, transitionRequiresReason } from './task-state-machine';

/**
 * The state machine is the only thing standing between a client and an invalid
 * task lifecycle, so the table is asserted edge by edge rather than sampled.
 */

const ALLOWED: ReadonlyArray<readonly [TaskStatus, TaskStatus]> = [
  ['draft', 'ready'],
  ['ready', 'queued'],
  ['queued', 'running'],
  ['queued', 'cancelled'],
  ['running', 'verifying'],
  ['running', 'failed'],
  ['running', 'cancelled'],
  ['verifying', 'succeeded'],
  ['verifying', 'failed'],
  ['verifying', 'blocked'],
  ['blocked', 'ready'],
];

describe('canTransition', () => {
  it('accepts every declared edge', () => {
    for (const [from, to] of ALLOWED) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  it('rejects succeeded -> running', () => {
    expect(canTransition('succeeded', 'running')).toBe(false);
  });

  it('rejects queued -> succeeded (skipping execution)', () => {
    expect(canTransition('queued', 'succeeded')).toBe(false);
  });

  it('rejects every self-transition', () => {
    for (const status of TaskStatus.options) {
      expect(canTransition(status, status), `${status} -> ${status}`).toBe(false);
    }
  });

  it('rejects every edge not in the declared table', () => {
    const allowed = new Set(ALLOWED.map(([from, to]) => `${from}->${to}`));

    for (const from of TaskStatus.options) {
      for (const to of TaskStatus.options) {
        const expected = allowed.has(`${from}->${to}`);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it('has exactly 11 edges', () => {
    const edges = TaskStatus.options.flatMap((from) =>
      TASK_TRANSITIONS[from].map((to) => `${from}->${to}`),
    );

    expect(edges).toHaveLength(11);
    expect(new Set(edges).size).toBe(11);
  });

  it('keeps terminal statuses terminal', () => {
    for (const from of ['succeeded', 'failed', 'cancelled'] as const) {
      expect(TASK_TRANSITIONS[from]).toHaveLength(0);
    }
  });
});

describe('transitionRequiresReason', () => {
  it('requires a reason when returning to ready from blocked', () => {
    expect(transitionRequiresReason('blocked', 'ready')).toBe(true);
  });

  it('does not require a reason for the initial draft -> ready promotion', () => {
    expect(transitionRequiresReason('draft', 'ready')).toBe(false);
  });

  it('does not require a reason for any other edge', () => {
    expect(transitionRequiresReason('ready', 'queued')).toBe(false);
    expect(transitionRequiresReason('queued', 'running')).toBe(false);
  });
});
