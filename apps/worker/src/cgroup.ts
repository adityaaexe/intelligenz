import { mkdir, readFile, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * cgroup v2, as ten file operations and no privilege.
 *
 * Everything here runs as the worker's own user. There is no `sudo`, no `setuid`
 * helper, no privileged syscall: the delegation boundary is established once by
 * `infra/scripts/setup-cgroups.sh` (root), and this module only writes files inside
 * the subtree it was given. A cgroup is a directory and a limit is a file, so the
 * privilege model is the filesystem's.
 *
 * ## Why a per-attempt cgroup and not rlimits
 *
 * `RLIMIT_AS` bounds one process's address space. A run that forks three children has
 * three address spaces, and a run that forks a thousand has a thousand: the aggregate
 * is unbounded, which is exactly the fork-bomb case a resource limit exists for.
 * `memory.max` on a cgroup bounds the **sum** of every process in it, `pids.max` bounds
 * the count, and `cpu.max` bounds the rate. Those are aggregate statements; rlimits are
 * not.
 *
 * ## The escape argument
 *
 * 1. Membership is inherited at `fork()`. A process cannot leave a cgroup it did not
 *    join, and there is no `fork` that produces a child outside its parent's cgroup.
 * 2. Changing membership requires writing `cgroup.procs` in the **destination** — a
 *    file inside `/sys/fs/cgroup`, which is not present in the sandbox's mount
 *    namespace. `bwrap` builds a fresh mount namespace from an explicit bind list
 *    (`/usr`, `/bin`, `/lib*`, `/etc`, `/proc`, `/dev`, `/tmp`, `/run`, one rw bind for
 *    `/workspace`); `/sys` is not on it, measured in `test/cgroup-escape.test.ts`.
 * 3. `--unshare-pid` means a descendant cannot be reparented outside the sandbox, and
 *    `--die-with-parent` means the tree dies when `bwrap` does.
 * 4. `cgroup.kill` is the backstop: it kills every process in the cgroup and every
 *    descendant cgroup atomically, which is what makes "the run is over" true even if a
 *    process is stuck in uninterruptible sleep.
 *
 * The one thing this module deliberately cannot do is **widen** the boundary:
 * `cgroup.subtree_control` on the delegation root is left root-owned by the setup
 * script. A worker bug can mis-set a limit; it cannot grant itself a controller.
 */

/** `<root>/<id>` — one directory per attempt, nothing else. */
export const DEFAULT_CGROUP_ROOT = '/sys/fs/cgroup/intelligenz';

/** `cgroup.procs` accepts one pid per write; `cpu.max` is `quota period`. */
const CPU_PERIOD_DEFAULT_US = 100_000;

/**
 * A cgroup id must be one path segment. Same allowlist as `workspace-manager`'s
 * `safeSegment`, duplicated rather than imported because this module must stay usable
 * from the reaper, which has no workspace handle — and because a path built from a
 * database value is a path an attacker may have written to.
 */
const CGROUP_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class CgroupError extends Error {
  readonly code:
    | 'CGROUP_PATH_UNSAFE'
    | 'CGROUP_CREATE_FAILED'
    | 'CGROUP_LIMIT_FAILED'
    | 'CGROUP_PLACEMENT_FAILED'
    | 'CGROUP_READ_FAILED';

  constructor(code: CgroupError['code'], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CgroupError';
    this.code = code;
  }
}

export interface CgroupHandle {
  /** Absolute path of the cgroup directory. */
  readonly path: string;
  /** The validated segment it was built from (the workspace id, in this codebase). */
  readonly id: string;
  readonly root: string;
}

export interface CgroupLimits {
  /** `memory.max`, bytes. */
  readonly memoryMaxBytes: number;
  /**
   * `memory.swap.max`, bytes. **Zero by default, and that is not an optimisation.**
   *
   * `memory.max` bounds resident memory only. On a host with swap, a run that exceeds it
   * is swapped out and keeps running — measured on this host: with `memory.max=32M` and
   * swap enabled, a process allocated 200 MB and exited 0 with `oom_kill=0`, its peak
   * pinned at the limit and the rest in swap. The same process with `memory.swap.max=0`
   * was OOM-killed in 94 ms with `oom_kill=1`.
   *
   * So `memory.max` alone is a *soft* ceiling. A hard one needs both files, and a
   * platform that writes only the first must not claim the second.
   */
  readonly swapMaxBytes: number;
  /** `pids.max`, integer. */
  readonly pidsMax: number;
  /** `cpu.max` quota, microseconds per period. */
  readonly cpuQuotaMicros: number;
  /** `cpu.max` period, microseconds. */
  readonly cpuPeriodMicros: number;
}

/** What the kernel says the limits are, which is not always what was written. */
export interface EffectiveLimits {
  /** Raw `memory.max`: a byte count, or the literal `max`. */
  readonly memoryMax: string;
  /** Raw `memory.swap.max`, or `unavailable` when the kernel has no swap accounting. */
  readonly swapMax: string;
  readonly pidsMax: string;
  readonly cpuMax: string;
  readonly cpuQuotaMicros: number | null;
  readonly cpuPeriodMicros: number;
}

export interface CgroupUsage {
  /** `memory.peak`, or null on a kernel older than 5.19 that lacks the file. */
  readonly memoryPeakBytes: number | null;
  /** `pids.peak`, or null when unavailable. */
  readonly pidsPeak: number | null;
  /** `cpu.stat usage_usec` → milliseconds. The number `ExecutionAttempt.cpuTimeMs` wants. */
  readonly cpuTimeMs: number;
  readonly cpuUsageUs: number;
  /** `memory.events oom_kill`: the kernel killed something here. */
  readonly oomKills: number;
  /** `pids.events max`: a `fork()` was refused because of `pids.max`. */
  readonly pidsEventsMax: number;
  readonly nrThrottled: number;
  readonly throttledUs: number;
}

function assertId(value: string): string {
  if (!CGROUP_ID.test(value)) {
    throw new CgroupError(
      'CGROUP_PATH_UNSAFE',
      `Unsafe cgroup id ${JSON.stringify(value)}: expected /^[A-Za-z0-9_-]{1,64}$/`,
    );
  }

  return value;
}

export function cgroupPathFor(root: string, id: string): string {
  return join(root, assertId(id));
}

/**
 * Read `key value` pairs out of a cgroup "file" (`cpu.stat`, `memory.events`,
 * `pids.events`). Lines with a single token are ignored rather than guessed at.
 */
export function parseCgroupCounters(text: string): ReadonlyMap<string, number> {
  const counters = new Map<string, number>();

  for (const line of text.split('\n')) {
    const [key, value] = line.trim().split(/\s+/);

    if (key === undefined || key.length === 0 || value === undefined) continue;

    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) counters.set(key, parsed);
  }

  return counters;
}

function counter(counters: ReadonlyMap<string, number>, key: string): number {
  return counters.get(key) ?? 0;
}

/**
 * Create the attempt's cgroup.
 *
 * `mkdir` on a cgroupfs creates a cgroup. It is not `recursive` on purpose: a missing
 * parent means the setup script was not run, and silently creating the delegation root
 * would hide that.
 */
export async function createCgroup(root: string, id: string): Promise<CgroupHandle> {
  const path = cgroupPathFor(root, id);

  try {
    await mkdir(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    // A retried activity may find its own cgroup from a previous, crashed pass. That is
    // a warm start, not a collision — the limits are re-applied by the caller.
    if (code !== 'EEXIST') {
      throw new CgroupError(
        'CGROUP_CREATE_FAILED',
        `Cannot create cgroup ${path}: ${code ?? String(error)}`,
        { cause: error },
      );
    }
  }

  return { path, id, root };
}

/**
 * Write the three limits and read back what the kernel accepted.
 *
 * The read-back is the point: a limit that was written but not accepted (a controller
 * that is not delegated, a value the kernel clamps) is indistinguishable from an
 * enforced one unless it is read from the same file the kernel enforces from.
 */
export async function applyLimits(
  handle: CgroupHandle,
  limits: CgroupLimits,
): Promise<EffectiveLimits> {
  if (limits.memoryMaxBytes <= 0 || limits.pidsMax <= 0 || limits.cpuQuotaMicros <= 0) {
    throw new CgroupError(
      'CGROUP_LIMIT_FAILED',
      `Refusing non-positive limits for ${handle.path}: ${JSON.stringify(limits)}`,
    );
  }

  const period = limits.cpuPeriodMicros > 0 ? limits.cpuPeriodMicros : CPU_PERIOD_DEFAULT_US;

  const writes: readonly (readonly [string, string])[] = [
    ['memory.max', String(limits.memoryMaxBytes)],
    ['memory.swap.max', String(limits.swapMaxBytes)],
    ['pids.max', String(limits.pidsMax)],
    ['cpu.max', `${String(limits.cpuQuotaMicros)} ${String(period)}`],
  ];

  for (const [file, value] of writes) {
    const path = join(handle.path, file);

    try {
      await writeFile(path, value, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      // A kernel without swap accounting has no `memory.swap.max`. That is a degraded
      // state, not a failure of the whole cgroup: the other three limits still apply.
      // It is *not* silent — `readEffectiveLimits` reports `unavailable` and the worker
      // logs it, because on that kernel `memory.max` is only a soft ceiling.
      if (file === 'memory.swap.max' && code === 'ENOENT') continue;

      throw new CgroupError(
        'CGROUP_LIMIT_FAILED',
        `Cannot write ${file}=${value} to ${handle.path}: ${code ?? String(error)}`,
        { cause: error },
      );
    }
  }

  return readEffectiveLimits(handle);
}

export async function readEffectiveLimits(handle: CgroupHandle): Promise<EffectiveLimits> {
  const [memoryMax, swapMax, pidsMax, cpuMax] = await Promise.all([
    readFile(join(handle.path, 'memory.max'), 'utf8'),
    readFile(join(handle.path, 'memory.swap.max'), 'utf8').catch(() => 'unavailable'),
    readFile(join(handle.path, 'pids.max'), 'utf8'),
    readFile(join(handle.path, 'cpu.max'), 'utf8'),
  ]);

  const [quota, period] = cpuMax.trim().split(/\s+/);
  const quotaMicros = quota === undefined || quota === 'max' ? null : Number.parseInt(quota, 10);
  const periodMicros = period === undefined ? CPU_PERIOD_DEFAULT_US : Number.parseInt(period, 10);

  return {
    memoryMax: memoryMax.trim(),
    swapMax: swapMax.trim(),
    pidsMax: pidsMax.trim(),
    cpuMax: cpuMax.trim(),
    cpuQuotaMicros: quotaMicros !== null && Number.isFinite(quotaMicros) ? quotaMicros : null,
    cpuPeriodMicros: Number.isFinite(periodMicros) ? periodMicros : CPU_PERIOD_DEFAULT_US,
  };
}

/**
 * Move one process into the cgroup.
 *
 * The caller does this from inside the child, before it execs, so there is no window in
 * which the sandbox has started and is still outside its limits — see
 * `runInProcessGroup({ placement })`. Doing it here, from the parent, is the racy
 * variant and is only used by the capability probe and by the reaper's diagnostics.
 */
export async function placeProcess(handle: CgroupHandle, pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new CgroupError('CGROUP_PLACEMENT_FAILED', `Refusing to place implausible pid ${pid}`);
  }

  try {
    await writeFile(join(handle.path, 'cgroup.procs'), String(pid), 'utf8');
  } catch (error) {
    throw new CgroupError(
      'CGROUP_PLACEMENT_FAILED',
      `Cannot move pid ${String(pid)} into ${handle.path}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`,
      { cause: error },
    );
  }
}

/** Every pid currently in the cgroup, read from `cgroup.procs`. Never matched by name. */
export async function listProcesses(handle: CgroupHandle): Promise<readonly number[]> {
  let text: string;

  try {
    text = await readFile(join(handle.path, 'cgroup.procs'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  return text
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/**
 * Usage for the attempt, read after the process tree has exited.
 *
 * A missing file is reported as `null`, never as `0`: a fabricated zero is
 * indistinguishable from a measured one, and `ExecutionAttempt.memoryPeakBytes` is
 * read by an operator as evidence.
 */
export async function readUsage(handle: CgroupHandle): Promise<CgroupUsage> {
  const read = async (file: string): Promise<string | null> => {
    try {
      return await readFile(join(handle.path, file), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new CgroupError(
        'CGROUP_READ_FAILED',
        `Cannot read ${file} from ${handle.path}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`,
        { cause: error },
      );
    }
  };

  const [cpuStat, memoryEvents, pidsEvents, memoryPeak, pidsPeak] = await Promise.all([
    read('cpu.stat'),
    read('memory.events'),
    read('pids.events'),
    read('memory.peak'),
    read('pids.peak'),
  ]);

  const cpu = parseCgroupCounters(cpuStat ?? '');
  const memory = parseCgroupCounters(memoryEvents ?? '');
  const pids = parseCgroupCounters(pidsEvents ?? '');

  const cpuUsageUs = counter(cpu, 'usage_usec');
  const peakBytes = memoryPeak === null ? null : Number.parseInt(memoryPeak.trim(), 10);
  const peakPids = pidsPeak === null ? null : Number.parseInt(pidsPeak.trim(), 10);

  return {
    memoryPeakBytes: peakBytes !== null && Number.isFinite(peakBytes) ? peakBytes : null,
    pidsPeak: peakPids !== null && Number.isFinite(peakPids) ? peakPids : null,
    cpuUsageUs,
    cpuTimeMs: Math.round(cpuUsageUs / 1000),
    oomKills: counter(memory, 'oom_kill'),
    pidsEventsMax: counter(pids, 'max'),
    nrThrottled: counter(cpu, 'nr_throttled'),
    throttledUs: counter(cpu, 'throttled_usec'),
  };
}

/**
 * `cgroup.kill`: SIGKILL to every process in the cgroup and its descendants, delivered
 * by the kernel in one pass. This is the only kill the platform relies on for
 * containment — the process-group signal is for grace, this is for certainty.
 *
 * A kill on an already-empty cgroup is a no-op, not an error.
 */
export async function killCgroup(handle: CgroupHandle): Promise<void> {
  try {
    await writeFile(join(handle.path, 'cgroup.kill'), '1', 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    // ENOENT: already removed. EBUSY: no processes to kill, or the cgroup is frozen.
    if (code === 'ENOENT') return;

    throw new CgroupError(
      'CGROUP_PLACEMENT_FAILED',
      `Cannot kill ${handle.path}: ${code ?? String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Remove the cgroup, tolerating a cgroup that is already gone.
 *
 * `rmdir` fails with `EBUSY` while any process remains — a process that was killed but
 * has not been reaped yet still counts. That is a transient state, so it is retried for
 * a bounded time; a cgroup that survives the retries is reported, because a leaked
 * cgroup keeps charging the parent and silence would hide it.
 */
export async function removeCgroup(
  handle: CgroupHandle,
  options: { readonly attempts?: number; readonly delayMs?: number } = {},
): Promise<boolean> {
  const attempts = options.attempts ?? 20;
  const delayMs = options.delayMs ?? 25;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rmdir(handle.path);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code === 'ENOENT') return true;
      if (code !== 'EBUSY' && code !== 'ENOTEMPTY') {
        throw new CgroupError(
          'CGROUP_CREATE_FAILED',
          `Cannot remove ${handle.path}: ${code ?? String(error)}`,
          { cause: error },
        );
      }
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
  }

  return false;
}
