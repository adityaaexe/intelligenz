/**
 * The runner: one benchmark, one run, measured end to end.
 *
 * Shape of a single run:
 *
 *   1. reset any host marker the benchmark is known to target (a stale marker from an
 *      earlier run must not disqualify this one),
 *   2. materialise the fixture into `<workRoot>/workspaces/<runId>/repo` with a
 *      deterministic base commit,
 *   3. hand it to the executor with a wall-clock ceiling,
 *   4. judge the workspace, scan what the run produced, hash the evidence,
 *   5. score under the versioned rubric,
 *   6. delete the clone.
 *
 * The executor is injected. `simulated` and `real` differ only in which executor is
 * passed in and in the `mode` label stamped on the result — the judging, scoring and
 * persistence path is identical, which is what makes the simulated run a test of the
 * harness rather than a separate code path that happens to print similar output.
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { fixtureDirectory } from './benchmark';
import { runProcess } from './exec';
import { materializeFixture, proveGitHookIsLive, type HookControlResult } from './fixture';
import { resolveJudgePath, runJudges } from './judge';
import { RUBRIC_VERSION, scoreRun } from './rubric';
import { detectSecurityEvents } from './security';
import type {
  Benchmark,
  JudgeResultView,
  RunMode,
  RunResult,
  RunArtifacts,
  SecurityEvent,
} from './types';
import { changeSetDigest, changedFiles, hashChangedFiles, hashTree } from './workspace';

export interface ExecuteInput {
  readonly benchmark: Benchmark;
  readonly runId: string;
  /**
   * A short identifier safe for both a directory name and a runtime `taskId`
   * (`[A-Za-z0-9_-]{1,64}`), e.g. `fix-failing-test-01`.
   *
   * It is short on purpose. A real adapter nests its run directory under the artifact
   * root, and a unix socket path is limited to 108 bytes: a run id carrying the semver
   * and a timestamp is enough to push `…/broker/broker.sock` past the limit, which
   * surfaces as a confusing `EADDRINUSE`.
   */
  readonly taskId: string;
  /** The directory the runtime is contained by: it must contain `repo/`. */
  readonly workspaceRoot: string;
  /** The materialised fixture repository. */
  readonly repoPath: string;
  /** Where this executor may write its own output. */
  readonly artifactsDir: string;
  readonly timeoutMs: number;
  readonly maxUsd: number;
  readonly runIndex: number;
}

export interface ExecutorOutcome {
  readonly status: 'succeeded' | 'failed' | 'timeout' | 'cancelled';
  readonly summary: string;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly costUsd: number | null;
  readonly costSource: 'provider' | 'simulated' | 'unreported';
  readonly retries: number | null;
  readonly toolInvocations: number;
  readonly refused: boolean;
  readonly termination: 'wall-clock' | 'budget' | null;
  /** Directories holding anything this run wrote outside the workspace. */
  readonly artifactDirs: readonly string[];
  readonly error: { readonly code: string; readonly message: string } | null;
}

export interface ExecutorContext {
  readonly mode: RunMode;
  readonly suiteDir: string;
  /** Everything this invocation will run, so an executor can validate itself up front. */
  readonly benchmarks: readonly Benchmark[];
  /** Suite-level containment root; one subdirectory per run. */
  readonly workspaceRoot: string;
  /** Suite-level artifact root. */
  readonly artifactsRoot: string;
  readonly capUsd: number | null;
}

export interface Executor {
  readonly kind: RunMode;
  readonly runtimeId: string;
  readonly runtimeVersion: string | null;
  readonly model: string;
  prepare?(context: ExecutorContext): Promise<void>;
  execute(input: ExecuteInput): Promise<ExecutorOutcome>;
  dispose?(): Promise<void>;
}

export type SuiteEvent =
  | { readonly type: 'benchmark-start'; readonly benchmark: Benchmark }
  | { readonly type: 'run-start'; readonly benchmark: Benchmark; readonly runIndex: number }
  | { readonly type: 'run-finish'; readonly result: RunResult }
  | { readonly type: 'run-skipped'; readonly benchmarkId: string; readonly reason: string }
  | { readonly type: 'control'; readonly control: HookControlResult };

export interface SkippedRun {
  readonly benchmarkId: string;
  readonly benchmarkVersion: string;
  readonly runIndex: number;
  readonly reason: string;
}

export interface RunSuiteOptions {
  readonly suiteDir: string;
  readonly benchmarks: readonly Benchmark[];
  readonly mode: RunMode;
  readonly runs: number;
  readonly capUsd: number | null;
  readonly executor: Executor;
  /** A temporary directory the caller owns; nothing here survives the process by default. */
  readonly workRoot: string;
  readonly keepWorkspaces?: boolean;
  readonly onEvent?: (event: SuiteEvent) => void;
}

export interface SuiteOutcome {
  readonly results: readonly RunResult[];
  readonly skipped: readonly SkippedRun[];
  readonly controls: readonly HookControlResult[];
}

function isoTimestamp(date: Date): string {
  return date.toISOString();
}

async function gitVersion(): Promise<string | null> {
  const outcome = await runProcess('git', ['--version'], {
    cwd: process.cwd(),
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
    timeoutMs: 5_000,
  });
  return outcome.code === 0 ? outcome.stdout.trim() : null;
}

/**
 * Marker paths a benchmark is known to target, derived from its `file-absent` judges.
 *
 * Only absolute paths are considered, and only those under `/tmp` or the run root are
 * ever deleted. A benchmark file is data in the repository; data does not get to name
 * an arbitrary host path for deletion.
 */
export function hostMarkerPaths(benchmark: Benchmark, workRoot: string): readonly string[] {
  const markers: string[] = [];

  for (const judge of benchmark.judge) {
    if (judge.type !== 'file-absent') continue;
    if (!judge.path.startsWith('/')) continue;
    if (!judge.path.startsWith('/tmp/') && !judge.path.startsWith(`${workRoot}/`)) continue;
    markers.push(resolveJudgePath(workRoot, judge.path));
  }

  // Control markers may be absolute (a host path) or relative (a file in the checkout).
  // Only absolute ones are host paths this process may delete; a relative one is the
  // judge's business and is checked inside the workspace.
  for (const marker of benchmark.negativeControl?.markerPaths ?? []) {
    if (!marker.startsWith('/')) continue;
    if (marker.startsWith('/tmp/') || marker.startsWith(`${workRoot}/`)) markers.push(marker);
  }

  return [...new Set(markers)];
}

function emptyArtifacts(): RunArtifacts {
  return { changed: [], adapter: [], changeSetSha256: changeSetDigest([]) };
}

export async function runSuite(options: RunSuiteOptions): Promise<SuiteOutcome> {
  const env = await gitVersion();
  const results: RunResult[] = [];
  const skipped: SkippedRun[] = [];
  const controls: HookControlResult[] = [];

  const workspaceRoot = join(options.workRoot, 'workspaces');
  const artifactsRoot = join(options.workRoot, 'artifacts');

  await options.executor.prepare?.({
    mode: options.mode,
    suiteDir: options.suiteDir,
    benchmarks: options.benchmarks,
    workspaceRoot,
    artifactsRoot,
    capUsd: options.capUsd,
  });

  let spentUsd = 0;

  try {
    for (const benchmark of options.benchmarks) {
      options.onEvent?.({ type: 'benchmark-start', benchmark });

      const markers = hostMarkerPaths(benchmark, options.workRoot);

      // The negative control is a property of the fixture, not of the run: prove once
      // per suite that the hostility is real before reporting that it was resisted.
      if (benchmark.negativeControl?.kind === 'git-hook') {
        const control = await proveGitHookIsLive({
          fixtureDir: fixtureDirectory(options.suiteDir, benchmark),
          destination: join(options.workRoot, 'controls', benchmark.id),
          benchmark,
          timeoutMs: benchmark.limits.wallClockMs,
          markerPaths: benchmark.negativeControl.markerPaths,
        });
        controls.push(control);
        options.onEvent?.({ type: 'control', control });
      }

      for (let runIndex = 1; runIndex <= options.runs; runIndex += 1) {
        // Reserve the benchmark's own ceiling, not its last observed cost. A cap that
        // is checked against a number the provider controls is not a cap.
        if (options.capUsd !== null && spentUsd + benchmark.limits.maxUsd > options.capUsd) {
          const reason =
            `cap: $${spentUsd.toFixed(4)} spent + $${benchmark.limits.maxUsd.toFixed(2)} ceiling ` +
            `for ${benchmark.id} would exceed --cap-usd $${options.capUsd.toFixed(2)}`;
          skipped.push({
            benchmarkId: benchmark.id,
            benchmarkVersion: benchmark.version,
            runIndex,
            reason,
          });
          options.onEvent?.({ type: 'run-skipped', benchmarkId: benchmark.id, reason });
          continue;
        }

        for (const marker of markers) await rm(marker, { force: true });

        // A run id becomes a directory name and, in real mode, the runtime's `taskId`.
        // The runtime accepts `[A-Za-z0-9_-]{1,64}`, so the semver dots are replaced:
        // `fix-failing-test-v1_0_0-01`.
        const runId = `${benchmark.id}-v${benchmark.version.replaceAll('.', '_')}-${String(runIndex).padStart(2, '0')}`;
        const startedAt = new Date();
        const startedMs = Date.now();

        options.onEvent?.({ type: 'run-start', benchmark, runIndex });

        const taskId = `${benchmark.id}-${String(runIndex).padStart(2, '0')}`;
        const runRoot = join(workspaceRoot, runId);
        const repoPath = join(runRoot, 'repo');
        const artifactsDir = join(artifactsRoot, runId);
        // Everything known before judging. The measured fields are filled in afterwards,
        // so a harness failure still writes a complete record instead of a hole.
        const base: Omit<RunResult, DeferredField> = {
          schemaVersion: 1,
          runId,
          outcome: 'scored',
          skipReason: null,
          mode: options.mode,
          benchmark: {
            id: benchmark.id,
            version: benchmark.version,
            category: benchmark.category,
            policyExpectation: benchmark.policyExpectation,
            fixture: benchmark.fixture,
            description: benchmark.description ?? null,
          },
          rubricVersion: RUBRIC_VERSION,
          runtime: {
            id: options.executor.runtimeId,
            version: options.executor.runtimeVersion,
            model: options.executor.model,
          },
          fixtureCommit: '',
          startedAt: isoTimestamp(startedAt),
          durationMs: 0,
          totalMs: 0,
          usage: {
            tokensIn: null,
            tokensOut: null,
            costUsd: null,
            costSource: 'unreported',
          },
          retries: null,
          toolInvocations: 0,
          termination: null,
          refused: false,
          environment: { node: process.version, platform: process.platform, git: env },
        };

        let fixtureCommit = '';
        let judgeResults: readonly JudgeResultView[] = [];
        let securityEvents: readonly SecurityEvent[] = [];
        let artifacts = emptyArtifacts();
        let outcome: ExecutorOutcome;
        let durationMs = 0;
        let harnessError: { code: string; message: string } | null = null;

        try {
          const materialized = await materializeFixture({
            fixtureDir: fixtureDirectory(options.suiteDir, benchmark),
            destination: repoPath,
            benchmark,
            timeoutMs: benchmark.limits.wallClockMs,
          });
          fixtureCommit = materialized.commit;

          const execStart = Date.now();
          outcome = await withWallClock(
            options.executor.execute({
              benchmark,
              runId,
              taskId,
              workspaceRoot: runRoot,
              repoPath,
              artifactsDir,
              timeoutMs: benchmark.limits.wallClockMs,
              maxUsd: benchmark.limits.maxUsd,
              runIndex,
            }),
            benchmark.limits.wallClockMs,
          );
          durationMs = Date.now() - execStart;

          if (outcome.costUsd !== null) spentUsd += outcome.costUsd;

          judgeResults = await runJudges(benchmark, repoPath, materialized.commit);

          const adapterHashes: ArtifactsAccumulator = { entries: [], truncated: false };
          for (const directory of outcome.artifactDirs) {
            const hashed = await hashTree(directory);
            adapterHashes.entries.push(...hashed.hashes);
            adapterHashes.truncated = adapterHashes.truncated || hashed.truncated;
          }

          const changed = await changedFiles(repoPath, materialized.commit);
          const changedHashes = await hashChangedFiles(changed);
          artifacts = {
            changed: changedHashes.hashes,
            adapter: adapterHashes.entries,
            changeSetSha256: changeSetDigest(changedHashes.hashes),
          };

          securityEvents = await detectSecurityEvents({
            workspace: repoPath,
            baseCommit: materialized.commit,
            artifactsDirs: outcome.artifactDirs,
            hostMarkerPaths: markers,
          });
        } catch (error) {
          harnessError = {
            code: 'HARNESS_ERROR',
            message: error instanceof Error ? error.message : String(error),
          };
          outcome = {
            status: 'failed',
            summary: 'the harness could not complete this run',
            tokensIn: null,
            tokensOut: null,
            costUsd: null,
            costSource: 'unreported',
            retries: null,
            toolInvocations: 0,
            refused: false,
            termination: null,
            artifactDirs: [],
            error: harnessError,
          };
        }

        const score = scoreRun({
          judges: judgeResults,
          securityEvents,
          termination: outcome.termination,
        });

        const result: RunResult = {
          ...base,
          fixtureCommit,
          durationMs,
          totalMs: Date.now() - startedMs,
          usage: {
            tokensIn: outcome.tokensIn,
            tokensOut: outcome.tokensOut,
            costUsd: outcome.costUsd,
            costSource: outcome.costSource,
          },
          retries: outcome.retries,
          toolInvocations: outcome.toolInvocations,
          termination: outcome.termination,
          refused: outcome.refused,
          judgeResults,
          dimensions: score.dimensions,
          score: score.total,
          passed: score.passed,
          disqualified: score.disqualified,
          disqualificationReason: score.disqualificationReason,
          securityEvents,
          artifacts,
          status: harnessError === null ? outcome.status : 'failed',
          error: harnessError ?? outcome.error,
        };

        results.push(result);
        options.onEvent?.({ type: 'run-finish', result });

        if (options.keepWorkspaces !== true) {
          await rm(runRoot, { recursive: true, force: true });
          await rm(artifactsDir, { recursive: true, force: true });
        }
      }
    }
  } finally {
    await options.executor.dispose?.();
  }

  return { results, skipped, controls };
}

type DeferredField =
  | 'judgeResults'
  | 'dimensions'
  | 'score'
  | 'passed'
  | 'disqualified'
  | 'disqualificationReason'
  | 'securityEvents'
  | 'artifacts'
  | 'status'
  | 'error';

interface ArtifactsAccumulator {
  entries: { path: string; sha256: string; bytes: number }[];
  truncated: boolean;
}

/**
 * A wall clock the harness owns.
 *
 * The executor is given the same ceiling and is expected to honour it, but an adapter
 * that hangs is exactly the case this must survive: the race resolves with a timeout
 * outcome and the run is scored as terminated, not lost.
 */
async function withWallClock(
  execution: Promise<ExecutorOutcome>,
  timeoutMs: number,
): Promise<ExecutorOutcome> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<ExecutorOutcome>((resolvePromise) => {
    timer = setTimeout(() => {
      resolvePromise({
        status: 'timeout',
        summary: `the harness terminated the run at its ${String(timeoutMs)}ms wall-clock limit`,
        tokensIn: null,
        tokensOut: null,
        costUsd: null,
        costSource: 'unreported',
        retries: null,
        toolInvocations: 0,
        refused: false,
        termination: 'wall-clock',
        artifactDirs: [],
        error: { code: 'WALL_CLOCK_EXCEEDED', message: `exceeded ${String(timeoutMs)}ms` },
      });
    }, timeoutMs);
  });

  // Mark a late rejection as handled: on a timeout the executor is still unwinding,
  // and an unhandled rejection would take the process down after the result was written.
  void execution.catch(() => undefined);

  try {
    return await Promise.race([execution, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
