import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';

import {
  assertContained,
  buildSandboxCommand,
  execSandboxed,
  type SandboxCommand,
} from '@intelligenz/workspace-manager';
import {
  HEALTH_PATH,
  readCredential,
  startEgressBroker,
  type CredentialSource,
  type EgressBroker,
} from '@intelligenz/egress-broker';

import { RuntimeConfigurationError } from '../errors';
import { redact, redactAndTruncate } from '../redact';
import { CGROUP_PLACEMENT_EXIT, runInProcessGroup, type KillReason } from '../process-group';
import { parseOpencodeStream, type ParsedStream } from './opencode-stream';
import { SANDBOX_ENTRY_SOURCE } from '../sandbox/entry-source';
import {
  BROKER_CANARY_ENV,
  BROKER_PROVIDER_ID,
  BROKER_RELAY_PORT,
  buildRuntimeSandbox,
} from '../sandbox/broker-contract';
import type {
  AgentRuntime,
  ArtifactReference,
  ExecutionEvent,
  ExecutionRequest,
  ExecutionResult,
  ExecutionUsage,
  RuntimeCapabilities,
  RuntimeHealth,
  ToolInvocationRecord,
} from '../types';

const execFileAsync = promisify(execFile);

/**
 * `OpencodeCliRuntime` — a **real** adapter, and the first one in this codebase.
 *
 * It runs `opencode` (v2.x) headlessly inside `bwrap`, in a disposable clone, with no
 * IP network of its own, no inherited environment, and a read-only root filesystem.
 *
 * ## The one non-obvious design decision: where authentication happens
 *
 * `--unshare-net` gives the sandbox a network namespace with nothing in it. That is
 * what makes `network: false` true rather than aspirational — but a model call needs
 * the internet, and the model call happens in the same process as the agent.
 *
 * Phase 3 resolved that by mounting the provider's SQLite credential store into the
 * sandbox. The audit measured the consequence: a 1.08 GB database holding the provider
 * key **and 696 operator sessions**, readable by an agent with a shell. Narrowing it
 * could not work, because opencode has to read the key to authenticate.
 *
 * Phase 4 removes the requirement instead:
 *
 * ```
 *   bwrap --unshare-net
 *     └── node sandbox-entry.mjs            loopback only (127.0.0.1:8899)
 *           └── opencode  --baseURL--> 127.0.0.1:8899  (canary key)
 *                                       │ (unix socket bound read-only)
 *                                       ▼
 *                                     host egress broker
 *                                       ├── capability token: this attempt only
 *                                       ├── path allowlist: provider endpoints
 *                                       ├── strips inbound auth headers
 *                                       └── injects the real credential ──> provider
 * ```
 *
 * Inside the sandbox there is **no provider credential, no credential database, and no
 * provider config** — only a random per-attempt canary that authenticates nothing. The
 * real key is read on the host, at request time, and never written down.
 *
 * Every process the agent can spawn — its shell tool, `curl`, `git`, a script it
 * writes — has no route to anything except that one unix socket, and the socket only
 * speaks to the operator-configured upstream.
 *
 * ## What this adapter refuses to do
 *
 * - **No workspace, no run.** A request without `workspaceRoot` fails with
 *   `WORKSPACE_REQUIRED`; it never falls back to the process's own cwd.
 * - **No workspace outside the root.** `workspaceRoot` must resolve inside
 *   `WORKSPACE_ROOT`, so a caller cannot point it at the host checkout.
 * - **No unsandboxed fallback.** A missing `bwrap` throws; it does not run anyway.
 * - **No unbrokered fallback.** If the broker cannot be started or does not answer its
 *   health probe, the run fails with `BROKER_UNAVAILABLE`. There is no path that
 *   authenticates from inside the sandbox, because there is no credential there to use.
 * - **No `shell: true`.** Every process is spawned with an argv array.
 * - **No host process against agent-controlled content.** Post-run `git` runs inside
 *   the same sandbox profile as the run itself; see `collectWorkspaceEvidence`.
 */

export const OPENCODE_CLI_ID = 'opencode-cli';

/**
 * Port the in-sandbox relay listens on. Loopback inside the sandbox's own network
 * namespace: reachable by the agent, and not a route to anything.
 */
export {
  BROKER_CANARY_ENV,
  BROKER_PROVIDER_ID,
  BROKER_RELAY_PORT,
  BROKER_RELAY_SOCKET,
} from '../sandbox/broker-contract';

/**
 * A real adapter with no spend cap is an unlimited purchase order, not a configuration.
 * The worker also defaults `AGENT_MAX_USD` to this value; the constructor default exists
 * so a caller cannot omit the cap and get an uncapped run by accident.
 */
const DEFAULT_MAX_USD = 0.5;

/** Requests one attempt may make through the broker. Bounds spend and looping SDKs. */
const DEFAULT_BROKER_MAX_REQUESTS = 400;


/**
 * Hard ceiling on `transcript.ndjson`. A transcript is evidence, not a dataset; a run
 * that emits more than this is truncated with an explicit marker line rather than
 * buffered in memory until the worker dies.
 */
const TRANSCRIPT_MAX_BYTES = 5 * 1024 * 1024;

/** The line written when the ceiling is hit. Valid NDJSON, and visibly not model output. */
const TRANSCRIPT_TRUNCATION_LINE = `${JSON.stringify({
  type: 'truncated',
  reason: 'transcript exceeded the 5 MiB evidence cap',
  limitBytes: TRANSCRIPT_MAX_BYTES,
})}\n`;

/**
 * Config overrides applied to **every** git invocation inside the sandbox.
 *
 * The sandbox is the control: a hook that runs there cannot reach the host. These are
 * defence in depth, so that an agent-authored `.git/config` cannot even influence the
 * bytes the worker trusts: `core.fsmonitor` would execute a command on every status,
 * `core.hooksPath` would run a hook, and `diff.external` would replace the diff output
 * with whatever a program chooses. `--no-ext-diff`/`--no-textconv` cover the
 * `.gitattributes` equivalents.
 */
const SANDBOX_GIT_CONFIG = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'diff.external=',
  // Global, so it precedes the subcommand. `git status` otherwise refreshes the index
  // and may write a lock file into a repository the agent controls.
  '--no-optional-locks',
] as const;

/**
 * A budget smaller than this cannot be honoured: spawning `bwrap`, `node` and
 * `opencode` costs more than a few milliseconds, so a 1 ms budget is already spent
 * before the first byte. Returning `timeout` is the honest answer — spawning anyway
 * would overspend the budget just to prove it.
 */
const SPAWN_FLOOR_MS = 50;

const STDERR_TAIL_BYTES = 8 * 1024;

/**
 * The key a model id gets in the generated config's `models` map.
 *
 * Derived rather than configured: two spellings of the same model are a way to get a
 * run that silently calls a different model than the operator set. The transform is
 * lossy on purpose (a config key must be stable and shell-safe), and the real id is
 * carried in `modelID`, which is what the provider receives.
 */
export function brokerModelKey(modelId: string): string {
  const key = modelId
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return key.length > 0 ? key : 'default';
}

/**
 * Validate the task id before it becomes a path segment.
 *
 * The run directory now contains the broker socket and the evidence log, so a task id
 * of `../../etc` would be a write outside `ARTIFACT_ROOT` — and a socket bound at a
 * path of the caller's choosing. The audit recorded this as a latent finding (F6) when
 * the consequence was one config file; with a socket it is a boundary, so it is
 * checked rather than trusted.
 */
export function safeRunIdSegment(taskId: string): string | null {
  return /^[A-Za-z0-9_-]{1,64}$/.test(taskId) ? taskId : null;
}

/**
 * Host-side broker configuration.
 *
 * `model` on the runtime is the **upstream** model id (`gemini-3.5-flash`,
 * `deepseek/deepseek-v4.1-flash`). The sandbox sees `izbroker/<key>` and never the
 * vendor. That indirection is the point: the sandbox's config names an endpoint on
 * loopback, and the host decides what that means.
 */
export interface OpencodeBrokerOptions {
  /** e.g. `https://api.provider.test/v1`. The broker appends the request path. */
  readonly upstreamBaseUrl: string;
  /** Where the real credential is read. Host-side only. */
  readonly credential: CredentialSource;
  /** Requests one attempt may make. Default 400. */
  readonly maxRequests?: number;
}

export interface OpencodeCliRuntimeOptions {
  /**
   * The containment boundary (`WORKSPACE_ROOT`). Every `req.workspaceRoot` must
   * resolve inside it. Required: an adapter that guesses its boundary has none.
   */
  readonly workspaceRoot: string;
  /** Where transcripts and diffs are written (`ARTIFACT_ROOT`). Required. */
  readonly artifactsRoot: string;
  /**
   * **Upstream** model id, sent to the provider by the broker. Required: an adapter
   * with no model is a configuration error, not a default.
   */
  readonly model: string;
  /**
   * Provider authentication and destination. Required: this adapter has no way to
   * authenticate without it, because the sandbox holds no credential.
   */
  readonly broker: OpencodeBrokerOptions;
  /** `opencode` executable. Resolved on `PATH` when omitted. */
  readonly binary?: string;
  /** `bwrap` executable. Resolved on `PATH` when omitted. */
  readonly bwrapPath?: string;
  /**
   * Hard spend cap in USD. Exceeding it terminates the run; it is not a warning.
   * Defaults to `0.5` — an uncapped real adapter is not a configuration option.
   */
  readonly maxUsd?: number;
  /** Grace between `SIGTERM` and `SIGKILL`. Default 5000 ms. */
  readonly killGraceMs?: number;
}

/**
 * The persisted transcript: one redacted line at a time, bounded in bytes.
 *
 * Redaction happens here — at collection — rather than at persistence, because the
 * window between "bytes exist" and "bytes are written" is where an unredacted copy
 * would live. `writeArtifacts` writes exactly what this returns; there is no second
 * path to the transcript.
 *
 * The buffer is byte-capped rather than count-capped: 5 MiB of NDJSON is roughly the
 * point at which a transcript stops being evidence and starts being a download. When
 * the cap is reached a single `{"type":"truncated"}` line is appended and every later
 * chunk is dropped, so memory cannot grow past the cap.
 */
export class TranscriptBuffer {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private readonly parts: string[] = [];
  private bytes = 0;
  private truncated = false;

  push(chunk: Buffer): void {
    if (this.truncated) return;

    this.pending += this.decoder.write(chunk);

    // One scan per chunk with a cursor, not `slice` per line: a 64 KiB chunk of short
    // lines is ordinary model output, and re-slicing the remainder per line is
    // quadratic in the chunk size.
    let start = 0;
    let newline = this.pending.indexOf('\n', start);

    while (newline !== -1 && !this.truncated) {
      this.append(this.pending.slice(start, newline));
      start = newline + 1;
      newline = this.pending.indexOf('\n', start);
    }

    if (start > 0) this.pending = this.pending.slice(start);

    // A process that never emits a newline must not be able to grow `pending` without
    // bound; the truncated line is a truthful description of what happened.
    if (!this.truncated && this.pending.length > TRANSCRIPT_MAX_BYTES) {
      this.append(this.pending);
      this.pending = '';
    }
  }

  /** Flush the trailing partial line and return the redacted transcript. */
  finish(): string {
    if (!this.truncated) {
      this.pending += this.decoder.end();
      if (this.pending.length > 0) this.append(this.pending);
      this.pending = '';
    }

    return this.parts.join('');
  }

  private append(line: string): void {
    if (this.truncated) return;

    // Every line goes through `redact` — including the synthetic ones. A tool that
    // printed a token in a partial line has still printed it.
    const rendered = `${redact(line)}\n`;
    const size = Buffer.byteLength(rendered);
    const reserve = Buffer.byteLength(TRANSCRIPT_TRUNCATION_LINE);

    if (this.bytes + size > TRANSCRIPT_MAX_BYTES - reserve) {
      this.truncated = true;
      this.parts.push(TRANSCRIPT_TRUNCATION_LINE);
      this.bytes += reserve;
      return;
    }

    this.parts.push(rendered);
    this.bytes += size;
  }
}


interface BuildFields {
  readonly status: ExecutionResult['status'];
  readonly summary: string;
  readonly artifacts?: readonly ArtifactReference[];
  readonly events?: readonly ExecutionEvent[];
  readonly usage?: ExecutionUsage;
  readonly error?: ExecutionResult['error'];
  readonly providerMeta?: Record<string, unknown>;
  readonly toolInvocations?: readonly ToolInvocationRecord[];
  readonly runtimeVersion?: string;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function exists(path: string): Promise<boolean> {
  return access(path, fsConstants.F_OK).then(
    () => true,
    () => false,
  );
}

export interface WorkspaceEvidence {
  /** `git status --porcelain`, verbatim. */
  readonly status: string;
  /** `git diff`, verbatim. */
  readonly diff: string;
  /** The `diff.patch` artifact body: both sections, with their headers. */
  readonly patch: string;
}

/**
 * Collect a workspace's git evidence **inside the sandbox**.
 *
 * This function replaces a host `execFile('git', ['-C', repoPath, …])` that ran after
 * every run, including cancelled and failed ones. That was a sandbox escape: the
 * workspace is agent-writable, so `.git/config` (`core.fsmonitor`) and `.git/hooks/*`
 * were agent-controlled programs executed by the worker user on the host. The
 * sandbox's guarantee ended the moment the adapter asked the host to interpret the
 * agent's repository.
 *
 * It now runs `git` through the same `buildSandboxCommand` profile the run uses:
 * read-only root, a single read-write bind at `/workspace`, `--unshare-net`,
 * `--clearenv`. A hook that fires there has nowhere to write and no process to reach.
 * `SANDBOX_GIT_CONFIG` additionally neutralises the three config keys that could
 * change what the command does, so the output cannot be fabricated even in-sandbox.
 *
 * Best effort by contract: a workspace that is not a git checkout has no evidence, and
 * returns `null` rather than failing a run that already produced a result.
 */
export async function collectWorkspaceEvidence(input: {
  /** The workspace root; `<root>/repo` is bound to `/workspace`. */
  readonly workspaceRoot: string;
  readonly bwrapPath?: string;
  readonly timeoutMs?: number;
  /** Diff output is capped so one huge file cannot exhaust the worker's memory. */
  readonly maxBuffer?: number;
}): Promise<WorkspaceEvidence | null> {
  const timeout = input.timeoutMs ?? 15_000;
  const maxBuffer = input.maxBuffer ?? 4 * 1024 * 1024;

  const git = async (args: readonly string[]): Promise<string> => {
    const command = buildSandboxCommand({ rootPath: input.workspaceRoot }, ['git', ...args], {
      ...(input.bwrapPath === undefined ? {} : { bwrapPath: input.bwrapPath }),
      // No network, no inherited environment, and no mounts beyond the workspace. This
      // call needs nothing else: not the provider credential, not the run's config.
      //
      // These are the values **inside** the sandbox. The host-side environment `bwrap`
      // itself inherits is derived from the same allowlist by `buildSandboxCommand`, which
      // is what keeps the worker's environment out of `/proc/1/environ` (audit F1).
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        // `.gitattributes` can name a filter, an external diff driver or a textconv
        // program. The system attributes file is one input; the repository's own is
        // agent-writable and cannot be switched off, which is why "the sandbox holds no
        // secret" is the control and these are belt and braces.
        GIT_ATTR_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      },
    });

    const { stdout } = await execSandboxed(command, { timeoutMs: timeout, maxBuffer });

    return stdout;
  };

  try {
    const status = await git([
      ...SANDBOX_GIT_CONFIG,
      'status',
      '--porcelain',
      '--untracked-files=normal',
    ]);
    const diff = await git([
      ...SANDBOX_GIT_CONFIG,
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--no-renames',
    ]);

    return {
      status,
      diff,
      patch: `# git status --porcelain\n${status}\n# git diff\n${diff}`,
    };
  } catch {
    return null;
  }
}


export class OpencodeCliRuntime implements AgentRuntime {
  readonly id = OPENCODE_CLI_ID;

  private readonly workspaceRoot: string;
  private readonly artifactsRoot: string;
  private readonly model: string;
  private readonly broker: OpencodeBrokerOptions;
  private readonly binaryOption: string | undefined;
  private readonly bwrapPath: string | undefined;
  private readonly maxUsd: number;
  private readonly killGraceMs: number;
  private readonly running = new Map<string, () => void>();
  private versionCache: { at: number; value: string | null } | undefined;

  constructor(options: OpencodeCliRuntimeOptions) {
    if (options.workspaceRoot.trim().length === 0) {
      throw new RuntimeConfigurationError('OpencodeCliRuntime requires a workspaceRoot');
    }

    if (options.artifactsRoot.trim().length === 0) {
      throw new RuntimeConfigurationError('OpencodeCliRuntime requires an artifactsRoot');
    }

    if (options.model.trim().length === 0) {
      throw new RuntimeConfigurationError('OpencodeCliRuntime requires a model id');
    }

    if (options.broker.upstreamBaseUrl.trim().length === 0) {
      throw new RuntimeConfigurationError(
        'OpencodeCliRuntime requires broker.upstreamBaseUrl; the sandbox holds no credential ' +
          'and there is no unbrokered path',
      );
    }

    this.workspaceRoot = resolve(options.workspaceRoot);
    this.artifactsRoot = resolve(options.artifactsRoot);
    this.model = options.model;
    this.broker = options.broker;
    this.binaryOption = options.binary;
    this.bwrapPath = options.bwrapPath;
    this.maxUsd = options.maxUsd ?? DEFAULT_MAX_USD;
    this.killGraceMs = options.killGraceMs ?? 5000;

    if (!Number.isFinite(this.maxUsd) || this.maxUsd <= 0) {
      throw new RuntimeConfigurationError(
        `OpencodeCliRuntime requires maxUsd > 0; received ${String(options.maxUsd)}`,
      );
    }
  }

  /**
   * What the **agent** can reach — not what the adapter can reach on its behalf.
   *
   * `network: false` means: no general egress and, since Phase 4, no provider-specific
   * egress either. Every process the agent can spawn runs in a network namespace with
   * no interfaces, so TCP, UDP and DNS all fail, and `probeSandbox()` measures that
   * rather than trusting this comment.
   *
   * It does **not** mean "the agent cannot speak to any socket". The model transport is
   * a second, separate channel owned by this adapter: a unix socket bound into the
   * sandbox that terminates at a host broker which (a) requires a per-attempt
   * capability token, (b) accepts a fixed list of OpenAI-compatible paths, and (c)
   * chooses the upstream itself. The agent can speak HTTP to that socket; it cannot use
   * it to name a host, reach any other port, or obtain a credential. Precisely: *no
   * general egress; model traffic only through a host broker that injects the
   * credential; all other sockets blocked.*
   *
   * That channel is not a capability the agent has, so it is not reported as one.
   */
  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      shell: true,
      network: false,
      filesystem: 'write',
      browser: false,
      mcp: false,
      imageInput: false,
    };
  }

  async health(): Promise<RuntimeHealth> {
    const checkedAt = new Date().toISOString();
    const startedAt = Date.now();
    const binary = this.resolveBinary();

    if (binary === null) {
      return {
        status: 'down',
        simulated: false,
        checkedAt,
        detail: 'opencode binary not found on PATH',
      };
    }

    const version = await this.opencodeVersion();

    if (version === null) {
      return { status: 'down', simulated: false, checkedAt, detail: 'opencode --version failed' };
    }

    // Host-side only, and the value is discarded immediately: `health()` must not be a
    // way to read a credential, only to learn whether one can be read.
    let credentialDetail: string;

    try {
      const resolved = readCredential(this.broker.credential);

      credentialDetail = `credential available via ${resolved.source}`;
    } catch (error) {
      return {
        status: 'degraded',
        simulated: false,
        checkedAt,
        latencyMs: Date.now() - startedAt,
        detail: `opencode ${version}; no usable provider credential (${
          error instanceof Error ? error.message : String(error)
        })`,
      };
    }

    return {
      status: 'ok',
      simulated: false,
      checkedAt,
      latencyMs: Date.now() - startedAt,
      detail: `opencode ${version}; ${credentialDetail}; credential injected by the host broker; sandbox enforced by bwrap`,
    };
  }

  async cancel(taskId: string): Promise<void> {
    this.running.get(taskId)?.();
  }

  async execute(req: ExecutionRequest, signal: AbortSignal): Promise<ExecutionResult> {
    const startedAt = Date.now();

    if (signal.aborted) {
      return this.build({ status: 'cancelled', summary: 'Cancelled before the run started' });
    }

    // Checked before the workspace, deliberately: a budget of 1 ms is already spent,
    // and "no workspace" would be a true but misleading explanation.
    if (req.timeoutMs < SPAWN_FLOOR_MS) {
      return this.build({
        status: 'timeout',
        summary: `Budget of ${req.timeoutMs}ms is below the ${SPAWN_FLOOR_MS}ms floor`,
        error: {
          code: 'TIMEOUT_BEFORE_SPAWN',
          message: `timeoutMs=${req.timeoutMs} cannot cover process startup`,
          retryable: true,
        },
      });
    }

    if (req.workspaceRoot === undefined) {
      return this.build({
        status: 'failed',
        summary:
          'Refused: the request carries no workspaceRoot, and a real run never executes in the host cwd',
        error: {
          code: 'WORKSPACE_REQUIRED',
          message: 'ExecutionRequest.workspaceRoot is required by opencode-cli',
          retryable: false,
        },
      });
    }

    let resolvedWorkspace: string;

    try {
      resolvedWorkspace = await assertContained(this.workspaceRoot, req.workspaceRoot);
    } catch (error) {
      return this.build({
        status: 'failed',
        summary: 'Refused: workspaceRoot is outside WORKSPACE_ROOT',
        error: {
          code: 'WORKSPACE_OUTSIDE_ROOT',
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        },
      });
    }

    const repoPath = join(resolvedWorkspace, 'repo');

    if (!(await exists(repoPath))) {
      return this.build({
        status: 'failed',
        summary: `Refused: no checkout at ${repoPath}`,
        error: {
          code: 'WORKSPACE_REQUIRED',
          message: `workspaceRoot must contain a repo/ directory (${repoPath})`,
          retryable: false,
        },
      });
    }

    const runSegment = safeRunIdSegment(req.taskId);

    if (runSegment === null) {
      return this.build({
        status: 'failed',
        summary: 'Refused: taskId is not usable as a path segment',
        error: {
          code: 'INVALID_TASK_ID',
          message: 'taskId must match [A-Za-z0-9_-]{1,64}; it becomes a run directory name',
          retryable: false,
        },
      });
    }

    const runId = `${runSegment}-${startedAt.toString(36)}`;
    const runDir = join(this.artifactsRoot, OPENCODE_CLI_ID, runId);
    const configDir = join(runDir, 'config');
    const brokerDir = join(runDir, 'broker');

    // The run directory now holds a unix socket and the broker evidence log; a path
    // outside `artifactsRoot` would be a write, and a bind, at the caller's choosing.
    await assertContained(this.artifactsRoot, runDir);
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await mkdir(brokerDir, { recursive: true, mode: 0o700 });

    // A capability, not a credential. It authenticates nothing at the provider; it
    // proves to the broker that this request came from this attempt's relay. Random per
    // attempt, so a token observed by one run cannot be replayed by another.
    const capability = `iz-canary-${randomBytes(24).toString('base64url')}`;
    const modelKey = brokerModelKey(this.model);

    // The agent's provider config. `baseURL` is loopback: the only reachable endpoint is
    // the relay, and the relay terminates at the host broker. The key is the canary.
    // Nothing in this file can authenticate anything, which is the point.
    await writeFile(
      join(configDir, 'opencode.json'),
      `${JSON.stringify(
        {
          model: `${BROKER_PROVIDER_ID}/${modelKey}`,
          providers: {
            [BROKER_PROVIDER_ID]: {
              name: 'INTELLIGENZ egress broker',
              env: [BROKER_CANARY_ENV],
              package: '@opencode/ai/providers/openai-compatible',
              settings: { baseURL: `http://127.0.0.1:${String(BROKER_RELAY_PORT)}/v1` },
              models: {
                [modelKey]: {
                  modelID: this.model,
                  name: this.model,
                  capabilities: { tools: true, input: ['text'], output: ['text'] },
                  limit: { context: 1_000_000, output: 32_768 },
                },
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    let broker: EgressBroker | undefined;

    try {
      broker = await startEgressBroker({
        socketDir: brokerDir,
        attemptId: runId,
        capabilityToken: capability,
        upstream: { baseUrl: this.broker.upstreamBaseUrl, credential: this.broker.credential },
        maxRequests: this.broker.maxRequests ?? DEFAULT_BROKER_MAX_REQUESTS,
        logFile: join(runDir, 'broker.ndjson'),
      });

      // Fail closed, before spawning anything and before spending anything. There is no
      // unbrokered path to fall back to: the sandbox has no credential and no network.
      if (!(await broker.ready())) {
        return this.build({
          status: 'failed',
          summary: 'Refused: the egress broker did not answer its health probe',
          error: {
            code: 'BROKER_UNAVAILABLE',
            message:
              'The host egress broker is not reachable on its socket; refusing to run without a ' +
              'credential channel (there is no unproxied fallback)',
            retryable: true,
          },
        });
      }

      // The shim is materialised per run and mounted read-only at a fixed path, so the
      // agent can neither read it from its checkout nor modify it for the next run.
      const entryDir = join(runDir, 'entry');
      const entryFile = join(entryDir, 'sandbox-entry.mjs');
      const entryContainer = '/opt/agent/sandbox-entry.mjs';

      await mkdir(entryDir, { recursive: true, mode: 0o700 });
      await writeFile(entryFile, SANDBOX_ENTRY_SOURCE, { mode: 0o500 });

      const { mounts, env, extraArgs } = buildRuntimeSandbox({
        nodeBinDir: this.nodeBinDir(),
        nodeRoot: this.nodeRoot(),
        configDir,
        brokerDir,
        entryDir,
        capability,
      });

      const argv = [
        'node',
        entryContainer,
        ...this.opencodeArgv({ taskId: req.taskId, goal: req.goal }),
      ];

      const command = buildSandboxCommand({ rootPath: resolvedWorkspace }, argv, {
        bwrapPath: this.bwrapPath,
        // No IP route out of the sandbox. The model channel is a unix socket bound
        // read-only into the sandbox, terminating at the host broker.
        network: 'blocked',
        env,
        mounts,
        extraArgs,
      });

      // The attempt's hard spend cap. A request-supplied cap can only lower the
      // adapter's configured ceiling, never raise it: the worker derives it from the
      // resource profile, and the profile is not something the agent can choose.
      const attemptMaxUsd = Math.min(this.maxUsd, req.maxUsd ?? Number.POSITIVE_INFINITY);

      // `cgroup.procs` of the attempt's cgroup, or nothing when the worker's probe
      // reported that cgroup isolation is unavailable. Nothing here decides policy; the
      // request either names a cgroup or it does not.
      const cgroupProcsPath =
        req.cgroupProcsPath === undefined ? undefined : `${req.cgroupProcsPath}/cgroup.procs`;

      const outcome = await this.spawnAndCollect({
        command,
        taskId: req.taskId,
        signal,
        timeoutMs: req.timeoutMs,
        maxUsd: attemptMaxUsd,
        cgroupProcsPath,
      });

      const parsed = parseOpencodeStream(outcome.transcript);
      const artifacts = await this.writeArtifacts({
        runDir,
        workspaceRoot: resolvedWorkspace,
        transcript: outcome.transcript,
      });
      const events = this.finishEvents(parsed.events, outcome.reason);
      const version = (await this.opencodeVersion()) ?? undefined;
      const providerMeta: Record<string, unknown> = {
        model: parsed.model ?? this.model,
        sessionId: parsed.sessionId,
        steps: parsed.stepCount,
        toolCalls: parsed.invocations.length,
        broker: {
          requests: broker.requestCount,
          upstream: broker.logs.map(
            (entry) =>
              `${entry.method} ${entry.path} ${String(entry.status)} ${String(entry.bytes)}b ${String(entry.durationMs)}ms${entry.denied === undefined ? '' : ` deny:${entry.denied}`}`,
          ),
        },
      };

      const common: BuildFields = {
        status: 'succeeded',
        summary: '',
        artifacts,
        events,
        usage: parsed.usage,
        providerMeta,
        toolInvocations: parsed.invocations,
        runtimeVersion: version,
      };

      if (outcome.reason === 'aborted') {
        return this.build({
          ...common,
          status: 'cancelled',
          summary: 'Cancelled by the caller; the process group was terminated',
        });
      }

      if (outcome.reason === 'timeout') {
        return this.build({
          ...common,
          status: 'timeout',
          summary: `Exceeded the ${req.timeoutMs}ms budget; the process group was terminated`,
          error: {
            code: 'TIMEOUT',
            message: `timeoutMs=${req.timeoutMs} elapsed`,
            retryable: true,
          },
        });
      }

      const spent = parsed.usage.usd ?? 0;

      if (outcome.reason === 'cost-cap' || spent > attemptMaxUsd) {
        return this.build({
          ...common,
          status: 'failed',
          summary: `Spend cap of $${attemptMaxUsd.toFixed(2)} reached after $${spent.toFixed(6)}; run terminated`,
          error: {
            code: 'COST_CAP_EXCEEDED',
            message: `maxUsd=${attemptMaxUsd} exceeded (reported $${spent.toFixed(6)})`,
            retryable: false,
          },
        });
      }

      if (outcome.exitCode === CGROUP_PLACEMENT_EXIT) {
        // The sandbox refused to start because it could not join its cgroup. It never
        // ran, so this is not an agent failure and must not be retried as one.
        return this.build({
          ...common,
          status: 'failed',
          summary: 'Refused to start: the sandbox could not be placed in its cgroup',
          error: {
            code: 'CGROUP_PLACEMENT_FAILED',
            message:
              'The placement wrapper could not write its pid to cgroup.procs and exited ' +
              `${String(CGROUP_PLACEMENT_EXIT)} without executing the agent. An unplaceable ` +
              'sandbox is not started at all.',
            retryable: false,
          },
        });
      }

      if (outcome.exitCode !== 0) {
        const tail = redactAndTruncate(
          outcome.stderr.trim().length > 0
            ? outcome.stderr.trim()
            : `opencode exited ${String(outcome.exitCode)} with no stderr`,
          2000,
        );

        // Distinguish "the credential channel failed" from "the model produced
        // something the agent did not like". Both exit non-zero; only one is a
        // platform fault. The health probe is excluded: it is proof the broker is up,
        // not proof that a model call reached it.
        const transport = broker.logs.filter((entry) => entry.path !== HEALTH_PATH);
        const tokenRefusal = transport.find((entry) => entry.denied === 'token');
        const credentialRefusal = transport.find((entry) => entry.denied === 'credential');

        if (tokenRefusal !== undefined) {
          return this.build({
            ...common,
            status: 'failed',
            summary: 'The egress broker refused this attempt\'s capability token',
            error: {
              code: 'BROKER_FORBIDDEN',
              message:
                'The broker rejected the per-attempt capability token. This is a platform ' +
                'defect, not a model failure: no request left the host.',
              retryable: false,
            },
          });
        }

        if (credentialRefusal !== undefined) {
          return this.build({
            ...common,
            status: 'failed',
            summary: 'The egress broker could not read a provider credential',
            error: {
              code: 'BROKER_CREDENTIAL_UNAVAILABLE',
              message:
                'The host broker refused to authorise the model call because it could not read ' +
                'the provider credential. Fix the credential source; retrying cannot. ' +
                'Nothing egressed without it.',
              retryable: false,
            },
          });
        }

        // The provider answered and refused. That is different from a broken repository:
        // an exhausted balance or an expired subscription is an operator action, and a
        // bare "exited 1" sends them looking in the wrong place. The status is not a
        // secret; the body is, so it is not included.
        const served = transport.filter((entry) => entry.denied === undefined);
        const statuses = served.map((entry) => entry.status);
        const refusal = [...statuses].reverse().find((status) => status >= 400);

        if (refusal !== undefined && !statuses.includes(200)) {
          return this.build({
            ...common,
            status: 'failed',
            summary: `The provider refused every model call (HTTP ${String(refusal)})`,
            error: {
              code: 'PROVIDER_REFUSED',
              message:
                `The upstream provider answered ${String(refusal)} for all ${String(served.length)} ` +
                'model request(s). The credential was injected and accepted by the transport, so ' +
                'this is a provider-side refusal (quota, balance, or entitlement), not a sandbox ' +
                'or broker defect.',
              retryable: refusal === 429 || refusal >= 500,
            },
          });
        }

        if (!transport.some((entry) => entry.denied === undefined)) {
          return this.build({
            ...common,
            status: 'failed',
            summary: 'No model request reached the egress broker',
            error: {
              code: 'BROKER_UNAVAILABLE',
              message: `The sandbox produced no brokered model call (${String(transport.length)} denied attempt(s)). There is no unproxied fallback. ${tail}`,
              retryable: true,
            },
          });
        }

        return this.build({
          ...common,
          status: 'failed',
          summary: `opencode exited ${String(outcome.exitCode)}`,
          error: {
            code: 'OPENCODE_EXIT_NONZERO',
            message: tail,
            // A transport failure is worth retrying; a broken repository is not.
            retryable: /ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|rate.?limit/i.test(tail),
          },
        });
      }

      return this.build({
        ...common,
        status: 'succeeded',
        summary: this.summarize(parsed, Date.now() - startedAt),
      });
    } catch (error) {
      return this.build({
        status: 'failed',
        summary: 'Adapter failure before the run produced a result',
        error: {
          code: 'ADAPTER_ERROR',
          message: redactAndTruncate(error instanceof Error ? error.message : String(error), 2000),
          retryable: false,
        },
      });
    } finally {
      await broker?.close();
    }
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private build(fields: BuildFields): ExecutionResult {
    return {
      status: fields.status,
      summary: redactAndTruncate(fields.summary, 4000),
      artifacts: [...(fields.artifacts ?? [])],
      events: [...(fields.events ?? [])],
      usage: fields.usage ?? {},
      runtimeId: OPENCODE_CLI_ID,
      simulated: false,
      ...(fields.error === undefined ? {} : { error: fields.error }),
      ...(fields.providerMeta === undefined ? {} : { providerMeta: fields.providerMeta }),
      ...(fields.toolInvocations === undefined
        ? {}
        : { toolInvocations: [...fields.toolInvocations] }),
      ...(fields.runtimeVersion === undefined ? {} : { runtimeVersion: fields.runtimeVersion }),
    };
  }

  private summarize(parsed: ParsedStream, durationMs: number): string {
    const cost = parsed.usage.usd === undefined ? 'cost unknown' : `$${parsed.usage.usd.toFixed(6)}`;
    const text = parsed.finalText.length > 0 ? ` | ${parsed.finalText}` : '';

    return `${parsed.invocations.length} tool call(s), ${parsed.stepCount} step(s), ${cost}, ${(durationMs / 1000).toFixed(1)}s${text}`;
  }

  private finishEvents(events: readonly ExecutionEvent[], reason: string): ExecutionEvent[] {
    return [
      ...events,
      {
        seq: events.length + 1,
        type: 'finished',
        at: new Date().toISOString(),
        message: `run finished: ${reason}`,
      },
    ];
  }

  private opencodeArgv(input: { taskId: string; goal: string }): string[] {
    // `--standalone` is a global flag (private server, no shared daemon on the host);
    // `--auto` belongs to `run`. Order matters and was measured.
    return [
      'opencode',
      '--standalone',
      'run',
      '--auto',
      '--model',
      `${BROKER_PROVIDER_ID}/${brokerModelKey(this.model)}`,
      '--format',
      'json',
      '--title',
      input.taskId,
      input.goal,
    ];
  }

  /**
   * What the agent can see.
   *
   * Four fixed mounts, all of them this run's own files: the entry shim, the node
   * installation, the generated config, and the broker socket directory. Nothing from
   * `$HOME` is mounted at all — not narrowed, not masked, absent. The state tree the
   * agent writes into is created empty inside the sandbox root. See
   * `buildRuntimeSandbox`, which is the single description of this layout.
   */
  private nodeRoot(): string {
    // `<nvm>/versions/node/v22/bin/node` -> `<nvm>/versions/node/v22`
    return dirname(dirname(resolve(process.execPath)));
  }

  private nodeBinDir(): string {
    return dirname(resolve(process.execPath));
  }

  private resolveBinary(): string | null {
    if (this.binaryOption !== undefined) return this.binaryOption;

    for (const directory of (process.env.PATH ?? '').split(':')) {
      if (directory.length === 0) continue;
      const candidate = join(directory, 'opencode');
      if (existsSync(candidate)) return candidate;
    }

    return null;
  }

  private async opencodeVersion(): Promise<string | null> {
    if (this.versionCache !== undefined && Date.now() - this.versionCache.at < 300_000) {
      return this.versionCache.value;
    }

    const binary = this.resolveBinary();
    if (binary === null) return null;

    try {
      const { stdout } = await execFileAsync(binary, ['--version'], { timeout: 20_000 });
      const value = stdout.trim().split('\n')[0]?.trim() ?? null;
      this.versionCache = { at: Date.now(), value };
      return value;
    } catch {
      this.versionCache = { at: Date.now(), value: null };
      return null;
    }
  }

  private async spawnAndCollect(input: {
    command: SandboxCommand;
    taskId: string;
    signal: AbortSignal;
    timeoutMs: number;
    /** `min(profile cap, deployment cap)`; the streamed check below uses this, not the adapter default. */
    maxUsd: number;
    /** Where the sandbox must land before it execs. Absent means no cgroup (rlimit-only). */
    cgroupProcsPath: string | undefined;
  }): Promise<{ transcript: string; stderr: string; exitCode: number; reason: KillReason }> {
    const transcript = new TranscriptBuffer();
    let stderr = '';
    let streamedCost = 0;

    const result = await runInProcessGroup({
      file: input.command.file,
      args: input.command.args,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      killGraceMs: this.killGraceMs,
      // Placement before exec, not after spawn: the wrapper writes its own pid and
      // then execs the sandbox in the same pid, so there is no unaccounted window.
      ...(input.cgroupProcsPath === undefined
        ? {}
        : { placement: { cgroupProcsPath: input.cgroupProcsPath } }),
      // The builder's scrubbed environment, not `process.env`. `--clearenv` governs the
      // command bwrap execs, not bwrap's own pid-1 env, so anything passed here is
      // readable at `/proc/1/environ` from inside the sandbox (audit F1).
      env: input.command.env,
      registerKill: (kill) => {
        // `cancel(taskId)` converges on the same kill path as a timeout or an abort.
        this.running.set(input.taskId, () => kill('aborted'));
      },
      onStdout: (chunk, kill) => {
        // Every line is redacted by the buffer before it can be persisted or parsed.
        transcript.push(chunk);

        // Spend is visible mid-stream; a cap that only runs after exit is not a cap.
        for (const match of chunk.toString('utf8').match(/"cost":\s*([0-9.]+)/g) ?? []) {
          const value = Number(match.split(':')[1]?.trim() ?? '0');
          if (Number.isFinite(value)) streamedCost += value;
        }

        if (streamedCost > input.maxUsd) kill('cost-cap');
      },
      onStderr: (chunk) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > STDERR_TAIL_BYTES) {
          stderr = stderr.slice(-STDERR_TAIL_BYTES);
        }
      },
    });

    this.running.delete(input.taskId);

    return {
      transcript: transcript.finish(),
      stderr,
      exitCode: result.exitCode,
      reason: result.reason,
    };
  }

  private async writeArtifacts(input: {
    runDir: string;
    workspaceRoot: string;
    transcript: string;
  }): Promise<ArtifactReference[]> {
    const artifacts: ArtifactReference[] = [];
    const transcriptPath = join(input.runDir, 'transcript.ndjson');
    // `spawnAndCollect` already redacted every line and capped the size; this is the
    // only bytes that are written, and the only bytes that are hashed.
    const transcript = Buffer.from(input.transcript, 'utf8');

    await writeFile(transcriptPath, transcript, { mode: 0o600 });
    artifacts.push({
      kind: 'transcript',
      uri: transcriptPath,
      checksum: sha256(transcript),
      sizeBytes: transcript.byteLength,
      mediaType: 'application/x-ndjson',
    });

    // The diff is produced by git **inside** the sandbox, never on the host: the
    // repository is agent-writable, so `.git/config` and `.git/hooks/*` are attacker
    // input. See `collectWorkspaceEvidence`.
    const evidence = await collectWorkspaceEvidence({
      workspaceRoot: input.workspaceRoot,
      ...(this.bwrapPath === undefined ? {} : { bwrapPath: this.bwrapPath }),
    });

    if (evidence !== null) {
      const diffPath = join(input.runDir, 'diff.patch');
      const bytes = Buffer.from(evidence.patch, 'utf8');

      await writeFile(diffPath, bytes, { mode: 0o600 });
      artifacts.push({
        kind: 'diff',
        uri: diffPath,
        checksum: sha256(bytes),
        sizeBytes: bytes.byteLength,
        mediaType: 'text/x-diff',
      });
    }

    return artifacts;
  }
}
