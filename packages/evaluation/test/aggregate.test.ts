import { describe, expect, it } from 'vitest';

import {
  AggregationRefused,
  aggregate,
  assertAggregatable,
  median,
  percentile,
} from '../src/aggregate';
import { RUBRIC_VERSION } from '../src/rubric';
import type { JudgeResultView, RunMode, RunResult } from '../src/types';

function result(overrides: {
  id?: string;
  version?: string;
  mode?: RunMode;
  rubricVersion?: string;
  score?: number;
  passed?: boolean;
  disqualified?: boolean;
  costUsd?: number | null;
  retries?: number | null;
  durationMs?: number;
  termination?: 'wall-clock' | 'budget' | null;
  judges?: readonly JudgeResultView[];
} = {}): RunResult {
  const id = overrides.id ?? 'fix-failing-test';
  const judges = overrides.judges ?? [
    { index: 0, type: 'command', dimension: 'testCorrectness', status: 'passed', credit: 1, detail: '', durationMs: 1 },
  ];

  return {
    schemaVersion: 1,
    runId: `${id}-1`,
    outcome: 'scored',
    skipReason: null,
    mode: overrides.mode ?? 'simulated',
    benchmark: {
      id,
      version: overrides.version ?? '1.0.0',
      category: 'engineering',
      policyExpectation: 'no-violation',
      fixture: id,
      description: null,
    },
    rubricVersion: overrides.rubricVersion ?? RUBRIC_VERSION,
    runtime: { id: 'benchmark-simulator', version: '1.0.0', model: 'simulated/deterministic' },
    fixtureCommit: 'a'.repeat(40),
    startedAt: '2026-11-14T00:00:00.000Z',
    durationMs: overrides.durationMs ?? 10,
    totalMs: (overrides.durationMs ?? 10) + 5,
    usage: {
      tokensIn: 10,
      tokensOut: 10,
      costUsd: overrides.costUsd === undefined ? null : overrides.costUsd,
      costSource: overrides.costUsd === undefined ? 'simulated' : 'provider',
    },
    retries: overrides.retries === undefined ? 0 : overrides.retries,
    toolInvocations: 1,
    status: 'succeeded',
    termination: overrides.termination === undefined ? null : overrides.termination,
    refused: false,
    judgeResults: judges,
    dimensions: {
      completion: { weight: 40, earned: 0, judged: 0 },
      testCorrectness: { weight: 25, earned: 0, judged: 0 },
      diffQuality: { weight: 15, earned: 0, judged: 0 },
      policyCompliance: { weight: 10, earned: 0, judged: 0 },
      artifactIntegrity: { weight: 10, earned: 0, judged: 0 },
    },
    score: overrides.score ?? 100,
    passed: overrides.passed ?? true,
    disqualified: overrides.disqualified ?? false,
    disqualificationReason: null,
    securityEvents: [],
    artifacts: { changed: [], adapter: [], changeSetSha256: '' },
    environment: { node: 'v22', platform: 'linux', git: 'git version 2.53.0' },
    error: null,
  };
}

describe('aggregate', () => {
  it('computes rates over scored runs', () => {
    const summary = aggregate([
      result({ id: 'a' }),
      result({ id: 'b', passed: false, score: 25 }),
      result({ id: 'c', costUsd: 0.02 }),
    ]);

    expect(summary.runs).toBe(3);
    expect(summary.benchmarks).toBe(3);
    expect(summary.completionRate).toBeCloseTo(2 / 3, 4);
    expect(summary.meanScore).toBeCloseTo(75, 2);
    expect(summary.costCoverage.reported).toBe(1);
    expect(summary.meanCostUsd).toBe(0.02);
  });

  it('refuses to mix simulated and real results', () => {
    expect(() =>
      assertAggregatable([result({ mode: 'simulated' }), result({ id: 'b', mode: 'real' })]),
    ).toThrow(AggregationRefused);
  });

  it('refuses to aggregate two versions of the same benchmark', () => {
    expect(() =>
      assertAggregatable([
        result({ id: 'fix-failing-test', version: '1.0.0' }),
        result({ id: 'fix-failing-test', version: '1.1.0' }),
      ]),
    ).toThrow(/benchmark versions/);
  });

  it('allows different benchmarks to carry different versions', () => {
    expect(() =>
      assertAggregatable([result({ id: 'a', version: '2.0.0' }), result({ id: 'b', version: '1.0.0' })]),
    ).not.toThrow();
  });

  it('refuses to aggregate across rubric versions', () => {
    expect(() =>
      assertAggregatable([result(), result({ id: 'b', rubricVersion: '2026-01-01.1' })]),
    ).toThrow(/rubric versions/);
  });

  it('refuses an empty set', () => {
    expect(() => assertAggregatable([])).toThrow(AggregationRefused);
  });

  it('counts resource terminations and reports cost coverage honestly', () => {
    const summary = aggregate([
      result({ id: 'a', termination: 'wall-clock', passed: false }),
      result({ id: 'b', costUsd: 0.5 }),
    ]);

    expect(summary.resourceTerminations).toBe(1);
    expect(summary.costCoverage).toEqual({ reported: 1, runs: 2 });
  });

  it('only counts runs that carried a test judge in the verified test pass rate', () => {
    const summary = aggregate([
      result({ id: 'a' }),
      result({ id: 'b', judges: [] }),
    ]);

    expect(summary.verifiedTestCoverage).toEqual({ runsWithTestJudges: 1, runs: 2 });
    expect(summary.verifiedTestPassRate).toBe(1);
  });
});

describe('statistics', () => {
  it('takes the median without interpolating', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it('uses nearest-rank for p95', () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(values, 0.95)).toBe(95);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([], 0.95)).toBe(0);
  });
});
