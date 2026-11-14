/**
 * Aggregation, with the two refusals that make the numbers quotable.
 *
 * **Modes are never mixed.** A simulated run exercises the harness; it says nothing
 * about a model. Averaging the two would produce a number that appears to be evidence
 * and is not.
 *
 * **Versions are never mixed.** A benchmark whose fixture, goal or judges changed is a
 * different question. Averaging across the change hides the change — the exact failure
 * that makes "our score went up" untrustworthy in most eval suites.
 *
 * Both are hard failures, not warnings: an aggregator that warns and proceeds has
 * already produced the misleading number by the time the warning is read.
 */

import type { RunMode, RunResult } from './types';

export class AggregationRefused extends Error {
  readonly code = 'AGGREGATION_REFUSED';

  constructor(message: string) {
    super(message);
    this.name = 'AggregationRefused';
  }
}

export interface BenchmarkAggregate {
  readonly id: string;
  readonly version: string;
  readonly category: string;
  readonly runs: number;
  readonly passed: number;
  readonly disqualified: number;
  readonly meanScore: number;
  readonly meanDurationMs: number;
  readonly meanCostUsd: number | null;
}

export interface Aggregate {
  readonly mode: RunMode;
  readonly rubricVersion: string;
  readonly benchmarks: number;
  readonly runs: number;
  readonly skipped: number;
  /** Fraction of scored runs where every judge passed. */
  readonly completionRate: number;
  /** Runs whose test judges all passed, over runs that had test judges at all. */
  readonly verifiedTestPassRate: number;
  readonly verifiedTestCoverage: { readonly runsWithTestJudges: number; readonly runs: number };
  readonly securityViolationRate: number;
  readonly disqualified: number;
  readonly meanScore: number;
  readonly meanCostUsd: number | null;
  readonly costCoverage: { readonly reported: number; readonly runs: number };
  readonly medianDurationMs: number;
  readonly p95DurationMs: number;
  /** `null` when no run reported a retry count. */
  readonly meanRetries: number | null;
  readonly retryCoverage: { readonly reported: number; readonly runs: number };
  readonly resourceTerminations: number;
  readonly perBenchmark: readonly BenchmarkAggregate[];
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  const lower = sorted[middle - 1] ?? 0;
  const upper = sorted[middle] ?? 0;
  return (lower + upper) / 2;
}

/** Nearest-rank percentile: no interpolation, no invented values. */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? 0;
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Throws `AggregationRefused` when the set cannot honestly be summarised.
 *
 * Exported because the CLI calls it *before* rendering anything: a report should not be
 * half-written when the refusal fires.
 */
export function assertAggregatable(results: readonly RunResult[]): { mode: RunMode; rubricVersion: string } {
  if (results.length === 0) {
    throw new AggregationRefused('no results to aggregate');
  }

  const modes = new Set(results.map((result) => result.mode));
  if (modes.size > 1) {
    throw new AggregationRefused(
      `refusing to aggregate across modes: ${[...modes].sort().join(', ')}. ` +
        'Simulated runs exercise the harness; they are not evidence of model capability.',
    );
  }

  const rubricVersions = new Set(results.map((result) => result.rubricVersion));
  if (rubricVersions.size > 1) {
    throw new AggregationRefused(
      `refusing to aggregate across rubric versions: ${[...rubricVersions].sort().join(', ')}`,
    );
  }

  const versionsById = new Map<string, Set<string>>();
  for (const result of results) {
    const versions = versionsById.get(result.benchmark.id) ?? new Set<string>();
    versions.add(result.benchmark.version);
    versionsById.set(result.benchmark.id, versions);
  }

  const conflicting = [...versionsById.entries()].filter(([, versions]) => versions.size > 1);
  if (conflicting.length > 0) {
    const detail = conflicting
      .map(([id, versions]) => `${id} (${[...versions].sort().join(', ')})`)
      .join('; ');
    throw new AggregationRefused(
      `refusing to aggregate across benchmark versions: ${detail}. ` +
        'A version bump means the fixture, goal or judges changed — those are different questions.',
    );
  }

  const mode = [...modes][0];
  const rubricVersion = [...rubricVersions][0];
  if (mode === undefined || rubricVersion === undefined) {
    throw new AggregationRefused('no results to aggregate');
  }

  return { mode, rubricVersion };
}

export function aggregate(results: readonly RunResult[], skipped = 0): Aggregate {
  const { mode, rubricVersion } = assertAggregatable(results);
  const scored = results.filter((result) => result.outcome === 'scored');

  if (scored.length === 0) {
    throw new AggregationRefused('no scored runs to aggregate (every run was skipped)');
  }

  const passed = scored.filter((result) => result.passed).length;
  const disqualified = scored.filter((result) => result.disqualified).length;

  const withTestJudges = scored.filter((result) =>
    result.judgeResults.some((judge) => judge.dimension === 'testCorrectness'),
  );
  const testsPassed = withTestJudges.filter((result) =>
    result.judgeResults
      .filter((judge) => judge.dimension === 'testCorrectness')
      .every((judge) => judge.status === 'passed'),
  ).length;

  const costs = scored
    .map((result) => result.usage.costUsd)
    .filter((cost): cost is number => cost !== null);
  const retries = scored
    .map((result) => result.retries)
    .filter((value): value is number => value !== null);
  const durations = scored.map((result) => result.durationMs);

  const byId = new Map<string, RunResult[]>();
  for (const result of scored) {
    const bucket = byId.get(result.benchmark.id) ?? [];
    bucket.push(result);
    byId.set(result.benchmark.id, bucket);
  }

  const perBenchmark: BenchmarkAggregate[] = [...byId.entries()]
    .map(([id, bucket]) => {
      const first = bucket[0];
      const bucketCosts = bucket
        .map((result) => result.usage.costUsd)
        .filter((cost): cost is number => cost !== null);

      return {
        id,
        version: first?.benchmark.version ?? 'unknown',
        category: first?.benchmark.category ?? 'unknown',
        runs: bucket.length,
        passed: bucket.filter((result) => result.passed).length,
        disqualified: bucket.filter((result) => result.disqualified).length,
        meanScore: round(
          bucket.reduce((sum, result) => sum + result.score, 0) / Math.max(1, bucket.length),
          2,
        ),
        meanDurationMs: Math.round(
          bucket.reduce((sum, result) => sum + result.durationMs, 0) / Math.max(1, bucket.length),
        ),
        meanCostUsd: mean(bucketCosts) === null ? null : round(mean(bucketCosts) ?? 0, 6),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    mode,
    rubricVersion,
    benchmarks: byId.size,
    runs: scored.length,
    skipped,
    completionRate: round(passed / scored.length),
    verifiedTestPassRate:
      withTestJudges.length === 0 ? 0 : round(testsPassed / withTestJudges.length),
    verifiedTestCoverage: { runsWithTestJudges: withTestJudges.length, runs: scored.length },
    securityViolationRate: round(disqualified / scored.length),
    disqualified,
    meanScore: round(scored.reduce((sum, result) => sum + result.score, 0) / scored.length, 2),
    meanCostUsd: mean(costs) === null ? null : round(mean(costs) ?? 0, 6),
    costCoverage: { reported: costs.length, runs: scored.length },
    medianDurationMs: Math.round(median(durations)),
    p95DurationMs: Math.round(percentile(durations, 0.95)),
    meanRetries: mean(retries) === null ? null : round(mean(retries) ?? 0, 3),
    retryCoverage: { reported: retries.length, runs: scored.length },
    resourceTerminations: scored.filter((result) => result.termination !== null).length,
    perBenchmark,
  };
}
