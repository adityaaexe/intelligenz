import { describe, expect, it } from 'vitest';

import { AggregationRefused } from '../src/aggregate';
import { RUBRIC_VERSION } from '../src/rubric';
import { buildResultsFile, reaggregate, resultsFileName } from '../src/results';
import type { RunResult } from '../src/types';

function run(overrides: { id?: string; version?: string } = {}): RunResult {
  const id = overrides.id ?? 'minimal-diff';

  return {
    schemaVersion: 1,
    runId: `${id}-1`,
    outcome: 'scored',
    skipReason: null,
    mode: 'simulated',
    benchmark: {
      id,
      version: overrides.version ?? '1.0.0',
      category: 'efficiency',
      policyExpectation: 'no-violation',
      fixture: id,
      description: null,
    },
    rubricVersion: RUBRIC_VERSION,
    runtime: { id: 'benchmark-simulator', version: '1.0.0', model: 'simulated/deterministic' },
    fixtureCommit: 'a'.repeat(40),
    startedAt: '2026-11-14T00:00:00.000Z',
    durationMs: 1,
    totalMs: 2,
    usage: { tokensIn: 1, tokensOut: 1, costUsd: null, costSource: 'simulated' },
    retries: 0,
    toolInvocations: 1,
    status: 'succeeded',
    termination: null,
    refused: false,
    judgeResults: [],
    dimensions: {
      completion: { weight: 40, earned: 0, judged: 0 },
      testCorrectness: { weight: 25, earned: 0, judged: 0 },
      diffQuality: { weight: 15, earned: 0, judged: 0 },
      policyCompliance: { weight: 10, earned: 0, judged: 0 },
      artifactIntegrity: { weight: 10, earned: 0, judged: 0 },
    },
    score: 100,
    passed: true,
    disqualified: false,
    disqualificationReason: null,
    securityEvents: [],
    artifacts: { changed: [], adapter: [], changeSetSha256: '' },
    environment: { node: 'v22', platform: 'linux', git: null },
    error: null,
  };
}

function file(results: readonly RunResult[]) {
  return buildResultsFile({
    mode: 'simulated',
    results,
    skipped: [],
    controls: [],
    at: new Date('2026-11-14T00:00:00.000Z'),
  });
}

describe('results ledger', () => {
  it('names files so the mode is in the name and sorting is chronological', () => {
    const name = resultsFileName(new Date('2026-11-14T05:04:03.123Z'), 'simulated');
    expect(name).toBe('20261114T050403Z-simulated.json');
  });

  it('records the mode and a fingerprint that matches its own results', () => {
    const built = file([run()]);

    expect(built.mode).toBe('simulated');
    expect(built.suiteFingerprint).toBe('minimal-diff@1.0.0');
    expect(reaggregate(built).runs).toBe(1);
  });

  it('refuses a file whose fingerprint disagrees with its contents', () => {
    const built = file([run()]);
    const tampered = { ...built, suiteFingerprint: 'minimal-diff@1.0.0 other@2.0.0' };

    expect(() => reaggregate(tampered)).toThrow(/fingerprint disagrees/);
  });

  it('refuses to build a file from two versions of one benchmark', () => {
    expect(() => file([run(), run({ version: '1.0.1' })])).toThrow(AggregationRefused);
  });

  it('refuses a hand-assembled file that mixes versions of one benchmark', () => {
    // This is the case the CLI demonstrates: a file can be assembled from two runs of
    // different suite versions, and each benchmark then appears exactly once — so the
    // per-file version guard is the only thing that can catch it.
    const built = file([run()]);
    const mixed = { ...built, results: [run(), run({ version: '1.0.1' })] };

    expect(() => reaggregate(mixed)).toThrow(/benchmark versions/);
  });
});
