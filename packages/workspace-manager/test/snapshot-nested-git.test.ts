import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildChangeManifest, takeWorkspaceSnapshot } from '../src';
import { initRepo } from './helpers/git';

/**
 * F-G11 — a nested `.git` is content, so it cannot be a silent write area.
 *
 * The walk skipped `.git` at **any depth** while `readGitMetadata` only described the
 * root's. A pre-existing `sub/.git` — the shape a nested clone or a submodule has, and
 * one an agent can create with one `mkdir` — was therefore described nowhere: not in
 * `entries`, not in `git`, not in the manifest. Measured before the fix: writing
 * `sub/.git/payload.bin` produced `changeCount: 0`, `complete: true`, an authoritative
 * manifest, and a final digest **identical to the baseline**.
 *
 * The fix is to skip `.git` only at the workspace root. A nested `.git` is not the root
 * repository's metadata; it is a directory the agent can write, so it is walked as
 * content and bounded by `maxEntries`/`maxTotalBytes` like every other directory. That
 * choice is the one that cannot be invisible: there is no second exclusion list whose
 * omission would need to be noticed.
 */

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'intelligenz-nested-git-'));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

let counter = 0;

async function tree(label: string): Promise<string> {
  counter += 1;
  const root = join(scratch, `${label}-${String(counter)}`);
  await mkdir(root, { recursive: true });

  return root;
}

describe('F-G11 — a nested `.git` is described as content', () => {
  it('reports a write into a pre-existing `sub/.git` as a change, not as nothing', async () => {
    const root = await tree('nested-write');
    await mkdir(join(root, 'sub', '.git'), { recursive: true });
    await writeFile(join(root, 'sub', '.git', 'seed.txt'), 'pre-existing nested metadata\n');

    const baseline = await takeWorkspaceSnapshot(root);

    // The baseline describes the nested directory. It is content: the root `.git` is the
    // only `.git` this module treats as repository metadata.
    expect(baseline.entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(['sub', 'sub/.git']),
    );

    // F-G14: the fact that a nested repository exists is on the anomaly list, so the worker
    // can write a durable record for it. Without this, `changeCount: 0, authoritative: true`
    // is all a reviewer sees of a workspace that contains a second repository.
    expect(baseline.git.anomalies).toContain('nested-git:sub/.git');

    // The agent's write, inside the directory the old walk skipped at every depth.
    await writeFile(join(root, 'sub', '.git', 'payload.bin'), Buffer.alloc(64, 0x42));

    const final = await takeWorkspaceSnapshot(root);
    const manifest = buildChangeManifest({ initial: baseline, final });

    expect(final.digest).not.toBe(baseline.digest);
    expect(final.complete).toBe(true);
    expect(manifest.complete).toBe(true);
    expect(manifest.changeCount).toBeGreaterThan(0);
    expect(manifest.changes).toContainEqual(
      expect.objectContaining({ path: 'sub/.git/payload.bin', status: 'added' }),
    );
  });

  it('hashes a nested `.git` *file* (a submodule gitfile) as content too', async () => {
    const root = await tree('nested-gitfile');
    await mkdir(join(root, 'sub'), { recursive: true });
    const gitfile = join(root, 'sub', '.git');
    await writeFile(gitfile, 'gitdir: ../.git/modules/sub\n');

    const baseline = await takeWorkspaceSnapshot(root);
    await writeFile(gitfile, 'gitdir: /somewhere/else\n');
    const final = await takeWorkspaceSnapshot(root);

    expect(baseline.entries).toContainEqual(
      expect.objectContaining({ path: 'sub/.git', kind: 'file' }),
    );
    expect(final.digest).not.toBe(baseline.digest);
    expect(buildChangeManifest({ initial: baseline, final }).changes).toContainEqual(
      expect.objectContaining({ path: 'sub/.git', status: 'modified' }),
    );
  });

  it('control: the root `.git` is still excluded from content and still described as metadata', async () => {
    const root = await tree('root-git');
    await initRepo(root, { 'a.txt': 'a\n' });

    const snapshot = await takeWorkspaceSnapshot(root);

    // The exclusion that is *earned*: the root's own metadata, captured structurally.
    expect(snapshot.entries.some((entry) => entry.path.startsWith('.git'))).toBe(false);
    expect(snapshot.git).toMatchObject({ present: true, kind: 'directory' });
    expect(snapshot.git.configSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.git.head).not.toBeNull();
    expect(snapshot.complete).toBe(true);
    // The negative control for F-G14: an ordinary checkout has no anomaly, so the durable
    // record the worker writes for one cannot fire on every normal repository.
    expect(snapshot.git.anomalies).toEqual([]);
  });

  it('control: a nested `.git` is bounded by `maxEntries`, so it cannot explode the walk', async () => {
    const root = await tree('nested-bounded');
    const nested = join(root, 'sub', '.git');

    await mkdir(nested, { recursive: true });
    for (let index = 0; index < 40; index += 1) {
      await writeFile(join(nested, `object-${String(index).padStart(2, '0')}`), 'x\n');
    }

    const snapshot = await takeWorkspaceSnapshot(root, { maxEntries: 8 });

    expect(snapshot.entryCount).toBe(8);
    expect(snapshot.entries).toHaveLength(8);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.stopReason).toBe('max-entries');
  });
});
