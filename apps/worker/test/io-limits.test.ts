import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runInProcessGroup } from '@intelligenz/agent-runtime';
import {
  createVolumePool,
  discoverVolumes,
  type VolumeLease,
  type VolumeSet,
} from '@intelligenz/workspace-manager';

import {
  applyIoMax,
  createCgroup,
  ioControllerDelegated,
  readIoMax,
  readIoStat,
  removeCgroup,
} from '../src/cgroup';
import { measureDisk, mentionsNoSpace } from '../src/activities/execute-agent';
import { RESOURCE_PROFILES, cpuCeilingFor } from '../src/resource-profiles';
import { classifyTermination, statusForTermination } from '../src/termination';

import { ROOT, TIER, TIER_REASON } from './helpers/cgroup-tier';

/**
 * Gate D — I/O and disk, measured rather than promised.
 *
 * Two claims are tested here:
 *
 * 1. **`io.max` on the volume's backing device is real.** The limit is written, read
 *    back, and then *used*: the same 32 MiB write is timed with and without it, and
 *    `io.stat` is read for the byte counters. A platform that reports an I/O ceiling it
 *    did not measure is worse than one that reports none, so the numbers are printed.
 * 2. **A full disk is a `disk` verdict, not a success.** `measureDisk` reads `statfs`,
 *    the adapter's own `ENOSPC` is recognised when space was freed again, and the
 *    classifier turns that into `failed`.
 *
 * Like the CPU suite, the throughput measurement needs a process placed in an attempt
 * cgroup, which the kernel only permits from inside the delegated subtree. The
 * configuration half (`io.max` write + read-back) needs no placement and runs always.
 */

const MiB = 1024 * 1024;
const IO_LIMIT_BPS = 8 * MiB;
const PROBE_BYTES = 32 * MiB;

const discovery = await discoverVolumes({ enabled: true });
const SET: VolumeSet | null = discovery.mode === 'bounded' ? discovery : null;

if (discovery.mode === 'unavailable') {
  process.stdout.write(
    `\n[io tier] unavailable — ${discovery.code}: ${discovery.reason}\n` +
      'The volume device cannot be named without a mounted volume; I/O tests are skipped.\n',
  );
}

function requireSet(): VolumeSet {
  if (SET === null) throw new Error('workspace volumes are unavailable on this host');

  return SET;
}

function volumeFrom(set: VolumeSet, index: number): NonNullable<VolumeSet['volumes'][number]> {
  const volume = set.volumes.at(index);

  if (volume === undefined) throw new Error(`no volume at index ${String(index)}`);

  return volume;
}

/**
 * The same cross-process lock the workspace-manager volume suite takes.
 *
 * Two suites leasing the same device and writing probe files into it would produce
 * numbers that are hard to attribute. This is test infrastructure only.
 */
const LOCK_PATH = join(tmpdir(), 'intelligenz-volumes-test.lock');
const LOCK_STALE_MS = 180_000;
const LOCK_WAIT_MS = 240_000;

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

let held: { pool: ReturnType<typeof createVolumePool>; lease: VolumeLease } | null = null;

beforeAll(async () => {
  if (SET === null) return;

  await acquireTestLock();
});

afterAll(async () => {
  if (held !== null) {
    await held.pool.release(held.lease).catch(() => undefined);
    held = null;
  }

  if (SET !== null) await rm(LOCK_PATH, { force: true });
});

/** Lease one volume so the probe file cannot be cleared by another suite mid-run. */
async function leaseProbeVolume(set: VolumeSet): Promise<VolumeLease> {
  if (held !== null) return held.lease;

  const volume = volumeFrom(set, set.volumes.length - 2);
  const pool = createVolumePool(
    { mode: 'bounded', root: set.root, registry: set.registry, volumes: [volume] },
    { owner: `io-test:${String(process.pid)}` },
  );
  const claimed = await pool.claim({ workspaceId: 'io-probe' });

  held = { pool, lease: claimed };

  return claimed;
}

const unique = (label: string): string =>
  `${label}-${String(process.pid)}-${String(Date.now() % 100_000)}`;

describe.skipIf(SET === null)('io.max — configuration and read-back', () => {
  it('accepts a bytes-per-second ceiling on the volume device and reports what the kernel kept', async () => {
    const set = requireSet();
    const volume = volumeFrom(set, set.volumes.length - 2);
    const handle = await createCgroup(ROOT, unique('io-max'));

    try {
      // `io` must have reached the children of the delegation root, or `io.max` would not
      // exist in an attempt cgroup at all.
      expect(await ioControllerDelegated(handle)).toBe(true);

      const effective = await applyIoMax(handle, {
        device: volume.device,
        rbps: IO_LIMIT_BPS,
        wbps: IO_LIMIT_BPS,
      });

      process.stdout.write(`[io] io.max read back: ${effective.line}\n`);

      expect(effective.device).toBe(volume.device);
      expect(effective.rbps).toBe(String(IO_LIMIT_BPS));
      expect(effective.wbps).toBe(String(IO_LIMIT_BPS));
      expect(effective.line).toContain(`rbps=${String(IO_LIMIT_BPS)}`);
      expect(effective.line).toContain(`wbps=${String(IO_LIMIT_BPS)}`);

      // The read-back is the authority: `applyIoMax` throws when the device is not
      // tracked, so reaching here means the kernel kept the line.
      const readBack = await readIoMax(handle);
      expect(readBack.find((entry) => entry.device === volume.device)).toEqual(effective);
    } finally {
      await removeCgroup(handle);
    }
  });

  it('refuses a device that is not <major>:<minor> instead of writing a malformed line', async () => {
    const handle = await createCgroup(ROOT, unique('io-bad-device'));

    try {
      await expect(applyIoMax(handle, { device: 'loop6', wbps: MiB })).rejects.toThrow(
        /io\.max needs a <major>:<minor> device/,
      );
      await expect(applyIoMax(handle, { device: '7:6' })).rejects.toThrow(/no limits/);
    } finally {
      await removeCgroup(handle);
    }
  });
});

describe.skipIf(SET === null || TIER !== 'full')('io.max — measured throughput', () => {
  it('holds a 32 MiB write to the configured wbps, with io.stat as the evidence', async () => {
    const set = requireSet();
    const claimed = await leaseProbeVolume(set);
    const baselineProbe = join(claimed.volume.mountPath, 'io-probe-baseline.bin');
    const throttledProbe = join(claimed.volume.mountPath, 'io-probe-throttled.bin');

    const write = (handlePath: string, probe: string): Promise<number> => {
      const startedAt = Date.now();

      return runInProcessGroup({
        file: '/bin/dd',
        // Fixed argv, no shell: the probe path is the only variable and it is ours.
        args: [`if=/dev/zero`, `of=${probe}`, 'bs=1M', `count=${String(PROBE_BYTES / MiB)}`, 'conv=fsync'],
        timeoutMs: 120_000,
        signal: new AbortController().signal,
        killGraceMs: 1_000,
        placement: { cgroupProcsPath: `${handlePath}/cgroup.procs` },
        onStdout: () => undefined,
      }).then((outcome) => {
        expect(outcome.exitCode).toBe(0);

        return Date.now() - startedAt;
      });
    };

    const baselineHandle = await createCgroup(ROOT, unique('io-baseline'));
    const throttledHandle = await createCgroup(ROOT, unique('io-throttled'));

    try {
      // One file per run, created by the run that writes it. Buffered writeback is charged
      // to the cgroup that first dirtied the inode, so a shared file would charge the
      // throttled run to the baseline cgroup — and `io.stat` would be empty here while the
      // bytes were counted there. Measured: that is exactly what happened with one file.
      const baselineMs = await write(baselineHandle.path, baselineProbe);
      const baselineMibps = PROBE_BYTES / MiB / (baselineMs / 1_000);

      const limit = await applyIoMax(throttledHandle, {
        device: claimed.volume.device,
        rbps: IO_LIMIT_BPS,
        wbps: IO_LIMIT_BPS,
      });

      const throttledMs = await write(throttledHandle.path, throttledProbe);
      const throttledMibps = PROBE_BYTES / MiB / (throttledMs / 1_000);
      const ioStat = await readIoStat(throttledHandle);
      const deviceStat = ioStat[claimed.volume.device] ?? {};

      process.stdout.write(
        `[io] device=${claimed.volume.device} limit=${String(IO_LIMIT_BPS)}B/s ` +
          `baseline_ms=${String(baselineMs)} baseline_mibps=${baselineMibps.toFixed(1)} ` +
          `throttled_ms=${String(throttledMs)} throttled_mibps=${throttledMibps.toFixed(2)} ` +
          `io.stat=${JSON.stringify(deviceStat)}\n`,
      );

      // The ceiling is not decorative: an unthrottled write on this host runs at hundreds
      // of MiB/s, so a measured rate near the limit is the limit doing its job.
      expect(baselineMibps).toBeGreaterThan(4 * (IO_LIMIT_BPS / MiB));
      expect(throttledMibps).toBeLessThanOrEqual(1.5 * (IO_LIMIT_BPS / MiB));
      // ...and it did not stall the run to a halt.
      expect(throttledMibps).toBeGreaterThanOrEqual(0.5 * (IO_LIMIT_BPS / MiB));
      expect(throttledMs).toBeGreaterThan(baselineMs * 3);

      // `io.stat` counts the bytes that went through the throttled cgroup on that device.
      expect(deviceStat['wbytes'] ?? 0).toBeGreaterThanOrEqual(PROBE_BYTES);
      expect(ioStat[claimed.volume.device]).toBeDefined();
      expect(limit.device).toBe(claimed.volume.device);

      // Read half. A buffered read is served from the page cache, which is why the ceiling
      // is reported as *configured* unless the read actually reached the device
      // (`rbytes > 0`). `O_DIRECT` is not available on this loop device, measured:
      // `dd iflag=direct` fails with "IO error: Invalid input".
      const readStartedAt = Date.now();
      await runInProcessGroup({
        file: '/bin/dd',
        args: [`if=${throttledProbe}`, 'of=/dev/null', 'bs=1M'],
        timeoutMs: 120_000,
        signal: new AbortController().signal,
        killGraceMs: 1_000,
        placement: { cgroupProcsPath: `${throttledHandle.path}/cgroup.procs` },
        onStdout: () => undefined,
      });
      const readMs = Date.now() - readStartedAt;
      const readStat = (await readIoStat(throttledHandle))[claimed.volume.device] ?? {};
      const readBytes = (readStat['rbytes'] ?? 0) - (deviceStat['rbytes'] ?? 0);

      process.stdout.write(
        `[io] read_ms=${String(readMs)} read_bytes=${String(readBytes)} ` +
          `read_mibps=${(PROBE_BYTES / MiB / (readMs / 1_000)).toFixed(2)}\n`,
      );

      if (readBytes > 0) {
        // The read reached the device: rbps was in force for it.
        expect(PROBE_BYTES / MiB / (readMs / 1_000)).toBeLessThanOrEqual(
          1.5 * (IO_LIMIT_BPS / MiB),
        );
      } else {
        process.stdout.write(
          '[io] read served from page cache (rbytes=0): the rbps ceiling is configured and ' +
            'read back, but a cache-independent read is not measurable without a host-wide ' +
            'cache drop. Reported as UNMEASURED rather than claimed.\n',
        );
      }
    } finally {
      await removeCgroup(baselineHandle);
      await removeCgroup(throttledHandle);
      await rm(baselineProbe, { force: true });
      await rm(throttledProbe, { force: true });
    }
  }, 180_000);
});

describe('disk exhaustion — the attempt verdict', () => {
  it('reads a bounded volume with statfs and reports "no volume" as null, never as plenty of space', async () => {
    // No lease at all: unbounded. That is a different fact from "free space is fine".
    await expect(measureDisk(undefined)).resolves.toBeNull();
    await expect(measureDisk({ handle: {} })).resolves.toBeNull();

    const root = await mkdtemp(join(tmpdir(), 'intelligenz-measure-'));

    try {
      const measured = await measureDisk({
        handle: { volume: { id: 'vol-x', mountPath: root, device: '0:0', totalBytes: 0, warmStart: false } },
      });

      expect(measured).not.toBeNull();
      expect(measured?.freeBytes).toBeGreaterThan(0);
      expect(measured?.exhausted).toBe(false);

      // A mount that vanished is `null` (unknown), not `exhausted: false`.
      await expect(
        measureDisk({
          handle: {
            volume: {
              id: 'vol-gone',
              mountPath: join(root, 'does-not-exist'),
              device: '0:0',
              totalBytes: 0,
              warmStart: false,
            },
          },
        }),
      ).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recognises ENOSPC from the adapter when the space was freed again before statfs', () => {
    expect(mentionsNoSpace({ error: { code: 'ENOSPC', message: 'write failed', retryable: false } })).toBe(true);
    expect(mentionsNoSpace({ error: { code: 'EIO', message: 'No space left on device', retryable: false } })).toBe(
      true,
    );
    expect(mentionsNoSpace({ error: { code: 'EDQUOT', message: 'disk quota exceeded', retryable: false } })).toBe(
      true,
    );
    expect(mentionsNoSpace({ error: { code: 'ENOENT', message: 'no such file', retryable: false } })).toBe(false);
    expect(mentionsNoSpace({})).toBe(false);
  });

  it('ends the attempt failed with reason disk, never succeeded, and not as a crash', () => {
    const verdict = classifyTermination({
      adapter: 'succeeded',
      usage: {
        memoryPeakBytes: 1_048_576,
        pidsPeak: 3,
        cpuTimeMs: 10,
        cpuUsageUs: 10_000,
        oomKills: 0,
        pidsEventsMax: 0,
        nrThrottled: 0,
        throttledUs: 0,
      },
      cpuCeilingUs: cpuCeilingFor(RESOURCE_PROFILES.SMALL),
      placementFailed: false,
      diskExhausted: true,
    });

    // An adapter that "succeeded" after its writes hit the kernel's ceiling did not
    // succeed; the resource fact outranks its own report.
    expect(verdict.reason).toBe('disk');
    expect(verdict.resourceKill).toBe(true);
    expect(verdict.overridesAdapter).toBe(true);
    expect(statusForTermination(verdict)).toBe('failed');
    expect(statusForTermination(verdict)).not.toBe('succeeded');

    // Distinct from a plain crash, which is what an unattributed write failure looks like.
    expect(
      classifyTermination({
        adapter: 'failed',
        usage: null,
        cpuCeilingUs: 0,
        placementFailed: false,
      }).reason,
    ).toBe('crashed');
  });

  it('leaves an ordinary successful run completed', () => {
    const verdict = classifyTermination({
      adapter: 'succeeded',
      usage: null,
      cpuCeilingUs: 0,
      placementFailed: false,
      diskExhausted: false,
    });

    expect(verdict.reason).toBe('completed');
    expect(statusForTermination(verdict)).toBe('succeeded');
  });
});

if (SET === null || TIER !== 'full') {
  process.stdout.write(
    `\n[io] throughput measurement skipped — volumes=${SET === null ? 'unavailable' : 'bounded'}, ` +
      `cgroup tier="${TIER}"\n${TIER_REASON}\n`,
  );
}
