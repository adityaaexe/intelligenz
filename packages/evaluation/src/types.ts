/**
 * The benchmark vocabulary.
 *
 * A `Benchmark` is data, not code: it lives in `BENCHMARK.json` at the root of a
 * fixture, it is versioned, and it is the only thing the runner reads. Adding a
 * benchmark therefore never touches the harness, and a harness change never silently
 * changes what a past result meant.
 */

export const BENCHMARK_CATEGORIES = [
  'engineering',
  'quality',
  'security',
  'resilience',
  'efficiency',
] as const;

export type BenchmarkCategory = (typeof BENCHMARK_CATEGORIES)[number];

/**
 * The five scored dimensions. Their weights live in `rubric.ts`; the names live here
 * because a judge declares which one it scores.
 */
export const JUDGE_DIMENSIONS = [
  'completion',
  'testCorrectness',
  'diffQuality',
  'policyCompliance',
  'artifactIntegrity',
] as const;

export type JudgeDimension = (typeof JUDGE_DIMENSIONS)[number];

/**
 * `no-violation` — the run is expected to do the task and leave the host alone.
 * `must-refuse`  — the fixture is hostile; the run is expected to refuse or to work
 *                  around the hostile instruction. Either way a *violation* still
 *                  disqualifies: "it refused the easy part but leaked the secret" is
 *                  not compliance.
 */
export type PolicyExpectation = 'no-violation' | 'must-refuse';

/**
 * A judge is one deterministic assertion over the workspace as the agent left it.
 *
 * `dimension` is an addition to the contract's union and is optional: when it is
 * absent the dimension is inferred from the judge type (see `judgeDimension`). It is
 * present in every shipped `BENCHMARK.json` so that the rubric never depends on an
 * inference for a benchmark we actually quote.
 */
export type Judge =
  | {
      readonly type: 'command';
      readonly argv: readonly string[];
      readonly expectExit: number;
      readonly dimension?: JudgeDimension;
      /** Wall-clock ceiling for this one command. Defaults to 60s. */
      readonly timeoutMs?: number;
    }
  | {
      readonly type: 'file-equals';
      readonly path: string;
      /** Lowercase hex SHA-256 of the expected bytes. */
      readonly sha256: string;
      readonly dimension?: JudgeDimension;
    }
  | { readonly type: 'file-absent'; readonly path: string; readonly dimension?: JudgeDimension }
  | {
      readonly type: 'grep';
      readonly path: string;
      /** JavaScript regular expression source, applied with the `m` flag. */
      readonly pattern: string;
      readonly expect: 'present' | 'absent';
      readonly dimension?: JudgeDimension;
    }
  | {
      readonly type: 'diff-files';
      /** Maximum number of files the run may add, modify or delete. */
      readonly maxChanged: number;
      readonly dimension?: JudgeDimension;
    };

export type JudgeType = Judge['type'];

export interface BenchmarkLimits {
  readonly wallClockMs: number;
  readonly maxUsd: number;
}

/**
 * Declared, executed proof that a fixture's hostility is real rather than decorative.
 *
 * For `git-hook` the runner materialises a second copy of the fixture and performs a
 * plain host `git checkout` in it. The control passes only when the marker appears —
 * which is what makes "the marker did not appear in the agent run" meaningful instead
 * of a statement about a hook that never worked.
 */
export type NegativeControl = { readonly kind: 'git-hook'; readonly markerPaths: readonly string[] };

export interface Benchmark {
  /** Stable, kebab-case. Never reused for a different task. */
  readonly id: string;
  /** Semver. Bump on any fixture, goal, judge or limit change. */
  readonly version: string;
  readonly category: BenchmarkCategory;
  /** Directory name under `infra/benchmarks/fixtures`. */
  readonly fixture: string;
  /** The prompt handed to the agent, verbatim. */
  readonly goal: string;
  /** Deterministic shell steps, run inside the fixture clone after the base commit. */
  readonly setup?: readonly string[];
  readonly judge: readonly Judge[];
  readonly limits: BenchmarkLimits;
  readonly policyExpectation: PolicyExpectation;
  /** One line stating what a passing run proves. Rendered in the report. */
  readonly description?: string;
  readonly negativeControl?: NegativeControl;
}

export const RUN_MODES = ['simulated', 'real'] as const;
export type RunMode = (typeof RUN_MODES)[number];

/**
 * How a run ended.
 *
 * `skipped` exists so that a cap abort is recorded rather than disguised as a failure:
 * a run that never started produced no evidence about anything.
 */
export type RunOutcome = 'scored' | 'skipped';

export type TerminationReason = 'wall-clock' | 'budget' | null;

export type SecurityEventKind = 'secret-shaped-content' | 'system-file-content' | 'host-write';

export interface SecurityEvent {
  readonly kind: SecurityEventKind;
  /** Always a violation. There is no "warning" that still scores. */
  readonly severity: 'violation';
  readonly detail: string;
  /** Workspace-relative or absolute path the evidence came from. */
  readonly path: string | null;
}

export interface JudgeResultView {
  readonly index: number;
  readonly type: JudgeType;
  readonly dimension: JudgeDimension;
  /** `error` means the judge itself could not run — not that the agent failed it. */
  readonly status: 'passed' | 'failed' | 'error';
  /** 0..1. Only `diff-files` produces values other than 0 and 1. */
  readonly credit: number;
  readonly detail: string;
  readonly durationMs: number;
}

export interface ArtifactHash {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface RunArtifacts {
  /** Files the run added or changed in the workspace, relative to the fixture commit. */
  readonly changed: readonly ArtifactHash[];
  /** Files the adapter itself wrote (transcript, broker log, config). */
  readonly adapter: readonly ArtifactHash[];
  /** SHA-256 over the sorted `path\0sha256` pairs of `changed`. */
  readonly changeSetSha256: string;
}

/**
 * One measured run. Every field is either measured or explicitly `null`.
 *
 * There is no estimated cost, no inferred token count and no filled-in default: an
 * absent measurement is `null` and the aggregate reports its coverage.
 */
export interface RunResult {
  readonly schemaVersion: 1;
  readonly runId: string;
  /** `scored` runs carry a score. `skipped` runs carry a reason and nothing else. */
  readonly outcome: RunOutcome;
  readonly skipReason: string | null;
  /**
   * The label that keeps simulated and real results apart for good. An aggregator
   * refuses to mix values of this field.
   */
  readonly mode: RunMode;
  readonly benchmark: {
    readonly id: string;
    readonly version: string;
    readonly category: BenchmarkCategory;
    readonly policyExpectation: PolicyExpectation;
    readonly fixture: string;
    readonly description: string | null;
  };
  readonly rubricVersion: string;
  readonly runtime: {
    readonly id: string;
    readonly version: string | null;
    readonly model: string;
  };
  /** Commit created from the committed fixture files at run time. */
  readonly fixtureCommit: string;
  readonly startedAt: string;
  /** Agent wall clock, excluding judge execution. */
  readonly durationMs: number;
  /** Agent wall clock plus judge execution. */
  readonly totalMs: number;
  readonly usage: {
    readonly tokensIn: number | null;
    readonly tokensOut: number | null;
    /** Provider-reported USD, or `null`. Never estimated. */
    readonly costUsd: number | null;
    readonly costSource: 'provider' | 'simulated' | 'unreported';
  };
  /** `null` when the adapter does not report retries. */
  readonly retries: number | null;
  readonly toolInvocations: number;
  readonly status: 'succeeded' | 'failed' | 'timeout' | 'cancelled' | 'skipped';
  readonly termination: TerminationReason;
  /** The executor's own claim. Scoring never trusts it; judges are the authority. */
  readonly refused: boolean;
  readonly judgeResults: readonly JudgeResultView[];
  readonly dimensions: Readonly<
    Record<JudgeDimension, { readonly weight: number; readonly earned: number; readonly judged: number }>
  >;
  readonly score: number;
  readonly passed: boolean;
  readonly disqualified: boolean;
  readonly disqualificationReason: string | null;
  readonly securityEvents: readonly SecurityEvent[];
  readonly artifacts: RunArtifacts;
  readonly environment: {
    readonly node: string;
    readonly platform: string;
    readonly git: string | null;
  };
  readonly error: { readonly code: string; readonly message: string } | null;
}
