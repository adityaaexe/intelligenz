/**
 * `@intelligenz/evaluation` — the measurement system, not a dashboard.
 *
 * Public surface, in the order a caller needs it:
 *
 *   loadSuite / selectBenchmarks        read `infra/benchmarks`
 *   SimulatedExecutor / RealExecutor    the two executors, identical interface
 *   runSuite                            run, judge, score
 *   aggregate / assertAggregatable      summarise, with the two refusals
 *   buildResultsFile / readResultsFile  the ledger
 *   renderReport                        the Markdown artifact
 */

export { BENCHMARK_CATEGORIES, JUDGE_DIMENSIONS, RUN_MODES } from './types';

export type {
  Benchmark,
  BenchmarkCategory,
  BenchmarkLimits,
  Judge,
  JudgeDimension,
  JudgeResultView,
  JudgeType,
  NegativeControl,
  PolicyExpectation,
  RunArtifacts,
  RunMode,
  RunOutcome,
  RunResult,
  SecurityEvent,
  SecurityEventKind,
  TerminationReason,
} from './types';

export {
  BenchmarkError,
  fixtureDirectory,
  judgeDimension,
  loadBenchmarkDefinition,
  parseBenchmark,
  suiteFingerprint,
} from './benchmark';

export { loadSuite, selectBenchmarks } from './suite';

export {
  AggregationRefused,
  aggregate,
  assertAggregatable,
  mean,
  median,
  percentile,
} from './aggregate';

export type { Aggregate, BenchmarkAggregate } from './aggregate';

export { RUBRIC_WEIGHTS, RUBRIC_VERSION, rubricTable, scoreRun } from './rubric';

export type { DimensionScore, ScoreInput, ScoreResult } from './rubric';

export { diffCredit, resolveJudgePath, runJudges } from './judge';

export { detectSecurityEvents } from './security';
export type { SecurityScanInput } from './security';

export { materializeFixture, proveGitHookIsLive } from './fixture';
export type { HookControlResult, MaterializedFixture, SetupStepResult } from './fixture';

export { hostMarkerPaths, runSuite } from './runner';
export type {
  ExecuteInput,
  Executor,
  ExecutorContext,
  ExecutorOutcome,
  RunSuiteOptions,
  SkippedRun,
  SuiteEvent,
  SuiteOutcome,
} from './runner';

export {
  SIMULATED_MODEL,
  SIMULATOR_ID,
  SIMULATOR_VERSION,
  SimulatedExecutor,
  SimulationError,
} from './executors/simulated';

export { RealExecutor, RuntimeUnavailableError, realExecutorOptionsFromEnv } from './executors/real';
export type { RealExecutorOptions } from './executors/real';

export {
  RESULTS_SCHEMA_VERSION,
  ResultsFileError,
  buildResultsFile,
  reaggregate,
  readResultsFile,
  resultsFileName,
} from './results';
export type { ResultsFile } from './results';

export { renderReport } from './report';
export type { ReportInput } from './report';

export { changeSetDigest, changedFiles, hashChangedFiles, hashTree } from './workspace';
export type { ChangedFile } from './workspace';
