import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { WorkspaceError } from './errors';
import { repositoryPath } from './paths';

/**
 * The sandbox, as an argv builder plus one measurement function.
 *
 * `bubblewrap` is the isolation primitive on this host (no Docker — Phase 3
 * baseline §4). The builder emits an argv array and never formats a string that a
 * shell will re-parse. The caller spawns `{ file, args }` with `execFile`/`spawn` and
 * **never** `shell: true`.
 *
 * The one thing it executes is `bwrap --help`, once per binary and cached, to learn
 * whether this build understands `--rlimit-*`; emitting an option a binary does not
 * know fails every sandbox, so the flag set is measured rather than assumed.
 *
 * ## What is in the sandbox, and why
 *
 * | Path | Mode | Reason |
 * |---|---|---|
 * | `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64` | ro | the toolchain the agent runs (`node`, `git`, `sh`) |
 * | `/etc` | ro | CA roots, `/etc/passwd` for uid resolution; needed even with no network |
 * | `/proc`, `/dev` | virtual | `node` and `git` need both; `--dev` is a minimal tmpfs |
 * | `/tmp`, `/run` | tmpfs | scratch that dies with the run; `/run` so nothing can pin a socket |
 * | `<rootPath>/repo` → `/workspace` | **rw** | the only writable mount, and the only place a run may leave a trace |
 *
 * Network is unshared by default (`--unshare-net`). A run that needs a provider
 * channel must say so via `network: 'host'`, which is a decision a caller records,
 * not a default they inherit.
 */

export interface SandboxMount {
  readonly hostPath: string;
  /** Defaults to `hostPath`: mounts are same-path unless there is a reason not to be. */
  readonly containerPath?: string;
  /**
   * `ro` binds read-only; `ephemeral` reads the host path through an overlayfs whose
   * upper layer is an invisible tmpfs, so the process can write and the host never
   * changes; `rw` binds writable and is a decision that needs a reason.
   */
  readonly mode: 'ro' | 'ephemeral' | 'rw';
}

export interface SandboxOptions {
  /**
   * **Required.** The environment inside the sandbox: emitted as `--setenv` assignments
   * after `--clearenv`, and the only source of the values the host-side `bwrap` process
   * itself is allowed to inherit (see `sandboxSpawnEnv`).
   *
   * Required, not optional, and deliberately so. It used to default to `{}`, which made
   * "the caller forgot" indistinguishable from "the caller wants only the base
   * environment" — and the second interpretation is not the dangerous one. A caller that
   * omits a field gets a compile error instead of a sandbox whose pid 1 carries the
   * worker's entire environment.
   *
   * Keys matching `/KEY|TOKEN|SECRET|PASSWORD/i` are rejected: a caller cannot smuggle a
   * credential in through the env, because that is exactly how a secret reaches a log
   * line or a model transcript.
   */
  readonly env: Readonly<Record<string, string>>;
  /** Read-only mounts, usually provider config. This is how opencode reads its config. */
  readonly readOnlyMounts?: readonly SandboxMount[];
  /** Full mount list override for callers that need ephemeral state directories. */
  readonly mounts?: readonly SandboxMount[];
  /** Default `'blocked'`. `'host'` keeps the host netns and must be justified. */
  readonly network?: 'blocked' | 'host';
  /** Absolute path or bare name; resolved against `PATH` when bare. */
  readonly bwrapPath?: string;
  /** Appended verbatim (e.g. `--dir`). Never interpolated into a shell string. */
  readonly extraArgs?: readonly string[];
  /**
   * Resource ceilings expressed as `bwrap --rlimit-*`. Only emitted when the local
   * `bwrap` understands the flag: 0.11.1 on Ubuntu does **not**, and a builder that
   * emits an unknown option produces a sandbox that never starts. The caller pairs
   * this with the same limits set through `prlimit` in the entry wrapper, so the
   * ceiling is enforced on hosts either way.
   */
  readonly rlimits?: SandboxRlimits;
  /** Test seam: pretend the local bwrap does or does not know `--rlimit-*`. */
  readonly bwrapFeatures?: SandboxFeatures;
}

export interface SandboxRlimits {
  /** File descriptors. `RLIMIT_NOFILE`. */
  readonly nofile?: number;
  /** Processes/threads for the uid. `RLIMIT_NPROC` — per-uid on Linux, see entry wrapper. */
  readonly nproc?: number;
  /** Virtual address space in bytes. `RLIMIT_AS`. */
  readonly asBytes?: number;
  /** Largest file a process may create, in bytes. `RLIMIT_FSIZE`. */
  readonly fsize?: number;
}

export interface SandboxFeatures {
  /** True when `bwrap --help` lists `--rlimit-*`. Measured once per binary. */
  readonly rlimitFlags: boolean;
}

export interface SandboxCommand {
  readonly file: string;
  readonly args: readonly string[];
  /**
   * The environment the **`bwrap` process itself** is spawned with.
   *
   * This is not the sandbox's environment — that is `--clearenv` plus `--setenv`, and it
   * applies to the command bwrap execs. `bwrap` itself keeps whatever environment it was
   * given, and after `--unshare-pid` it (or its first child) is pid 1 in the new
   * namespace, where `/proc/1/environ` is world-readable from inside. Spawning bwrap
   * without an `env` therefore hands the whole worker environment to the agent: an
   * `.git/config` filter, a hook, or a `node -e` one-liner reads it back out.
   *
   * Carried on the command so there is no second, skippable step: `execFile(file, args,
   * { env: command.env })` is the only correct way to run it, and `execSandboxed` below
   * is the sanctioned helper that does exactly that.
   */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The only host environment a sandboxed spawn may inherit.
 *
 * `bwrap` needs none of these to run (it is resolved to an absolute path), but a process
 * with *no* environment at all is a surprising thing to debug, and locale-less children
 * produce mojibake in evidence. Everything else — credentials, `DATABASE_URL`, proxy
 * settings, the CI provider's tokens — stays on the host.
 */
const SPAWN_ENV_KEYS = ['PATH', 'LANG', 'HOME', 'TMPDIR'] as const;

/**
 * Build the host-side environment for a sandboxed spawn.
 *
 * Values come from the caller's declared environment when present, so `HOME` is the
 * sandbox's `HOME` and not the operator's, and fall back to `BASE_ENV`. Keys outside
 * `SPAWN_ENV_KEYS` are dropped rather than forwarded: the run's extras
 * (`IZ_BROKER_CAPABILITY`, config directories) are for the exec'd command, which receives
 * them through `--setenv`, and every variable present at pid 1 is readable by the agent.
 */
export function sandboxSpawnEnv(
  env: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const spawn: Record<string, string> = {};

  for (const key of SPAWN_ENV_KEYS) {
    const value = env[key] ?? BASE_ENV[key];
    if (value !== undefined) spawn[key] = value;
  }

  return spawn;
}

/** Rejected environment keys. An allowlist cannot leak what it refuses to carry. */
const SECRET_LIKE = /KEY|TOKEN|SECRET|PASSWORD/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const BASE_READ_ONLY = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/lib32', '/libx32'];
const BASE_ENV: Readonly<Record<string, string>> = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/tmp/home',
  TMPDIR: '/tmp',
  LANG: 'C.UTF-8',
  TERM: 'dumb',
};

function resolveExecutable(name: string): string | undefined {
  if (name.includes('/')) return existsSync(name) ? name : undefined;

  for (const directory of (process.env.PATH ?? '').split(':')) {
    if (directory.length === 0) continue;
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }

  return undefined;
}

/** Fail closed. An install without `bwrap` gets an error, never an unsandboxed run. */
export function resolveBwrap(bwrapPath?: string): string {
  const resolved = resolveExecutable(bwrapPath ?? 'bwrap');

  if (resolved === undefined) {
    throw new WorkspaceError(
      'SANDBOX_UNAVAILABLE',
      'bubblewrap (bwrap) is not installed; refusing to execute unsandboxed',
    );
  }

  return resolved;
}

function buildEnv(env: Readonly<Record<string, string>> | undefined): string[] {
  const args: string[] = [];

  for (const [key, value] of Object.entries({ ...BASE_ENV, ...env })) {
    if (!ENV_NAME.test(key)) {
      throw new WorkspaceError('SANDBOX_ENV_REJECTED', `Environment key ${key} is not a valid name`);
    }

    if (SECRET_LIKE.test(key)) {
      throw new WorkspaceError(
        'SANDBOX_ENV_REJECTED',
        `Environment key ${key} looks like a credential; pass secrets through a read-only mount`,
      );
    }

    args.push('--setenv', key, value);
  }

  return args;
}

/**
 * Which optional flags this `bwrap` understands, measured once per binary.
 *
 * `--rlimit-nofile` is not universal: bubblewrap 0.11.1 as shipped by Ubuntu does not
 * parse it, and passing an unknown option makes every sandbox fail to start. A builder
 * that assumes the flag has turned a resource control into an outage, so the answer is
 * probed rather than assumed. `--help` is the cheapest capability query bwrap offers
 * and it does not require privileges.
 */
const featureCache = new Map<string, SandboxFeatures>();

export function bwrapFeatures(bwrapPath: string): SandboxFeatures {
  const cached = featureCache.get(bwrapPath);
  if (cached !== undefined) return cached;

  let rlimitFlags = false;

  try {
    const probe = spawnSync(bwrapPath, ['--help'], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });

    rlimitFlags = probe.status === 0 && (probe.stdout ?? '').includes('--rlimit-nofile');
  } catch {
    // A probe that cannot run is not evidence of support. Fail closed: omit the flag.
    rlimitFlags = false;
  }

  const features: SandboxFeatures = { rlimitFlags };
  featureCache.set(bwrapPath, features);

  return features;
}

function rlimitArgs(limits: SandboxRlimits | undefined): string[] {
  if (limits === undefined) return [];

  const args: string[] = [];
  const pairs: readonly (readonly [keyof SandboxRlimits, string])[] = [
    ['nofile', '--rlimit-nofile'],
    ['nproc', '--rlimit-nproc'],
    ['asBytes', '--rlimit-as'],
    ['fsize', '--rlimit-fsize'],
  ];

  for (const [key, flag] of pairs) {
    const value = limits[key];
    if (value === undefined) continue;

    if (!Number.isInteger(value) || value <= 0) {
      throw new WorkspaceError(
        'SANDBOX_COMMAND_INVALID',
        `rlimit ${key} must be a positive integer, received ${String(value)}`,
      );
    }

    args.push(flag, String(value));
  }

  return args;
}

/**
 * Build the `bwrap` invocation for one workspace.
 *
 * @param workspace anything with a `rootPath`; a full `WorkspaceHandle` satisfies it.
 * @param argv the command to run inside, as separate arguments.
 */
export function buildSandboxCommand(
  workspace: { readonly rootPath: string },
  argv: readonly string[],
  options: SandboxOptions,
): SandboxCommand {
  if (argv.length === 0) {
    throw new WorkspaceError('SANDBOX_COMMAND_INVALID', 'Refusing to build a sandbox with no command');
  }

  const file = resolveBwrap(options.bwrapPath);
  const repoPath = repositoryPath(workspace.rootPath);
  const args: string[] = [];

  for (const path of BASE_READ_ONLY) {
    if (existsSync(path)) args.push('--ro-bind', path, path);
  }

  // Read-only, and not excluded: `/etc/ssl` and `/etc/resolv.conf` are needed for
  // TLS verification and for the provider channel, and a read-only bind is not a
  // write path. Secrets are not in `/etc` here; they are in `$HOME`, which is a tmpfs.
  args.push('--ro-bind', '/etc', '/etc');
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run');
  args.push('--dir', '/tmp/home');

  args.push('--bind', repoPath, '/workspace');

  for (const mount of [...(options.readOnlyMounts ?? []), ...(options.mounts ?? [])]) {
    const target = mount.containerPath ?? mount.hostPath;

    if (mount.mode === 'ro') args.push('--ro-bind', mount.hostPath, target);
    else if (mount.mode === 'rw') args.push('--bind', mount.hostPath, target);
    else args.push('--overlay-src', mount.hostPath, '--tmp-overlay', target);
  }

  args.push('--unshare-pid', '--unshare-ipc', '--unshare-uts');
  if ((options.network ?? 'blocked') === 'blocked') args.push('--unshare-net');
  args.push('--new-session', '--die-with-parent');

  // Emitted only when this bwrap knows the flag; the entry wrapper sets the same
  // ceilings through `prlimit`, so a host without support still gets them.
  const features = options.bwrapFeatures ?? bwrapFeatures(file);
  if (features.rlimitFlags) args.push(...rlimitArgs(options.rlimits));

  args.push('--clearenv', ...buildEnv(options.env));
  args.push(...(options.extraArgs ?? []));
  args.push('--chdir', '/workspace');
  args.push(...argv);

  return { file, args, env: sandboxSpawnEnv(options.env) };
}

/**
 * The sanctioned way to execute a `SandboxCommand` from the host.
 *
 * It exists so the spawn environment is not a thing a caller can forget: the `env` comes
 * from the command, which `buildSandboxCommand` derived from the caller's allowlist, and
 * this helper is the only place in the package that spawns a sandbox with arguments a
 * caller controls. `execFile` with `env: command.env` and never `shell: true`.
 *
 * Rejects on a non-zero exit, matching `child_process.execFile`'s promise contract:
 * callers that treat "not a git repository" as *no evidence* catch, and callers that
 * treat it as a failure let it propagate.
 */
export function execSandboxed(
  command: SandboxCommand,
  options: { readonly timeoutMs: number; readonly maxBuffer: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      command.file,
      [...command.args],
      {
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        encoding: 'utf8',
        env: command.env,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }

        resolvePromise({ stdout, stderr });
      },
    );
  });
}

export interface SandboxProbeResult {
  /** True means no IP egress from inside the sandbox — measured, not declared. */
  readonly networkBlocked: boolean;
  /** True means a write to `/workspace` succeeds. */
  readonly canWriteWorkspace: boolean;
  /** True means a write to `/etc/x` fails with a read-only filesystem. */
  readonly rootReadOnly: boolean;
  /** Raw evidence, truncated. Printed by the real-run script. */
  readonly evidence: Readonly<Record<string, string>>;
}

interface RunOutcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

function run(command: SandboxCommand, timeoutMs: number): Promise<RunOutcome> {
  return new Promise((resolvePromise) => {
    execFile(
      command.file,
      [...command.args],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8', env: command.env },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof (error as { code?: unknown }).code === 'number'
            ? ((error as { code?: number }).code ?? null)
            : null;

        resolvePromise({
          code,
          stdout,
          stderr,
          timedOut: Boolean((error as { killed?: boolean } | null)?.killed),
        });
      },
    );
  });
}

/**
 * Measure what the sandbox can actually do by running commands inside it.
 *
 * Every capability the adapter declares is traceable to this function. A probe that
 * cannot run is not a pass: `networkBlocked` is only true when the egress attempt
 * failed **and** the probe itself worked, so a missing `bash` cannot masquerade as
 * isolation.
 */
export async function probeSandbox(
  workspace: { readonly rootPath: string },
  // The default is an **empty allowlist**, not an inherited one: a capability probe needs
  // no environment beyond the builder's own `BASE_ENV`, and `{ env: {} }` is the only
  // safe default for a function that exists to measure isolation. It is still passed to
  // the builder explicitly — the builder has no default of its own.
  options: SandboxOptions = { env: {} },
): Promise<SandboxProbeResult> {
  const evidence: Record<string, string> = {};
  const build = (argv: readonly string[]): SandboxCommand =>
    buildSandboxCommand(workspace, argv, options);

  const network = await run(
    build([
      '/usr/bin/bash',
      '-c',
      'if (exec 3<>/dev/tcp/1.1.1.1/443) 2>/dev/null; then echo REACHABLE; else echo BLOCKED; fi',
    ]),
    20_000,
  );
  const curl = await run(
    build(['/usr/bin/curl', '-sS', '-m', '4', '-o', '/dev/null', 'https://example.com']),
    20_000,
  );

  evidence.network = `tcp/443 => ${network.stdout.trim() || 'no-output'} (exit ${String(network.code)}); curl => exit ${String(curl.code)} ${curl.stderr.trim().slice(0, 160)}`;

  const write = await run(
    build([
      '/bin/sh',
      '-c',
      'echo probe > /workspace/.intelligenz-probe && rm -f /workspace/.intelligenz-probe && echo WROTE',
    ]),
    20_000,
  );

  evidence.workspaceWrite = `${write.stdout.trim()} (exit ${String(write.code)}) ${write.stderr.trim().slice(0, 160)}`;

  const rootWrite = await run(
    build(['/bin/sh', '-c', 'echo pwned > /etc/intelligenz-probe && echo WROTE']),
    20_000,
  );

  evidence.rootWrite = `exit ${String(rootWrite.code)} ${rootWrite.stderr.trim().slice(0, 160)}`;

  return {
    networkBlocked: network.stdout.includes('BLOCKED') && curl.code !== 0,
    canWriteWorkspace: write.stdout.includes('WROTE'),
    rootReadOnly: rootWrite.code !== 0 && !rootWrite.stdout.includes('WROTE'),
    evidence,
  };
}
