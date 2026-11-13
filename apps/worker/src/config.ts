import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Worker configuration — read once at boot from the environment (contract §4, §15 A5).
 *
 * The worker has no Nest DI container, so config is a plain frozen object rather than
 * an injected provider. `loadWorkerConfig` is pure: the same environment always yields
 * the same config, and a test can build one without touching `process.env`.
 */

export interface WorkerConfig {
  readonly nodeEnv: string;
  readonly logLevel: LogLevel;
  readonly databaseUrl: string;
  readonly temporal: {
    readonly address: string;
    readonly namespace: string;
    readonly taskQueue: string;
  };
  /** Absolute. `<root>/<orgId>/<taskId>/result.md` is where a run's artifact lands. */
  readonly artifactRoot: string;
  readonly runtime: {
    readonly timeoutMs: number;
    /** Advisory, recorded only (contract §15 A7). */
    readonly budgetUsd: number;
    /** Simulated per-step delay; the stand-in for a real runtime's latency. */
    readonly stepDelayMs: number;
  };
  /** Dev-only levers. Both are inert unless explicitly set. */
  readonly faultInjection: {
    /** `execute-once` in `WORKER_FAULT_INJECT`: the first attempt of the activity throws. */
    readonly failExecuteOnce: boolean;
  };
  readonly shutdownTimeoutMs: number;
  readonly maxConcurrentActivities: number;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS = new Set<string>(['debug', 'info', 'warn', 'error']);

/** Contract §16. Hard-coded defaults so an unset `.env` still speaks the right queue. */
export const TASK_QUEUE = 'intelligenz-tasks';
export const WORKFLOW_TYPE = 'runTaskWorkflow';
export const WORKFLOW_ID_PREFIX = 'task-';

function readString(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name]?.trim();

  return value !== undefined && value.length > 0 ? value : fallback;
}

function readInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be an integer, received "${raw}".`);
  }

  return parsed;
}

function readNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;

  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number, received "${raw}".`);
  }

  return parsed;
}

/**
 * Loads the nearest `.env`, walking up from the working directory. Node 22's
 * `process.loadEnvFile` does not override variables that are already set, so an
 * explicit `DATABASE_URL=… pnpm …` beats the file and CI needs no file at all.
 *
 * Only `main.ts` and the test bootstrap call this. Importing a module must never
 * mutate the process environment as a side effect.
 */
export function loadNearestEnvFile(startDirectory: string = process.cwd()): void {
  let directory = resolve(startDirectory);

  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = resolve(directory, '.env');

    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }

    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

/**
 * `pnpm --filter @intelligenz/worker dev` runs with `cwd=apps/worker`, so a relative
 * `ARTIFACT_ROOT` would resolve to `apps/worker/.artifacts` and the API's seed would
 * disagree about where evidence lives (contract §15 A5 says they must agree). Resolve
 * against the workspace root instead, found by walking up to `pnpm-workspace.yaml`.
 */
export function findWorkspaceRoot(startDirectory: string = process.cwd()): string {
  let directory = resolve(startDirectory);

  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(directory, 'pnpm-workspace.yaml'))) return directory;

    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  return resolve(startDirectory);
}

export function resolveArtifactRoot(
  value: string | undefined,
  workspaceRoot: string = findWorkspaceRoot(),
): string {
  const configured = value?.trim();
  const candidate = configured !== undefined && configured.length > 0 ? configured : '.artifacts';

  return isAbsolute(candidate) ? resolve(candidate) : resolve(workspaceRoot, candidate);
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const databaseUrl = readString(env, 'DATABASE_URL', '');

  if (databaseUrl.length === 0) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env at the repository root, or export it.',
    );
  }

  const rawLevel = readString(env, 'LOG_LEVEL', 'info');

  if (!LOG_LEVELS.has(rawLevel)) {
    throw new Error('LOG_LEVEL must be one of debug|info|warn|error.');
  }

  const faultInject = readString(env, 'WORKER_FAULT_INJECT', '');

  return {
    nodeEnv: readString(env, 'NODE_ENV', 'development'),
    logLevel: rawLevel as LogLevel,
    databaseUrl,
    temporal: {
      address: readString(env, 'TEMPORAL_ADDRESS', 'localhost:7233'),
      namespace: readString(env, 'TEMPORAL_NAMESPACE', 'default'),
      taskQueue: readString(env, 'TEMPORAL_TASK_QUEUE', TASK_QUEUE),
    },
    artifactRoot: resolveArtifactRoot(env['ARTIFACT_ROOT']),
    runtime: {
      // Below the activity's 60s `startToCloseTimeout` on purpose: the runtime must
      // return a `timeout` result before Temporal kills the activity, or the reason is
      // lost and the task is retried for the wrong cause.
      timeoutMs: readInteger(env, 'AGENT_TIMEOUT_MS', 50_000),
      budgetUsd: readNumber(env, 'AGENT_BUDGET_USD', 0),
      stepDelayMs: readInteger(env, 'AGENT_STEP_DELAY_MS', 40),
    },
    faultInjection: {
      failExecuteOnce: faultInject
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .includes('execute-once'),
    },
    shutdownTimeoutMs: readInteger(env, 'WORKER_SHUTDOWN_TIMEOUT_MS', 10_000),
    maxConcurrentActivities: readInteger(env, 'WORKER_MAX_CONCURRENT_ACTIVITIES', 10),
  };
}

/**
 * The process-wide config. Activities resolve it per invocation, which must not mean a
 * `process.env` read and a filesystem walk (for `ARTIFACT_ROOT`) on every task.
 */
let cached: WorkerConfig | undefined;

export function getWorkerConfig(): WorkerConfig {
  cached ??= loadWorkerConfig();

  return cached;
}

/** Test seam: forget the memoised config so a new environment can be read. */
export function resetWorkerConfig(): void {
  cached = undefined;
}
