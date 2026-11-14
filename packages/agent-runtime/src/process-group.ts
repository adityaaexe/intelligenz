import { spawn } from 'node:child_process';

/**
 * One child, one process group, one deadline.
 *
 * This is the *only* place the adapter kills a running agent, and it is a separate
 * module because the interesting property — that a forked grandchild dies with its
 * parent — is not something a comment can establish. `test/process-group.test.ts`
 * starts a shell that backgrounds a `sleep`, kills the group, and then checks after the
 * sleep would have fired that it wrote nothing.
 *
 * ## Why a process group
 *
 * The child is spawned `detached: true`, which makes it a session and group leader.
 * Every descendant inherits the group id unless it calls `setsid()`, and the sandbox
 * adds `--unshare-pid` and `--die-with-parent`, so there are two independent reasons a
 * grandchild cannot outlive the run: the group signal and the PID namespace teardown.
 * Signalling `-pid` (the group) instead of `pid` is what makes the first one work.
 *
 * ## Why `SIGTERM` then `SIGKILL`
 *
 * A model call should get the chance to close its socket; a shell loop must not be able
 * to ignore the request forever. The grace window is bounded and unref'd so it cannot
 * hold the process open by itself.
 */

export type KillReason = 'exit' | 'aborted' | 'timeout' | 'cost-cap';

/**
 * Exit code the placement wrapper uses when it could not join its cgroup. Distinct from
 * every code the agent could produce so a placement failure is never read as an agent
 * failure (see `apps/worker/src/termination.ts`: it maps to `workspace_error`).
 */
export const CGROUP_PLACEMENT_EXIT = 97;

export interface GroupedProcessOptions {
  readonly file: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  /** Grace between `SIGTERM` and `SIGKILL`. */
  readonly killGraceMs: number;
  /**
   * Move the process into a cgroup **before** it execs.
   *
   * This is the only race-free placement. Writing `cgroup.procs` from the parent after
   * `spawn()` returns is a window in which the sandbox exists and is unaccounted for —
   * short, but a fork bomb does not need a long window. Instead the spawned program is
   * a three-line `/bin/sh` that writes **its own pid** into the cgroup and then `exec`s
   * the real command in the same pid: a shell that has not forked cannot have produced a
   * child outside the cgroup, and `exec` preserves both the pid and the membership.
   *
   * The path is passed as `$1`, never interpolated into the script text.
   */
  readonly placement?: { readonly cgroupProcsPath: string };
  /**
   * The environment the sandbox process inherits.
   *
   * Optional, and the default is itself an allowlist (`PATH` + `LANG`), never
   * `process.env`. The production caller does not rely on it: `spawnAndCollect` passes
   * `SandboxCommand.env`, which `buildSandboxCommand` derived from the caller's declared
   * environment. `--clearenv` inside `bwrap` applies to the command it execs, not to the
   * `bwrap` process itself — pid 1 in the sandbox's pid namespace, readable at
   * `/proc/1/environ` — so what is passed here must be scrubbed (audit F1).
   */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Called once with the kill function, right after spawn. `cancel(taskId)` uses it to
   * converge a caller-initiated cancellation on the same group kill a timeout uses.
   */
  readonly registerKill?: (kill: (reason: KillReason) => void) => void;
  /** Called for every stdout chunk. `kill` terminates the whole group and records
   * `reason` — that is how a spend cap becomes real mid-stream instead of a check
   * after the fact. */
  readonly onStdout?: (chunk: Buffer, kill: (reason: KillReason) => void) => void;
  readonly onStderr?: (chunk: Buffer) => void;
}

export interface GroupedProcessResult {
  readonly exitCode: number;
  readonly reason: KillReason;
}

export function runInProcessGroup(options: GroupedProcessOptions): Promise<GroupedProcessResult> {
  return new Promise((resolvePromise) => {
    const spawnTarget = withPlacement(options);

    const child = spawn(spawnTarget.file, spawnTarget.args, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env ?? { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' },
    });

    let reason: KillReason = 'exit';
    let killed = false;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;

    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;

      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      options.signal.removeEventListener('abort', onAbort);
      resolvePromise({ exitCode, reason });
    };

    const kill = (next: KillReason): void => {
      if (killed || child.pid === undefined) return;

      killed = true;
      reason = next;

      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }

      graceTimer = setTimeout(() => {
        if (child.pid === undefined) return;

        try {
          // SIGKILL to the group: a descendant that ignored SIGTERM does not get to
          // decide how long the run lasts.
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, options.killGraceMs);
      graceTimer.unref();
    };

    const onAbort = (): void => kill('aborted');

    const timer = setTimeout(() => kill('timeout'), options.timeoutMs);
    options.signal.addEventListener('abort', onAbort, { once: true });

    options.registerKill?.(kill);

    child.stdout?.on('data', (chunk: Buffer) => options.onStdout?.(chunk, kill));
    child.stderr?.on('data', (chunk: Buffer) => options.onStderr?.(chunk));

    child.on('error', () => {
      // A spawn failure has no exit code and no stderr of its own; the caller reports
      // it from the result. Treated as an immediate non-zero exit.
      finish(1);
    });

    child.on('close', (code) => finish(code ?? 1));
  });
}

/**
 * The three-line placement wrapper.
 *
 * `$$` is the shell's own pid, which is the pid `child_process` returned and the pid
 * that survives `exec` — so the cgroup membership established here is the membership of
 * the sandbox and of every process it ever forks. `shift` drops the path, `exec "$@"`
 * replaces the shell without forking.
 *
 * If the write fails the shell exits 97 and the command never runs: an unplaced sandbox
 * is not started at all, which is the only acceptable outcome when the alternative is an
 * unbounded one.
 */
function withPlacement(options: GroupedProcessOptions): {
  file: string;
  args: readonly string[];
} {
  if (options.placement === undefined) {
    return { file: options.file, args: options.args };
  }

  const script = ['printf "%s\\n" "$$" > "$1" || exit 97', 'shift', 'exec "$@"'].join('; ');

  return {
    file: '/bin/sh',
    args: [
      '-c',
      script,
      'intelligenz-cgroup',
      options.placement.cgroupProcsPath,
      options.file,
      ...options.args,
    ],
  };
}
