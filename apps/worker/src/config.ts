import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import type { CredentialSource } from '@intelligenz/egress-broker';

import {
  RESOURCE_PROFILE_NAMES,
  isResourceProfileName,
  type ResourceProfileName,
} from './resource-profiles';

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
  /** Absolute, disposable lease root for real executions (`WORKSPACE_ROOT`). */
  readonly workspace: {
    readonly root: string;
    /**
     * Repository a real run is cloned from (`WORKSPACE_SOURCE_REPO`). Unset means an
     * empty workspace: a real agent with no checkout, which is a legitimate (but
     * unusual) request and never a silent fallback to the host tree.
     */
    readonly sourceRepo: string | undefined;
  };
  /**
   * Adapter selection. `local-simulated` is the default **on purpose**: a real run
   * spends provider credit and must be opt-in, never something a missing variable
   * quietly enables (Phase 3 baseline §7).
   */
  readonly execution: {
    readonly runtimeId: AgentRuntimeId;
    /**
     * **Upstream** model id, sent to the provider by the broker (`AGENT_MODEL`).
     * Required when the runtime is real: the sandbox sees `izbroker/<key>`, and the
     * host maps that onto this id.
     */
    readonly model: string | undefined;
    /** Hard spend cap in USD for one real run. Defaults to `DEFAULT_AGENT_MAX_USD`. */
    readonly maxUsd: number;
    readonly bwrapPath: string | undefined;
    /**
     * Provider authentication for a real run. Host-side only: the broker injects the
     * credential, and the sandbox never holds one.
     */
    readonly broker: {
      /** `AGENT_BROKER_UPSTREAM_URL` — e.g. `https://provider.example/v1`. */
      readonly upstreamBaseUrl: string | undefined;
      /** Where the credential is read: an opencode SQLite row, or an env variable. */
      readonly credential: CredentialSource | undefined;
      /** Requests one attempt may make through the broker. */
      readonly maxRequests: number;
    };
    /**
     * Scratch directory the **adapter** owns: its per-run config, broker socket and
     * raw transcript, before the worker copies evidence into the workspace.
     *
     * Separate from `artifactRoot` because the adapter builds
     * `<scratch>/opencode-cli/<taskId>-<suffix>/broker/broker.sock`, and a unix socket
     * path must stay under 107 bytes. With a UUID task id and a repository-relative
     * artifact root the path is 113 bytes, libuv silently binds a truncated name, and
     * every provider call fails with `ECONNRESET`. See `assertAdapterScratchBudget`.
     */
    readonly scratchRoot: string;
  };
  readonly runtime: {
    readonly timeoutMs: number;
    /** Advisory, recorded only (contract §15 A7). */
    readonly budgetUsd: number;
    /** Simulated per-step delay; the stand-in for a real runtime's latency. */
    readonly stepDelayMs: number;
  };
  /**
   * Phase 4 resource enforcement. Server-owned: nothing in this block is read from a
   * task, a request body or an agent's output.
   */
  readonly resources: {
    /**
     * Where per-attempt cgroups are created. Must be the subtree the setup script
     * delegated; the capability probe reads this path and nothing else.
     */
    readonly cgroupRoot: string;
    /**
     * `WORKER_ALLOW_UNENFORCED_EXECUTION` — the documented escape hatch from the boot-time
     * execution-enforcement gate. **Default: false.**
     *
     * Off by default because the gate protects the one property the platform cannot
     * observe from inside itself: whether the process that executes tasks is actually
     * inside the delegated cgroup. A worker outside it runs every task with rlimit-only
     * enforcement and records `rlimit-only` — the record is honest, the enforcement is
     * absent, and nothing else notices. So the only process that may take this flag is one
     * that does not execute tasks: a control-plane or diagnostics process, a migration
     * runner, a queue-observation probe. A worker that polls a task queue must never take
     * it by default, because the flag would then be indistinguishable from a normal boot
     * and its absence of enforcement would be invisible in exactly the way this gate was
     * built to end.
     */
    readonly allowUnenforcedExecution: boolean;
    /** `WORKER_RESOURCE_PROFILE` — an operator override of the selection policy. */
    readonly profile: ResourceProfileName | undefined;
    /**
     * Reaper period. `WORKER_REAPER_INTERVAL_MS`, default 60 s. Also sets the grace
     * window for an expired lease: 2 × this value.
     */
    readonly reaperIntervalMs: number;
    /** `WORKER_REAPER_ENABLED=false` disables the loop; the pass is still callable. */
    readonly reaperEnabled: boolean;
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

/** The adapters this deployment may select. A name that is not here is a boot failure. */
export const AGENT_RUNTIME_IDS = ['local-simulated', 'opencode-cli'] as const;
export type AgentRuntimeId = (typeof AGENT_RUNTIME_IDS)[number];

const LOG_LEVELS = new Set<string>(['debug', 'info', 'warn', 'error']);
const AGENT_RUNTIMES = new Set<string>(AGENT_RUNTIME_IDS);

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

/** `undefined` (not `''`) so "unset" and "set to empty" have one representation. */
function readOptionalString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]?.trim();

  return raw === undefined || raw.length === 0 ? undefined : raw;
}

function readOptionalNumber(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = readOptionalString(env, name);
  if (raw === undefined) return undefined;

  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number, received "${raw}".`);
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

/** `WORKSPACE_ROOT`, same resolution rule as `ARTIFACT_ROOT` and for the same reason. */
export function resolveWorkspaceRoot(
  value: string | undefined,
  workspaceRoot: string = findWorkspaceRoot(),
): string {
  const configured = value?.trim();
  const candidate = configured !== undefined && configured.length > 0 ? configured : '.workspaces';

  return isAbsolute(candidate) ? resolve(candidate) : resolve(workspaceRoot, candidate);
}

/**
 * A repository path as the workspace manager receives it. A relative value is
 * resolved against the repository root rather than the process cwd, so
 * `WORKSPACE_SOURCE_REPO=infra/fixtures/sample-repo` means the same thing whether the
 * worker was started from the root or from `apps/worker`.
 */
export function resolveSourceRepo(
  value: string | undefined,
  workspaceRoot: string = findWorkspaceRoot(),
): string | undefined {
  const configured = value?.trim();
  if (configured === undefined || configured.length === 0) return undefined;

  return isAbsolute(configured) ? resolve(configured) : resolve(workspaceRoot, configured);
}

function readAgentRuntime(env: NodeJS.ProcessEnv): AgentRuntimeId {
  const raw = readString(env, 'AGENT_RUNTIME', 'local-simulated');

  if (!AGENT_RUNTIMES.has(raw)) {
    throw new Error(
      `AGENT_RUNTIME must be one of ${AGENT_RUNTIME_IDS.join('|')}, received "${raw}". ` +
        'Refusing to guess: an unknown value would silently change whether real work runs.',
    );
  }

  return raw as AgentRuntimeId;
}

/**
 * Longest unix socket path on Linux is 107 bytes (108 including the NUL). libuv does
 * not reject a longer path — it binds a *truncated* name, so the failure is not at
 * configuration time but at model-call time as `ECONNRESET` through the sandbox shim.
 * That was observed, not theorised: a UUID task id under a repository-relative
 * artifact root produced a 113-byte socket path and every provider call failed.
 *
 * The budget is checked with room to spare (100), against a worst-case run directory
 * (`<uuid>-<base36 suffix>`), so a misconfigured scratch root fails at boot with an
 * explanation instead of costing a real run.
 */
const UNIX_SOCKET_PATH_BUDGET = 107;
const WORST_CASE_RUN_ID = 36 + 1 + 8;

/**
 * Default spend cap for a real run, in USD.
 *
 * This is deliberately a **default, not a commented-out example**. A real adapter with
 * no cap is an unlimited purchase order, and "the operator forgot to set a variable" is
 * not a reason to run one. `AGENT_MAX_USD` overrides it; a value of zero or below is
 * refused at boot rather than interpreted as "unlimited".
 */
export const DEFAULT_AGENT_MAX_USD = 0.5;

export function assertAdapterScratchBudget(scratchRoot: string): void {
  const worstCase = join(
    scratchRoot,
    'opencode-cli',
    `${'0'.repeat(36)}-12345678`,
    'broker',
    'broker.sock',
  );

  if (worstCase.length > UNIX_SOCKET_PATH_BUDGET) {
    throw new Error(
      `AGENT_RUNTIME_SCRATCH_ROOT resolves to "${scratchRoot}", and the adapter's broker ` +
        `socket would be ${String(worstCase.length)} bytes (limit ${String(UNIX_SOCKET_PATH_BUDGET)}, ` +
        `worst-case run id ${String(WORST_CASE_RUN_ID)} characters). ` +
        'Choose a shorter path (the default is /tmp/intelligenz-runtime). A longer one ' +
        'fails silently at model-call time with ECONNRESET.',
    );
  }
}

export function resolveScratchRoot(
  value: string | undefined,
  workspaceRoot: string = findWorkspaceRoot(),
): string {
  const configured = value?.trim();

  if (configured === undefined || configured.length === 0) {
    return join(tmpdir(), 'intelligenz-runtime');
  }

  return isAbsolute(configured) ? resolve(configured) : resolve(workspaceRoot, configured);
}

/** Requests one attempt may make through the egress broker. */
export const DEFAULT_BROKER_MAX_REQUESTS = 400;

/** Where opencode keeps the credential on this host (`auth.json` does not exist). */
export function defaultCredentialDatabasePath(): string {
  return join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

function assertHttpUrl(name: string, value: string): string {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL, received "${value}".`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${name} must be http or https, received "${parsed.protocol}".`);
  }

  return value;
}

/**
 * Provider authentication for a real run.
 *
 * Two sources, because two deployments are legitimate: an operator machine where
 * opencode already holds the credential in its SQLite store, and a container where the
 * credential arrives from a secret manager as an environment variable. The adapter
 * never sees either — the broker reads it per request.
 *
 * Nothing here reads the value. A boot check that printed a credential would be the
 * leak it was meant to prevent.
 */
export function resolveBrokerConfig(
  env: NodeJS.ProcessEnv,
  workspaceRoot: string = findWorkspaceRoot(),
): {
  readonly upstreamBaseUrl: string | undefined;
  readonly credential: CredentialSource | undefined;
  readonly maxRequests: number;
} {
  const rawUpstream = readOptionalString(env, 'AGENT_BROKER_UPSTREAM_URL');
  const upstreamBaseUrl =
    rawUpstream === undefined
      ? undefined
      : assertHttpUrl('AGENT_BROKER_UPSTREAM_URL', rawUpstream);

  const credentialEnv = readOptionalString(env, 'AGENT_BROKER_CREDENTIAL_ENV');
  const integrationId = readOptionalString(env, 'AGENT_BROKER_CREDENTIAL');
  const rawDatabase = readOptionalString(env, 'AGENT_BROKER_CREDENTIAL_DB');

  const databasePath =
    rawDatabase === undefined
      ? defaultCredentialDatabasePath()
      : isAbsolute(rawDatabase)
        ? resolve(rawDatabase)
        : resolve(workspaceRoot, rawDatabase);

  let credential: CredentialSource | undefined;

  if (credentialEnv !== undefined) {
    credential = { kind: 'env', name: credentialEnv };
  } else if (integrationId !== undefined) {
    credential = { kind: 'opencode-db', databasePath, integrationId };
  }

  return {
    upstreamBaseUrl,
    credential,
    maxRequests: readInteger(env, 'AGENT_BROKER_MAX_REQUESTS', DEFAULT_BROKER_MAX_REQUESTS),
  };
}

function readResourceProfile(env: NodeJS.ProcessEnv): ResourceProfileName | undefined {
  const raw = readOptionalString(env, 'WORKER_RESOURCE_PROFILE');
  if (raw === undefined) return undefined;

  const upper = raw.toUpperCase();

  if (!isResourceProfileName(upper)) {
    // Refusing at boot, not silently falling back: a typo that silently selects SMALL
    // would cap a real run at 512 MiB and look like an OOM bug.
    throw new Error(
      `WORKER_RESOURCE_PROFILE must be one of ${RESOURCE_PROFILE_NAMES.join('|')}, received "${raw}".`,
    );
  }

  return upper;
}

function readBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = readOptionalString(env, name);
  if (raw === undefined) return fallback;

  const lowered = raw.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
  if (['0', 'false', 'no', 'off'].includes(lowered)) return false;

  throw new Error(`${name} must be a boolean, received "${raw}".`);
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
  const workspaceRootDirectory = findWorkspaceRoot();
  const runtimeId = readAgentRuntime(env);
  const maxUsd = readOptionalNumber(env, 'AGENT_MAX_USD') ?? DEFAULT_AGENT_MAX_USD;
  const broker = resolveBrokerConfig(env, workspaceRootDirectory);

  if (runtimeId === 'opencode-cli') {
    // Fail at boot, not 90 seconds and one provider charge into a run.
    assertAdapterScratchBudget(
      resolveScratchRoot(env['AGENT_RUNTIME_SCRATCH_ROOT'], workspaceRootDirectory),
    );

    // A real runtime without a positive cap is refused. `0` previously meant "the
    // adapter's own default"; now it means "no cap", which is not a supported mode.
    if (!(maxUsd > 0)) {
      throw new Error(
        `AGENT_MAX_USD must be greater than 0 when AGENT_RUNTIME=${runtimeId}; ` +
          `received "${String(env['AGENT_MAX_USD'])}". Unset means ${DEFAULT_AGENT_MAX_USD}.`,
      );
    }

    // Phase 4: the sandbox holds no credential, so the broker is the only way to
    // authenticate. A deployment that selects the real runtime without it has no
    // working model channel at all — there is no unproxied fallback to discover at
    // run time, so it is refused here instead.
    if (broker.upstreamBaseUrl === undefined) {
      throw new Error(
        'AGENT_BROKER_UPSTREAM_URL is required when AGENT_RUNTIME=opencode-cli. The sandbox ' +
          'holds no provider credential; the host broker is the only authentication path.',
      );
    }

    if (broker.credential === undefined) {
      throw new Error(
        'A provider credential source is required when AGENT_RUNTIME=opencode-cli. Set ' +
          'AGENT_BROKER_CREDENTIAL to an opencode integration id (read from ' +
          'AGENT_BROKER_CREDENTIAL_DB) or AGENT_BROKER_CREDENTIAL_ENV to an environment ' +
          'variable name.',
      );
    }

    if (readOptionalString(env, 'AGENT_MODEL') === undefined) {
      throw new Error(
        'AGENT_MODEL is required when AGENT_RUNTIME=opencode-cli: it is the upstream model ' +
          'id the broker sends. There is no default, because a wrong one is a charge, not ' +
          'a crash.',
      );
    }
  }

  return {
    nodeEnv: readString(env, 'NODE_ENV', 'development'),
    logLevel: rawLevel as LogLevel,
    databaseUrl,
    temporal: {
      address: readString(env, 'TEMPORAL_ADDRESS', 'localhost:7233'),
      namespace: readString(env, 'TEMPORAL_NAMESPACE', 'default'),
      taskQueue: readString(env, 'TEMPORAL_TASK_QUEUE', TASK_QUEUE),
    },
    artifactRoot: resolveArtifactRoot(env['ARTIFACT_ROOT'], workspaceRootDirectory),
    workspace: {
      root: resolveWorkspaceRoot(env['WORKSPACE_ROOT'], workspaceRootDirectory),
      sourceRepo: resolveSourceRepo(env['WORKSPACE_SOURCE_REPO'], workspaceRootDirectory),
    },
    execution: {
      runtimeId: runtimeId,
      model: readOptionalString(env, 'AGENT_MODEL'),
      maxUsd,
      bwrapPath: readOptionalString(env, 'AGENT_BWRAP_PATH'),
      broker,
      scratchRoot: resolveScratchRoot(env['AGENT_RUNTIME_SCRATCH_ROOT'], workspaceRootDirectory),
    },
    runtime: {
      // Below the activity's 60s `startToCloseTimeout` on purpose: the runtime must
      // return a `timeout` result before Temporal kills the activity, or the reason is
      // lost and the task is retried for the wrong cause.
      timeoutMs: readInteger(env, 'AGENT_TIMEOUT_MS', 50_000),
      budgetUsd: readNumber(env, 'AGENT_BUDGET_USD', 0),
      stepDelayMs: readInteger(env, 'AGENT_STEP_DELAY_MS', 40),
    },
    resources: {
      cgroupRoot: readString(env, 'WORKER_CGROUP_ROOT', '/sys/fs/cgroup/intelligenz'),
      // Not `readBoolean(..., true)` and not "warn only": see the field comment. A gate
      // that is on by default and off by configuration is a gate in name only.
      allowUnenforcedExecution: readBoolean(env, 'WORKER_ALLOW_UNENFORCED_EXECUTION', false),
      profile: readResourceProfile(env),
      reaperIntervalMs: readInteger(env, 'WORKER_REAPER_INTERVAL_MS', 60_000),
      reaperEnabled: readBoolean(env, 'WORKER_REAPER_ENABLED', true),
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
