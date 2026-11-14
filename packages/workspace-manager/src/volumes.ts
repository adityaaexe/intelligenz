import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rmdir,
  statfs,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

/**
 * Bounded workspace volumes — the disk quota that is a property of a block device.
 *
 * ## Why a volume and not a `du` check
 *
 * The measured host mounts `/` as ext4 **without `prjquota`** (Phase 5 baseline §3), so
 * filesystem project quotas do not exist here. The alternatives are not equivalent:
 *
 * | Mechanism | When the ceiling applies |
 * |---|---|
 * | project quota | at `write()`, by the filesystem |
 * | fixed-size block device | at `write()`, by the kernel — `ENOSPC` |
 * | periodic `du` sweep | after the fact, on a schedule the agent can outrun |
 *
 * Only the middle one is a quota. A sweep that notices a breach after 200 MiB were
 * written has already failed at its only job, and it reports a number rather than
 * stopping a write. So the ceiling here is a 1 GiB ext4 image on a loop device,
 * prepared once by `infra/scripts/setup-workspace-volumes.sh` (root, idempotent) and
 * **leased** per attempt. Nothing in this module mounts anything and nothing calls
 * `sudo`: the privilege boundary is the image, created before the worker starts.
 *
 * ## The volume is the unit, not the path
 *
 * This is the boundary, stated once and enforced by construction:
 *
 * - The agent's only writable mount is `/workspace`, bound to `<volume>/repo`.
 * - A file written **outside** the volume — `/tmp` (tmpfs), a provider cache under
 *   `$HOME` (tmpfs), an absolute path the agent guessed — is not counted against the
 *   volume, because it is not on it. Accounting follows the device, not the path.
 * - Therefore the honest claim is: *"the checkout is bounded to one volume; temporary
 *   and in-memory state are bounded by `memory.max` instead"* — not *"the attempt cannot
 *   write more than 1 GiB anywhere"*.
 * - A symbolic link inside the volume pointing outside it does not move bytes into the
 *   volume. That is why the agent's writable mount is the volume itself: there is no
 *   path inside the sandbox that resolves outside it.
 *
 * ## Cleanup cannot traverse outside the volume
 *
 * `clearVolume()` refuses unless the path is a mount point listed in
 * `/proc/self/mountinfo`, enumerates entries with `lstat`, and **unlinks** symbolic
 * links instead of following them. It never builds a path from untrusted input, so
 * there is no `../` to sanitise: the only paths it touches are children of a directory
 * it just listed.
 *
 * ## Leases
 *
 * One attempt, one volume, one lock. The lock is a file **inside** the volume, created
 * with `O_CREAT|O_EXCL`, so acquiring proves the volume is mounted and writable before
 * a single agent byte is written. A worker that dies holding a lock leaves it behind;
 * `claim()` breaks such a lock when its recorded pid is dead **and** the boot id
 * matches, which is the only way to distinguish "the process is gone" from "a different
 * machine's pid namespace happens to use the same number".
 */

/** Where the setup script mounts the volumes. Overridable per deployment. */
export const DEFAULT_VOLUME_MOUNT_ROOT = '/var/lib/intelligenz/mnt';

/** The manifest the setup script writes; the worker never guesses volume names. */
export const DEFAULT_VOLUME_REGISTRY = '/var/lib/intelligenz/volumes/registry.tsv';

/** The lease file. Inside the volume on purpose: acquiring proves it is writable. */
export const VOLUME_LOCK_FILE = '.intelligenz-lease';

/** The directory on the volume that becomes the sandbox's `/workspace`. */
export const VOLUME_REPO_DIR = 'repo';

/**
 * Entries **every** ext4 image carries and no attempt can write, kept during a clear.
 *
 * `mke2fs` creates `lost+found` as `root:root 0700`. A worker running as its own uid can
 * neither read it nor chmod it, so a literal clear fails with `EACCES` on the first lease
 * of a freshly prepared image — measured on this host, which is why this list exists.
 *
 * Keeping it cannot leak one attempt's bytes into the next: the directory is not
 * writable by the worker uid, so no attempt can have put anything there. Removing it
 * would need root and is not the worker's job.
 */
export const VOLUME_INFRASTRUCTURE_ENTRIES = ['lost+found'] as const;

export type VolumeUnavailableCode =
  | 'VOLUME_DISABLED'
  | 'VOLUME_REGISTRY_MISSING'
  | 'VOLUME_ROOT_MISSING'
  | 'VOLUME_NONE_MOUNTED'
  | 'VOLUME_NOT_WRITABLE'
  | 'VOLUME_TOO_SMALL';

export type VolumeClaimRefusal = 'VOLUME_EXHAUSTED' | 'VOLUME_NOT_MOUNTED' | 'VOLUME_LOCK_CONTENDED';

/**
 * A volume operation that failed for a reason the operator must act on, beyond the pool
 * being full. `VOLUME_NOT_WRITABLE` is a directory inside a mounted volume that this uid
 * cannot read, chmod or remove — fail-closed (the lease is not granted) but named, with
 * the entry and the errno, instead of a bare `EACCES` from `scandir`.
 */
export type VolumeErrorCode = VolumeClaimRefusal | 'VOLUME_NOT_WRITABLE';

/**
 * A lease failure with its own `code` space.
 *
 * Deliberately **not** a `WorkspaceError`: those codes are the workspace lifecycle's
 * vocabulary and a UI filters on them. "No volume is free" is admission control, not a
 * broken workspace path, and collapsing the two would make `WORKSPACE_PROVISION_FAILED`
 * mean two unrelated things. The manager maps it to a provisioning failure with the
 * volume code in the message, so the row still records what happened.
 */
export class VolumeError extends Error {
  readonly code: VolumeErrorCode;

  constructor(code: VolumeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'VolumeError';
    this.code = code;
  }
}

export interface VolumeDescriptor {
  /** 1-based index from the registry. Stable across reboots for the same image. */
  readonly index: number;
  /** `vol-<index>`. The identity a lock is keyed on. */
  readonly id: string;
  readonly imagePath: string;
  readonly loopDevice: string;
  readonly mountPath: string;
  /** `<major>:<minor>` of the backing device — the key `io.max` is written against. */
  readonly device: string;
  /** Apparent size from the registry. `readVolumeUsage()` reports what ext4 exposes. */
  readonly bytes: number;
}

export interface VolumeUsage {
  readonly totalBytes: number;
  readonly freeBytes: number;
  readonly usedBytes: number;
}

export interface VolumeSet {
  readonly mode: 'bounded';
  readonly root: string;
  readonly registry: string;
  readonly volumes: readonly VolumeDescriptor[];
}

export interface VolumeUnavailable {
  readonly mode: 'unavailable';
  readonly root: string;
  readonly registry: string;
  readonly code: VolumeUnavailableCode;
  readonly reason: string;
  readonly remediation: string;
}

export type VolumeDiscovery = VolumeSet | VolumeUnavailable;

export interface VolumeLease {
  readonly volume: VolumeDescriptor;
  readonly workspaceId: string;
  /** `<mountPath>/repo` — the only writable mount the sandbox gets. */
  readonly repoPath: string;
  readonly lockPath: string;
  readonly acquiredAt: string;
  /** True when an existing checkout was adopted instead of a fresh volume cleared. */
  readonly warmStart: boolean;
  readonly usage: VolumeUsage;
}

interface VolumeLockPayload {
  readonly workspaceId: string;
  readonly owner: string;
  readonly pid: number;
  readonly host: string;
  readonly bootId: string;
  readonly acquiredAt: string;
}

const SETUP_REMEDIATION =
  'Run: sudo bash infra/scripts/setup-workspace-volumes.sh (once). It creates the ' +
  'sparse images, attaches them to loop devices and mounts them; the worker never ' +
  'mounts anything.';

export function resolveVolumeMountRoot(configured?: string): string {
  const value =
    configured ?? process.env['WORKSPACE_VOLUMES_ROOT'] ?? DEFAULT_VOLUME_MOUNT_ROOT;

  return resolve(value);
}

export function resolveVolumeRegistry(configured?: string): string {
  const value =
    configured ?? process.env['WORKSPACE_VOLUMES_REGISTRY'] ?? DEFAULT_VOLUME_REGISTRY;

  return resolve(value);
}

/** `WORKSPACE_VOLUMES=off` (or `0`/`false`) turns volume mode off deliberately. */
export function volumesDisabled(configured?: boolean): boolean {
  if (configured !== undefined) return !configured;

  const flag = (process.env['WORKSPACE_VOLUMES'] ?? '').trim().toLowerCase();

  return flag === 'off' || flag === '0' || flag === 'false' || flag === 'disabled';
}

/**
 * Volume mode is **opt-in**, and the reason is not caution for its own sake.
 *
 * The registry file exists as soon as an operator runs the setup script, so "the
 * registry is present" would silently switch every test run and every developer shell to
 * leases on the machine's real volumes — including the one another attempt is using. The
 * switch is therefore an explicit `WORKSPACE_VOLUMES_ROOT` (or `volumes: {...}` in code),
 * which is exactly the line the setup script prints for the operator to paste.
 *
 * The consequence of the default is stated everywhere it matters: disk is
 * declared-but-unenforced unless configured, and `assertProfileAvailable` refuses
 * `HEAVY` when it is not enforced.
 */
export function volumesConfigured(): boolean {
  if (volumesDisabled()) return false;

  return (process.env['WORKSPACE_VOLUMES_ROOT'] ?? '').trim().length > 0;
}

/**
 * `/proc/self/mountinfo` is the authority on what is mounted.
 *
 * `stat().dev` is not: a bind mount has the same device as its source, and a directory
 * that merely *looks* like a mount would pass a dev comparison. Field 5 of mountinfo is
 * the mount point, with `\040`-style escapes. Resolving the value through `realpath`
 * once on each side makes the comparison about the directory, not the spelling.
 */
async function mountedPaths(): Promise<ReadonlySet<string>> {
  let text: string;

  try {
    text = await readFile('/proc/self/mountinfo', 'utf8');
  } catch {
    return new Set();
  }

  const paths = new Set<string>();

  for (const line of text.split('\n')) {
    const fields = line.split(' ');
    const raw = fields[4];
    if (raw === undefined) continue;

    paths.add(raw.replace(/\\([0-7]{3})/g, (_, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    ));
  }

  return paths;
}

export async function isMountPoint(path: string): Promise<boolean> {
  const mounted = await mountedPaths();
  const resolved = await realpath(path).catch(() => resolve(path));

  return mounted.has(resolved) || mounted.has(resolve(path));
}

function parseRegistry(text: string): VolumeDescriptor[] {
  const volumes: VolumeDescriptor[] = [];

  for (const line of text.split('\n')) {
    const fields = line.split('\t');
    if (fields.length < 6) continue;

    // The registry is tab-separated and the setup script right-aligns some columns, so
    // `device` arrives as `"  7:6 "`. Untrimmed, `applyIoMax` refused every lease with
    // "io.max needs a <major>:<minor> device" and Gate D's I/O ceiling was silently never
    // applied — the activity records the refusal as "unsupported". Trim at the boundary.
    const [rawIndex, imagePath, loopDevice, rawMountPath, rawDevice, rawBytes] = fields;
    const index = Number.parseInt(rawIndex ?? '', 10);
    const bytes = Number.parseInt(rawBytes ?? '', 10);
    const mountPath = (rawMountPath ?? '').trim();
    const device = (rawDevice ?? '').trim();

    if (!Number.isInteger(index) || !Number.isInteger(bytes)) continue;
    if (!mountPath.startsWith('/')) continue;

    volumes.push({
      index,
      id: `vol-${String(index)}`,
      imagePath: (imagePath ?? '').trim(),
      loopDevice: (loopDevice ?? '').trim(),
      mountPath,
      device,
      bytes,
    });
  }

  return volumes.sort((left, right) => left.index - right.index);
}

/**
 * Discover what the setup script actually prepared, and verify it rather than trust it.
 *
 * A registry entry is a claim: the image may have been unmounted, the mount may have
 * been made read-only, or the loop device may have been detached. Each volume is
 * therefore checked against the mount table, `statfs` and an `access(W_OK)` before it is
 * offered. An empty result is reported as `unavailable` with the reason, never as
 * "bounded with zero volumes" — those are different facts and an operator needs to tell
 * them apart.
 */
export async function discoverVolumes(options: {
  readonly root?: string;
  readonly registry?: string;
  readonly minBytes?: number;
  readonly disabled?: boolean;
  /** Overrides the environment: `true` opts in even when no env var is set. */
  readonly enabled?: boolean;
} = {}): Promise<VolumeDiscovery> {
  const root = resolveVolumeMountRoot(options.root);
  const registry = resolveVolumeRegistry(options.registry);
  const minBytes = options.minBytes ?? 0;

  const unavailable = (code: VolumeUnavailableCode, reason: string): VolumeUnavailable => ({
    mode: 'unavailable',
    root,
    registry,
    code,
    reason,
    remediation: SETUP_REMEDIATION,
  });

  if (volumesDisabled(options.disabled)) {
    return unavailable(
      'VOLUME_DISABLED',
      'Volume mode is off (WORKSPACE_VOLUMES=off or volumes: false).',
    );
  }

  const optedIn =
    options.enabled ?? (options.root !== undefined || volumesConfigured());

  if (!optedIn) {
    return unavailable(
      'VOLUME_DISABLED',
      'Volume mode is off: nothing is leased, so disk is declared-but-unenforced. ' +
        'Opt in with WORKSPACE_VOLUMES_ROOT=/var/lib/intelligenz/mnt after running ' +
        'the setup script, and the HEAVY profile becomes available again.',
    );
  }

  let text: string;

  try {
    text = await readFile(registry, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    return unavailable(
      'VOLUME_REGISTRY_MISSING',
      `Cannot read the volume registry ${registry} (${code ?? String(error)}). ` +
        'Without it there is no volume to lease and no disk quota to claim.',
    );
  }

  const declared = parseRegistry(text);
  if (declared.length === 0) {
    return unavailable(
      'VOLUME_ROOT_MISSING',
      `The volume registry ${registry} lists no volumes.`,
    );
  }

  const mounted = await mountedPaths();
  const usable: VolumeDescriptor[] = [];
  const rejected: string[] = [];

  for (const volume of declared) {
    const resolvedMount = await realpath(volume.mountPath).catch(() => undefined);

    if (resolvedMount === undefined || !mounted.has(resolvedMount)) {
      rejected.push(`${volume.id} (${volume.mountPath} is not a mount point)`);
      continue;
    }

    try {
      await access(resolvedMount, fsConstants.W_OK);
    } catch {
      rejected.push(`${volume.id} (${resolvedMount} is not writable by this uid)`);
      continue;
    }

    const usage = await readVolumeUsage(resolvedMount);

    if (usage.totalBytes < minBytes) {
      rejected.push(
        `${volume.id} (${String(usage.totalBytes)}B usable < required ${String(minBytes)}B)`,
      );
      continue;
    }

    usable.push({ ...volume, mountPath: resolvedMount, bytes: usage.totalBytes });
  }

  if (usable.length === 0) {
    return unavailable(
      'VOLUME_NONE_MOUNTED',
      `None of the ${String(declared.length)} registered volumes is a usable mount: ` +
        `${rejected.join('; ')}.`,
    );
  }

  return { mode: 'bounded', root, registry, volumes: usable };
}

export async function readVolumeUsage(mountPath: string): Promise<VolumeUsage> {
  const stats = await statfs(mountPath);
  const blockSize = Number(stats.bsize);
  const totalBytes = Number(stats.blocks) * blockSize;
  const freeBytes = Number(stats.bavail) * blockSize;

  return { totalBytes, freeBytes, usedBytes: Math.max(0, totalBytes - freeBytes) };
}

/**
 * Clear everything inside a mounted volume.
 *
 * Three properties make this safe to run against a directory an agent wrote:
 *
 * 1. **It refuses a path that is not a mount point.** If the volume was unmounted, the
 *    mount path is an ordinary directory on the host root filesystem and clearing it
 *    would delete host bytes; the check is on `/proc/self/mountinfo`, which cannot be
 *    spoofed by a directory layout.
 * 2. **It enumerates, it does not construct.** Every path is `join(directory, entry)`
 *    of a name returned by `readdir` of a directory already validated — there is no
 *    caller-supplied segment to sanitise and no `../` that can appear.
 * 3. **Symbolic links are unlinked, never followed.** A link to `/` is one entry and one
 *    `unlink()`; nothing beneath it is visited.
 *
 * The `boundary` argument is redundant on purpose: it is asserted on every recursion so
 * a future refactor that starts building paths is caught by the assertion rather than by
 * a production incident.
 */
export async function clearVolume(
  mountPath: string,
  options: { readonly keep?: readonly string[] } = {},
): Promise<{ removedEntries: number; linkRefusals: number }> {
  if (!(await isMountPoint(mountPath))) {
    throw new VolumeError(
      'VOLUME_NOT_MOUNTED',
      `Refusing to clear ${mountPath}: it is not a mount point. An unmounted volume is a ` +
        'plain directory on the host filesystem, and clearing it would delete host bytes.',
    );
  }

  const boundary = await realpath(mountPath);
  const keep = new Set([...(options.keep ?? []), ...VOLUME_INFRASTRUCTURE_ENTRIES]);
  let removedEntries = 0;
  let linkRefusals = 0;

  const notWritable = (path: string, cause: unknown): VolumeError =>
    new VolumeError(
      'VOLUME_NOT_WRITABLE',
      `Cannot clear ${path} inside volume ${boundary}: ${
        (cause as NodeJS.ErrnoException).code ?? String(cause)
      }. It is not owned by this uid and not writable, so the volume cannot be returned ` +
        'to a known-empty state. Fail-closed: this lease is refused. Fix ownership of the ' +
        'entry (or remove it) as the volume owner, then retry.',
      { cause },
    );

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (directory === boundary && keep.has(entry.name)) continue;

      const full = join(directory, entry.name);

      if (!full.startsWith(boundary + sep)) {
        throw new VolumeError(
          'VOLUME_NOT_MOUNTED',
          `Refusing to touch ${full}: outside the volume boundary ${boundary}.`,
        );
      }

      const stats = await lstat(full);

      // A symbolic link is an entry, never a traversal. This is the whole reason the
      // function is written out instead of calling `rm -rf` and trusting it.
      if (stats.isSymbolicLink()) {
        await unlink(full).catch(() => undefined);
        linkRefusals += 1;
        removedEntries += 1;
        continue;
      }

      if (stats.isDirectory()) {
        try {
          await walk(full);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;

          if (code === 'EACCES' || code === 'EPERM') {
            // A directory the agent created without write permission for us: it is still
            // inside the volume, so making it traversable is within the boundary. If the
            // chmod does not help, the directory is not ours — refuse with a named error
            // rather than a raw `scandir` failure that says nothing about the volume.
            await chmod(full, 0o700).catch(() => undefined);
            await walk(full).catch((retry: unknown) => {
              throw notWritable(full, retry);
            });
          } else {
            throw error;
          }
        }

        await rmdir(full).catch((error: unknown) => {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EACCES' || code === 'EPERM') throw notWritable(full, error);
          throw error;
        });
        removedEntries += 1;
        continue;
      }

      await unlink(full).catch((error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EACCES' || code === 'EPERM') throw notWritable(full, error);
        throw error;
      });
      removedEntries += 1;
    }
  };

  await walk(boundary);

  return { removedEntries, linkRefusals };
}

// ── Liveness ────────────────────────────────────────────────────────────────────

let cachedBootId: string | undefined;

async function bootId(): Promise<string> {
  if (cachedBootId !== undefined) return cachedBootId;

  cachedBootId = await readFile('/proc/sys/kernel/random/boot_id', 'utf8')
    .then((text) => text.trim())
    .catch(() => 'unknown');

  return cachedBootId;
}

/**
 * Is the pid alive *on this boot*? `process.kill(pid, 0)` is the only portable probe and
 * it does not deliver a signal. `EPERM` means "alive, different owner", which is still
 * alive: treating it as dead would let a lock be stolen from a live process.
 */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readLock(lockPath: string): Promise<VolumeLockPayload | null> {
  try {
    const text = await readFile(lockPath, 'utf8');
    const parsed: unknown = JSON.parse(text);

    if (typeof parsed !== 'object' || parsed === null) return null;

    const payload = parsed as Partial<VolumeLockPayload>;

    if (typeof payload.workspaceId !== 'string' || typeof payload.pid !== 'number') return null;

    return {
      workspaceId: payload.workspaceId,
      owner: typeof payload.owner === 'string' ? payload.owner : 'unknown',
      pid: payload.pid,
      host: typeof payload.host === 'string' ? payload.host : 'unknown',
      bootId: typeof payload.bootId === 'string' ? payload.bootId : 'unknown',
      acquiredAt: typeof payload.acquiredAt === 'string' ? payload.acquiredAt : 'unknown',
    };
  } catch {
    return null;
  }
}

export interface VolumeLockState {
  readonly volumeId: string;
  readonly mountPath: string;
  readonly held: boolean;
  readonly payload: VolumeLockPayload | null;
  readonly stale: boolean;
}

// ── The pool ────────────────────────────────────────────────────────────────────

export interface VolumePoolOptions {
  readonly root?: string;
  readonly registry?: string;
  readonly minBytes?: number;
  readonly disabled?: boolean;
  /** Who holds leases. `host:pid:bootId`, matching `ExecutionWorkspace.leaseOwner`. */
  readonly owner: string;
  /** Injectable clock for tests. */
  readonly now?: () => number;
}

export interface VolumePool {
  readonly discovery: VolumeDiscovery;
  /** Claim a volume for one attempt. Throws `VolumeError('VOLUME_EXHAUSTED')` when full. */
  claim(input: { readonly workspaceId: string; readonly clear?: boolean }): Promise<VolumeLease>;
  /** Clear (by default) and unlock. Idempotent: releasing twice is not an error. */
  release(lease: VolumeLease, options?: { readonly clear?: boolean }): Promise<void>;
  /** Leases this process holds. A lease held by another process is not here. */
  held(): readonly VolumeLease[];
  /** Locks that name a dead owner, without taking them. Diagnostics and the auditor. */
  inspectLocks(): Promise<readonly VolumeLockState[]>;
}

/**
 * The in-memory lease table, backed by `O_EXCL` lock files.
 *
 * In-memory **and** on-disk is not redundancy: the map answers "does this process hold
 * this volume" (which `cleanup` needs so a forged handle cannot delete a sibling's
 * volume), and the lock file answers "does *any* process hold it" (which survives a
 * crash). Neither alone is enough.
 */
export function createVolumePool(discovery: VolumeDiscovery, options: VolumePoolOptions): VolumePool {
  const leases = new Map<string, VolumeLease>();
  const now = options.now ?? (() => Date.now());
  const host = process.env['HOSTNAME'] ?? 'localhost';

  if (discovery.mode === 'unavailable') {
    return {
      discovery,
      claim: () => {
        throw new VolumeError('VOLUME_EXHAUSTED', `No volume available: ${discovery.reason}`);
      },
      release: async () => undefined,
      held: () => [],
      inspectLocks: async () => [],
    };
  }

  const lockPathFor = (volume: VolumeDescriptor): string =>
    join(volume.mountPath, VOLUME_LOCK_FILE);

  async function lockState(volume: VolumeDescriptor): Promise<VolumeLockState> {
    const lockPath = lockPathFor(volume);
    const payload = await readLock(lockPath);
    const currentBoot = await bootId();

    // A lock is stale when its owner cannot be alive: a different boot (the recorded pid
    // means nothing now) or a pid that no longer exists. Same boot + live pid is not
    // stale, even if it is a different uid — EPERM is alive.
    const stale =
      payload === null
        ? false
        : payload.bootId !== currentBoot || !pidAlive(payload.pid);

    return {
      volumeId: volume.id,
      mountPath: volume.mountPath,
      held: payload !== null,
      payload,
      stale,
    };
  }

  /**
   * Take the lock with `O_CREAT|O_EXCL`. `wx` is the primitive: it fails with `EEXIST`
   * for every caller after the first, across processes, without a lock of our own.
   *
   * Breaking a stale lock is a two-step (unlink then create) and therefore racy in
   * principle: two workers can both see a stale lock and both unlink. The loser's
   * `unlink` returns ENOENT (ignored) and then its `wx` create fails with EEXIST —
   * which is handled by re-reading, so the race resolves to exactly one holder.
   */
  async function takeLock(
    volume: VolumeDescriptor,
    workspaceId: string,
  ): Promise<{ ok: true; warmStart: boolean } | { ok: false; reason: string }> {
    const lockPath = lockPathFor(volume);
    const payload: VolumeLockPayload = {
      workspaceId,
      owner: options.owner,
      pid: process.pid,
      host,
      bootId: await bootId(),
      acquiredAt: new Date(now()).toISOString(),
    };

    /** The last payload seen on this path, including one that was about to be broken. */
    let lastHolder: VolumeLockPayload | null = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Read before creating: after `wx` succeeds the file is ours and says nothing
      // about who held it. This is what distinguishes a warm start (same workspace,
      // dead owner, keep the checkout) from a fresh lease (clear the volume).
      const before = await readLock(lockPath);

      // A stale lock is *unlinked* before the retry, so the attempt that finally creates
      // the file reads `null`. Without remembering the last payload seen, `warmStart`
      // would be false for exactly the case it exists for — a crashed worker whose
      // checkout should be adopted rather than cleared. Measured: it was.
      if (before !== null) lastHolder = before;

      try {
        const handle = await open(lockPath, 'wx', 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(payload)}\n`, 'utf8');
        } finally {
          await handle.close();
        }

        return { ok: true, warmStart: lastHolder?.workspaceId === workspaceId };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;

        if (code === 'ENOENT') {
          return { ok: false, reason: `${volume.mountPath} disappeared while locking` };
        }

        if (code !== 'EEXIST') {
          return { ok: false, reason: `cannot create ${lockPath}: ${code ?? String(error)}` };
        }
      }

      const state = await lockState(volume);

      // Someone else holds it and is alive: this volume is not ours.
      if (state.payload !== null && !state.stale) return { ok: false, reason: 'held' };

      // Stale or unreadable: unlink and retry the exclusive create.
      await unlink(lockPath).catch(() => undefined);
    }

    return { ok: false, reason: 'lock contended after 3 attempts' };
  }

  return {
    discovery,

    async claim(input): Promise<VolumeLease> {
      // Reclaim the same volume on a warm start before considering a fresh one, so a
      // retried attempt finds its own checkout rather than a cleared stranger.
      const ordered = [...discovery.volumes].sort((left, right) => {
        const leftHeld = leases.has(left.id) ? 1 : 0;
        const rightHeld = leases.has(right.id) ? 1 : 0;

        return leftHeld - rightHeld || left.index - right.index;
      });

      const refusals: string[] = [];

      for (const volume of ordered) {
        if (leases.has(volume.id)) {
          // Named in the refusal below: "All 8 volumes are leased or unusable: ." is what
          // an operator reads when the table is full, so an in-process holder must appear
          // in the list like any other reason.
          refusals.push(`${volume.id}: leased by this pool (${leases.get(volume.id)?.workspaceId ?? 'unknown'})`);
          continue;
        }

        if (!(await isMountPoint(volume.mountPath))) {
          refusals.push(`${volume.id}: no longer a mount point`);
          continue;
        }

        const taken = await takeLock(volume, input.workspaceId);

        if (!taken.ok) {
          refusals.push(`${volume.id}: ${taken.reason}`);
          continue;
        }

        const repoPath = join(volume.mountPath, VOLUME_REPO_DIR);

        try {
          if ((input.clear ?? true) && !taken.warmStart) {
            await clearVolume(volume.mountPath, { keep: [VOLUME_LOCK_FILE] });
          }
        } catch (error) {
          await unlink(lockPathFor(volume)).catch(() => undefined);
          throw error;
        }

        const lease: VolumeLease = {
          volume,
          workspaceId: input.workspaceId,
          repoPath,
          lockPath: lockPathFor(volume),
          acquiredAt: new Date(now()).toISOString(),
          warmStart: taken.warmStart,
          usage: await readVolumeUsage(volume.mountPath),
        };

        leases.set(volume.id, lease);

        return lease;
      }

      throw new VolumeError(
        'VOLUME_EXHAUSTED',
        `No workspace volume is available for ${input.workspaceId}. ` +
          `All ${String(discovery.volumes.length)} volumes are leased or unusable: ` +
          `${refusals.join('; ')}. This is admission control, not a bug: the aggregate ` +
          'disk a set of concurrent attempts can consume is (volumes × size), and ' +
          'exceeding it is refused rather than overcommitted.',
      );
    },

    async release(lease, releaseOptions = {}): Promise<void> {
      // Ownership is decided by the lock *before* anything is deleted. Two pools in one
      // process share `owner` and `pid`, and a stale handle from a previous holder can
      // outlive its lease; clearing first and checking the lock afterwards would delete a
      // live attempt's checkout while leaving the new holder's lock in place — a failure
      // that looks like the agent's, not the cleaner's.
      const local = leases.get(lease.volume.id);
      const ownsLocal = local !== undefined && local.workspaceId === lease.workspaceId;
      const payload = await readLock(lease.lockPath);

      // No lock and no local entry: a handle for a lease this pool never held. Nothing to
      // clean and nothing to delete, so releasing it is a no-op rather than a raid on a
      // volume that may be claimed between these two reads.
      const ownsLock =
        payload === null
          ? ownsLocal
          : payload.workspaceId === lease.workspaceId && payload.owner === options.owner;

      if (!ownsLock) {
        // The device is someone else's now. Drop our own bookkeeping if we had any, but
        // touch neither the lock file nor the bytes it protects.
        if (ownsLocal) leases.delete(lease.volume.id);

        return;
      }

      if ((releaseOptions.clear ?? true) && (await isMountPoint(lease.volume.mountPath))) {
        await clearVolume(lease.volume.mountPath, { keep: [VOLUME_LOCK_FILE] });
      }

      // Only remove a lock that still names us: a volume that was broken and re-leased
      // by another worker must not have its lock deleted by the previous holder.
      await unlink(lease.lockPath).catch(() => undefined);

      if (ownsLocal) leases.delete(lease.volume.id);
    },

    held(): readonly VolumeLease[] {
      return [...leases.values()];
    },

    async inspectLocks(): Promise<readonly VolumeLockState[]> {
      const states: VolumeLockState[] = [];

      for (const volume of discovery.volumes) {
        states.push(await lockState(volume));
      }

      return states;
    },
  };
}

/** True when the discovery describes real mounts rather than an intention. */
export function isBounded(discovery: VolumeDiscovery): discovery is VolumeSet {
  return discovery.mode === 'bounded';
}

/** One line for a boot log or an attempt log. */
export function describeVolumes(discovery: VolumeDiscovery): string {
  if (discovery.mode === 'bounded') {
    const totalBytes = discovery.volumes.reduce((sum, volume) => sum + volume.bytes, 0);

    return (
      `workspace volumes: BOUNDED (${String(discovery.volumes.length)} × ` +
      `${String(Math.round(discovery.volumes[0]?.bytes ?? 0) / (1024 * 1024))} MiB ` +
      `= ${String(Math.round(totalBytes / (1024 * 1024)))} MiB aggregate ceiling, root ` +
      `${discovery.root})`
    );
  }

  return (
    `workspace volumes: UNAVAILABLE [${discovery.code}] ${discovery.reason} ` +
    `Disk is declared-but-unenforced; ${discovery.remediation}`
  );
}

/** Exported so a test can assert the lock payload shape it wrote. */
export async function readVolumeLock(lockPath: string): Promise<VolumeLockPayload | null> {
  return readLock(lockPath);
}

/** Write a lease file directly. Used by tests and by the auditor's stale-lock fixture. */
export async function writeVolumeLock(lockPath: string, payload: VolumeLockPayload): Promise<void> {
  await writeFile(lockPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
}

export type { VolumeLockPayload };
