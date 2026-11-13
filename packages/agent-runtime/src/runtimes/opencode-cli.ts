import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';

import {
  assertContained,
  buildSandboxCommand,
  type SandboxMount,
} from '@intelligenz/workspace-manager';

import { RuntimeConfigurationError } from '../errors';
import { redact, redactAndTruncate } from '../redact';
import { runInProcessGroup, type KillReason } from '../process-group';
import { startEgressProxy, type EgressProxy } from '../sandbox/egress-proxy';
import { parseOpencodeStream, type ParsedStream } from './opencode-stream';
import { SANDBOX_ENTRY_SOURCE } from '../sandbox/entry-source';
import { buildOpencodeStateMounts } from '../sandbox/state-mounts';
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
 * ## The one non-obvious design decision: how the model is reached
 *
 * `--unshare-net` gives the sandbox a network namespace with nothing in it. That is
 * what makes `network: false` true rather than aspirational — but a model call needs
 * the internet, and the model call happens in the same process as the agent.
 *
 * The resolution is a split, not a compromise:
 *
 * ```
 *   bwrap --unshare-net
 *     └── node sandbox-entry.mjs          loopback only
 *           └── opencode --HTTPS_PROXY--> 127.0.0.1:8888
 *                                          │ (unix socket bound into the sandbox)
 *                                          ▼
 *                                        host egress proxy --allowlist--> provider
 * ```
 *
 * Every process the agent can spawn — its shell tool, `curl`, `git`, a script it
 * writes — has no route to anything. Provider traffic leaves through a unix socket
 * that the agent cannot use to reach a host outside the allowlist, and only on 443.
 * `probeSandbox()` measures the block; `EgressProxy.requests` records what was
 * actually reached.
 *
 * ## What this adapter refuses to do
 *
 * - **No workspace, no run.** A request without `workspaceRoot` fails with
 *   `WORKSPACE_REQUIRED`; it never falls back to the process's own cwd.
 * - **No workspace outside the root.** `workspaceRoot` must resolve inside
 *   `WORKSPACE_ROOT`, so a caller cannot point it at the host checkout.
 * - **No unsandboxed fallback.** A missing `bwrap` throws; it does not run anyway.
 * - **No `shell: true`.** Every process is spawned with an argv array.
 * - **No host process against agent-controlled content.** Post-run `git` runs inside
 *   the same sandbox profile as the run itself; see `collectWorkspaceEvidence`.
 */

export const OPENCODE_CLI_ID = 'opencode-cli';

const DEFAULT_MODEL = 'commandcode/deepseek/deepseek-v4-flash';

/**
 * A real adapter with no spend cap is an unlimited purchase order, not a configuration.
 * The worker also defaults `AGENT_MAX_USD` to this value; the constructor default exists
 * so a caller cannot omit the cap and get an uncapped run by accident.
 */
const DEFAULT_MAX_USD = 0.5;

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
] as const;

/**
 * Provider hosts, exactly.
 *
 * `opencode.ai` serves model metadata and session sync; `api.commandcode.ai` serves
 * the completion. Anything else is denied by the proxy and shows up in the report as a
 * `deny` line. Matching is exact — no wildcard — and the tunnel port is fixed at 443.
 */
const DEFAULT_ALLOW_HOSTS = ['opencode.ai', 'api.commandcode.ai'] as const;

/**
 * A budget smaller than this cannot be honoured: spawning `bwrap`, `node` and
 * `opencode` costs more than a few milliseconds, so a 1 ms budget is already spent
 * before the first byte. Returning `timeout` is the honest answer — spawning anyway
 * would overspend the budget just to prove it.
 */
const SPAWN_FLOOR_MS = 50;

const STDERR_TAIL_BYTES = 8 * 1024;

export interface OpencodeCliRuntimeOptions {
  /**
   * The containment boundary (`WORKSPACE_ROOT`). Every `req.workspaceRoot` must
   * resolve inside it. Required: an adapter that guesses its boundary has none.
   */
  readonly workspaceRoot: string;
  /** Where transcripts and diffs are written (`ARTIFACT_ROOT`). Required. */
  readonly artifactsRoot: string;
  /** Provider-qualified model id. */
  readonly model?: string;
  /** `opencode` executable. Resolved on `PATH` when omitted. */
  readonly binary?: string;
  /** `bwrap` executable. Resolved on `PATH` when omitted. */
  readonly bwrapPath?: string;
  /** Host `XDG_DATA_HOME`; `opencode.db` (and therefore the credential) lives here. */
  readonly dataHome?: string;
  /** Host `XDG_STATE_HOME`. */
  readonly stateHome?: string;
  /** Host `XDG_CACHE_HOME` (model catalogue cache). */
  readonly cacheHome?: string;
  /** Host `XDG_CONFIG_HOME`. Only a legacy `opencode/auth.json` is ever mounted. */
  readonly configHome?: string;
  /** Provider hosts the proxy may tunnel to. Defaults to the CommandCode pair. */
  readonly allowHosts?: readonly string[];
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

function toAbsolute(path: string, base: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
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
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      },
    });

    const { stdout } = await execFileAsync(command.file, [...command.args], {
      timeout,
      maxBuffer,
    });

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
  private readonly binaryOption: string | undefined;
  private readonly bwrapPath: string | undefined;
  private readonly dataHome: string;
  private readonly stateHome: string;
  private readonly cacheHome: string;
  private readonly configHome: string;
  private readonly allowHosts: readonly string[];
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

    this.workspaceRoot = resolve(options.workspaceRoot);
    this.artifactsRoot = resolve(options.artifactsRoot);
    this.model = options.model ?? DEFAULT_MODEL;
    this.binaryOption = options.binary;
    this.bwrapPath = options.bwrapPath;
    this.dataHome = toAbsolute(options.dataHome ?? '.local/share', homedir());
    this.stateHome = toAbsolute(options.stateHome ?? '.local/state', homedir());
    this.cacheHome = toAbsolute(options.cacheHome ?? '.cache', homedir());
    this.configHome = toAbsolute(options.configHome ?? '.config', homedir());
    this.allowHosts = options.allowHosts ?? DEFAULT_ALLOW_HOSTS;
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
   * `network: false` means: no general egress. Every process the agent can spawn runs
   * in a network namespace with no interfaces, so TCP, UDP and DNS all fail, and
   * `probeSandbox()` measures that rather than trusting this comment.
   *
   * It does **not** mean "the agent cannot speak to the network at all". The model
   * transport is a second, separate channel owned by this adapter: a unix socket bound
   * into the sandbox that terminates at a host proxy which accepts `CONNECT` only to an
   * exact allowlist of provider hosts and **only on port 443**. The agent can speak
   * proxy protocol to that socket; it cannot use it to reach any other host or any other
   * port, and it cannot reach the internet directly. Precisely: *no general egress;
   * model traffic only via an allowlisted 443 proxy; all other sockets blocked.*
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

    const credential = await this.hasCredential();

    return {
      status: credential ? 'ok' : 'degraded',
      simulated: false,
      checkedAt,
      latencyMs: Date.now() - startedAt,
      detail: credential
        ? `opencode ${version}; credential present; sandbox enforced by bwrap`
        : `opencode ${version}; no stored credential`,
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

    const runId = `${req.taskId}-${startedAt.toString(36)}`;
    const runDir = join(this.artifactsRoot, OPENCODE_CLI_ID, runId);
    const configDir = join(runDir, 'config');
    const egressDir = join(runDir, 'egress');

    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await mkdir(egressDir, { recursive: true, mode: 0o700 });

    // A minimal config, generated per run. Not `$HOME/.config/opencode`: that file
    // configures seventeen MCP servers and several plugins the agent must not have.
    // What the agent gets is the model and nothing else.
    await writeFile(join(configDir, 'opencode.json'), `${JSON.stringify({ model: this.model })}\n`, {
      mode: 0o600,
    });

    let proxy: EgressProxy | undefined;

    try {
      proxy = await startEgressProxy({ socketDir: egressDir, allowHosts: this.allowHosts });

      // The shim is materialised per run and mounted read-only at a fixed path, so the
      // agent can neither read it from its checkout nor modify it for the next run.
      const entryDir = join(runDir, 'entry');
      const entryFile = join(entryDir, 'sandbox-entry.mjs');
      const entryContainer = '/opt/agent/sandbox-entry.mjs';

      await mkdir(entryDir, { recursive: true, mode: 0o700 });
      await writeFile(entryFile, SANDBOX_ENTRY_SOURCE, { mode: 0o500 });

      const { mounts, dirs, masks } = await this.mountsFor({ configDir, egressDir, entryDir });
      const argv = [
        'node',
        entryContainer,
        ...this.opencodeArgv({ taskId: req.taskId, goal: req.goal }),
      ];

      const command = buildSandboxCommand({ rootPath: resolvedWorkspace }, argv, {
        bwrapPath: this.bwrapPath,
        // No IP route out of the sandbox. The model channel is the unix socket, which
        // is not a route to the internet — the proxy decides what it may reach: an
        // exact allowlisted host, port 443, nothing else.
        network: 'blocked',
        env: {
          PATH: `${this.nodeBinDir()}:/usr/local/bin:/usr/bin:/bin`,
          OPENCODE_CONFIG_DIR: '/cfg',
          XDG_DATA_HOME: '/xdg-data',
          XDG_STATE_HOME: '/xdg-state',
          XDG_CACHE_HOME: '/xdg-cache',
          XDG_CONFIG_HOME: '/xdg-config',
          AGENT_PROXY_SOCKET: '/run/agent-egress/egress.sock',
          AGENT_PROXY_PORT: '8888',
          // Ceilings the entry wrapper applies with `prlimit`. `bwrap` on this host
          // does not parse `--rlimit-*`, so these env values are the enforcement path;
          // the builder emits the flags too on a bwrap that supports them.
          AGENT_RLIMIT_NOFILE: '1024',
          AGENT_RLIMIT_NPROC: '4096',
          AGENT_RLIMIT_AS: String(6 * 1024 * 1024 * 1024),
          OPENCODE_DISABLE_AUTOUPDATE: '1',
          CI: '1',
        },
        mounts,
        // The XDG base directories exist even when nothing is mounted over them, so
        // opencode can write its own state into an ephemeral path instead of failing
        // or writing into the (read-only) root. The masks come after the overlay so a
        // directory of operator output is replaced by an empty, writable tmpfs.
        extraArgs: [
          ...masks.flatMap((mask) => ['--tmpfs', mask]),
          ...dirs.flatMap((dir) => ['--dir', dir]),
        ],
      });

      const outcome = await this.spawnAndCollect({
        command,
        taskId: req.taskId,
        signal,
        timeoutMs: req.timeoutMs,
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
        egress: proxy.requests.map(
          (entry) =>
            `${entry.method} ${entry.host}:${String(entry.port)} ${entry.allowed ? 'allow' : 'deny'}`,
        ),
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

      if (outcome.reason === 'cost-cap' || spent > this.maxUsd) {
        return this.build({
          ...common,
          status: 'failed',
          summary: `Spend cap of $${this.maxUsd.toFixed(2)} reached after $${spent.toFixed(6)}; run terminated`,
          error: {
            code: 'COST_CAP_EXCEEDED',
            message: `maxUsd=${this.maxUsd} exceeded (reported $${spent.toFixed(6)})`,
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
      await proxy?.close();
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
      this.model,
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
   * Four fixed mounts (the entry shim, the node installation, the per-run config, the
   * egress socket) plus the opencode state allowlist from `buildOpencodeStateMounts`.
   * **Nothing from `$HOME` is mounted wholesale** — see that module for what used to be
   * exposed and why the list below is the minimum that authenticates and runs.
   */
  private async mountsFor(input: {
    configDir: string;
    egressDir: string;
    entryDir: string;
  }): Promise<{ mounts: SandboxMount[]; dirs: string[]; masks: string[] }> {
    const mounts: SandboxMount[] = [
      { hostPath: input.entryDir, containerPath: '/opt/agent', mode: 'ro' },
      // The node installation that also contains `opencode`. Read-only: the agent must
      // not be able to modify its own runtime.
      { hostPath: this.nodeRoot(), mode: 'ro' },
      { hostPath: input.configDir, containerPath: '/cfg', mode: 'ro' },
      // Connecting to a unix socket needs no write access, and a read-only bind means
      // the agent cannot replace the socket with one of its own.
      { hostPath: input.egressDir, containerPath: '/run/agent-egress', mode: 'ro' },
    ];

    const state = await buildOpencodeStateMounts({
      dataHome: this.dataHome,
      stateHome: this.stateHome,
      cacheHome: this.cacheHome,
      configHome: this.configHome,
    });

    return { mounts: [...mounts, ...state.mounts], dirs: state.dirs, masks: state.masks };
  }

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

  /**
   * `opencode auth list` prints integration names, never secrets. Presence of a
   * `stored` credential is the only fact extracted; the value is never read.
   */
  private async hasCredential(): Promise<boolean> {
    const binary = this.resolveBinary();
    if (binary === null) return false;

    try {
      const { stdout } = await execFileAsync(binary, ['--standalone', 'auth', 'list'], {
        timeout: 45_000,
        env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: '1' },
      });

      return /\bstored\b|\benvironment\b/.test(stdout);
    } catch {
      return false;
    }
  }

  private async spawnAndCollect(input: {
    command: { file: string; args: readonly string[] };
    taskId: string;
    signal: AbortSignal;
    timeoutMs: number;
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
      // bwrap inherits this, then `--clearenv` inside drops all of it. Passing a
      // minimal env means even a bwrap bug would not forward the host's secrets.
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' },
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

        if (streamedCost > this.maxUsd) kill('cost-cap');
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
