/**
 * The result ledger.
 *
 * One JSON file per invocation, named `<timestamp>-<mode>.json`, under
 * `infra/benchmarks/results/` (gitignored). A committed report is a *rendering* of one
 * of these files — it is never hand-written, because a hand-written result is a claim.
 *
 * The file carries its own mode and suite fingerprint, so a reader does not have to
 * trust the filename.
 */

import { readFile } from 'node:fs/promises';

import { AggregationRefused, aggregate, assertAggregatable, type Aggregate } from './aggregate';
import { suiteFingerprint } from './benchmark';
import type { HookControlResult } from './fixture';
import type { SkippedRun } from './runner';
import type { RunMode, RunResult } from './types';

export const RESULTS_SCHEMA_VERSION = 1;

export interface ResultsFile {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly mode: RunMode;
  readonly rubricVersion: string;
  readonly suiteFingerprint: string;
  readonly results: readonly RunResult[];
  readonly skipped: readonly SkippedRun[];
  readonly controls: readonly HookControlResult[];
  readonly aggregate: Aggregate;
}

export class ResultsFileError extends Error {
  readonly code = 'RESULTS_INVALID';
}

/** `20261114T050000Z-simulated.json` — sortable, and the mode is in the name. */
export function resultsFileName(at: Date, mode: RunMode): string {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${stamp}-${mode}.json`;
}

export function buildResultsFile(input: {
  readonly mode: RunMode;
  readonly results: readonly RunResult[];
  readonly skipped: readonly SkippedRun[];
  readonly controls: readonly HookControlResult[];
  readonly at: Date;
}): ResultsFile {
  const { mode, rubricVersion } = assertAggregatable(input.results);

  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    generatedAt: input.at.toISOString(),
    mode,
    rubricVersion,
    // Derived from what was actually measured, including benchmarks that were skipped,
    // so the fingerprint can be re-checked against the file's own contents later.
    suiteFingerprint: suiteFingerprint([
      ...input.results.map((result) => result.benchmark),
      ...input.skipped.map((skip) => ({ id: skip.benchmarkId, version: skip.benchmarkVersion })),
    ]),
    results: input.results,
    skipped: input.skipped,
    controls: input.controls,
    aggregate: aggregate(input.results, input.skipped.length),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a persisted results file for re-aggregation.
 *
 * Deliberately shallow: it validates the fields aggregation *uses*, so a truncated or
 * hand-edited file is refused rather than averaged. It does not attempt to be a full
 * schema — the file was written by this package, and a reader that silently accepts a
 * missing `mode` is how simulated and real results end up in the same table.
 */
export async function readResultsFile(path: string): Promise<ResultsFile> {
  const text = await readFile(path, 'utf8').catch(() => {
    throw new ResultsFileError(`${path} is unreadable`);
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ResultsFileError(`${path} is not JSON: ${error instanceof Error ? error.message : ''}`);
  }

  if (!isRecord(parsed)) throw new ResultsFileError(`${path} is not a results object`);

  const results = parsed['results'];
  if (!Array.isArray(results) || results.length === 0) {
    throw new ResultsFileError(`${path} contains no results`);
  }

  for (const [index, entry] of results.entries()) {
    if (!isRecord(entry)) throw new ResultsFileError(`${path}: results[${String(index)}] is not an object`);
    if (entry['mode'] !== 'simulated' && entry['mode'] !== 'real') {
      throw new ResultsFileError(`${path}: results[${String(index)}].mode is not simulated|real`);
    }
    if (typeof entry['rubricVersion'] !== 'string') {
      throw new ResultsFileError(`${path}: results[${String(index)}].rubricVersion is missing`);
    }
    const benchmark = entry['benchmark'];
    if (!isRecord(benchmark) || typeof benchmark['id'] !== 'string' || typeof benchmark['version'] !== 'string') {
      throw new ResultsFileError(`${path}: results[${String(index)}].benchmark is malformed`);
    }
  }

  const mode = parsed['mode'];
  if (mode !== 'simulated' && mode !== 'real') {
    throw new ResultsFileError(`${path}: mode is not simulated|real`);
  }

  return parsed as unknown as ResultsFile;
}

/**
 * Re-aggregate a file, refusing exactly as a fresh run would — plus one check that only
 * applies to a file: its recorded suite fingerprint must match the runs it contains.
 *
 * Without it, a file assembled from two different runs of the suite (or hand-edited to
 * bump one benchmark) aggregates happily, because each benchmark appears once and there
 * is nothing left to conflict with.
 */
export function reaggregate(file: ResultsFile): Aggregate {
  // Coherence first: a set that mixes versions is refused before anything else is said
  // about it, because the version list is the diagnosis a reader needs.
  assertAggregatable(file.results);

  const recorded = suiteFingerprint([
    ...file.results.map((result) => result.benchmark),
    ...file.skipped.map((skip) => ({ id: skip.benchmarkId, version: skip.benchmarkVersion })),
  ]);

  if (file.suiteFingerprint.length > 0 && recorded !== file.suiteFingerprint) {
    throw new AggregationRefused(
      'refusing to aggregate: the file\'s suite fingerprint disagrees with its own results. ' +
        'It was edited, or assembled from runs of different suite versions.\n' +
        `  recorded: ${file.suiteFingerprint.split('\n').join(' ')}` +
        `  contents: ${recorded.split('\n').join(' ')}`,
    );
  }

  try {
    return aggregate(file.results, file.skipped.length);
  } catch (error) {
    if (error instanceof AggregationRefused) throw error;
    throw new ResultsFileError(error instanceof Error ? error.message : String(error));
  }
}
