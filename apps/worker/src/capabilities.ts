import { spawn } from 'node:child_process';
import { readFile, rmdir, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  describeVolumes,
  discoverVolumes,
  type VolumeDescriptor,
  type VolumeDiscovery,
  type VolumeUnavailableCode,
} from '@intelligenz/workspace-manager';

import {
  CgroupError,
  applyIoMax,
  applyLimits,
  createCgroup,
  ioControllerDelegated,
  placeProcess,
  readIoMax,
  readUsage,
} from './cgroup';

/**
 * Boot-time capability detection: is cgroup isolation **real** on this host, right now?
 *
 * The honest question is not "does `/sys/fs/cgroup/intelligenz` exist". A directory can
 * exist, be writable, and still be useless: a `cgroup.procs` migration is authorised
 * against both the source and the destination, so a worker started in a login session
 * can create a cgroup, write `memory.max`, and then be unable to put a single process in
 * it. That combination — every file writable, no process placeable — is exactly how a
 * platform ends up claiming enforcement it does not have.
 *
 * So the probe **migrates a real child** and reads that child's usage. If the migration
 * is refused, the mode is `unavailable`, the reason is the errno, and the remediation is
 * the command that fixes it. Nothing downstream may claim cgroup isolation after that.
 *
 * The probe is cheap (one `node -e` child, ~250 ms) and runs once per process.
 *
 * ## Why writability is not evidence
 *
 * Writing `memory.max` in a **plain directory** creates an ordinary file. The write
 * succeeds, the read-back returns exactly what was written, and writing `cgroup.procs`
 * creates another ordinary file that also "succeeds". A probe made of writes alone
 * therefore reports `enforced` for `/tmp`. That is the single most dangerous false
 * positive this module can produce, because the boot log is the platform's claim about
 * itself and the attempt record (`executionProfile`) repeats it.
 *
 * So the filesystem is checked first, by superblock magic (`CGROUP2_SUPER_MAGIC`,
 * `0x63677270`), and `cgroup.controllers` must exist and list the three controllers the
 * limits depend on. Only then is anything created, written or migrated.
 */

export type CgroupMode = 'enforced' | 'unavailable';

export type CgroupUnavailableCode =
  | 'CGROUP_ROOT_MISSING'
  | 'CGROUP_ROOT_READ_ONLY'
  | 'CGROUP_ROOT_NOT_WRITABLE'
  | 'CGROUP_NOT_CGROUP2'
  | 'CGROUP_LIMIT_NOT_APPLIED'
  | 'CGROUP_MIGRATION_DENIED'
  | 'CGROUP_PROBE_FAILED';

export interface CgroupProbeEvidence {
  /** `memory.max` as read back from the probe cgroup. */
  readonly memoryMax: string;
  readonly pidsMax: string;
  readonly cpuMax: string;
  /** `cpu.stat usage_usec` for the migrated child. */
  readonly cpuUsageUs: number;
  /** Where this process's own cgroup is, e.g. `/intelligenz/worker`. */
  readonly selfCgroup: string;
}

export interface CgroupEnforced {
  readonly mode: 'enforced';
  readonly root: string;
  readonly evidence: CgroupProbeEvidence;
}

export interface CgroupUnavailable {
  readonly mode: 'unavailable';
  readonly root: string;
  readonly code: CgroupUnavailableCode;
  /** Exact reason, including the errno and the path. Logged once at boot. */
  readonly reason: string;
  /** The command or configuration change that fixes it. */
  readonly remediation: string;
}

export type CgroupCapability = CgroupEnforced | CgroupUnavailable;

export interface DetectOptions {
  readonly root?: string;
  /** Test seam: skip the child process and use this outcome. Never used in production. */
  readonly probePid?: number;
  readonly timeoutMs?: number;
}

const SETUP_REMEDIATION =
  'Run: sudo bash infra/scripts/setup-cgroups.sh (once), then start the worker with ' +
  'sudo bash infra/scripts/worker-with-cgroup.sh so it runs inside the delegated cgroup.';

/**
 * `CGROUP2_SUPER_MAGIC` from `linux/magic.h`. The only filesystem on which a write to
 * `memory.max` is a limit rather than a file creation.
 */
const CGROUP2_SUPER_MAGIC = 0x63677270;

/** The probe's limits. Read back verbatim; a clamp is a failure, not a rounding. */
const PROBE_MEMORY_MAX = 64 * 1024 * 1024;
const PROBE_PIDS_MAX = 16;
const PROBE_CPU_QUOTA_US = 10_000;
const PROBE_CPU_PERIOD_US = 100_000;

/**
 * The controllers the three probe limits need. `cgroup.controllers` in the delegation
 * root lists what its children may use; if one is absent the child has no such file and
 * no amount of writing will create a limit.
 */
const REQUIRED_CONTROLLERS = ['cpu', 'memory', 'pids'] as const;

/** `/proc/self/cgroup` is `0::/path`. The path is the useful half. */
export async function selfCgroupPath(): Promise<string> {
  try {
    const text = await readFile('/proc/self/cgroup', 'utf8');

    return text.trim().replace(/^0::/, '') || '/';
  } catch {
    return 'unknown';
  }
}

/**
 * The errno, including through a `cause` chain.
 *
 * `createCgroup` wraps the filesystem error in a `CgroupError`, so the errno a diagnosis
 * needs (`EACCES`, `EROFS`, `ENOENT`) is on `error.cause`, not on `error.code` — which is
 * this module family's own `CGROUP_*` code. Reading only the outer object turns every
 * diagnosis into "probe failed", which is the least useful line a boot log can carry.
 */
function errnoOf(error: unknown, depth = 0): string {
  if (typeof error !== 'object' || error === null) return String(error);

  const code = (error as { code?: unknown }).code;

  if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) && !code.startsWith('CGROUP_')) {
    return code;
  }

  if (depth < 3 && 'cause' in error) {
    return errnoOf((error as { cause?: unknown }).cause, depth + 1);
  }

  return typeof code === 'string' ? code : String(error);
}

/**
 * Spawn a short-lived child so there is a real process to migrate. `node` is used
 * rather than `sleep` because the worker is running on it: a missing `sleep` would look
 * like a migration failure and produce a wrong diagnosis.
 */
function spawnProbeChild(): { pid: number; done: Promise<void> } {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 400)'], {
    stdio: 'ignore',
    detached: false,
  });

  const done = new Promise<void>((resolvePromise) => {
    child.once('exit', () => resolvePromise());
    child.once('error', () => resolvePromise());
  });

  return { pid: child.pid ?? 0, done };
}

export async function detectCgroupCapability(
  options: DetectOptions = {},
): Promise<CgroupCapability> {
  const root = options.root ?? '/sys/fs/cgroup/intelligenz';
  const selfCgroup = await selfCgroupPath();
  const id = `probe-${String(process.pid)}`;
  const path = join(root, id);

  const unavailable = (
    code: CgroupUnavailableCode,
    reason: string,
    remediation: string = SETUP_REMEDIATION,
  ): CgroupUnavailable => ({ mode: 'unavailable', root, code, reason, remediation });

  // ── 0. Is this a cgroup v2 hierarchy with the controllers we need? ────────────
  //
  // Before any write. A `mkdir` plus a `memory.max` write proves only that the process
  // may create files in a directory — on an ordinary directory, both succeed and every
  // read-back agrees, which is exactly how a probe ends up claiming enforcement it does
  // not have. The superblock magic is a fact the filesystem cannot fake.
  let filesystemType: number;

  try {
    filesystemType = (await statfs(root)).type;
  } catch (error) {
    const errno = errnoOf(error);

    if (errno === 'ENOENT') {
      return unavailable(
        'CGROUP_ROOT_MISSING',
        `Cannot stat ${root}: the path does not exist (ENOENT).`,
      );
    }

    if (errno === 'EACCES' || errno === 'EPERM') {
      return unavailable(
        'CGROUP_ROOT_NOT_WRITABLE',
        `Cannot stat ${root}: permission denied (${errno}).`,
      );
    }

    return unavailable(
      'CGROUP_PROBE_FAILED',
      `Cannot stat ${root}: ${errno} (${error instanceof Error ? error.message : String(error)}).`,
    );
  }

  if (filesystemType !== CGROUP2_SUPER_MAGIC) {
    return unavailable(
      'CGROUP_NOT_CGROUP2',
      `${root} is not a cgroup v2 filesystem: statfs reports magic ` +
        `0x${filesystemType.toString(16)}, expected 0x63677270. Any memory.max written ` +
        'here is an ordinary file that reads back correctly and enforces nothing, so ' +
        'no enforcement can be claimed.',
      'Point WORKER_CGROUP_ROOT at the cgroup2 mount (normally /sys/fs/cgroup/intelligenz) ' +
        'and create the delegation root with infra/scripts/setup-cgroups.sh.',
    );
  }

  let controllers: string;

  try {
    controllers = await readFile(join(root, 'cgroup.controllers'), 'utf8');
  } catch (error) {
    const errno = errnoOf(error);

    return unavailable(
      'CGROUP_NOT_CGROUP2',
      `${root} reports the cgroup2 superblock but has no readable cgroup.controllers ` +
        `(${errno}). A cgroup2 root always has one, so this is not a hierarchy this probe ` +
        'can trust.',
      'Recreate the delegation root with infra/scripts/setup-cgroups.sh.',
    );
  }

  const delegated = new Set(controllers.trim().split(/\s+/).filter((word) => word.length > 0));
  const missing = REQUIRED_CONTROLLERS.filter((controller) => !delegated.has(controller));

  if (missing.length > 0) {
    return unavailable(
      'CGROUP_LIMIT_NOT_APPLIED',
      `${root}/cgroup.controllers does not delegate ${missing.join(', ')} ` +
        `(available: ${[...delegated].join(' ') || 'none'}). The attempt cgroups would have ` +
        'no such limit file, so memory, pids and cpu cannot be bounded.',
    );
  }

  // ── 1. Create the cgroup ───────────────────────────────────────────────────────
  let handle;
  try {
    handle = await createCgroup(root, id);
  } catch (error) {
    const errno = errnoOf(error);

    if (errno === 'ENOENT') {
      return unavailable(
        'CGROUP_ROOT_MISSING',
        `Cannot create ${path}: the parent does not exist (ENOENT).`,
      );
    }

    if (errno === 'EROFS') {
      return unavailable(
        'CGROUP_ROOT_READ_ONLY',
        `Cannot create ${path}: read-only filesystem (EROFS). The cgroup root is mounted ` +
          'read-only, so no limit can be written and no process can be placed.',
      );
    }

    if (errno === 'EACCES' || errno === 'EPERM') {
      return unavailable(
        'CGROUP_ROOT_NOT_WRITABLE',
        `Cannot create ${path}: permission denied (${errno}). ${root} is not delegated to ` +
          `uid ${String(process.getuid?.() ?? -1)}; this process is in cgroup ${selfCgroup}.`,
      );
    }

    return unavailable(
      'CGROUP_PROBE_FAILED',
      `Cannot create ${path}: ${errno} (${error instanceof Error ? error.message : String(error)}).`,
    );
  }

  try {
    // ── 2. Write limits and read them back ───────────────────────────────────────
    let effective;

    try {
      effective = await applyLimits(handle, {
        memoryMaxBytes: PROBE_MEMORY_MAX,
        swapMaxBytes: 0,
        pidsMax: PROBE_PIDS_MAX,
        cpuQuotaMicros: PROBE_CPU_QUOTA_US,
        cpuPeriodMicros: PROBE_CPU_PERIOD_US,
      });
    } catch (error) {
      const errno = errnoOf(error);

      return unavailable(
        'CGROUP_LIMIT_NOT_APPLIED',
        `The cgroup exists but its limits could not be written (${errno}): ` +
          `${error instanceof Error ? error.message : String(error)}. The memory/pids/cpu ` +
          'controllers are not delegated to the children of the root.',
      );
    }

    // The read-back is a separate assertion, not a formality: a controller can accept a
    // write and report a different value (clamping, `max`), and a value the kernel did
    // not accept is not a limit.
    const expected = {
      memoryMax: String(PROBE_MEMORY_MAX),
      pidsMax: String(PROBE_PIDS_MAX),
      cpuMax: `${String(PROBE_CPU_QUOTA_US)} ${String(PROBE_CPU_PERIOD_US)}`,
    } as const;

    const mismatches = (
      [
        ['memory.max', effective.memoryMax, expected.memoryMax],
        ['pids.max', effective.pidsMax, expected.pidsMax],
        ['cpu.max', effective.cpuMax, expected.cpuMax],
      ] as const
    )
      .filter(([, actual, wanted]) => actual !== wanted)
      .map(([file, actual, wanted]) => `${file}: wrote ${wanted}, read ${actual}`);

    if (mismatches.length > 0) {
      return unavailable(
        'CGROUP_LIMIT_NOT_APPLIED',
        `The limits written to ${path} did not read back as written — ` +
          `${mismatches.join('; ')}. A value the kernel did not accept is not enforced.`,
      );
    }

    // ── 3. Migrate a real process ────────────────────────────────────────────────
    const child = spawnProbeChild();

    if (child.pid === 0) {
      return unavailable('CGROUP_PROBE_FAILED', 'Could not spawn a probe child to migrate.');
    }

    try {
      await placeProcess(handle, child.pid);
    } catch (error) {
      const errno = errnoOf(error);

      if (errno === 'ENOENT') {
        return unavailable(
          'CGROUP_MIGRATION_DENIED',
          `Migrating pid ${String(child.pid)} failed with ENOENT: the process exited before it ` +
            'could be placed. Retried at boot; treat as inconclusive rather than enforced.',
        );
      }

      if (errno === 'EACCES' || errno === 'EPERM') {
        return unavailable(
          'CGROUP_MIGRATION_DENIED',
          `Cannot move pid ${String(child.pid)} into ${path}: ${errno}. A cgroup.procs write is ` +
            'authorised against both the source and the destination cgroup, and this process ' +
            `runs in ${selfCgroup}, which is outside the delegated subtree ${root}. ` +
            'The limits would be written and never applied.',
        );
      }

      return unavailable(
        'CGROUP_MIGRATION_DENIED',
        `Cannot move pid ${String(child.pid)} into ${path}: ${errno}.`,
      );
    } finally {
      await child.done;
    }

    // ── 4. Read the migrated child's usage ───────────────────────────────────────
    const usage = await readUsage(handle);

    return {
      mode: 'enforced',
      root,
      evidence: {
        // The same values the comparison above accepted, from the same files.
        memoryMax: effective.memoryMax,
        pidsMax: effective.pidsMax,
        cpuMax: effective.cpuMax,
        cpuUsageUs: usage.cpuUsageUs,
        selfCgroup,
      },
    };
  } finally {
    await rmdir(path).catch(() => undefined);
  }
}

/**
 * Write one line to the cgroup's `cgroup.kill`, used by the probe's failure path in
 * tests. Exported so a test can prove the file exists on this kernel without duplicating
 * the path logic.
 */
export async function writeKill(path: string): Promise<void> {
  await writeFile(join(path, 'cgroup.kill'), '1', 'utf8').catch((error: unknown) => {
    if (errnoOf(error) === 'ENOENT') return;
    throw error;
  });
}

// ── Disk (Gate D) ───────────────────────────────────────────────────────────────

/**
 * Is there a real disk quota on this host, right now?
 *
 * Two different questions live here and the answer must not merge them:
 *
 * 1. **Can a bounded volume be mounted?** — measured by `discoverVolumes`: a registry
 *    entry that is a mount point, writable, and reports a size with `statfs`.
 * 2. **Does the platform claim a quota anyway?** — no. When (1) is false the mode is
 *    `unavailable` and the reason is printed at boot; `assertProfileAvailable` then
 *    refuses `HEAVY`, and the attempt log says `disk=declared-but-unenforced`.
 *
 * The distinction matters because "the directory is empty" and "the directory is
 * bounded" are the same directory. Only the mount table and `statfs` tell them apart.
 */
export interface DiskBounded {
  readonly mode: 'bounded';
  readonly volumes: readonly VolumeDescriptor[];
  readonly aggregateBytes: number;
  readonly discovery: VolumeDiscovery;
}

export interface DiskUnavailable {
  readonly mode: 'unavailable';
  readonly code: VolumeUnavailableCode | 'VOLUME_PROBE_FAILED';
  readonly reason: string;
  readonly remediation: string;
  readonly discovery: VolumeDiscovery;
}

export type DiskCapability = DiskBounded | DiskUnavailable;

export async function detectDiskCapability(options: {
  readonly root?: string;
  readonly registry?: string;
  readonly minBytes?: number;
} = {}): Promise<DiskCapability> {
  let discovery: VolumeDiscovery;

  try {
    discovery = await discoverVolumes({
      ...(options.root === undefined ? {} : { root: options.root }),
      ...(options.registry === undefined ? {} : { registry: options.registry }),
      ...(options.minBytes === undefined ? {} : { minBytes: options.minBytes }),
    });
  } catch (error) {
    return {
      mode: 'unavailable',
      code: 'VOLUME_PROBE_FAILED',
      reason: `The volume probe threw: ${error instanceof Error ? error.message : String(error)}`,
      remediation: 'Run: sudo bash infra/scripts/setup-workspace-volumes.sh',
      discovery: {
        mode: 'unavailable',
        root: options.root ?? '/var/lib/intelligenz/mnt',
        registry: options.registry ?? '/var/lib/intelligenz/volumes/registry.tsv',
        code: 'VOLUME_NONE_MOUNTED',
        reason: 'probe failed',
        remediation: 'Run: sudo bash infra/scripts/setup-workspace-volumes.sh',
      },
    };
  }

  if (discovery.mode === 'unavailable') {
    return {
      mode: 'unavailable',
      code: discovery.code,
      reason: discovery.reason,
      remediation: discovery.remediation,
      discovery,
    };
  }

  return {
    mode: 'bounded',
    volumes: discovery.volumes,
    aggregateBytes: discovery.volumes.reduce((sum, volume) => sum + volume.bytes, 0),
    discovery,
  };
}

export function describeDiskCapability(capability: DiskCapability): string {
  return capability.mode === 'bounded'
    ? describeVolumes(capability.discovery)
    : `disk quota: UNAVAILABLE [${capability.code}] ${capability.reason} ` +
        'Attempts run with disk declared-but-unenforced, and the HEAVY profile is refused. ' +
        capability.remediation;
}

// ── I/O (`io.max`) ──────────────────────────────────────────────────────────────

export type IoMode = 'enforced' | 'unsupported';

export interface IoEnforced {
  readonly mode: 'enforced';
  /** The `io.max` line the kernel kept, e.g. `7:6 rbps=10485760 wbps=10485760`. */
  readonly line: string;
}

export interface IoUnsupported {
  readonly mode: 'unsupported';
  /** The exact errno and message — never "not supported" without evidence. */
  readonly reason: string;
}

export type IoCapability = IoEnforced | IoUnsupported;

/**
 * Probe `io.max` on a real device by writing and reading it back.
 *
 * A capability that is claimed must be measured. `io` is delegated separately from
 * `cpu`/`memory`/`pids`, and `io.max` depends on the block device: a device with no
 * request queue accepts the write and throttles nothing. So the probe writes a
 * deliberately tiny limit to the given device, reads the file back, and reports either
 * the exact line the kernel kept or the exact error it returned.
 */
export async function probeIoCapability(
  root: string,
  device: string,
): Promise<IoCapability> {
  const id = `io-probe-${String(process.pid)}`;
  let handle;

  try {
    handle = await createCgroup(root, id);
  } catch (error) {
    return { mode: 'unsupported', reason: `cannot create a probe cgroup: ${String(error)}` };
  }

  try {
    if (!(await ioControllerDelegated(handle))) {
      return {
        mode: 'unsupported',
        reason:
          `io.max is absent from ${handle.path}: the io controller is not delegated to the ` +
          'children of the delegation root (cgroup.subtree_control lacks +io).',
      };
    }

    const effective = await applyIoMax(handle, { device, rbps: 1024 * 1024, wbps: 1024 * 1024 });
    const readBack = await readIoMax(handle);

    return { mode: 'enforced', line: readBack[0]?.line ?? effective.line };
  } catch (error) {
    return {
      mode: 'unsupported',
      reason: errnoOf(error) === 'CGROUP_LIMIT_FAILED'
        ? (error instanceof Error ? error.message : String(error))
        : `${errnoOf(error)}: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await rmdir(handle.path).catch(() => undefined);
  }
}

let cached: Promise<CgroupCapability> | undefined;

/** Once per process. Boot logs it, activities read it, nothing re-probes mid-run. */
export function getCgroupCapability(options: DetectOptions = {}): Promise<CgroupCapability> {
  cached ??= detectCgroupCapability(options);

  return cached;
}

/** Test seam: forget the memoised probe. */
export function resetCgroupCapability(): void {
  cached = undefined;
}

/** One line for the boot log: the mode, and the exact reason when it is not enforced. */
export function describeCgroupCapability(capability: CgroupCapability): string {
  if (capability.mode === 'enforced') {
    return (
      `cgroup isolation: ENFORCED (root ${capability.root}, probe memory.max=` +
      `${capability.evidence.memoryMax}, self cgroup ${capability.evidence.selfCgroup})`
    );
  }

  return (
    `cgroup isolation: UNAVAILABLE [${capability.code}] ${capability.reason} ` +
    `Profiles run as rlimit-only and the HEAVY profile is refused. ${capability.remediation}`
  );
}

/** Narrowing helper so callers do not repeat the discriminant check. */
export function isEnforced(capability: CgroupCapability): capability is CgroupEnforced {
  return capability.mode === 'enforced';
}

export { CgroupError };
