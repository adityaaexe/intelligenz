import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  VOLUME_LOCK_FILE,
  VolumeError,
  clearVolume,
  createVolumePool,
  createWorkspaceManager,
  describeVolumes,
  discoverVolumes,
  isMountPoint,
  readVolumeLock,
  readVolumeUsage,
  volumesDisabled,
  writeVolumeLock,
  type VolumeLease,
  type VolumePool,
  type VolumeSet,
} from '../src';

/**
 * Gate D — the disk quota is a property of a block device, and these tests measure it
 * against the real 1 GiB ext4 volumes on this host.
 *
 * ## Why the real volumes, and why that is still safe
 *
 * A lease cannot be faked: `claim()` proves the volume is a mount point by reading
 * `/proc/self/mountinfo` and proves it is writable by creating an `O_EXCL` lock *inside*
 * it. A temp directory would pass neither check, and a mock would only test the mock.
 * So the suite leases the host's volumes, releases every one it takes, and never
 * unmounts, formats or deletes an image.
 *
 * ## The cross-process lock
 *
 * The pool is shared state — the root `vitest run` executes this file beside the
 * worker's I/O suite, which leases a volume to measure `io.max`. Two suites leasing the
 * same device would make the exclusivity assertions flaky rather than wrong, so
 * volume-touching suites serialise on one lock file. It is test infrastructure: nothing
 * in `src/` knows this file exists.
 */

const discovery = await discoverVolumes({ enabled: true });

const SET: VolumeSet | null = discovery.mode === 'bounded' ? discovery : null;

if (discovery.mode === 'unavailable') {
  process.stdout.write(
    `\n[volumes tier] unavailable — ${discovery.code}: ${discovery.reason}\n` +
      'Gate D cannot be measured on this host; the suite is skipped rather than mocked.\n',
  );
}

function requireSet(): VolumeSet {
  if (SET === null) throw new Error('workspace volumes are unavailable on this host');

  return SET;
}

/** A discovery restricted to one volume, so "the next lease" cannot be a different device. */
function onlyVolume(set: VolumeSet, index: number): VolumeSet {
  const volume = set.volumes.at(index);

  if (volume === undefined) throw new Error(`no volume at index ${String(index)}`);

  return { mode: 'bounded', root: set.root, registry: set.registry, volumes: [volume] };
}

function volumeFrom(set: VolumeSet, index: number): NonNullable<VolumeSet['volumes'][number]> {
  const volume = set.volumes.at(index);

  if (volume === undefined) throw new Error(`no volume at index ${String(index)}`);

  return volume;
}

const LOCK_PATH = join(tmpdir(), 'intelligenz-volumes-test.lock');
const LOCK_STALE_MS = 180_000;
const LOCK_WAIT_MS = 240_000;

/**
 * One exclusive holder across processes, with a stale-lock breaker.
 *
 * Deliberately the same primitive the volumes themselves use (`O_CREAT|O_EXCL`), so a
 * crashed test cannot deadlock the next run: a lock older than three minutes is broken.
 */
async function acquireTestLock(): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    try {
      const handle = await open(LOCK_PATH, 'wx', 0o600);
      await handle.writeFile(`${String(process.pid)}\n`, 'utf8');
      await handle.close();

      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

      const age = await stat(LOCK_PATH)
        .then((info) => Date.now() - info.mtimeMs)
        .catch(() => LOCK_STALE_MS + 1);

      if (age > LOCK_STALE_MS) {
        await rm(LOCK_PATH, { force: true });
        continue;
      }

      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${LOCK_PATH}; another volume suite is running`);
      }

      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
}

/** Leases this file holds. Released in every `finally`, and again in `afterAll`. */
const outstanding: { pool: VolumePool; lease: VolumeLease }[] = [];

async function lease(pool: VolumePool, workspaceId: string): Promise<VolumeLease> {
  const claimed = await pool.claim({ workspaceId });
  outstanding.push({ pool, lease: claimed });

  return claimed;
}

async function releaseOutstanding(): Promise<void> {
  for (const { pool, lease: claimed } of outstanding.splice(0)) {
    await pool.release(claimed).catch(() => undefined);
  }
}

beforeAll(async () => {
  if (SET === null) return;

  await acquireTestLock();
});

afterAll(async () => {
  await releaseOutstanding();

  if (SET !== null) await rm(LOCK_PATH, { force: true });
});

describe.skipIf(SET === null)('volume leases', () => {
  it('leases eight volumes in parallel, never repeats one, and refuses the ninth with a typed error', async () => {
    const set = requireSet();
    const pool = createVolumePool(set, { owner: `test:${String(process.pid)}` });

    try {
      const leases = await Promise.all(
        set.volumes.map((_, index) => pool.claim({ workspaceId: `par-ws-${String(index)}` })),
      );

      for (const claimed of leases) outstanding.push({ pool, lease: claimed });

      const ids = leases.map((claimed) => claimed.volume.id);

      // The registry is the measured starting state: 8 images, 8 mounts.
      expect(set.volumes.length).toBeGreaterThanOrEqual(8);
      expect(leases).toHaveLength(set.volumes.length);
      expect(new Set(ids).size).toBe(leases.length);

      for (const claimed of leases) {
        // A lease is a place to write, not a label: the checkout path is on the volume.
        expect(claimed.repoPath).toBe(join(claimed.volume.mountPath, 'repo'));
        expect(await isMountPoint(claimed.volume.mountPath)).toBe(true);
        expect(claimed.lockPath).toBe(join(claimed.volume.mountPath, VOLUME_LOCK_FILE));
        expect(claimed.usage.totalBytes).toBeGreaterThan(0);
      }

      // Nine concurrent attempts on eight volumes: the ninth is admission control, not a
      // crash and not an overcommit.
      const refusal: unknown = await pool.claim({ workspaceId: 'par-ws-overflow' }).then(
        () => null,
        (error: unknown) => error,
      );

      expect(refusal).toBeInstanceOf(VolumeError);
      if (!(refusal instanceof VolumeError)) throw new Error('expected a VolumeError');

      expect(refusal.code).toBe('VOLUME_EXHAUSTED');
      expect(refusal.message).toContain('admission control');
      // The message names every volume it tried, so an operator can see why.
      for (const claimed of leases) expect(refusal.message).toContain(claimed.volume.id);
    } finally {
      await releaseOutstanding();
    }

    expect(pool.held()).toEqual([]);
  });

  it('returns a released volume empty, and the next lease adopts it clean', async () => {
    const set = requireSet();
    // One volume, so "the next lease" cannot be a different device by accident.
    const pool = createVolumePool(onlyVolume(set, 0), { owner: `test:${String(process.pid)}` });

    try {
      const first = await lease(pool, 'release-ws-a');
      const mount = first.volume.mountPath;

      await mkdir(join(first.repoPath, 'nested'), { recursive: true });
      await writeFile(join(first.repoPath, 'nested', 'left-behind.txt'), 'agent bytes');
      await writeFile(join(mount, 'root-level.txt'), 'agent bytes');

      expect((await readVolumeLock(first.lockPath))?.workspaceId).toBe('release-ws-a');

      await pool.release(first);
      outstanding.splice(0);

      // Released: no lock, and nothing an agent wrote survives.
      expect(pool.held()).toEqual([]);
      await expect(readVolumeLock(first.lockPath)).resolves.toBeNull();

      const entries = await readdir(mount);
      expect(entries).not.toContain('repo');
      expect(entries).not.toContain('root-level.txt');
      // `lost+found` is ext4 infrastructure (root-owned 0700), not attempt content. It is
      // kept on purpose: no attempt can write there, so it cannot leak between leases.
      expect(entries).toContain('lost+found');

      const second = await lease(pool, 'release-ws-b');

      expect(second.volume.id).toBe(first.volume.id);
      // A different workspace is a fresh lease, not a warm start.
      expect(second.warmStart).toBe(false);
      // The previous attempt's checkout is gone, measured rather than assumed.
      await expect(stat(join(second.repoPath, 'nested', 'left-behind.txt'))).rejects.toThrow();
    } finally {
      await releaseOutstanding();
    }
  });

  it('adopts a stale lock on the same workspace as a warm start instead of clearing the checkout', async () => {
    const set = requireSet();
    const volume = volumeFrom(set, 1);
    const pool = createVolumePool(onlyVolume(set, 1), { owner: `test:${String(process.pid)}` });

    try {
      // A worker that died holding the lock: right workspace, no live pid, another boot.
      // This is the case the warm start exists for — a retried attempt should find its own
      // checkout instead of a cleared stranger.
      await mkdir(join(volume.mountPath, 'repo'), { recursive: true });
      await writeFile(join(volume.mountPath, 'repo', 'uncommitted.patch'), 'the work in progress');
      await writeVolumeLock(join(volume.mountPath, VOLUME_LOCK_FILE), {
        workspaceId: 'warm-ws',
        owner: 'worker-that-died',
        pid: 2_147_483_646,
        host: 'gone',
        bootId: 'a-previous-boot',
        acquiredAt: new Date(0).toISOString(),
      });

      const warm = await lease(pool, 'warm-ws');

      // Regression: the stale lock is unlinked before the successful `wx`, so a naive
      // read of the new lock file reports `warmStart: false` and clears the checkout.
      expect(warm.warmStart).toBe(true);
      expect(await readFile(join(warm.repoPath, 'uncommitted.patch'), 'utf8')).toBe(
        'the work in progress',
      );

      await pool.release(warm);
      outstanding.splice(0);

      // A lease on a *different* workspace over the same device is not warm, and it is
      // cleared: a stranger's bytes must not become the next attempt's checkout.
      await mkdir(join(volume.mountPath, 'repo'), { recursive: true });
      await writeFile(join(volume.mountPath, 'repo', 'someone-elses.patch'), 'not yours');

      const fresh = await lease(pool, 'someone-else');

      expect(fresh.warmStart).toBe(false);
      await expect(stat(join(fresh.repoPath, 'someone-elses.patch'))).rejects.toThrow();
    } finally {
      await releaseOutstanding();
    }
  });
});

describe.skipIf(SET === null)('workspace on a bounded volume', () => {
  it('reports the volume mountpoint for a leased workspace and puts the checkout on it', async () => {
    const set = requireSet();
    const root = await mkdtemp(join(tmpdir(), 'intelligenz-vol-ws-'));

    const manager = createWorkspaceManager({ root, volumeDiscovery: onlyVolume(set, 2) });

    const handle = await manager.provision({
      orgId: 'org-1',
      taskId: 'task-1',
      workspaceId: 'ws-on-volume',
      source: { kind: 'empty' },
    });

    try {
      expect(handle.state).toBe('ready');

      const volume = handle.volume;

      expect(volume).toBeDefined();
      if (volume === undefined) throw new Error('expected the workspace to be bound to a volume');

      // The volume is reported by its mountpoint and verified to be a mount, not a path
      // that merely looks like one.
      expect(await isMountPoint(volume.mountPath)).toBe(true);
      expect(handle.repoPath).toBe(join(volume.mountPath, 'repo'));
      expect(handle.repoPath.startsWith(volume.mountPath)).toBe(true);

      // Writing through the handle lands on the volume — the same inode namespace, proven
      // by resolving both sides rather than comparing strings.
      await writeFile(join(handle.repoPath, 'on-volume.txt'), 'x');
      expect(await realpath(join(handle.repoPath, 'on-volume.txt'))).toBe(
        join(await realpath(volume.mountPath), 'repo', 'on-volume.txt'),
      );

      // The reported ceiling is the device's, read back with statfs.
      const usage = await readVolumeUsage(volume.mountPath);
      expect(volume.totalBytes).toBe(usage.totalBytes);
      expect(volume.totalBytes).toBeGreaterThan(512 * 1024 * 1024);

      // The handle also keeps the host-side lease directory. That is deliberate: rootPath
      // is where `artifacts/` survives cleanup, and it must not sit on the disposable
      // volume. The checkout — the only writable mount — is the volume path above.
      expect(handle.rootPath.startsWith(await realpath(root))).toBe(true);
      expect(handle.rootPath).not.toBe(volume.mountPath);

      expect(await manager.volumeLeases()).toHaveLength(1);
    } finally {
      await manager.cleanup(handle);
      await rm(root, { recursive: true, force: true });
    }

    // Cleanup returns the lease: a workspace that ended must not hold a device slot.
    expect(await manager.volumeLeases()).toEqual([]);
  });

  it('degrades to an unavailable discovery when nothing is mounted, and does not claim a quota', async () => {
    const missingRoot = join(tmpdir(), 'intelligenz-no-such-mnt');
    const missingRegistry = join(tmpdir(), 'intelligenz-no-such-registry.tsv');

    const absent = await discoverVolumes({
      enabled: true,
      root: missingRoot,
      registry: missingRegistry,
    });

    expect(absent.mode).toBe('unavailable');
    if (absent.mode !== 'unavailable') throw new Error('expected an unavailable discovery');
    expect(absent.code).toBe('VOLUME_REGISTRY_MISSING');
    expect(describeVolumes(absent)).toContain('UNAVAILABLE');
    expect(absent.remediation).toContain('setup-workspace-volumes.sh');

    // A registry that lists a directory which is not a mount is rejected per volume, and
    // reported as "none mounted" — never as "bounded with zero volumes".
    const registryDir = await mkdtemp(join(tmpdir(), 'intelligenz-reg-'));
    const fakeRegistry = join(registryDir, 'registry.tsv');
    const notAMount = await mkdtemp(join(tmpdir(), 'intelligenz-not-a-mount-'));
    await writeFile(
      fakeRegistry,
      `1\t/tmp/fake.img\t/dev/loop99\t${notAMount}\t  7:99 \t1048576\n`,
      'utf8',
    );

    const noneMounted = await discoverVolumes({
      enabled: true,
      root: notAMount,
      registry: fakeRegistry,
    });

    expect(noneMounted.mode).toBe('unavailable');
    if (noneMounted.mode !== 'unavailable') throw new Error('expected an unavailable discovery');
    expect(noneMounted.code).toBe('VOLUME_NONE_MOUNTED');
    expect(noneMounted.reason).toContain('is not a mount point');

    // The explicit switch, and the documented `WORKSPACE_VOLUMES=off` environment form.
    expect(volumesDisabled(false)).toBe(true);
    expect(volumesDisabled(true)).toBe(false);

    const previous = process.env['WORKSPACE_VOLUMES'];
    process.env['WORKSPACE_VOLUMES'] = 'off';

    try {
      expect(volumesDisabled()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env['WORKSPACE_VOLUMES'];
      else process.env['WORKSPACE_VOLUMES'] = previous;
    }

    expect(volumesDisabled()).toBe(false);

    // With no usable volume the manager still runs — disk is declared-but-unenforced, and
    // the handle says so by having no `volume` at all rather than a fake one.
    const root = await mkdtemp(join(tmpdir(), 'intelligenz-unbounded-'));
    const manager = createWorkspaceManager({
      root,
      volumes: { root: missingRoot, registry: missingRegistry },
    });

    const handle = await manager.provision({
      orgId: 'org-1',
      taskId: 'task-1',
      workspaceId: 'ws-unbounded',
      source: { kind: 'empty' },
    });

    try {
      expect(handle.state).toBe('ready');
      expect(handle.volume).toBeUndefined();
      expect(handle.repoPath).toBe(join(handle.rootPath, 'repo'));
      expect(await manager.volumeLeases()).toEqual([]);
      expect((await manager.volumes()).mode).toBe('unavailable');
    } finally {
      await manager.cleanup(handle);
      await rm(root, { recursive: true, force: true });
      await rm(notAMount, { recursive: true, force: true });
      await rm(registryDir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(SET === null)('volume cleanup containment', () => {
  it('cannot be made to delete outside the volume by `..` or by a symbolic link', async () => {
    const set = requireSet();
    const volume = volumeFrom(set, 3);
    const pool = createVolumePool(onlyVolume(set, 3), { owner: `test:${String(process.pid)}` });

    const outside = await mkdtemp(join(tmpdir(), 'intelligenz-outside-'));
    const sibling = join(outside, 'sibling.txt');
    await writeFile(sibling, 'must survive');

    try {
      const claimed = await lease(pool, 'containment-ws');

      await mkdir(claimed.repoPath, { recursive: true });
      await writeFile(join(claimed.repoPath, 'file.txt'), 'x');
      await symlink(sibling, join(claimed.repoPath, 'link-to-sibling'));
      await symlink('/', join(claimed.repoPath, 'link-to-root'));

      // A path that resolves out of the volume is refused before anything is enumerated.
      // `<mount>/..` resolves to the mount root, which is not itself a mount point.
      await expect(clearVolume(join(volume.mountPath, '..'))).rejects.toMatchObject({
        code: 'VOLUME_NOT_MOUNTED',
      });
      await expect(clearVolume(outside)).rejects.toMatchObject({ code: 'VOLUME_NOT_MOUNTED' });

      // The refusal happened before any deletion: the checkout is still there.
      expect((await stat(join(claimed.repoPath, 'file.txt'))).isFile()).toBe(true);

      const cleared = await clearVolume(volume.mountPath, { keep: [VOLUME_LOCK_FILE] });

      // Two links were unlinked as entries, not followed: a `rm -rf` would have deleted
      // the contents of `/` here.
      expect(cleared.linkRefusals).toBeGreaterThanOrEqual(2);
      expect(await readFile(sibling, 'utf8')).toBe('must survive');
      expect(await readdir(outside)).toEqual(['sibling.txt']);

      const entries = await readdir(volume.mountPath);
      expect(entries).not.toContain('repo');
      expect(entries).toContain(VOLUME_LOCK_FILE);
    } finally {
      await releaseOutstanding();
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses to clear a directory that is not a mount point, leaving its contents intact', async () => {
    const decoy = await mkdtemp(join(tmpdir(), 'intelligenz-decoy-'));
    const file = join(decoy, 'host-bytes.txt');
    await writeFile(file, 'host data');

    await expect(clearVolume(decoy)).rejects.toBeInstanceOf(VolumeError);
    await expect(clearVolume(decoy)).rejects.toMatchObject({ code: 'VOLUME_NOT_MOUNTED' });

    expect(await readFile(file, 'utf8')).toBe('host data');
    expect((await lstat(file)).isFile()).toBe(true);

    await rm(decoy, { recursive: true, force: true });
  });
});

/**
 * The lease is the unit of exclusion, and these tests attack it from the two directions a
 * real worker gets it wrong: an attempt that still has a handle to a volume it no longer
 * owns, and an attempt that tries to release one it never held.
 *
 * There is no lease TTL in `volumes.ts` (the injectable `now` is used for timestamps, not
 * expiry). Reclaim is **liveness-based**: a lock is stale when its recorded boot id is not
 * this boot, or when its pid is not alive on this boot. That is deliberate — a TTL would
 * expire a long-running attempt that is still working, while a dead pid never does. The
 * tests below drive that mechanism with real lock files, not with sleeps.
 */
describe.skipIf(SET === null)('lease ownership, release and reclaim', () => {
  const bootId = async (): Promise<string> =>
    readFile('/proc/sys/kernel/random/boot_id', 'utf8')
      .then((text) => text.trim())
      .catch(() => 'unknown');

  it('hands a one-volume pool to exactly one of two concurrent claims', async () => {
    const set = requireSet();
    // One volume, two simultaneous claims, no sleep anywhere: whichever loses the
    // `O_EXCL` create must refuse rather than return the same lease twice.
    const pool = createVolumePool(onlyVolume(set, 4), { owner: `test:${String(process.pid)}` });

    try {
      const results = await Promise.allSettled([
        pool.claim({ workspaceId: 'race-ws-a' }),
        pool.claim({ workspaceId: 'race-ws-b' }),
      ]);

      const granted = results.filter(
        (result): result is PromiseFulfilledResult<VolumeLease> => result.status === 'fulfilled',
      );
      const refused = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );

      expect(granted).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(refused[0]?.reason).toBeInstanceOf(VolumeError);
      expect((refused[0]?.reason as VolumeError).code).toBe('VOLUME_EXHAUSTED');

      const winner = granted[0]?.value;
      if (winner === undefined) throw new Error('expected exactly one granted lease');
      outstanding.push({ pool, lease: winner });

      // The pool's own view and the lock file agree on who won.
      expect(pool.held().map((candidate) => candidate.workspaceId)).toEqual([
        winner.workspaceId,
      ]);
      expect((await readVolumeLock(winner.lockPath))?.workspaceId).toBe(winner.workspaceId);
    } finally {
      await releaseOutstanding();
    }
  });

  it('refuses a release from a pool that does not own the lock, and keeps the checkout', async () => {
    const set = requireSet();
    const volume = volumeFrom(set, 5);
    const holder = createVolumePool(onlyVolume(set, 5), { owner: 'owner-that-holds' });
    const intruder = createVolumePool(onlyVolume(set, 5), { owner: 'owner-that-does-not' });

    try {
      const claimed = await lease(holder, 'holder-ws');
      await mkdir(claimed.repoPath, { recursive: true });
      await writeFile(join(claimed.repoPath, 'work-in-progress.patch'), 'not yours to delete');

      // A stale handle from another worker that was never granted this volume. Clearing
      // before checking ownership would delete a live attempt's checkout — the lock file
      // survives, so the damage would be invisible until the attempt failed.
      await intruder.release(claimed);

      expect(await readFile(join(claimed.repoPath, 'work-in-progress.patch'), 'utf8')).toBe(
        'not yours to delete',
      );
      expect((await readVolumeLock(join(volume.mountPath, VOLUME_LOCK_FILE)))?.workspaceId).toBe(
        'holder-ws',
      );
      expect(holder.held().map((candidate) => candidate.workspaceId)).toEqual(['holder-ws']);
      expect(intruder.held()).toEqual([]);
    } finally {
      await releaseOutstanding();
    }
  });

  it('does not let a forged lease clear a sibling volume or evict its in-process entry', async () => {
    const set = requireSet();
    const volume = volumeFrom(set, 6);
    const pool = createVolumePool(onlyVolume(set, 6), { owner: `test:${String(process.pid)}` });

    try {
      const claimed = await lease(pool, 'real-ws');
      await mkdir(claimed.repoPath, { recursive: true });
      await writeFile(join(claimed.repoPath, 'keep.txt'), 'alive');

      // Same process, same `owner`, same pid — the only field that distinguishes the
      // lease is the workspace id, and it is the one a forged handle guesses.
      await pool.release({ ...claimed, workspaceId: 'forged-ws' });

      expect(await readFile(join(claimed.repoPath, 'keep.txt'), 'utf8')).toBe('alive');
      expect((await readVolumeLock(join(volume.mountPath, VOLUME_LOCK_FILE)))?.workspaceId).toBe(
        'real-ws',
      );
      expect(pool.held().map((candidate) => candidate.workspaceId)).toEqual(['real-ws']);
    } finally {
      await releaseOutstanding();
    }
  });

  it('releases twice (and an unknown lease) without error, and the volume stays claimable', async () => {
    const set = requireSet();
    const volume = volumeFrom(set, 5);
    const pool = createVolumePool(onlyVolume(set, 5), { owner: `test:${String(process.pid)}` });

    try {
      const claimed = await lease(pool, 'idempotent-ws');

      await pool.release(claimed);
      outstanding.splice(0);

      // A second release of the same handle, and a handle for a lease this pool never
      // held: both are no-ops, not errors and not a reason to delete someone's bytes.
      await expect(pool.release(claimed)).resolves.toBeUndefined();
      await expect(pool.release({ ...claimed, workspaceId: 'never-held' })).resolves.toBeUndefined();

      expect(pool.held()).toEqual([]);
      await expect(readVolumeLock(join(volume.mountPath, VOLUME_LOCK_FILE))).resolves.toBeNull();
      expect(await readdir(volume.mountPath)).not.toContain(VOLUME_LOCK_FILE);

      // Available again, exactly once.
      const again = await lease(pool, 'idempotent-ws-2');

      expect(again.volume.id).toBe(volume.id);
      expect(again.warmStart).toBe(false);
      expect(pool.held()).toHaveLength(1);
      await pool.release(again);
      outstanding.splice(0);
    } finally {
      await releaseOutstanding();
    }
  });

  it('reclaims a dead owner’s lock on this boot, but not a live pid’s lock', async () => {
    const set = requireSet();
    const volume = volumeFrom(set, 3);
    const lockPath = join(volume.mountPath, VOLUME_LOCK_FILE);
    const currentBoot = await bootId();

    try {
      // Dead pid, same boot: the container/pid-namespace case a boot-id-only check would
      // miss. The pid is out of range on purpose — `kill(pid, 0)` returns ESRCH.
      await writeVolumeLock(lockPath, {
        workspaceId: 'dead-owner-ws',
        owner: 'worker-that-died',
        pid: 2_147_483_646,
        host: 'same-host',
        bootId: currentBoot,
        acquiredAt: new Date(0).toISOString(),
      });

      const reclaimer = createVolumePool(onlyVolume(set, 3), { owner: 'reclaimer' });

      const deadState = (await reclaimer.inspectLocks())[0];
      expect(deadState?.stale).toBe(true);

      const reclaimed = await reclaimer.claim({ workspaceId: 'reclaimer-ws' });

      expect(reclaimed.volume.id).toBe(volume.id);
      expect(reclaimed.warmStart).toBe(false);
      outstanding.push({ pool: reclaimer, lease: reclaimed });
      await reclaimer.release(reclaimed);
      outstanding.splice(0);

      // Live pid, same boot: this is not stale, so a second pool must refuse rather than
      // break a lock that a working attempt is holding.
      await writeVolumeLock(lockPath, {
        workspaceId: 'live-owner-ws',
        owner: 'worker-that-is-alive',
        pid: process.pid,
        host: 'same-host',
        bootId: currentBoot,
        acquiredAt: new Date().toISOString(),
      });

      const second = createVolumePool(onlyVolume(set, 3), { owner: 'second-pool' });
      const liveState = (await second.inspectLocks())[0];

      expect(liveState?.stale).toBe(false);

      const refusal: unknown = await second
        .claim({ workspaceId: 'second-pool-ws' })
        .then(() => null, (error: unknown) => error);

      expect(refusal).toBeInstanceOf(VolumeError);
      if (!(refusal instanceof VolumeError)) throw new Error('expected a VolumeError');
      expect(refusal.code).toBe('VOLUME_EXHAUSTED');
      expect(refusal.message).toContain('held');
      expect(second.held()).toEqual([]);
    } finally {
      await releaseOutstanding();
      // The fixture lock is the test's, not a lease: remove it so the volume is clean.
      await rm(lockPath, { force: true });
    }
  });

  it('reclaims a lock from a different boot even when its pid is alive here', async () => {
    const set = requireSet();
    const volume = volumeFrom(set, 6);
    const lockPath = join(volume.mountPath, VOLUME_LOCK_FILE);
    const pool = createVolumePool(onlyVolume(set, 6), { owner: 'boot-mismatch' });

    try {
      // `process.pid` is alive, but it belongs to *this* boot. A lock written before a
      // reboot records a pid that now means something else; trusting it would strand the
      // volume until the number was reused.
      await writeVolumeLock(lockPath, {
        workspaceId: 'before-reboot-ws',
        owner: 'worker-before-reboot',
        pid: process.pid,
        host: 'same-host',
        bootId: 'a-previous-boot',
        acquiredAt: new Date(0).toISOString(),
      });

      const state = (await pool.inspectLocks())[0];
      expect(state?.stale).toBe(true);

      const claimed = await pool.claim({ workspaceId: 'after-reboot-ws' });

      expect(claimed.volume.id).toBe(volume.id);
      expect(claimed.warmStart).toBe(false);
      outstanding.push({ pool, lease: claimed });
    } finally {
      await releaseOutstanding();
      await rm(lockPath, { force: true });
    }
  });

  it('keeps the pool table and the lock files honest across acquire/release cycles', async () => {
    const set = requireSet();
    const volume = volumeFrom(set, 5);
    const pool = createVolumePool(onlyVolume(set, 5), { owner: `test:${String(process.pid)}` });
    const lockPath = join(volume.mountPath, VOLUME_LOCK_FILE);

    try {
      for (let cycle = 0; cycle < 3; cycle += 1) {
        const claimed = await pool.claim({ workspaceId: `cycle-${String(cycle)}` });

        expect(claimed.volume.id).toBe(volume.id);

        // One volume, one lease, one lock — not "at least one" of any of them.
        expect(pool.held()).toHaveLength(1);
        expect(pool.held().filter((candidate) => candidate.volume.id === volume.id)).toHaveLength(
          1,
        );
        expect((await readdir(volume.mountPath)).filter((name) => name === VOLUME_LOCK_FILE)).toEqual(
          [VOLUME_LOCK_FILE],
        );
        expect((await readVolumeLock(lockPath))?.workspaceId).toBe(`cycle-${String(cycle)}`);

        await pool.release(claimed);

        expect(pool.held()).toEqual([]);
        await expect(readVolumeLock(lockPath)).resolves.toBeNull();
        expect(await readdir(volume.mountPath)).not.toContain(VOLUME_LOCK_FILE);
      }

      // No duplicate discovery entry either: a volume appears once in the set it leases.
      expect(set.volumes.filter((candidate) => candidate.id === volume.id)).toHaveLength(1);
    } finally {
      await releaseOutstanding();
    }
  });

  it('leaves no orphaned lock or active lease when an acquisition is refused', async () => {
    const set = requireSet();
    const volume = volumeFrom(set, 6);
    const lockPath = join(volume.mountPath, VOLUME_LOCK_FILE);
    const pool = createVolumePool(onlyVolume(set, 6), { owner: `test:${String(process.pid)}` });

    try {
      const held = await lease(pool, 'orphan-holder');

      const refusal: unknown = await pool.claim({ workspaceId: 'orphan-refused' }).then(
        () => null,
        (error: unknown) => error,
      );

      expect(refusal).toBeInstanceOf(VolumeError);
      expect((refusal as VolumeError).code).toBe('VOLUME_EXHAUSTED');

      // The refused attempt left nothing behind: the only lock names the holder, and the
      // pool's table has exactly the one lease it granted.
      expect((await readVolumeLock(lockPath))?.workspaceId).toBe('orphan-holder');
      expect((await readdir(volume.mountPath)).filter((name) => name === VOLUME_LOCK_FILE)).toEqual(
        [VOLUME_LOCK_FILE],
      );
      expect(pool.held().map((candidate) => candidate.workspaceId)).toEqual(['orphan-holder']);

      await pool.release(held);
      outstanding.splice(0);

      expect(pool.held()).toEqual([]);
      await expect(readVolumeLock(lockPath)).resolves.toBeNull();
    } finally {
      await releaseOutstanding();
    }
  });
});

describe.skipIf(SET === null)('volume ENOSPC', () => {
  it('surfaces a full volume as a typed workspace failure, not a raw write error', async () => {
    const set = requireSet();
    // The last volume, so filling it cannot disturb the others in this file.
    const only = onlyVolume(set, set.volumes.length - 1);
    const volume = volumeFrom(set, set.volumes.length - 1);

    // A stale lock naming the workspace we are about to provision makes `claim()` adopt
    // (warm start) instead of clearing, so the fill survives the lease. This is the
    // crashed-worker-on-a-full-disk case, not a contrived one.
    await writeVolumeLock(join(volume.mountPath, VOLUME_LOCK_FILE), {
      workspaceId: 'full-ws',
      owner: 'worker-that-died',
      pid: 2_147_483_646,
      host: 'gone',
      bootId: 'a-previous-boot',
      acquiredAt: new Date(0).toISOString(),
    });

    const filler = join(volume.mountPath, 'filler.bin');
    const handle = await open(filler, 'w');
    const chunk = Buffer.alloc(4 * 1024 * 1024, 0x61);
    const page = Buffer.alloc(4 * 1024, 0x61);
    let written = 0;

    try {
      // Fill the device until the kernel refuses. The host filesystem is not touched: the
      // bytes land in a 1 GiB loop image, which is the point of the volume. A second pass
      // with block-sized writes is needed because a 4 MiB write is refused *atomically*
      // and can leave up to 4 MiB free — not empty enough to make a `mkdir` fail, and
      // `mkdir` failing is exactly the workspace-layer behaviour under test.
      for (;;) {
        try {
          const result = await handle.write(chunk);
          written += result.bytesWritten;

          if (result.bytesWritten < chunk.byteLength) break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOSPC') break;
          throw error;
        }
      }

      for (;;) {
        try {
          const result = await handle.write(page);
          written += result.bytesWritten;

          if (result.bytesWritten < page.byteLength) break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOSPC') break;
          throw error;
        }
      }
    } finally {
      await handle.close();
    }

    const usage = await readVolumeUsage(volume.mountPath);

    // The authoritative measurement: a fresh write fails with the kernel's error.
    const rawFailure: unknown = await writeFile(
      join(volume.mountPath, 'after-fill.bin'),
      Buffer.alloc(2 * 1024 * 1024, 0x62),
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect((rawFailure as NodeJS.ErrnoException | null)?.code).toBe('ENOSPC');
    expect(written).toBeGreaterThan(850 * 1024 * 1024);
    expect(usage.freeBytes).toBeLessThan(4 * 1024);

    process.stdout.write(
      `[enospc] wrote=${String(written)}B raw_errno=${String(
        (rawFailure as NodeJS.ErrnoException | null)?.code,
      )} free_bytes=${String(usage.freeBytes)} mount=${volume.mountPath}\n`,
    );

    // Now the workspace layer, on the same full device.
    const root = await mkdtemp(join(tmpdir(), 'intelligenz-enospc-'));
    const manager = createWorkspaceManager({ root, volumeDiscovery: only });

    try {
      const failed = await manager.provision({
        orgId: 'org-enospc',
        taskId: 'task-enospc',
        workspaceId: 'full-ws',
        source: { kind: 'empty' },
      });

      // A failed provision is a record with a code and a stage — the shape the worker
      // persists — rather than an exception the activity has to match on a POSIX errno.
      expect(failed.state).toBe('failed');
      expect(failed.error).toBeDefined();
      expect(failed.error?.code).toBe('WORKSPACE_PROVISION_FAILED');
      // `empty` creates the checkout in the `source` stage, so that is where a full device
      // reports the failure. The message carries the errno and the exact path, which is
      // what makes it actionable rather than "provisioning failed".
      expect(failed.error?.stage).toBe('source');
      expect(failed.error?.message).toMatch(/ENOSPC|no space left on device/i);
      expect(failed.error?.message).toContain(volume.mountPath);

      process.stdout.write(
        `[enospc] provision state=${failed.state} code=${String(failed.error?.code)} ` +
          `stage=${String(failed.error?.stage)} message=${String(failed.error?.message)}\n`,
      );

      // Provisioning a failed workspace releases the lease and clears the device, so one
      // bad attempt does not turn a full volume into a permanently unavailable slot.
      expect(await manager.volumeLeases()).toEqual([]);
      const recovered = await readVolumeUsage(volume.mountPath);
      expect(recovered.freeBytes).toBeGreaterThan(850 * 1024 * 1024);
      await expect(stat(filler)).rejects.toThrow();

      await manager.cleanup(failed);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(filler, { force: true });
    }
  }, 120_000);
});
