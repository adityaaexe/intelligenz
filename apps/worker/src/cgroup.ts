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
    | 'CGROUP_READ_FAILED'
    | 'CGROUP_IO_UNSUPPORTED';

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

// ── CPU lifetime budget ─────────────────────────────────────────────────────────

/**
 * `cpu.stat usage_usec` — cumulative CPU consumed by the whole cgroup, in microseconds,
 * summed across every process and every CPU.
 *
 * This is the number a *budget* needs and that `cpu.max` cannot provide. `cpu.max` is a
 * bandwidth ceiling (`quota period`), so it answers "how fast" and never "how much": a
 * run throttled to one CPU for its full wall clock legitimately consumes the entire wall
 * clock in CPU-seconds, and from inside the quota there is no way to tell a busy run from
 * a pathological one.
 *
 * `null` means the file could not be read, which is reported as unknown rather than as
 * zero — a fabricated zero would look like a run that used no CPU.
 */
export async function readCpuUsageUs(handle: CgroupHandle): Promise<number | null> {
  try {
    const text = await readFile(join(handle.path, 'cpu.stat'), 'utf8');
    const value = parseCgroupCounters(text).get('usage_usec');

    return value ?? null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;

    throw new CgroupError(
      'CGROUP_READ_FAILED',
      `Cannot read cpu.stat from ${handle.path}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`,
      { cause: error },
    );
  }
}

export interface CpuBudgetSample {
  readonly usageUs: number;
  readonly budgetUs: number;
  readonly elapsedMs: number;
  /** 0..1+, so an operator can see *how far past* the budget the run got. */
  readonly fraction: number;
}

export interface CpuBudgetWatch {
  /** CPU-seconds consumed when the watch stopped. Always a measurement, never a guess. */
  readonly lastSample: () => CpuBudgetSample | null;
  /** Resolves when the budget is exceeded. Never resolves if it is not. */
  readonly exceeded: Promise<CpuBudgetSample>;
  /** Stop sampling. Safe to call twice, and safe to call after `exceeded` resolved. */
  stop(): void;
}

/**
 * Sample `usage_usec` and stop the attempt when the budget is gone.
 *
 * Three properties matter more than the interval:
 *
 * 1. **It observes, it does not predict.** The decision is a read of the kernel's own
 *    counter, not an estimate from wall clock × quota. An attempt that spent its budget
 *    in ten seconds is killed at ten seconds.
 * 2. **It is cumulative, not instantaneous.** A short burst of CPU is not a breach; only
 *    the total is. That is what makes this distinct from the `cpu` rate check in
 *    `termination.ts`, which asks whether `cpu.max` was in force at all.
 * 3. **A failed read is not a breach.** An unreadable `cpu.stat` stops the sampler and
 *    reports nothing: killing a run because a file could not be read would be a resource
 *    kill with no measurement behind it.
 *
 * The interval is deliberately short relative to the budget (100 ms against 30 s) so the
 * overshoot is bounded by scheduling jitter, and deliberately not zero so the sampler
 * costs one file read per tick rather than a busy loop of its own.
 */
export function startCpuBudgetWatch(input: {
  readonly handle: CgroupHandle;
  readonly budgetUs: number;
  readonly intervalMs?: number;
  /** Called once, synchronously, when the budget is found exhausted. */
  readonly onExceeded?: (sample: CpuBudgetSample) => void;
}): CpuBudgetWatch {
  const intervalMs = Math.max(10, input.intervalMs ?? 100);
  const startedAt = Date.now();

  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let last: CpuBudgetSample | null = null;
  let resolveExceeded: ((sample: CpuBudgetSample) => void) | undefined;

  const exceeded = new Promise<CpuBudgetSample>((resolvePromise) => {
    resolveExceeded = resolvePromise;
  });

  const stop = (): void => {
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };

  const tick = (): void => {
    if (stopped) return;

    void readCpuUsageUs(input.handle)
      .then((usageUs) => {
        // `stopped` can flip between the read and this callback; a sample taken after
        // the stop would be charged to a run that has already ended.
        if (stopped || usageUs === null) return;

        const sample: CpuBudgetSample = {
          usageUs,
          budgetUs: input.budgetUs,
          elapsedMs: Date.now() - startedAt,
          fraction: input.budgetUs <= 0 ? 0 : usageUs / input.budgetUs,
        };

        last = sample;

        if (input.budgetUs > 0 && usageUs > input.budgetUs) {
          stop();
          input.onExceeded?.(sample);
          resolveExceeded?.(sample);
        }
      })
      .catch(() => {
        // A read that fails is not evidence of a breach. Stop rather than guess.
        stop();
      });
  };

  timer = setInterval(tick, intervalMs);
  // Never hold the process open for a sampler: the attempt owns the lifetime, not this.
  timer.unref();
  tick();

  return {
    lastSample: () => last,
    exceeded,
    stop,
  };
}

// ── I/O limits (`io.max`) ───────────────────────────────────────────────────────

export interface IoMaxLimits {
  /** `<major>:<minor>` of the backing device, from the mount table. */
  readonly device: string;
  readonly rbps?: number;
  readonly wbps?: number;
  readonly riops?: number;
  readonly wiops?: number;
}

export interface IoMaxEffective {
  /** The line the kernel kept, exactly as `io.max` reads it back. */
  readonly line: string;
  readonly device: string;
  readonly rbps: string;
  readonly wbps: string;
  readonly riops: string;
  readonly wiops: string;
}

/**
 * Apply `io.max` to the device that backs a workspace volume.
 *
 * ## Why this is attempted rather than promised
 *
 * The `io` controller is delegated separately from `cpu`/`memory`/`pids`, and `io.max`
 * support depends on the block device: a device with no request queue, or a kernel built
 * without `blk-throttle`, accepts the write and enforces nothing — or refuses it
 * outright. So the value is written and **read back**, and a refusal is reported as
 * `CGROUP_IO_UNSUPPORTED` with the errno rather than swallowed. A platform that claims
 * an I/O limit it did not measure is worse than one that reports none.
 */
export async function applyIoMax(
  handle: CgroupHandle,
  limits: IoMaxLimits,
): Promise<IoMaxEffective> {
  if (!/^\d+:\d+$/.test(limits.device)) {
    throw new CgroupError(
      'CGROUP_LIMIT_FAILED',
      `io.max needs a <major>:<minor> device, received ${JSON.stringify(limits.device)}`,
    );
  }

  const parts = [
    limits.rbps === undefined ? null : `rbps=${String(limits.rbps)}`,
    limits.wbps === undefined ? null : `wbps=${String(limits.wbps)}`,
    limits.riops === undefined ? null : `riops=${String(limits.riops)}`,
    limits.wiops === undefined ? null : `wiops=${String(limits.wiops)}`,
  ].filter((part): part is string => part !== null);

  if (parts.length === 0) {
    throw new CgroupError('CGROUP_LIMIT_FAILED', 'io.max was called with no limits');
  }

  const value = `${limits.device} ${parts.join(' ')}`;

  try {
    await writeFile(join(handle.path, 'io.max'), value, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const detail = `${code ?? String(error)}: ${(error as Error).message ?? ''}`.trim();

    throw new CgroupError(
      'CGROUP_LIMIT_FAILED',
      code === 'ENOENT'
        ? `io.max does not exist in ${handle.path}: the io controller is not delegated to ` +
          'the children of the delegation root. Run infra/scripts/setup-cgroups.sh.'
        : `Cannot write io.max="${value}" to ${handle.path}: ${detail}. The backing device ` +
          'does not support throttling (no request queue, or blk-throttle is absent).',
      { cause: error },
    );
  }

  const readBack = await readIoMax(handle);
  const line = readBack.find((entry) => entry.device === limits.device);

  if (line === undefined) {
    throw new CgroupError(
      'CGROUP_LIMIT_FAILED',
      `io.max accepted "${value}" but reads back ${JSON.stringify(readBack)}: the device ` +
        'is not tracked, so nothing is throttled.',
    );
  }

  return line;
}

/** Every configured line in `io.max`, parsed. An empty array means "no limits". */
export async function readIoMax(handle: CgroupHandle): Promise<readonly IoMaxEffective[]> {
  const text = await readFile(join(handle.path, 'io.max'), 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  });

  const lines: IoMaxEffective[] = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const [device, ...pairs] = trimmed.split(/\s+/);
    if (device === undefined || !/^\d+:\d+$/.test(device)) continue;

    const fields = new Map<string, string>();

    for (const pair of pairs) {
      const [key, value] = pair.split('=');
      if (key !== undefined && value !== undefined) fields.set(key, value);
    }

    lines.push({
      line: trimmed,
      device,
      rbps: fields.get('rbps') ?? 'max',
      wbps: fields.get('wbps') ?? 'max',
      riops: fields.get('riops') ?? 'max',
      wiops: fields.get('wiops') ?? 'max',
    });
  }

  return lines;
}

/** `io.stat` for the cgroup, verbatim key→bytes pairs per device. Empty means no I/O. */
export async function readIoStat(
  handle: CgroupHandle,
): Promise<Readonly<Record<string, Readonly<Record<string, number>>>>> {
  const text = await readFile(join(handle.path, 'io.stat'), 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  });

  const stats: Record<string, Record<string, number>> = {};

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const [device, ...pairs] = trimmed.split(/\s+/);
    if (device === undefined) continue;

    const fields: Record<string, number> = {};

    for (const pair of pairs) {
      const [key, value] = pair.split('=');
      if (key === undefined || value === undefined) continue;

      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) fields[key] = parsed;
    }

    stats[device] = fields;
  }

  return stats;
}

/** True when `io.max` exists in an attempt cgroup — i.e. `io` reached the children. */
export async function ioControllerDelegated(handle: CgroupHandle): Promise<boolean> {
  try {
    await readFile(join(handle.path, 'io.max'), 'utf8');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
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
