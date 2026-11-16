import { describe, expect, it } from 'vitest';

import { createCgroup, type CgroupHandle } from '../src/cgroup';
import {
  classifyLeaf,
  disposeLeaf,
  isTestOwnedLeafName,
  listStaleTestLeaves,
  makeLeafId,
  readLeafState,
  reconcileTestLeaves,
} from '../src/cgroup-hygiene';
import { ROOT, TIER as tier } from './helpers/cgroup-tier';

/**
 * Leaf hygiene: the naming, the disposal and the reconciliation.
 *
 * The three leaves recorded in `IO-ENFORCEMENT-PROOF.md` §8 existed because cleanup was a
 * boolean nobody read. `removeCgroup` returns `false` on a still-busy leaf, and every
 * `finally` discarded it — so a leaf that kept a busy-loop process alive was indistinguish-
 * able from one that was removed. One of them was still running a shell when this was
 * written, 1 day 12 hours after the test that made it.
 *
 * So the tests here are about what happens when cleanup *cannot* succeed: that it kills
 * before it gives up, that it refuses to `rmdir` a non-empty leaf, and that the reconciler
 * will not delete a name it does not recognise. The seams exist because the failure cases
 * are not reproducible on a host that is behaving.
 */

const fakeLeaf = (path: string): CgroupHandle => ({ path, id: 'leaf', root: '/fake' });

describe('leaf names identify an attempt, not a process', () => {
  it('includes the pid, a timestamp and a sequence so two calls cannot collide', () => {
    const first = makeLeafId('cleanup', 1_700_000_000_000);
    const second = makeLeafId('cleanup', 1_700_000_000_000);

    expect(first).toMatch(/^cleanup-\d+-[0-9a-z]+-\d+$/);
    expect(first).toContain(String(process.pid));
    expect(second).not.toBe(first);
    expect(isTestOwnedLeafName(first)).toBe(true);
    expect(isTestOwnedLeafName(second)).toBe(true);
  });

  it('stays inside the kernel name limit and the cgroup id charset', () => {
    const id = makeLeafId('cpu-desc-parent');

    expect(id.length).toBeLessThanOrEqual(64);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('refuses a label that could escape or confuse the path', () => {
    for (const label of ['../escape', 'Upper', '', 'a b', 'a/b']) {
      expect(() => makeLeafId(label), `${JSON.stringify(label)} must be refused`).toThrow(
        /Refusing leaf label/,
      );
    }
  });
});

describe('the test-owned allowlist', () => {
  it('accepts the names the suites produce, including the ones that leaked', () => {
    expect(isTestOwnedLeafName('oom-684210-31881')).toBe(true);
    expect(isTestOwnedLeafName('cpu-budget-857041-28855')).toBe(true);
    expect(isTestOwnedLeafName(makeLeafId('limits'))).toBe(true);
  });

  it('refuses production names and the ad-hoc leaf that matching nothing created', () => {
    // `worker` belongs to the launcher. Production attempt leaves are execution workspace
    // ids (UUIDs). `oom3-687854` was made by hand — two segments, no code path produces it,
    // and a reconciler that deleted it would be deleting a name it cannot explain.
    expect(isTestOwnedLeafName('worker')).toBe(false);
    expect(isTestOwnedLeafName('3f2a1b4c-5d6e-5f70-8a9b-0c1d2e3f4a5b')).toBe(false);
    expect(isTestOwnedLeafName('oom3-687854')).toBe(false);
    expect(isTestOwnedLeafName('intelligenz')).toBe(false);
  });
});

describe('classification decides what may be deleted', () => {
  it('permits an empty test-owned leaf', () => {
    const leaf = classifyLeaf('oom-1-2', '/root/oom-1-2', [], false);

    expect(leaf.removable).toBe(true);
    expect(leaf.refusal).toBeUndefined();
  });

  it('refuses a leaf that holds a process, and names it', () => {
    const leaf = classifyLeaf('cpu-budget-1-2', '/root/cpu-budget-1-2', [857053], true);

    expect(leaf.removable).toBe(false);
    expect(leaf.refusal).toContain('857053');
  });

  it('refuses when cgroup.events disagrees with an empty cgroup.procs', () => {
    // A fork can land between the two reads; `populated` is the tie-breaker that keeps a
    // just-forked child from being deleted out from under its parent.
    const leaf = classifyLeaf('oom-1-2', '/root/oom-1-2', [], true);

    expect(leaf.removable).toBe(false);
    expect(leaf.refusal).toContain('populated=1');
  });

  it('refuses anything it does not recognise, empty or not', () => {
    expect(classifyLeaf('worker', '/root/worker', [], false).removable).toBe(false);
    expect(classifyLeaf('worker', '/root/worker', [], false).refusal).toContain(
      'not a test-owned leaf name',
    );
  });
});

describe('disposal kills, verifies, then removes', () => {
  it('removes an empty leaf without sending a kill', async () => {
    const killed: string[] = [];
    const removed: string[] = [];

    const result = await disposeLeaf(fakeLeaf('/fake/leaf'), {
      listPids: async () => [],
      kill: async (handle) => {
        killed.push(handle.path);
      },
      remove: async (handle) => {
        removed.push(handle.path);
        return true;
      },
      wait: async () => undefined,
    });

    expect(result.removed).toBe(true);
    expect(killed).toEqual([]);
    expect(removed).toEqual(['/fake/leaf']);
  });

  it('kills a surviving process and removes the leaf once it is empty', async () => {
    // The timeout / forced-termination path: the child outlived the deadline, so `rmdir`
    // would have returned EBUSY and the leaf would have leaked.
    const reads = [[4242], [4242], []];
    let attempt = 0;
    const killed: readonly number[][] = [];

    const result = await disposeLeaf(fakeLeaf('/fake/leaf'), {
      listPids: async () => reads[attempt++] ?? [],
      kill: async () => {
        (killed as number[][]).push([4242]);
      },
      remove: async () => true,
      wait: async () => undefined,
    });

    expect(killed.length).toBeGreaterThan(0);
    expect(result.removed).toBe(true);
    expect(result.killedPids).toContain(4242);
    expect(result.remainingPids).toEqual([]);
  });

  it('refuses to rmdir a leaf whose contents could not be read', async () => {
    // A read error is not an empty leaf. `listProcesses` maps ENOENT to `[]` (the reaper
    // got there first), so an error here is EACCES/EPERM — and deleting on an assumption
    // is how a cgroup with a process inside gets removed.
    let removals = 0;

    const result = await disposeLeaf(fakeLeaf('/fake/leaf'), {
      listPids: async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
      kill: async () => undefined,
      remove: async () => {
        removals += 1;
        return true;
      },
      wait: async () => undefined,
    });

    expect(result.removed).toBe(false);
    expect(result.reason).toContain('could not be read');
    expect(removals).toBe(0);
  });

  it('refuses to rmdir a leaf that is still non-empty, and says what is in it', async () => {
    let removals = 0;

    const result = await disposeLeaf(fakeLeaf('/fake/leaf'), {
      attempts: 3,
      delayMs: 0,
      listPids: async () => [31337],
      kill: async () => undefined,
      remove: async () => {
        removals += 1;
        return true;
      },
      wait: async () => undefined,
    });

    expect(result.removed).toBe(false);
    expect(result.remainingPids).toEqual([31337]);
    expect(result.reason).toContain('refusing to rmdir a non-empty cgroup');
    // The important half: `rmdir` was never attempted, so the leaf is untouched rather
    // than deleted with a process inside it.
    expect(removals).toBe(0);
  });
});

describe.skipIf(tier === 'unavailable')('against a real leaf', () => {
  it('creates, disposes and tolerates a second disposal', async () => {
    const handle = await createCgroup(ROOT, makeLeafId('cleanup'));

    expect((await readLeafState(handle.path)).exists).toBe(true);

    const first = await disposeLeaf(handle);

    expect(first.removed).toBe(true);
    expect((await readLeafState(handle.path)).exists).toBe(false);

    // Disposing twice is what a `finally` after a reaper already cleaned up looks like.
    const second = await disposeLeaf(handle);

    expect(second.removed).toBe(true);
  }, 20_000);

  it('classifies the real root without touching the launcher leaf', async () => {
    const leaves = await listStaleTestLeaves(ROOT);
    const worker = leaves.find((leaf) => leaf.name === 'worker');

    // The launcher's leaf exists on a correctly configured host and must never be
    // removable, whatever it holds.
    if (worker !== undefined) {
      expect(worker.removable).toBe(false);
      expect(worker.refusal).toContain('not a test-owned leaf name');
    }

    // Nothing in this classification is removable unless it is genuinely empty; a dry run
    // must not change the directory.
    const report = await reconcileTestLeaves({ root: ROOT });

    expect(report.applied).toBe(false);
    expect(report.removed).toEqual([]);
  }, 20_000);

  it('removes a leaf the tests created and nothing else', async () => {
    const handle = await createCgroup(ROOT, makeLeafId('cleanup'));

    try {
      const listed = await listStaleTestLeaves(ROOT);
      const mine = listed.find((leaf) => leaf.name === handle.id);

      expect(mine?.removable).toBe(true);
    } finally {
      await disposeLeaf(handle);
    }
  }, 20_000);
});
