/**
 * The evaluation CLI.
 *
 *   npx tsx infra/scripts/eval.ts --benchmark all --mode simulated --runs 1
 *   npx tsx infra/scripts/eval.ts --benchmark fix-failing-test --mode real --runs 1 --cap-usd 0.05
 *   npx tsx infra/scripts/eval.ts --from infra/benchmarks/results/<file>.json
 *
 * Simulated is the default and is labelled everywhere it could be quoted: in the banner,
 * on every run line, in the JSON (`mode: "simulated"`, `costUsd: null`) and in the
 * Markdown. `--mode real` refuses to start without `AGENT_MODEL` and an explicit
 * `--cap-usd`, because a real run that is not capped is a run that can spend money
 * nobody authorised.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AggregationRefused,
  BenchmarkError,
  RealExecutor,
  RuntimeUnavailableError,
  SimulatedExecutor,
  aggregate,
  buildResultsFile,
  reaggregate,
  readResultsFile,
  realExecutorOptionsFromEnv,
  renderReport,
  resultsFileName,
  runSuite,
  selectBenchmarks,
  suiteFingerprint,
  type Executor,
  type RunMode,
  type RunResult,
  type SkippedRun,
  type SuiteEvent,
} from '../../packages/evaluation/src/index.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_SUITE = join(REPO_ROOT, 'infra/benchmarks');

const out = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

const rule = (char = '─'): void => out(char.repeat(78));

interface Arguments {
  readonly benchmark: string;
  readonly mode: RunMode;
  readonly runs: number;
  readonly capUsd: number | null;
  readonly suiteDir: string;
  readonly out: string | null;
  readonly from: string | null;
  readonly keep: boolean;
}

class UsageError extends Error {
  readonly code = 'USAGE';
}

function parseArguments(argv: readonly string[]): Arguments {
  let benchmark = 'all';
  let mode: RunMode = 'simulated';
  let runs = 1;
  let capUsd: number | null = null;
  let suiteDir = DEFAULT_SUITE;
  let outPath: string | null = null;
  let from: string | null = null;
  let keep = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];

    const next = (): string => {
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`${String(flag)} needs a value`);
      }
      index += 1;
      return value;
    };

    switch (flag) {
      case '--benchmark':
        benchmark = next();
        break;
      case '--mode': {
        const candidate = next();
        if (candidate !== 'simulated' && candidate !== 'real') {
          throw new UsageError('--mode must be simulated or real');
        }
        mode = candidate;
        break;
      }
      case '--runs': {
        const candidate = Number(next());
        if (!Number.isInteger(candidate) || candidate < 1) {
          throw new UsageError('--runs must be a positive integer');
        }
        runs = candidate;
        break;
      }
      case '--cap-usd': {
        const candidate = Number(next());
        if (!Number.isFinite(candidate) || candidate <= 0) {
          throw new UsageError('--cap-usd must be a positive number of dollars');
        }
        capUsd = candidate;
        break;
      }
      case '--suite':
        suiteDir = resolve(next());
        break;
      case '--out':
        outPath = resolve(next());
        break;
      case '--from':
        from = resolve(next());
        break;
      case '--keep':
        keep = true;
        break;
      case '--help':
        out(HELP);
        process.exit(0);
        break;
      default:
        throw new UsageError(`unknown argument: ${String(flag)}`);
    }
  }

  return { benchmark, mode, runs, capUsd, suiteDir, out: outPath, from, keep };
}

const HELP = `
Evaluation harness

  --benchmark <id|all>   which benchmark to run (default: all)
  --mode <mode>          simulated (default) | real
  --runs <n>             runs per benchmark (default: 1)
  --cap-usd <x>          hard spend ceiling; required for --mode real
  --suite <dir>          suite directory (default: infra/benchmarks)
  --out <path>           write the Markdown report here
  --from <results.json>  re-aggregate a persisted result file instead of running
  --keep                 keep the disposable workspaces

Simulated mode exercises the harness with a deterministic scripted effect. It is not
evidence of model capability and is labelled as such everywhere.
`.trim();

function modeBanner(mode: RunMode): void {
  rule('═');
  out(`INTELLIGENZ evaluation — mode ${mode.toUpperCase()}`);
  rule('═');

  if (mode === 'simulated') {
    out('SIMULATED — deterministic harness self-test. No model is contacted.');
    out('These results are NOT evidence of model capability and must never be quoted');
    out('as a real result. Every row carries mode="simulated" and costUsd=null.');
  } else {
    out('REAL — runs against the configured provider. Cost is provider-reported or null.');
  }

  out();
}

function printEvent(event: SuiteEvent): void {
  switch (event.type) {
    case 'benchmark-start':
      out();
      out(`▸ ${event.benchmark.id}@${event.benchmark.version} (${event.benchmark.category})`);
      break;
    case 'run-start':
      out(`  run ${String(event.runIndex)} …`);
      break;
    case 'run-skipped':
      out(`  skipped: ${event.reason}`);
      break;
    case 'control':
      out(
        `  control ${event.control.kind}: ${
          event.control.fired ? 'fires on the host (fixture is live)' : 'DID NOT FIRE — fixture unusable'
        }`,
      );
      break;
    case 'run-finish': {
      const result = event.result;
      const judges = result.judgeResults;
      const passedJudges = judges.filter((judge) => judge.status === 'passed').length;
      const tests = judges.filter((judge) => judge.dimension === 'testCorrectness');

      out(`    status      ${result.status}${result.error === null ? '' : ` (${result.error.code})`}`);
      out(
        `    judges      ${String(passedJudges)}/${String(judges.length)} passed` +
          (tests.length === 0
            ? ''
            : `   tests: ${tests.every((judge) => judge.status === 'passed') ? 'verified passing' : 'failing'}`),
      );
      out(`    score       ${result.score.toFixed(2)}${result.passed ? '   passed' : ''}`);
      if (result.disqualified) {
        out(`    DISQUALIFIED  ${result.disqualificationReason ?? 'security violation'}`);
      }
      out(`    duration    ${String(result.durationMs)}ms (total ${String(result.totalMs)}ms)`);
      out(
        `    cost        ${
          result.usage.costSource === 'simulated'
            ? 'n/a (simulated)'
            : result.usage.costUsd === null
              ? 'n/a (unreported)'
              : `$${result.usage.costUsd.toFixed(6)} (provider)`
        }`,
      );
      out(
        `    tokens      in=${result.usage.tokensIn === null ? 'n/a' : String(result.usage.tokensIn)} out=${
          result.usage.tokensOut === null ? 'n/a' : String(result.usage.tokensOut)
        }   tools=${String(result.toolInvocations)}   retries=${
          result.retries === null ? 'n/a' : String(result.retries)
        }`,
      );
      out(`    fixture     ${result.fixtureCommit.slice(0, 12)}`);
      break;
    }
  }
}

function printAggregate(results: readonly RunResult[], skipped: readonly SkippedRun[]): void {
  const summary = aggregate(results, skipped.length);

  out();
  rule();
  out(`AGGREGATE  mode=${summary.mode}  rubric=${summary.rubricVersion}`);
  rule();

  const rows: [string, string][] = [
    ['benchmarks', String(summary.benchmarks)],
    ['runs', `${String(summary.runs)}${summary.skipped > 0 ? ` (+${String(summary.skipped)} skipped)` : ''}`],
    ['completion rate', `${(summary.completionRate * 100).toFixed(1)}%`],
    [
      'verified test pass rate',
      `${(summary.verifiedTestPassRate * 100).toFixed(1)}%  (${String(summary.verifiedTestCoverage.runsWithTestJudges)}/${String(summary.verifiedTestCoverage.runs)} runs carried a test judge)`,
    ],
    [
      'security violation rate',
      `${(summary.securityViolationRate * 100).toFixed(1)}%  (${String(summary.disqualified)} disqualified)`,
    ],
    ['mean score', summary.meanScore.toFixed(2)],
    [
      'mean cost',
      `${summary.meanCostUsd === null ? 'n/a' : `$${summary.meanCostUsd.toFixed(6)}`}  (${String(summary.costCoverage.reported)}/${String(summary.costCoverage.runs)} runs reported)`,
    ],
    ['median duration', `${String(summary.medianDurationMs)}ms`],
    ['p95 duration', `${String(summary.p95DurationMs)}ms`],
    [
      'mean retries',
      `${summary.meanRetries === null ? 'n/a' : summary.meanRetries.toFixed(3)}  (${String(summary.retryCoverage.reported)}/${String(summary.retryCoverage.runs)} runs reported)`,
    ],
    ['resource terminations', String(summary.resourceTerminations)],
  ];

  for (const [label, value] of rows) out(`  ${label.padEnd(26)} ${value}`);

  out();
  out('  per benchmark');
  for (const entry of summary.perBenchmark) {
    out(
      `    ${entry.id.padEnd(30)} score ${entry.meanScore.toFixed(2).padStart(6)}   ` +
        `passed ${String(entry.passed)}/${String(entry.runs)}   disq ${String(entry.disqualified)}`,
    );
  }
}

async function main(): Promise<void> {
  let args: Arguments;

  try {
    args = parseArguments(process.argv.slice(2));
  } catch (error) {
    out(`refused: ${error instanceof Error ? error.message : String(error)}`);
    out();
    out(HELP);
    process.exitCode = 1;
    return;
  }

  // Re-aggregation: no runs, just the refusals and the report.
  if (args.from !== null) {
    try {
      const file = await readResultsFile(args.from);
      const summary = reaggregate(file);
      const report = renderReport({
        results: file.results,
        skipped: file.skipped,
        controls: file.controls,
        aggregate: summary,
        generatedAt: new Date(file.generatedAt),
        suiteFingerprint: file.suiteFingerprint,
        node: process.version,
      });

      if (args.out !== null) {
        await mkdir(dirname(args.out), { recursive: true });
        await writeFile(args.out, report, 'utf8');
        out(`report written to ${args.out}`);
      } else {
        process.stdout.write(report);
      }

      return;
    } catch (error) {
      if (error instanceof AggregationRefused) {
        out();
        rule('═');
        out('REFUSED');
        rule('═');
        out(error.message);
        out();
        process.exitCode = 1;
        return;
      }

      throw error;
    }
  }

  modeBanner(args.mode);

  let benchmarks;
  try {
    benchmarks = await selectBenchmarks(args.suiteDir, args.benchmark);
  } catch (error) {
    if (error instanceof BenchmarkError) {
      out(`refused: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  let executor: Executor;
  let runtimeNote: string;

  if (args.mode === 'simulated') {
    executor = new SimulatedExecutor({ suiteDir: args.suiteDir });
    runtimeNote = 'benchmark-simulator 1.0.0 (scripted, deterministic)';
  } else {
    if (args.capUsd === null) {
      out('refused: --mode real requires an explicit --cap-usd. An uncapped real run is an');
      out('unauthorised spend, not a measurement.');
      process.exitCode = 1;
      return;
    }

    if ((process.env['AGENT_MODEL'] ?? '').trim().length === 0) {
      out();
      rule('═');
      out('REAL BASELINE BLOCKED');
      rule('═');
      out('reason: AGENT_MODEL is not set. Real mode will not guess a model id, and a');
      out('baseline produced without one would not be reproducible.');
      out();
      process.exitCode = 2;
      return;
    }

    try {
      const options = realExecutorOptionsFromEnv(process.env);
      executor = new RealExecutor(options);
      runtimeNote = `opencode-cli model=${options.model} upstream=${options.upstreamBaseUrl}`;
    } catch (error) {
      if (error instanceof RuntimeUnavailableError) {
        out(`refused: ${error.message}`);
        process.exitCode = 2;
        return;
      }
      throw error;
    }
  }

  out(`suite           ${args.suiteDir}`);
  out(`benchmarks      ${benchmarks.map((benchmark) => benchmark.id).join(', ')}`);
  out(`runs            ${String(args.runs)} per benchmark`);
  out(`runtime         ${runtimeNote}`);
  out(`cap             ${args.capUsd === null ? 'none needed (simulated)' : `$${args.capUsd.toFixed(2)}`}`);
  out(`fingerprint     ${suiteFingerprint(benchmarks).split('\n').join(' ')}`);

  // Short, and outside the repository: a real adapter nests a unix socket under this
  // path and a socket path is limited to 108 bytes. `--keep` retains it for inspection.
  const workRoot = await mkdtemp(join(tmpdir(), 'iz-eval-'));
  out(`work root       ${workRoot}`);

  let outcome;
  try {
    outcome = await runSuite({
      suiteDir: args.suiteDir,
      benchmarks,
      mode: args.mode,
      runs: args.runs,
      capUsd: args.capUsd,
      executor,
      workRoot,
      keepWorkspaces: args.keep,
      onEvent: printEvent,
    });
  } catch (error) {
    if (error instanceof RuntimeUnavailableError) {
      out();
      rule('═');
      out(`REAL BASELINE BLOCKED`);
      rule('═');
      out(`reason: ${error.message}`);
      out();
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  if (outcome.results.length === 0) {
    out('no runs were scored; nothing to aggregate.');
    process.exitCode = 1;
    return;
  }

  const summary = aggregate(outcome.results, outcome.skipped.length);
  printAggregate(outcome.results, outcome.skipped);

  const generatedAt = new Date();
  const resultsDir = join(args.suiteDir, 'results');
  const jsonPath = join(resultsDir, resultsFileName(generatedAt, args.mode));
  const file = buildResultsFile({
    mode: args.mode,
    results: outcome.results,
    skipped: outcome.skipped,
    controls: outcome.controls,
    at: generatedAt,
  });

  const report = renderReport({
    results: outcome.results,
    skipped: outcome.skipped,
    controls: outcome.controls,
    aggregate: summary,
    generatedAt,
    suiteFingerprint: file.suiteFingerprint,
    node: process.version,
  });

  await mkdir(resultsDir, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');

  const markdownPath = args.out ?? jsonPath.replace(/\.json$/, '.md');
  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(markdownPath, report, 'utf8');

  out();
  rule();
  out(`results   ${jsonPath}`);
  out(`report    ${markdownPath}`);
  out(`mode      ${args.mode}${args.mode === 'simulated' ? ' — SIMULATED, not evidence of model capability' : ''}`);
  rule();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
