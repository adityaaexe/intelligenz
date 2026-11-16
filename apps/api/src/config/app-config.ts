import type { Level } from 'pino';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Configuration is read once, at boot, and injected — never read from
 * `process.env` at request time. A missing `JWT_SECRET` must be a boot failure,
 * not a 500 on the first login that only production discovers.
 *
 * `APP_CONFIG` is a symbol so a provider with the same string name elsewhere
 * cannot collide with it.
 */
export const APP_CONFIG = Symbol('APP_CONFIG');

export interface TemporalConfig {
  readonly address: string;
  readonly namespace: string;
  readonly taskQueue: string;
  /**
   * Attempts per RPC, including the first (`TEMPORAL_RPC_MAX_ATTEMPTS`, default 10 —
   * the SDK's own default). `1` disables the client's automatic retries.
   *
   * ## Why this is stated instead of inherited
   *
   * The SDK installs a gRPC retry interceptor that schedules a `setTimeout` per
   * retryable failure (up to ten attempts, backing off to 5 s). That timer belongs to
   * the interceptor, not to the channel: `Connection.close()` does not clear it. A
   * timer that fires after the channel is shut down calls `nextCall()` on a dead
   * channel and throws `Channel has been shut down` **inside the timer callback** —
   * there is no promise to reject and no `catch` to run, so it surfaces as an uncaught
   * exception after the owning app has already been closed.
   *
   * That is exactly the shape of a suite that points the app at an unreachable
   * orchestrator to assert the `503` path: the request is over (it gave up on the call
   * and answered), but the abandoned call keeps retrying into the closed channel.
   * Retrying cannot help a call whose answer is already decided, so those apps set `1`
   * and no timer is ever scheduled.
   */
  readonly rpcMaxAttempts: number;
}

export interface AppConfig {
  readonly nodeEnv: string;
  readonly port: number;
  readonly host: string;
  readonly databaseUrl: string;
  readonly jwtSecret: string;
  readonly jwtTtlSeconds: number;
  readonly logLevel: Level | 'silent';
  /** Browser origins allowed by CORS. The web client calls the API directly. */
  readonly corsOrigins: readonly string[];
  readonly temporal: TemporalConfig;
  /** Bounds every readiness probe. A hung dependency must not hang the probe. */
  readonly readinessTimeoutMs: number;
  /**
   * Where the worker writes evidence (`ARTIFACT_ROOT`, contract §15 A5: the two
   * services must agree). Absolute; a relative value resolves against the repository
   * root, not the process cwd.
   */
  readonly artifactRoot: string;
  /**
   * Where real runs lease a disposable checkout (`WORKSPACE_ROOT`). Artifacts of a
   * real run live at `<workspace>/artifacts`, so the API must know this root too — a
   * run's transcript is evidence, and evidence is served, not guessed.
   */
  readonly workspaceRoot: string;
  /**
   * How long an approved grant stays usable (`APPROVAL_TTL_HOURS`, default 24). Set at
   * creation and refreshed at the decision, so a request that waited three days for a
   * review does not arrive already expired.
   *
   * A null `ApprovalRequest.expiresAt` (a pre-Phase-4 row) is evaluated against
   * `createdAt + this value`, never as "forever".
   */
  readonly approvalTtlHours: number;
  /**
   * Repositories whose checkouts are trusted, as a comma-separated allowlist
   * (`TRUSTED_SOURCE_REPOS`). A task is `trusted` only when its `sourceRef` matches an
   * entry **and** it pins a `baseCommit`; a branch name is not a pin.
   *
   * Empty by default: nothing is trusted until an operator opts a repository in. That
   * is why a file write on an unlisted repository is at least `HIGH` (D-006).
   */
  readonly trustedSourceRepos: readonly string[];
}

/**
 * Ports 3000 and 4000 belong to an unrelated product's live backend on this host
 * (contract §15 A1). Refusing them here makes the mistake impossible to ship
 * instead of merely documented.
 */
const RESERVED_PORTS = new Set([3000, 4000]);

const LOG_LEVELS = new Set<string>(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);

function readString(env: NodeJS.ProcessEnv, name: string, fallback?: string): string {
  const value = env[name]?.trim();

  if (value && value.length > 0) return value;
  if (fallback !== undefined) return fallback;

  throw new Error(`${name} is not set. Copy .env.example to .env at the repository root.`);
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

/** HS256 needs a key at least as long as the hash it feeds. */
const MIN_JWT_SECRET_LENGTH = 32;

/** A 64-character hex string (32 random bytes) is accepted on its own. */
const MIN_HEX_SECRET_LENGTH = 64;

/**
 * Values that must never sign a token even when they are long enough.
 *
 * `.env.example` ships `REPLACE_ME` so a fresh clone that copies the template
 * verbatim fails to boot. That is the correct behaviour: a placeholder that boots
 * is a placeholder that reaches production, and a public signing key is a full
 * authentication bypass — anyone can mint `{ sub, email }` for any user.
 */
const PLACEHOLDER_JWT_SECRETS: readonly string[] = [
  'replace-me-with-openssl-rand-hex-32',
  'replace_me',
  'replace-me',
  'changeme',
  'change-me',
  'change_me',
  'secret',
  'test',
  'testing',
  'development',
  'password',
  'your-secret-here',
  'your_secret_here',
];

/** `secret-secret-secret-…` is long, mixed-case and still worthless. */
const REPEATED_WEAK_WORD = new RegExp(
  `^(?:${['secret', 'changeme', 'change-me', 'test', 'development', 'password'].join('|')})+$`,
);

/**
 * `JWT_SECRET` has no default on purpose. A generated fallback is the kind of
 * convenience that ends up signing real tokens in an environment nobody checked.
 *
 * The check is a denylist *and* an entropy proxy, because length alone is not
 * evidence of entropy: the 35-character placeholder this repository published in
 * `.env.example` passed a `length >= 32` test and was used to forge an `OWNER`
 * token against the running API. Strength is "not a known placeholder, not a
 * repeated character or word, at least 32 characters, and either 64+ hex
 * characters or at least three of lowercase/uppercase/digit/symbol".
 */
function readJwtSecret(env: NodeJS.ProcessEnv): string {
  const secret = env['JWT_SECRET']?.trim() ?? '';
  const problem = describeJwtSecretProblem(secret);

  if (problem !== undefined) {
    throw new Error(
      `JWT_SECRET ${problem}. Generate a real signing key with \`openssl rand -hex 32\` and put it in .env. ` +
        'A service must never start with the value from .env.example.',
    );
  }

  return secret;
}

/** Returns the reason a secret is unacceptable, or `undefined` when it is usable. */
export function describeJwtSecretProblem(secret: string): string | undefined {
  if (secret.length === 0) return 'is not set';

  const lower = secret.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/g, '');

  if (
    PLACEHOLDER_JWT_SECRETS.includes(lower) ||
    lower.includes('replace-me') ||
    lower.includes('replace_me') ||
    REPEATED_WEAK_WORD.test(compact)
  ) {
    return 'is a placeholder from .env.example, not a generated key';
  }

  if (/^(.)\1+$/.test(secret)) return 'is a single repeated character';

  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    return `is ${secret.length} characters; at least ${MIN_JWT_SECRET_LENGTH} are required`;
  }

  if (!meetsJwtSecretStrength(secret)) {
    return 'does not contain enough entropy (use 64+ hex characters, or mix three of lowercase, uppercase, digit and symbol)';
  }

  return undefined;
}

function meetsJwtSecretStrength(secret: string): boolean {
  // `openssl rand -hex 32` is the documented generator: 64 hex characters is 32
  // random bytes and only ever two classes, so it is accepted explicitly.
  if (/^[0-9a-f]+$/i.test(secret) && secret.length >= MIN_HEX_SECRET_LENGTH) return true;

  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) =>
    pattern.test(secret),
  ).length;

  return classes >= 3;
}

function readLogLevel(env: NodeJS.ProcessEnv): Level | 'silent' {
  const level = env['LOG_LEVEL']?.trim() ?? 'info';

  if (!LOG_LEVELS.has(level)) {
    throw new Error(`LOG_LEVEL must be one of trace|debug|info|warn|error|fatal|silent.`);
  }

  return level as Level | 'silent';
}

function readPort(env: NodeJS.ProcessEnv): number {
  const port = readInteger(env, 'API_PORT', 4100);

  if (port < 1 || port > 65_535) throw new Error(`API_PORT ${port} is not a valid port.`);

  if (RESERVED_PORTS.has(port)) {
    throw new Error(
      `API_PORT ${port} belongs to another service on this host. Use 4100 (contract §15 A1).`,
    );
  }

  return port;
}

/**
 * Pure function: the same environment always produces the same config, and a test
 * can build one without touching the real process environment.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const repositoryRoot = findRepositoryRoot();

  return {
    nodeEnv: readString(env, 'NODE_ENV', 'development'),
    port: readPort(env),
    host: readString(env, 'API_HOST', '0.0.0.0'),
    databaseUrl: readString(env, 'DATABASE_URL'),
    jwtSecret: readJwtSecret(env),
    // 15 minutes (contract §5). Overridable only so tests do not have to fake time.
    jwtTtlSeconds: readInteger(env, 'JWT_ACCESS_TTL_SECONDS', 900),
    logLevel: readLogLevel(env),
    corsOrigins: (env['API_CORS_ORIGINS'] ?? 'http://localhost:3100')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    temporal: {
      address: readString(env, 'TEMPORAL_ADDRESS', 'localhost:7233'),
      namespace: readString(env, 'TEMPORAL_NAMESPACE', 'default'),
      taskQueue: readString(env, 'TEMPORAL_TASK_QUEUE', 'intelligenz-tasks'),
      // The SDK's default, named. See `TemporalConfig.rpcMaxAttempts` for why an app
      // pointed at an unreachable address sets 1 instead.
      rpcMaxAttempts: readPositiveInteger(env, 'TEMPORAL_RPC_MAX_ATTEMPTS', 10),
    },
    readinessTimeoutMs: readInteger(env, 'READINESS_TIMEOUT_MS', 2_000),
    artifactRoot: resolveRoot(env['ARTIFACT_ROOT'], '.artifacts', repositoryRoot),
    workspaceRoot: resolveRoot(env['WORKSPACE_ROOT'], '.workspaces', repositoryRoot),
    approvalTtlHours: readPositiveInteger(env, 'APPROVAL_TTL_HOURS', 24),
    trustedSourceRepos: (env['TRUSTED_SOURCE_REPOS'] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  };
}

/**
 * A positive integer, or the default. Zero and negatives are refused rather than
 * accepted: `APPROVAL_TTL_HOURS=0` would expire every grant the moment it is created,
 * which looks like a misconfiguration but behaves like an outage.
 */
function readPositiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = readInteger(env, name, fallback);

  if (value < 1) {
    throw new Error(`${name} must be at least 1, received "${String(value)}".`);
  }

  return value;
}

/**
 * A storage root as an absolute path.
 *
 * A relative `ARTIFACT_ROOT` must mean the same directory whether the API was started
 * from the repository root or from `apps/api` — otherwise the worker writes evidence
 * somewhere the API cannot find it, and the failure appears as a 410 on a file that
 * plainly exists. Walking up to `pnpm-workspace.yaml` is how both services agree.
 */
export function resolveRoot(
  value: string | undefined,
  fallback: string,
  repositoryRoot: string = findRepositoryRoot(),
): string {
  const configured = value?.trim();
  const candidate = configured !== undefined && configured.length > 0 ? configured : fallback;

  return isAbsolute(candidate) ? resolve(candidate) : resolve(repositoryRoot, candidate);
}

let repositoryRootCache: string | undefined;

export function findRepositoryRoot(startDirectory: string = process.cwd()): string {
  if (repositoryRootCache !== undefined) return repositoryRootCache;

  let directory = resolve(startDirectory);

  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(directory, 'pnpm-workspace.yaml'))) {
      repositoryRootCache = directory;
      return directory;
    }

    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  repositoryRootCache = resolve(startDirectory);

  return repositoryRootCache;
}
