/**
 * Loading a suite from disk.
 *
 * The suite is whatever `infra/benchmarks/fixtures/*` contains a `BENCHMARK.json` for.
 * Ordering is by id so a run is reproducible; a fixture directory without a definition
 * is an error, because a fixture nobody runs is a fixture that rots.
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { BenchmarkError, loadBenchmarkDefinition } from './benchmark';
import type { Benchmark } from './types';

export async function loadSuite(suiteDir: string): Promise<readonly Benchmark[]> {
  const fixturesDir = join(suiteDir, 'fixtures');
  const entries = await readdir(fixturesDir, { withFileTypes: true }).catch(() => {
    throw new BenchmarkError(fixturesDir, 'fixtures directory is missing');
  });

  const benchmarks: Benchmark[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const directory = join(fixturesDir, entry.name);
    const definition = join(directory, 'BENCHMARK.json');
    const exists = await stat(definition)
      .then((value) => value.isFile())
      .catch(() => false);

    if (!exists) {
      throw new BenchmarkError(directory, 'fixture directory has no BENCHMARK.json');
    }

    const benchmark = await loadBenchmarkDefinition(directory);

    if (benchmark.fixture !== entry.name) {
      throw new BenchmarkError(
        definition,
        `fixture is "${benchmark.fixture}" but the directory is "${entry.name}"`,
      );
    }

    benchmarks.push(benchmark);
  }

  const seen = new Set<string>();
  for (const benchmark of benchmarks) {
    if (seen.has(benchmark.id)) throw new BenchmarkError(benchmark.id, 'duplicate benchmark id');
    seen.add(benchmark.id);
  }

  return benchmarks.sort((left, right) => left.id.localeCompare(right.id));
}

export async function selectBenchmarks(
  suiteDir: string,
  selector: string,
): Promise<readonly Benchmark[]> {
  const all = await loadSuite(suiteDir);

  if (selector === 'all') return all;

  const selected = all.filter((benchmark) => benchmark.id === selector);

  if (selected.length === 0) {
    throw new BenchmarkError(
      selector,
      `no benchmark with that id. Available: ${all.map((benchmark) => benchmark.id).join(', ')}`,
    );
  }

  return selected;
}
