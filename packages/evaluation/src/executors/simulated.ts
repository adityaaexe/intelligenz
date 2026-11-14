/**
 * The simulated executor.
 *
 * It exists to prove the harness works without spending a cent: it walks the same
 * materialise → execute → judge → score → persist path as a real run, with a
 * deterministic scripted effect instead of a model.
 *
 * Two rules keep it from being mistaken for evidence:
 *
 *   - every result it produces carries `mode: 'simulated'`, `costUsd: null` and
 *     `costSource: 'simulated'`;
 *   - it writes a transcript that says SIMULATED in its first line, so the artifact it
 *     leaves behind cannot be quoted out of context either.
 *
 * It is a **harness self-test**, never a capability measurement.
 */

import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { writeText } from '../exec';
import type { Executor, ExecutorContext, ExecutorOutcome, ExecuteInput } from '../runner';
import type { Benchmark } from '../types';

export const SIMULATOR_ID = 'benchmark-simulator';
export const SIMULATOR_VERSION = '1.0.0';
export const SIMULATED_MODEL = 'simulated/deterministic';

interface SimulatedWrite {
  readonly path: string;
  readonly content: string;
}

interface Simulation {
  readonly benchmarkId: string;
  readonly benchmarkVersion: string;
  /** Informational: what the scripted agent does. Never used for scoring. */
  readonly outcome: 'solved' | 'refused' | 'violated' | 'noop';
  readonly note: string;
  readonly writes: readonly SimulatedWrite[];
  readonly artifacts: readonly SimulatedWrite[];
  readonly usage: { readonly tokensIn: number; readonly tokensOut: number };
  readonly toolInvocations: number;
  readonly retries: number;
}

export class SimulationError extends Error {
  readonly code = 'SIMULATION_INVALID';
}

function parseSimulation(raw: unknown, source: string): Simulation {
  const record = raw as Record<string, unknown> | null;

  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new SimulationError(`${source}: simulation must be an object`);
  }

  const string = (key: string): string => {
    const value = record[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new SimulationError(`${source}: ${key} must be a non-empty string`);
    }
    return value;
  };

  const writes = (key: string): SimulatedWrite[] => {
    const value = record[key];
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new SimulationError(`${source}: ${key} must be an array`);

    return value.map((entry, index) => {
      const item = entry as Record<string, unknown>;
      if (typeof item['path'] !== 'string' || typeof item['content'] !== 'string') {
        throw new SimulationError(`${source}: ${key}[${String(index)}] needs path and content`);
      }
      return { path: item['path'], content: item['content'] };
    });
  };

  const outcome = string('outcome');
  if (!['solved', 'refused', 'violated', 'noop'].includes(outcome)) {
    throw new SimulationError(`${source}: outcome must be solved, refused, violated or noop`);
  }

  const usage = record['usage'] as Record<string, unknown> | undefined;
  const toolInvocations = record['toolInvocations'];
  const retries = record['retries'];

  return {
    benchmarkId: string('benchmarkId'),
    benchmarkVersion: string('benchmarkVersion'),
    outcome: outcome as Simulation['outcome'],
    note: string('note'),
    writes: writes('writes'),
    artifacts: writes('artifacts'),
    usage: {
      tokensIn: typeof usage?.['tokensIn'] === 'number' ? usage['tokensIn'] : 0,
      tokensOut: typeof usage?.['tokensOut'] === 'number' ? usage['tokensOut'] : 0,
    },
    toolInvocations: typeof toolInvocations === 'number' ? toolInvocations : 0,
    retries: typeof retries === 'number' ? retries : 0,
  };
}

async function loadSimulation(suiteDir: string, benchmark: Benchmark): Promise<Simulation> {
  const path = join(suiteDir, 'simulations', `${benchmark.id}.json`);
  const text = await readFile(path, 'utf8').catch(() => {
    throw new SimulationError(
      `${path} is missing: simulated mode needs one script per benchmark and must not guess behaviour`,
    );
  });

  const simulation = parseSimulation(JSON.parse(text) as unknown, path);

  if (simulation.benchmarkId !== benchmark.id) {
    throw new SimulationError(
      `${path}: benchmarkId "${simulation.benchmarkId}" does not match "${benchmark.id}"`,
    );
  }

  if (simulation.benchmarkVersion !== benchmark.version) {
    throw new SimulationError(
      `${path}: benchmarkVersion "${simulation.benchmarkVersion}" does not match the benchmark ` +
        `version "${benchmark.version}". A version bump invalidates the script.`,
    );
  }

  return simulation;
}

/**
 * Resolve a scripted write inside the workspace.
 *
 * A simulation is repository data. It may create a file, and it may not traverse out of
 * the clone — the one place in this package where `..` in data could touch the host.
 */
function safeWritePath(root: string, path: string): string {
  if (isAbsolute(path)) {
    throw new SimulationError(`simulation path must be relative: ${path}`);
  }

  const resolved = resolve(root, path);
  const normalizedRoot = resolve(root);

  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}/`)) {
    throw new SimulationError(`simulation path escapes the workspace: ${path}`);
  }

  return resolved;
}

export class SimulatedExecutor implements Executor {
  readonly kind = 'simulated' as const;
  readonly runtimeId = SIMULATOR_ID;
  readonly runtimeVersion = SIMULATOR_VERSION;
  readonly model = SIMULATED_MODEL;

  private readonly suiteDir: string;

  constructor(options: { readonly suiteDir: string }) {
    this.suiteDir = options.suiteDir;
  }

  async prepare(context: ExecutorContext): Promise<void> {
    const directory = join(this.suiteDir, 'simulations');
    const entries = await readdir(directory).catch(() => [] as string[]);

    if (entries.length === 0) {
      throw new SimulationError(`${directory} contains no simulations`);
    }

    // Load and validate every script up front. A missing or stale simulation is a
    // harness configuration error, not a failed run: it must stop the suite before
    // run 1 rather than produce eight results that all say "the harness broke".
    for (const benchmark of context.benchmarks) {
      await loadSimulation(this.suiteDir, benchmark);
    }
  }

  async execute(input: ExecuteInput): Promise<ExecutorOutcome> {
    const simulation = await loadSimulation(this.suiteDir, input.benchmark);

    for (const write of simulation.writes) {
      await writeText(safeWritePath(input.repoPath, write.path), write.content);
    }

    for (const artifact of simulation.artifacts) {
      await writeText(safeWritePath(input.artifactsDir, artifact.path), artifact.content);
    }

    await writeText(
      join(input.artifactsDir, 'TRANSCRIPT.md'),
      [
        '# SIMULATED RUN',
        '',
        'No provider was contacted and no model produced this. The simulated executor',
        'applied a scripted effect so that the judging, scoring and persistence path could',
        'be exercised for free.',
        '',
        `benchmark: ${input.benchmark.id}@${input.benchmark.version}`,
        `script:    ${simulation.outcome} — ${simulation.note}`,
        '',
      ].join('\n'),
    );

    return {
      status: 'succeeded',
      summary: `[simulated] ${simulation.note}`,
      tokensIn: simulation.usage.tokensIn,
      tokensOut: simulation.usage.tokensOut,
      // Nothing was billed and nothing was reported. `null` is the honest value; a zero
      // here would be indistinguishable from a provider that reported zero.
      costUsd: null,
      costSource: 'simulated',
      retries: simulation.retries,
      toolInvocations: simulation.toolInvocations,
      refused: simulation.outcome === 'refused',
      termination: null,
      artifactDirs: [input.artifactsDir],
      error: null,
    };
  }
}
