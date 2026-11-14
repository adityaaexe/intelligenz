import { describe, expect, it } from 'vitest';

import type { CgroupUsage } from '../src/cgroup';
import {
  TERMINATION_REASONS,
  classifyTermination,
  statusForTermination,
} from '../src/termination';

/**
 * The verdict table.
 *
 * The rule this file exists to protect: **a resource kill is never reported as a normal
 * agent failure**, and an ordinary failure is never relabelled as a resource kill. Both
 * directions have a test, because a misclassification in either direction makes the
 * column useless.
 */

function usage(overrides: Partial<CgroupUsage> = {}): CgroupUsage {
  return {
    memoryPeakBytes: 10 * 1024 * 1024,
    pidsPeak: 3,
    cpuTimeMs: 500,
    cpuUsageUs: 500_000,
    oomKills: 0,
    pidsEventsMax: 0,
    nrThrottled: 0,
    throttledUs: 0,
    ...overrides,
  };
}

const NO_CEILING = 0;

describe('classifyTermination', () => {
  it('reports a clean exit as completed', () => {
    const verdict = classifyTermination({
      adapter: 'succeeded',
      usage: usage(),
      cpuCeilingUs: NO_CEILING,
      placementFailed: false,
    });

    expect(verdict).toMatchObject({ reason: 'completed', resourceKill: false });
  });

  it('reports the kernel OOM kill as oom, even when the adapter said it failed', () => {
    const verdict = classifyTermination({
      adapter: 'failed',
      usage: usage({ oomKills: 1, memoryPeakBytes: 1_073_741_824 }),
      cpuCeilingUs: NO_CEILING,
      placementFailed: false,
    });

    expect(verdict).toMatchObject({ reason: 'oom', resourceKill: true, overridesAdapter: true });
  });

  it('overrides an adapter that claimed success after losing a process to the OOM killer', () => {
    const verdict = classifyTermination({
      adapter: 'succeeded',
      usage: usage({ oomKills: 1 }),
      cpuCeilingUs: NO_CEILING,
      placementFailed: false,
    });

    expect(verdict.reason).toBe('oom');
    expect(verdict.overridesAdapter).toBe(true);
  });

  it('reports a refused fork as pids', () => {
    const verdict = classifyTermination({
      adapter: 'failed',
      usage: usage({ pidsEventsMax: 4 }),
      cpuCeilingUs: NO_CEILING,
      placementFailed: false,
    });

    expect(verdict).toMatchObject({ reason: 'pids', resourceKill: true });
  });

  it('reports more CPU than the quota allows as cpu — an enforcement failure, not a busy run', () => {
    const verdict = classifyTermination({
      adapter: 'succeeded',
      usage: usage({ cpuUsageUs: 10_000_000 }),
      cpuCeilingUs: 1_000_000,
      placementFailed: false,
    });

    expect(verdict).toMatchObject({ reason: 'cpu', resourceKill: true, overridesAdapter: true });
  });

  it('does not call CPU usage below the ceiling a breach', () => {
    const verdict = classifyTermination({
      adapter: 'succeeded',
      usage: usage({ cpuUsageUs: 10_000_000 }),
      cpuCeilingUs: 20_000_000,
      placementFailed: false,
    });

    expect(verdict.reason).toBe('completed');
  });

  it('maps an adapter timeout to timeout, and does not blame the agent', () => {
    const verdict = classifyTermination({
      adapter: 'timeout',
      usage: usage(),
      cpuCeilingUs: NO_CEILING,
      placementFailed: false,
    });

    expect(verdict).toMatchObject({ reason: 'timeout', resourceKill: true });
  });

  it('maps a cancellation to cancelled', () => {
    const verdict = classifyTermination({
      adapter: 'cancelled',
      usage: usage(),
      cpuCeilingUs: NO_CEILING,
      placementFailed: false,
    });

    expect(verdict.reason).toBe('cancelled');
  });

  it('reports an ordinary failure as crashed, not completed', () => {
    const verdict = classifyTermination({
      adapter: 'failed',
      usage: usage(),
      cpuCeilingUs: NO_CEILING,
      placementFailed: false,
    });

    expect(verdict).toMatchObject({ reason: 'crashed', resourceKill: false });
  });

  it('reports a placement failure as workspace_error — nothing ran', () => {
    const verdict = classifyTermination({
      adapter: 'threw',
      usage: null,
      cpuCeilingUs: NO_CEILING,
      placementFailed: true,
    });

    expect(verdict).toMatchObject({ reason: 'workspace_error', overridesAdapter: true });
  });

  it('works with no usage at all (rlimit-only mode)', () => {
    const verdict = classifyTermination({
      adapter: 'succeeded',
      usage: null,
      cpuCeilingUs: NO_CEILING,
      placementFailed: false,
    });

    expect(verdict.reason).toBe('completed');
  });

  it('only ever returns a reason from the closed set', () => {
    const outcomes = ['succeeded', 'failed', 'timeout', 'cancelled', 'threw'] as const;

    for (const adapter of outcomes) {
      for (const pidsEventsMax of [0, 1]) {
        for (const oomKills of [0, 1]) {
          const verdict = classifyTermination({
            adapter,
            usage: usage({ pidsEventsMax, oomKills }),
            cpuCeilingUs: 1,
            placementFailed: false,
          });

          expect(TERMINATION_REASONS).toContain(verdict.reason);
        }
      }
    }
  });
});

describe('statusForTermination', () => {
  it('never turns a resource kill into a success', () => {
    for (const reason of ['oom', 'pids', 'cpu', 'crashed', 'workspace_error'] as const) {
      expect(statusForTermination({ reason, resourceKill: true, overridesAdapter: true })).toBe(
        'failed',
      );
    }
  });

  it('maps the wall clock to timed_out, which is a different fact from failed', () => {
    expect(
      statusForTermination({ reason: 'timeout', resourceKill: true, overridesAdapter: false }),
    ).toBe('timed_out');
  });

  it('maps a clean exit to succeeded and a cancellation to cancelled', () => {
    expect(
      statusForTermination({ reason: 'completed', resourceKill: false, overridesAdapter: false }),
    ).toBe('succeeded');
    expect(
      statusForTermination({ reason: 'cancelled', resourceKill: false, overridesAdapter: false }),
    ).toBe('cancelled');
  });
});
