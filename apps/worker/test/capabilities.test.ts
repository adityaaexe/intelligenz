import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  describeCgroupCapability,
  detectCgroupCapability,
  isEnforced,
  selfCgroupPath,
} from '../src/capabilities';
import { ROOT, TIER, TIER_REASON } from './helpers/cgroup-tier';

/**
 * Capability detection, including the paths where it must say **no**.
 *
 * The expensive mistake this file guards against is a platform that reports cgroup
 * isolation because a directory existed. `detectCgroupCapability` requires a real child
 * to be migrated into a real cgroup, so each refusal below is a real filesystem
 * condition, not a mock.
 */

const temporaryRoots: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('capability probe', () => {
  it('reports ENFORCED on this host only after migrating a real process', async () => {
    const capability = await detectCgroupCapability({ root: ROOT });

    if (TIER === 'full') {
      expect(capability.mode).toBe('enforced');
      if (!isEnforced(capability)) return;

      // The evidence is a measured read-back, not a config value.
      expect(capability.evidence.memoryMax).toBe(String(64 * 1024 * 1024));
      expect(capability.evidence.pidsMax).toBe('16');
      expect(capability.evidence.cpuMax).toBe('10000 100000');
      expect(capability.evidence.selfCgroup.startsWith('/intelligenz')).toBe(true);
      expect(describeCgroupCapability(capability)).toContain('ENFORCED');
    } else {
      // Outside the delegated subtree the kernel refuses the migration, and the probe
      // must report that rather than the writability of a directory.
      expect(capability.mode).toBe('unavailable');
      if (isEnforced(capability)) return;

      expect(['CGROUP_MIGRATION_DENIED', 'CGROUP_ROOT_NOT_WRITABLE']).toContain(capability.code);
      expect(capability.reason.length).toBeGreaterThan(20);
      expect(describeCgroupCapability(capability)).toContain('UNAVAILABLE');
      expect(describeCgroupCapability(capability)).toContain('setup-cgroups.sh');
    }
  }, 30_000);

  it('reports CGROUP_ROOT_MISSING when the delegation root does not exist', async () => {
    const root = join(tmpdir(), `iz-missing-${String(Date.now())}`, 'intelligenz');
    const capability = await detectCgroupCapability({ root });

    expect(capability.mode).toBe('unavailable');
    if (isEnforced(capability)) return;

    expect(capability.code).toBe('CGROUP_ROOT_MISSING');
    expect(capability.remediation).toContain('setup-cgroups.sh');
  });

  it('reports CGROUP_ROOT_NOT_WRITABLE for a root this user does not own', async () => {
    // `/sys/fs/cgroup` itself: a real cgroup2 mount, owned by root, mode 0555. This is
    // the "setup script was not run" state, and it must not be mistaken for enforcement.
    const capability = await detectCgroupCapability({ root: '/sys/fs/cgroup' });

    expect(capability.mode).toBe('unavailable');
    if (isEnforced(capability)) return;

    expect(capability.code).toBe('CGROUP_ROOT_NOT_WRITABLE');
    expect(capability.reason).toContain('EACCES');
  });

  it('refuses a plain directory: a writable path is not a cgroup', async () => {
    // A plain directory: `mkdir` succeeds, writing `memory.max` succeeds (it creates a
    // regular file), writing `cgroup.procs` succeeds, and every read-back agrees — so a
    // probe built on writes alone reports ENFORCED for /tmp. This is the false positive
    // the statfs check exists to stop, and it previously shipped.
    const base = await mkdtemp(join(tmpdir(), 'iz-fake-cgroup-'));
    temporaryRoots.push(base);
    const root = join(base, 'intelligenz');
    await mkdir(root);

    const capability = await detectCgroupCapability({ root });

    expect(capability.mode).toBe('unavailable');
    if (isEnforced(capability)) return;

    expect(capability.code).toBe('CGROUP_NOT_CGROUP2');
    expect(capability.reason).toContain('0x63677270');
    expect(capability.reason).toContain(root);
    // Nothing was created: the probe stops before it writes into a non-cgroup path.
    expect(await readdir(root)).toEqual([]);
  }, 30_000);

  it('refuses a cgroup2 filesystem that does not delegate the controllers', async () => {
    // The root itself is a real cgroup2 mount, so statfs passes; what is missing is the
    // delegation to *children*. `/sys/fs/cgroup` is root-owned (mkdir → EACCES), which is
    // the "setup script was not run" state. The point of the assertion is that a genuine
    // cgroup2 path is not, by itself, enforcement.
    const capability = await detectCgroupCapability({ root: '/sys/fs/cgroup' });

    expect(capability.mode).toBe('unavailable');
    if (isEnforced(capability)) return;

    expect(['CGROUP_ROOT_NOT_WRITABLE', 'CGROUP_LIMIT_NOT_APPLIED']).toContain(capability.code);
  }, 30_000);

  it('reads its own cgroup from /proc rather than guessing', async () => {
    expect(await selfCgroupPath()).toMatch(/^\/|unknown$/);
  });
});

describe('tier', () => {
  it('states which tier this suite ran at', () => {
    expect(['unavailable', 'limited', 'full']).toContain(TIER);
    if (TIER !== 'full') expect(TIER_REASON.length).toBeGreaterThan(10);
  });
});
