import { describe, expect, it } from 'vitest';

import { TIMELINE_ROW_CAP, defaultAttemptId, orderAttempts, timelineMayBeTruncated } from './executions';
import type { ExecutionAttempt } from './types';

/**
 * Ordering and disclosure rules for the attempt list.
 *
 * Two claims are load-bearing and are pinned here:
 * - the list is the API's order, unmodified (newest first is the server's
 *   ordering, not a client guess), and
 * - one attempt opens expanded, several open on the newest.
 */

function attempt(id: string, number: number): ExecutionAttempt {
  return {
    id,
    taskId: 't-1',
    workflowRunId: 'w-1',
    attemptNumber: number,
    runtimeId: 'opencode-cli',
    runtimeVersion: null,
    simulated: false,
    status: 'succeeded',
    startedAt: '2026-11-13T10:00:00.000Z',
    finishedAt: '2026-11-13T10:00:10.000Z',
    durationMs: 10_000,
    tokensIn: 1,
    tokensOut: 1,
    costUsd: null,
    error: null,
    workspace: null,
  };
}

describe('orderAttempts', () => {
  it('returns the API order untouched', () => {
    const api = [attempt('b', 2), attempt('a', 1)];
    expect(orderAttempts(api).map((entry) => entry.id)).toEqual(['b', 'a']);
  });

  it('returns a copy, so a caller cannot mutate the response', () => {
    const api = [attempt('a', 1)];
    const ordered = orderAttempts(api);
    expect(ordered).not.toBe(api);
  });
});

describe('defaultAttemptId', () => {
  it('opens the only attempt when there is one', () => {
    expect(defaultAttemptId([attempt('only', 1)])).toBe('only');
  });

  it('opens the newest attempt when there are several', () => {
    expect(defaultAttemptId([attempt('newest', 3), attempt('middle', 2), attempt('oldest', 1)])).toBe(
      'newest',
    );
  });

  it('opens nothing when no attempt has been recorded', () => {
    // The empty state is a real state; there is no attempt to disclose.
    expect(defaultAttemptId([])).toBeNull();
  });
});

describe('timelineMayBeTruncated', () => {
  it('flags a trace that reached the display cap', () => {
    expect(timelineMayBeTruncated(TIMELINE_ROW_CAP - 1)).toBe(false);
    expect(timelineMayBeTruncated(TIMELINE_ROW_CAP)).toBe(true);
    expect(timelineMayBeTruncated(TIMELINE_ROW_CAP + 40)).toBe(true);
  });
});
