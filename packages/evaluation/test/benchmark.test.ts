import { describe, expect, it } from 'vitest';

import { BenchmarkError, judgeDimension, parseBenchmark, suiteFingerprint } from '../src/benchmark';
import type { Judge } from '../src/types';

function valid(): Record<string, unknown> {
  return {
    id: 'example-benchmark',
    version: '1.0.0',
    category: 'engineering',
    fixture: 'example-benchmark',
    description: 'A benchmark used to test the validator.',
    goal: 'Fix the thing in src/thing.js and run the test suite.',
    judge: [{ type: 'command', argv: ['node', '--test'], expectExit: 0 }],
    limits: { wallClockMs: 60_000, maxUsd: 0.01 },
    policyExpectation: 'no-violation',
  };
}

describe('benchmark validation', () => {
  it('accepts a well-formed definition', () => {
    const benchmark = parseBenchmark(valid(), 'test');

    expect(benchmark.id).toBe('example-benchmark');
    expect(benchmark.setup).toBeUndefined();
    expect(benchmark.judge).toHaveLength(1);
  });

  it('rejects a non-kebab id', () => {
    expect(() => parseBenchmark({ ...valid(), id: 'Not_Kebab' }, 'test')).toThrow(BenchmarkError);
  });

  it('rejects a non-semver version', () => {
    expect(() => parseBenchmark({ ...valid(), version: 'v1' }, 'test')).toThrow(/semver/);
  });

  it('rejects a fixture that is a path rather than a directory name', () => {
    expect(() => parseBenchmark({ ...valid(), fixture: '../etc' }, 'test')).toThrow(BenchmarkError);
  });

  it('rejects an invalid grep pattern at load time', () => {
    expect(() =>
      parseBenchmark(
        {
          ...valid(),
          judge: [{ type: 'grep', path: 'a.txt', pattern: '([', expect: 'present' }],
        },
        'test',
      ),
    ).toThrow(/regular expression/);
  });

  it('rejects an unknown judge type', () => {
    expect(() =>
      parseBenchmark({ ...valid(), judge: [{ type: 'llm-judge' }] }, 'test'),
    ).toThrow(/not a known judge type/);
  });

  it('rejects a malformed sha256', () => {
    expect(() =>
      parseBenchmark(
        { ...valid(), judge: [{ type: 'file-equals', path: 'a', sha256: 'deadbeef' }] },
        'test',
      ),
    ).toThrow(/sha256/);
  });

  it('requires at least one judge', () => {
    expect(() => parseBenchmark({ ...valid(), judge: [] }, 'test')).toThrow(/judge/);
  });

  it('rejects an unknown policy expectation', () => {
    expect(() => parseBenchmark({ ...valid(), policyExpectation: 'maybe' }, 'test')).toThrow(
      /policyExpectation/,
    );
  });
});

describe('judge dimension inference', () => {
  it('infers testCorrectness for a test runner command', () => {
    const judge: Judge = { type: 'command', argv: ['node', '--test'], expectExit: 0 };
    expect(judgeDimension(judge)).toBe('testCorrectness');
  });

  it('infers completion for a non-test command', () => {
    const judge: Judge = { type: 'command', argv: ['node', '-e', 'process.exit(0)'], expectExit: 0 };
    expect(judgeDimension(judge)).toBe('completion');
  });

  it('prefers an explicit dimension', () => {
    const judge: Judge = { type: 'file-absent', path: 'x', dimension: 'completion' };
    expect(judgeDimension(judge)).toBe('completion');
  });

  it('defaults by judge type', () => {
    expect(judgeDimension({ type: 'file-equals', path: 'x', sha256: 'a'.repeat(64) })).toBe(
      'artifactIntegrity',
    );
    expect(judgeDimension({ type: 'diff-files', maxChanged: 1 })).toBe('diffQuality');
    expect(judgeDimension({ type: 'file-absent', path: 'x' })).toBe('policyCompliance');
    expect(judgeDimension({ type: 'grep', path: 'x', pattern: 'a', expect: 'present' })).toBe(
      'completion',
    );
  });
});

describe('suite fingerprint', () => {
  it('is order independent and version sensitive', () => {
    const left = suiteFingerprint([
      { id: 'a', version: '1.0.0' },
      { id: 'b', version: '1.0.0' },
    ]);
    const right = suiteFingerprint([
      { id: 'b', version: '1.0.0' },
      { id: 'a', version: '1.0.0' },
    ]);
    const bumped = suiteFingerprint([
      { id: 'a', version: '1.0.1' },
      { id: 'b', version: '1.0.0' },
    ]);

    expect(left).toBe(right);
    expect(left).not.toBe(bumped);
  });
});
