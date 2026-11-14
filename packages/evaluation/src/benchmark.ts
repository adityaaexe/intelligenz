/**
 * Reading and validating a `BENCHMARK.json`.
 *
 * The schema is hand-written rather than pulled from `zod` for one reason: this
 * package must add **no** runtime dependency. `zod` is resolvable inside the
 * packages that declare it, not from here, and adding it would mean touching the
 * lockfile while other units are mid-install. A hundred lines of explicit
 * validation with paths in the error messages is the cheaper trade.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';

import {
  BENCHMARK_CATEGORIES,
  JUDGE_DIMENSIONS,
  type Benchmark,
  type BenchmarkCategory,
  type BenchmarkLimits,
  type Judge,
  type JudgeDimension,
  type NegativeControl,
  type PolicyExpectation,
} from './types';

export class BenchmarkError extends Error {
  readonly code = 'BENCHMARK_INVALID';
  readonly source: string;

  constructor(source: string, message: string) {
    super(`${source}: ${message}`);
    this.name = 'BenchmarkError';
    this.source = source;
  }
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, source: string, path: string): Json {
  if (!isObject(value)) throw new BenchmarkError(source, `${path} must be an object`);
  return value;
}

function requireString(value: unknown, source: string, path: string, min = 1): string {
  if (typeof value !== 'string' || value.trim().length < min) {
    throw new BenchmarkError(source, `${path} must be a string of at least ${String(min)} characters`);
  }
  return value;
}

function requireInteger(value: unknown, source: string, path: string, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new BenchmarkError(source, `${path} must be an integer >= ${String(min)}`);
  }
  return value;
}

function requireNonNegativeNumber(value: unknown, source: string, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new BenchmarkError(source, `${path} must be a finite number >= 0`);
  }
  return value;
}

function requireArray(value: unknown, source: string, path: string, min: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < min) {
    throw new BenchmarkError(source, `${path} must be an array of at least ${String(min)} entries`);
  }
  return value;
}

function requireOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  source: string,
  path: string,
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new BenchmarkError(source, `${path} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function optionalDimension(value: unknown, source: string, path: string): JudgeDimension | undefined {
  if (value === undefined) return undefined;
  return requireOneOf(value, JUDGE_DIMENSIONS, source, path);
}

/**
 * A fixture path is a directory under `infra/benchmarks/fixtures`, never a path. This
 * rejects `..`, absolute paths and separators — a benchmark file is data, and data
 * does not get to name a directory outside the suite.
 */
function requireFixtureSlug(value: unknown, source: string): string {
  const slug = requireString(value, source, 'fixture');
  if (slug.includes('/') || slug.includes('\\') || slug.includes('..') || isAbsolute(slug)) {
    throw new BenchmarkError(source, 'fixture must be a single directory name, not a path');
  }
  if (!KEBAB.test(slug)) throw new BenchmarkError(source, 'fixture must be kebab-case');
  return slug;
}

function parseJudge(raw: unknown, source: string, path: string): Judge {
  const judge = requireObject(raw, source, path);
  const type = requireString(judge['type'], source, `${path}.type`);
  const dimension = optionalDimension(judge['dimension'], source, `${path}.dimension`);

  switch (type) {
    case 'command': {
      const argv = requireArray(judge['argv'], source, `${path}.argv`, 1).map((entry, index) => {
        return requireString(entry, source, `${path}.argv[${String(index)}]`);
      });
      const expectExit = requireInteger(judge['expectExit'], source, `${path}.expectExit`, 0);
      const timeoutMs = judge['timeoutMs'];
      return {
        type: 'command',
        argv,
        expectExit,
        ...(dimension === undefined ? {} : { dimension }),
        ...(timeoutMs === undefined
          ? {}
          : { timeoutMs: requireInteger(timeoutMs, source, `${path}.timeoutMs`, 1) }),
      };
    }
    case 'file-equals': {
      const digest = requireString(judge['sha256'], source, `${path}.sha256`).toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(digest)) {
        throw new BenchmarkError(source, `${path}.sha256 must be 64 lowercase hex characters`);
      }
      return {
        type: 'file-equals',
        path: requireString(judge['path'], source, `${path}.path`),
        sha256: digest,
        ...(dimension === undefined ? {} : { dimension }),
      };
    }
    case 'file-absent':
      return {
        type: 'file-absent',
        path: requireString(judge['path'], source, `${path}.path`),
        ...(dimension === undefined ? {} : { dimension }),
      };
    case 'grep': {
      const pattern = requireString(judge['pattern'], source, `${path}.pattern`);
      try {
        // Validate at load time, not at judging time: a broken rubric should fail the
        // suite before a cent is spent.
        new RegExp(pattern, 'm');
      } catch {
        throw new BenchmarkError(source, `${path}.pattern is not a valid regular expression`);
      }
      return {
        type: 'grep',
        path: requireString(judge['path'], source, `${path}.path`),
        pattern,
        expect: requireOneOf(judge['expect'], ['present', 'absent'] as const, source, `${path}.expect`),
        ...(dimension === undefined ? {} : { dimension }),
      };
    }
    case 'diff-files':
      return {
        type: 'diff-files',
        maxChanged: requireInteger(judge['maxChanged'], source, `${path}.maxChanged`, 0),
        ...(dimension === undefined ? {} : { dimension }),
      };
    default:
      throw new BenchmarkError(source, `${path}.type "${type}" is not a known judge type`);
  }
}

function parseNegativeControl(raw: unknown, source: string): NegativeControl {
  const control = requireObject(raw, source, 'negativeControl');
  const kind = requireOneOf(control['kind'], ['git-hook'] as const, source, 'negativeControl.kind');
  const markerPaths = requireArray(control['markerPaths'], source, 'negativeControl.markerPaths', 1).map(
    (entry, index) => requireString(entry, source, `negativeControl.markerPaths[${String(index)}]`),
  );
  return { kind, markerPaths };
}

/**
 * Validate one benchmark document. `source` is used in every message, so a broken
 * `BENCHMARK.json` in a suite of eight says which one.
 */
export function parseBenchmark(raw: unknown, source: string): Benchmark {
  const document = requireObject(raw, source, 'benchmark');

  const id = requireString(document['id'], source, 'id');
  if (!KEBAB.test(id)) throw new BenchmarkError(source, 'id must be kebab-case');

  const version = requireString(document['version'], source, 'version');
  if (!SEMVER.test(version)) throw new BenchmarkError(source, 'version must be semver (e.g. 1.0.0)');

  const category = requireOneOf<BenchmarkCategory>(
    document['category'],
    BENCHMARK_CATEGORIES,
    source,
    'category',
  );
  const fixture = requireFixtureSlug(document['fixture'], source);
  const goal = requireString(document['goal'], source, 'goal', 10);

  const setupRaw = document['setup'];
  const setup =
    setupRaw === undefined
      ? undefined
      : requireArray(setupRaw, source, 'setup', 1).map((entry, index) =>
          requireString(entry, source, `setup[${String(index)}]`),
        );

  const judge = requireArray(document['judge'], source, 'judge', 1).map((entry, index) =>
    parseJudge(entry, source, `judge[${String(index)}]`),
  );

  const limitsRaw = requireObject(document['limits'], source, 'limits');
  const limits: BenchmarkLimits = {
    wallClockMs: requireInteger(limitsRaw['wallClockMs'], source, 'limits.wallClockMs', 1000),
    maxUsd: requireNonNegativeNumber(limitsRaw['maxUsd'], source, 'limits.maxUsd'),
  };

  const policyExpectation: PolicyExpectation = requireOneOf(
    document['policyExpectation'],
    ['no-violation', 'must-refuse'] as const,
    source,
    'policyExpectation',
  );

  const description = document['description'];

  const negativeControl = document['negativeControl'];

  return {
    id,
    version,
    category,
    fixture,
    goal,
    ...(setup === undefined ? {} : { setup }),
    judge,
    limits,
    policyExpectation,
    ...(description === undefined
      ? {}
      : { description: requireString(description, source, 'description') }),
    ...(negativeControl === undefined
      ? {}
      : { negativeControl: parseNegativeControl(negativeControl, source) }),
  };
}

/** Read and validate `BENCHMARK.json` from a fixture directory. */
export async function loadBenchmarkDefinition(fixtureDir: string): Promise<Benchmark> {
  const path = join(fixtureDir, 'BENCHMARK.json');
  let text: string;

  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new BenchmarkError(path, 'BENCHMARK.json is missing or unreadable');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new BenchmarkError(path, `not valid JSON: ${error instanceof Error ? error.message : 'unknown'}`);
  }

  return parseBenchmark(parsed, path);
}

/**
 * The judge's dimension, resolved once so scoring and reporting never disagree.
 *
 * The inference exists for convenience only; every shipped benchmark states it.
 */
export function judgeDimension(judge: Judge): JudgeDimension {
  if (judge.dimension !== undefined) return judge.dimension;

  switch (judge.type) {
    case 'command': {
      const head = judge.argv[0] ?? '';
      const testish = /(^|\/)(node|npx|npm|pnpm|yarn|vitest|jest|pytest|cargo|go)$/.test(head)
        ? judge.argv.some((arg) => /--test|(^|\/)test$|vitest|jest|pytest/.test(arg))
        : false;
      return testish ? 'testCorrectness' : 'completion';
    }
    case 'file-equals':
      return 'artifactIntegrity';
    case 'file-absent':
      return 'policyCompliance';
    case 'grep':
      return 'completion';
    case 'diff-files':
      return 'diffQuality';
  }
}

/**
 * A stable fingerprint of the suite's identity.
 *
 * Two results files with the same fingerprint measured the same questions, which is
 * what makes comparing them meaningful. It changes when any benchmark id or version
 * changes — and an aggregator refuses to combine results whose versions differ.
 */
export function suiteFingerprint(
  benchmarks: readonly { readonly id: string; readonly version: string }[],
): string {
  const canonical = [...new Set(benchmarks.map((benchmark) => `${benchmark.id}@${benchmark.version}`))]
    .sort()
    .join('\n');
  return canonical;
}

/** Normalise a fixture-relative path for display without letting it escape. */
export function fixtureDirectory(suiteDir: string, benchmark: Benchmark): string {
  const resolved = normalize(join(suiteDir, 'fixtures', benchmark.fixture));
  const root = normalize(join(suiteDir, 'fixtures'));

  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new BenchmarkError(benchmark.id, 'fixture resolves outside the fixtures directory');
  }

  return resolved;
}
