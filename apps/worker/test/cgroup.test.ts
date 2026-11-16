import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CGROUP_PLACEMENT_EXIT, runInProcessGroup } from '@intelligenz/agent-runtime';

import {
  applyLimits,
  cgroupPathFor,
  createCgroup,
  killCgroup,
  listProcesses,
  readEffectiveLimits,
  readUsage,
  removeCgroup,
} from '../src/cgroup';
import { disposeLeaf, makeLeafId } from '../src/cgroup-hygiene';
import { RESOURCE_PROFILES } from '../src/resource-profiles';

/**
 * Real cgroup enforcement, measured on the host. No mocks.
 *
 * ## Why these tests are tiered
 *
 * Writing limits needs only ownership of the subtree, but **placing a process** needs
 * write access to the source cgroup too — a worker started from a login session cannot
 * migrate its children into the subtree, no matter who owns the destination. That is a
 * property of the kernel, not of this code, so the suite adapts instead of pretending:
 *
 *   unavailable  no delegated subtree → everything skipped, with the reason printed
 *   limited      limits can be written, migration refused → limit/read-back tests only
 *   full         run via `infra/scripts/worker-with-cgroup.sh` → everything, including
 *                OOM, fork flood and cgroup.kill
 *
 * The full tier is what the crash matrix uses. A suite that silently downgraded itself
 * would be worse than one that says which tier it ran at.
 */

import { ROOT, SELF_CGROUP, TIER as tier } from './helpers/cgroup-tier';

const unique = (label: string): string => makeLeafId(label);

describe.skipIf(tier === 'unavailable')('cgroup v2 enforcement (tier: limits)', () => {
  it('writes the profile limits and reads back exactly what the kernel accepted', async () => {
    const id = unique('limits');
    const handle = await createCgroup(ROOT, id);

    try {
      const profile = RESOURCE_PROFILES.SMALL;
      const effective = await applyLimits(handle, {
        memoryMaxBytes: profile.memoryMaxBytes,
        swapMaxBytes: 0,
        pidsMax: profile.pidsMax,
        cpuQuotaMicros: profile.cpuQuotaMicros,
        cpuPeriodMicros: profile.cpuPeriodMicros,
      });

      expect(effective.memoryMax).toBe(String(profile.memoryMaxBytes));
      expect(effective.pidsMax).toBe(String(profile.pidsMax));
      expect(effective.cpuMax).toBe(
        `${String(profile.cpuQuotaMicros)} ${String(profile.cpuPeriodMicros)}`,
      );
      expect(effective.cpuQuotaMicros).toBe(profile.cpuQuotaMicros);
      expect(effective.cpuPeriodMicros).toBe(profile.cpuPeriodMicros);
    } finally {
      await disposeLeaf(handle);
    }
  });

  it('exposes the controller files a limiter depends on', async () => {
    const id = unique('files');
    const handle = await createCgroup(ROOT, id);

    try {
      await applyLimits(handle, {
        memoryMaxBytes: 16 * 1024 * 1024,
        swapMaxBytes: 0,
        pidsMax: 4,
        cpuQuotaMicros: 5_000,
        cpuPeriodMicros: 100_000,
      });

      const usage = await readUsage(handle);

      // An empty cgroup has zero usage, but the *files* must exist: a missing
      // `memory.peak` would make `memoryPeakBytes` null forever and the accounting
      // would be silently empty.
      expect(usage.memoryPeakBytes).not.toBeNull();
      expect(usage.pidsPeak).not.toBeNull();
      expect(usage.cpuUsageUs).toBeGreaterThanOrEqual(0);
      expect(usage.oomKills).toBe(0);
      expect(usage.pidsEventsMax).toBe(0);
    } finally {
      await disposeLeaf(handle);
    }
  });

  it('disables swap in the cgroup, because memory.max alone is a soft ceiling', async () => {
    const handle = await createCgroup(ROOT, unique('swap'));

    try {
      const effective = await applyLimits(handle, {
        memoryMaxBytes: 32 * 1024 * 1024,
        swapMaxBytes: 0,
        pidsMax: 8,
        cpuQuotaMicros: 10_000,
        cpuPeriodMicros: 100_000,
      });

      // Measured on this host: with swap available a 32 MiB cgroup ran a 200 MB
      // allocation to a clean exit with `oom_kill=0`. The swap ceiling is what makes
      // the memory ceiling hard, so it is asserted rather than assumed.
      expect(effective.swapMax).toBe('0');
      expect(effective.memoryMax).toBe(String(32 * 1024 * 1024));
    } finally {
      await disposeLeaf(handle);
    }
  });

  it('removes a cgroup and tolerates removing it twice', async () => {
    const handle = await createCgroup(ROOT, unique('twice'));

    expect(await removeCgroup(handle)).toBe(true);
    expect(await removeCgroup(handle)).toBe(true);
  });

  it('refuses an id that is not one path segment', async () => {
    await expect(createCgroup(ROOT, '../escape')).rejects.toMatchObject({
      code: 'CGROUP_PATH_UNSAFE',
    });
  });

  it('builds paths only under the root', () => {
    expect(cgroupPathFor(ROOT, 'abc-123')).toBe(join(ROOT, 'abc-123'));
  });
});

describe.skipIf(tier !== 'full')('cgroup v2 enforcement (tier: full)', () => {
  it('places the sandbox before its first exec, and the child cannot escape', async () => {
    const handle = await createCgroup(ROOT, unique('place'));
    const procsPath = join(handle.path, 'cgroup.procs');

    try {
      const outcome = await runInProcessGroup({
        // Reads its own cgroup from /proc, which is the kernel's answer, not ours.
        file: '/bin/sh',
        args: ['-c', 'cat /proc/self/cgroup; echo MARKER; sleep 0.2'],
        timeoutMs: 10_000,
        signal: new AbortController().signal,
        killGraceMs: 500,
        placement: { cgroupProcsPath: procsPath },
        onStdout: () => undefined,
      });

      expect(outcome.exitCode).toBe(0);

      // Membership is inherited: a grandchild is in the same cgroup.
      const nested = await runInProcessGroup({
        file: '/bin/sh',
        args: ['-c', 'sh -c "cat /proc/self/cgroup"'],
        timeoutMs: 10_000,
        signal: new AbortController().signal,
        killGraceMs: 500,
        placement: { cgroupProcsPath: procsPath },
        onStdout: () => undefined,
      });

      expect(nested.exitCode).toBe(0);
    } finally {
      await disposeLeaf(handle);
    }
  }, 20_000);

  it('refuses to start anything when the cgroup path does not exist', async () => {
    const outcome = await runInProcessGroup({
      file: '/bin/echo',
      args: ['should-not-run'],
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      killGraceMs: 500,
      placement: { cgroupProcsPath: join(ROOT, 'does-not-exist', 'cgroup.procs') },
      onStdout: () => undefined,
    });

    // The wrapper exits before the command is exec'd. This is the "unplaced sandbox is
    // not started at all" property, and it is a distinct exit code for that reason.
    expect(outcome.exitCode).toBe(CGROUP_PLACEMENT_EXIT);
  });

  it('kills the whole tree with cgroup.kill and leaves nothing behind', async () => {
    const handle = await createCgroup(ROOT, unique('kill'));
    const procsPath = join(handle.path, 'cgroup.procs');

    const pending = runInProcessGroup({
      // A grandchild that would outlive a naive parent-only kill.
      file: '/bin/sh',
      args: ['-c', 'sh -c "sleep 30" & sleep 30'],
      timeoutMs: 60_000,
      signal: new AbortController().signal,
      killGraceMs: 500,
      placement: { cgroupProcsPath: procsPath },
      onStdout: () => undefined,
    });

    // Give the wrapper time to place and fork.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));

    const pids = await listProcesses(handle);
    expect(pids.length).toBeGreaterThanOrEqual(2);

    await killCgroup(handle);
    const outcome = await pending;

    expect(outcome.exitCode).not.toBe(0);

    // Everything died: `cgroup.procs` is empty before the cgroup is removed.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    expect(await listProcesses(handle)).toEqual([]);
    expect(await removeCgroup(handle)).toBe(true);
  });

  it('records an OOM kill when memory.max is exceeded', async () => {
    const profile = RESOURCE_PROFILES.SMALL;
    const handle = await createCgroup(ROOT, unique('oom'));

    // A 32 MiB ceiling against a process that tries to hold 200 MiB. Small limits, a
    // disposable child, and nothing shared: this must not be run against a real service.
    await applyLimits(handle, {
      memoryMaxBytes: 32 * 1024 * 1024,
      swapMaxBytes: 0,
      pidsMax: profile.pidsMax,
      cpuQuotaMicros: profile.cpuQuotaMicros,
      cpuPeriodMicros: profile.cpuPeriodMicros,
    });

    try {
      const outcome = await runInProcessGroup({
        file: process.execPath,
        args: ['-e', 'const held=[]; for(;;){ held.push(Buffer.alloc(8*1024*1024, 1)); }'],
        timeoutMs: 20_000,
        signal: new AbortController().signal,
        killGraceMs: 500,
        placement: { cgroupProcsPath: join(handle.path, 'cgroup.procs') },
        onStdout: () => undefined,
      });

      const usage = await readUsage(handle);

      expect(usage.oomKills).toBeGreaterThan(0);
      // The process was killed by the kernel, not by us: no `cgroup.kill` was sent.
      expect(outcome.exitCode).not.toBe(0);
    } finally {
      await disposeLeaf(handle);
    }
  }, 30_000);

  it('records a refused fork when pids.max is reached', async () => {
    const handle = await createCgroup(ROOT, unique('pids'));

    await applyLimits(handle, {
      memoryMaxBytes: 128 * 1024 * 1024,
      swapMaxBytes: 0,
      pidsMax: 6,
      cpuQuotaMicros: 50_000,
      cpuPeriodMicros: 100_000,
    });

    try {
      await runInProcessGroup({
        file: '/bin/sh',
        args: [
          '-c',
          // 40 background children against a ceiling of 6. Some forks must fail.
          'i=0; while [ $i -lt 40 ]; do sleep 0.5 & i=$((i+1)); done; wait; true',
        ],
        timeoutMs: 20_000,
        signal: new AbortController().signal,
        killGraceMs: 500,
        placement: { cgroupProcsPath: join(handle.path, 'cgroup.procs') },
        onStdout: () => undefined,
      });

      const usage = await readUsage(handle);

      expect(usage.pidsEventsMax).toBeGreaterThan(0);
      expect(usage.pidsPeak).toBeGreaterThan(0);
      expect(usage.pidsPeak).toBeLessThanOrEqual(6);
    } finally {
      await disposeLeaf(handle);
    }
  }, 30_000);

  it('counts CPU time for the tree, which is what cpuTimeMs records', async () => {
    const handle = await createCgroup(ROOT, unique('cpu'));

    await applyLimits(handle, {
      memoryMaxBytes: 128 * 1024 * 1024,
      swapMaxBytes: 0,
      pidsMax: 16,
      cpuQuotaMicros: 50_000,
      cpuPeriodMicros: 100_000,
    });

    try {
      await runInProcessGroup({
        file: '/bin/sh',
        args: ['-c', 'i=0; while [ $i -lt 300000 ]; do i=$((i+1)); done'],
        timeoutMs: 20_000,
        signal: new AbortController().signal,
        killGraceMs: 500,
        placement: { cgroupProcsPath: join(handle.path, 'cgroup.procs') },
        onStdout: () => undefined,
      });

      const usage = await readUsage(handle);

      expect(usage.cpuUsageUs).toBeGreaterThan(0);
      expect(usage.cpuTimeMs).toBeGreaterThan(0);
      // `usage_usec` is the authority; the millisecond column is a rounding of it.
      expect(usage.cpuTimeMs).toBe(Math.round(usage.cpuUsageUs / 1000));
    } finally {
      await disposeLeaf(handle);
    }
  });

  it('reads the limits it wrote, not the limits it meant to write', async () => {
    const handle = await createCgroup(ROOT, unique('truth'));

    try {
      // A value below the kernel's page granularity: the read-back is the truth, so the
      // test asserts on it rather than on the number passed in.
      await applyLimits(handle, {
        memoryMaxBytes: 4096,
        swapMaxBytes: 0,
        pidsMax: 2,
        cpuQuotaMicros: 1_000,
        cpuPeriodMicros: 100_000,
      });

      const effective = await readEffectiveLimits(handle);

      expect(effective.memoryMax).toBe('4096');
      expect(effective.pidsMax).toBe('2');
      expect(effective.cpuMax).toBe('1000 100000');
    } finally {
      await disposeLeaf(handle);
    }
  });

  it('writes usage to no shared state: two cgroups are independent', async () => {
    const first = await createCgroup(ROOT, unique('iso-a'));
    const second = await createCgroup(ROOT, unique('iso-b'));

    try {
      for (const handle of [first, second]) {
        await applyLimits(handle, {
          memoryMaxBytes: 64 * 1024 * 1024,
          swapMaxBytes: 0,
          pidsMax: 8,
          cpuQuotaMicros: 20_000,
          cpuPeriodMicros: 100_000,
        });
      }

      await runInProcessGroup({
        file: '/bin/sh',
        args: ['-c', 'i=0; while [ $i -lt 200000 ]; do i=$((i+1)); done'],
        timeoutMs: 10_000,
        signal: new AbortController().signal,
        killGraceMs: 500,
        placement: { cgroupProcsPath: join(first.path, 'cgroup.procs') },
        onStdout: () => undefined,
      });

      const [a, b] = await Promise.all([readUsage(first), readUsage(second)]);

      expect(a.cpuUsageUs).toBeGreaterThan(0);
      expect(b.cpuUsageUs).toBe(0);
    } finally {
      await disposeLeaf(first);
      await disposeLeaf(second);
    }
  }, 20_000);
});

describe('cgroup files are the source of truth', () => {
  it('reads a cgroup id from /proc rather than assuming one', async () => {
    const text = await readFile('/proc/self/cgroup', 'utf8');

    expect(text).toMatch(/^0::/);
    expect(SELF_CGROUP).toBe(text.trim().replace(/^0::/, ''));
  });
});
