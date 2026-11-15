import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildChangeManifest,
  manifestCounts,
  serialiseManifest,
  takeWorkspaceSnapshot,
} from '../src';
import { addAll, commit, git, initRepo } from './helpers/git';

/**
 * The change manifest, measured against the three attacks it replaces.
 *
 * Each test does the same two things in the same order, and the order is the point:
 *
 *   1. **perform the attack against git** and assert git's answer really is empty — if the
 *      attack does not work against git, the test proves nothing about the manifest;
 *   2. **build the manifest** and assert it reports the change that git denied.
 *
 * The third attack is the one that matters most. A staged file or a filtered file leaves a
 * status line behind; a commit leaves *nothing at all*. `git status` and `git diff` both
 * return empty for a completely rewritten tree, so an approver reading that patch is told
 * "nothing changed" with no signal that anything is missing. No manifest can be talked into
 * that answer, because it never asks the repository.
 */

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

let scratch: string;
let markers: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'intelligenz-manifest-'));
  // Outside every repository: a marker written inside the tree would appear in the very
  // snapshot it is supposed to be evidence about.
  markers = await mkdtemp(join(tmpdir(), 'intelligenz-manifest-markers-'));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
  await rm(markers, { recursive: true, force: true });
});

async function repo(name: string, files: Readonly<Record<string, string>>): Promise<string> {
  const root = join(scratch, name);
  await initRepo(root, files);
  return root;
}

describe('attack 1 — a staged change: `git diff` is empty, the tree is not', () => {
  it('reports the modification that staging hid from `git diff`', async () => {
    const root = await repo('staged', { 'answer.txt': 'original\n' });

    const initial = await takeWorkspaceSnapshot(root);

    await writeFile(join(root, 'answer.txt'), 'COMPROMISED\n');
    await addAll(root);

    // ── (1) the attack, proven against git ──────────────────────────────────
    const status = await git(root, ['status', '--porcelain']);
    const diff = await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color']);

    // A single status line and an empty patch: `git diff` compares the index against the
    // worktree, so staging empties it by definition.
    expect(status.trim()).toBe('M  answer.txt');
    expect(diff.trim()).toBe('');

    // ── (2) the manifest, which never asks git ──────────────────────────────
    const final = await takeWorkspaceSnapshot(root);
    const manifest = buildChangeManifest({ initial, final });

    expect(manifest.complete).toBe(true);
    expect(manifest.changes).toEqual([
      {
        path: 'answer.txt',
        status: 'modified',
        before: {
          kind: 'file',
          mode: expect.any(Number) as number,
          sizeBytes: 9,
          sha256: sha256('original\n'),
          symlinkTarget: null,
        },
        after: {
          kind: 'file',
          mode: expect.any(Number) as number,
          sizeBytes: 12,
          sha256: sha256('COMPROMISED\n'),
          symlinkTarget: null,
        },
      },
    ]);
    expect(manifest.changeCount).toBe(1);
    expect(manifest.initial.digest).toBe(initial.digest);
    expect(manifest.final.digest).toBe(final.digest);
  });
});

describe('attack 2 — a clean filter: git sees the index, the disk holds something else', () => {
  it('reports the bytes on disk, not the bytes the filter told git to see', async () => {
    const root = await repo('filtered', { 'secret.txt': 'SECRET=original\n' });

    // A `clean` filter rewrites what git indexes. `--no-textconv` does not disable it:
    // textconv and clean/smudge are different mechanisms, and this is the pair the old
    // evidence path left open.
    const cleanScript = join(markers, 'clean.sh');
    await writeFile(
      cleanScript,
      `#!/bin/sh\nprintf 'ran\\n' >> ${JSON.stringify(join(markers, 'clean-ran'))}\nexec sed s/COMPROMISED/original/\n`,
      { mode: 0o755 },
    );

    await writeFile(join(root, '.gitattributes'), 'secret.txt filter=hide\n');
    const existingConfig = await readFile(join(root, '.git', 'config'), 'utf8');
    await writeFile(
      join(root, '.git', 'config'),
      `${existingConfig}[filter "hide"]\n\tclean = ${cleanScript}\n\tsmudge = cat\n`,
    );

    const initial = await takeWorkspaceSnapshot(root);

    await writeFile(join(root, 'secret.txt'), 'SECRET=COMPROMISED\n');

    // ── (1) the attack, proven against git ──────────────────────────────────
    const diff = await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color']);

    expect(diff.trim()).toBe('');
    // The filter ran — otherwise "empty diff" would be a coincidence rather than the
    // mechanism this test is about.
    expect(await readFile(join(markers, 'clean-ran'), 'utf8')).toContain('ran');

    // ── (2) the manifest, which hashes what is on disk ──────────────────────
    const final = await takeWorkspaceSnapshot(root);
    const manifest = buildChangeManifest({ initial, final });

    const secret = manifest.changes.find((change) => change.path === 'secret.txt');

    expect(secret?.status).toBe('modified');
    expect(secret?.before?.sha256).toBe(sha256('SECRET=original\n'));
    // The bytes an operator would `cat`. Not the filter's opinion of them.
    expect(secret?.after?.sha256).toBe(sha256('SECRET=COMPROMISED\n'));
    expect(secret?.after?.sizeBytes).toBe('SECRET=COMPROMISED\n'.length);

    // `.gitattributes` and `.git/config` were hostile *before* the baseline, which is the
    // realistic shape: they arrive with a clone or an earlier attempt. They are not
    // changes, and the point is that they do not need to be — the manifest's answer is
    // identical whether the filter is fresh or pre-existing, because the filter is never
    // consulted.
    expect(manifest.changes.map((change) => change.path)).toEqual(['secret.txt']);
    expect(final.git.configSha256).toBe(initial.git.configSha256);
  });
});

describe('attack 3 — a committed change: the tree is clean and entirely different', () => {
  it('reports a non-empty manifest while `git status` and `git diff` both say nothing', async () => {
    const root = await repo('committed', { 'answer.txt': 'original\n', 'other.txt': 'keep\n' });

    const initial = await takeWorkspaceSnapshot(root);

    await writeFile(join(root, 'answer.txt'), 'COMPROMISED\n');
    await addAll(root);
    await commit(root, 'rewrite');

    // ── (1) the attack, proven against git ──────────────────────────────────
    const status = await git(root, ['status', '--porcelain', '--untracked-files=normal']);
    const diff = await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color']);

    // Both empty. This is the shape that matters: not a tampering signal, a confident
    // negative — the patch asserts "nothing changed" while nothing is the same.
    expect(status.trim()).toBe('');
    expect(diff.trim()).toBe('');

    // ── (2) the manifest ────────────────────────────────────────────────────
    const final = await takeWorkspaceSnapshot(root);
    const manifest = buildChangeManifest({ initial, final });

    expect(manifest.complete).toBe(true);
    expect(manifest.changes).toHaveLength(1);
    expect(manifest.changes[0]?.path).toBe('answer.txt');
    expect(manifest.changes[0]?.status).toBe('modified');
    expect(manifest.changes[0]?.after?.sha256).toBe(sha256('COMPROMISED\n'));

    // The index moved too, which is the fact `git status` was reporting as "clean".
    expect(final.git.indexSha256).not.toBe(initial.git.indexSha256);
  });
});

describe('buildChangeManifest — one row per path, with the status that matters', () => {
  it('reports nothing for an unchanged tree', async () => {
    const root = await repo('unchanged', { 'a.txt': 'same\n' });

    const initial = await takeWorkspaceSnapshot(root);
    const final = await takeWorkspaceSnapshot(root);
    const manifest = buildChangeManifest({ initial, final });

    expect(manifest.changes).toEqual([]);
    expect(manifest.changeCount).toBe(0);
    expect(manifest.complete).toBe(true);
    expect(manifestCounts(manifest)).toEqual({
      added: 0,
      modified: 0,
      deleted: 0,
      mode_changed: 0,
      symlink_retargeted: 0,
    });
  });

  it('covers every status the contract names', async () => {
    const root = join(scratch, 'statuses');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'modified.txt'), 'one\n');
    await writeFile(join(root, 'deleted.txt'), 'gone\n');
    await writeFile(join(root, 'chmodded.txt'), 'same\n');
    await writeFile(join(root, 'link'), '');
    await unlink(join(root, 'link'));
    await symlink('first-target', join(root, 'link'));

    const initial = await takeWorkspaceSnapshot(root);

    await writeFile(join(root, 'modified.txt'), 'two\n');
    await unlink(join(root, 'deleted.txt'));
    await chmod(join(root, 'chmodded.txt'), 0o600);
    await unlink(join(root, 'link'));
    await symlink('/etc/passwd', join(root, 'link'));
    await writeFile(join(root, 'added.txt'), 'new\n');

    const final = await takeWorkspaceSnapshot(root);
    const manifest = buildChangeManifest({ initial, final });

    const byPath = new Map(manifest.changes.map((change) => [change.path, change.status]));

    expect(byPath.get('modified.txt')).toBe('modified');
    expect(byPath.get('deleted.txt')).toBe('deleted');
    expect(byPath.get('chmodded.txt')).toBe('mode_changed');
    expect(byPath.get('link')).toBe('symlink_retargeted');
    expect(byPath.get('added.txt')).toBe('added');
    expect(manifest.changeCount).toBe(5);

    // The retarget is recorded as a target string, never resolved. `/etc/passwd` is a
    // fact about the link; it is not a file this manifest read.
    expect(manifest.changes.find((change) => change.path === 'link')?.after?.symlinkTarget).toBe(
      '/etc/passwd',
    );
    expect(manifest.changes.find((change) => change.path === 'link')?.after?.sha256).toBeNull();
  });

  it('prefers `modified` over `mode_changed` for one path, and keeps the mode in both halves', async () => {
    const root = join(scratch, 'precedence');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'both.txt'), 'one\n');

    const initial = await takeWorkspaceSnapshot(root);
    await writeFile(join(root, 'both.txt'), 'two\n');
    await chmod(join(root, 'both.txt'), 0o600);
    const final = await takeWorkspaceSnapshot(root);

    const manifest = buildChangeManifest({ initial, final });

    // One row: "how many files changed" must not depend on how many properties changed.
    expect(manifest.changes).toHaveLength(1);
    expect(manifest.changes[0]?.status).toBe('modified');
    expect(manifest.changes[0]?.before?.mode).not.toBe(manifest.changes[0]?.after?.mode);
  });

  it('treats a file that became a symlink as a modification with two kinds', async () => {
    const root = join(scratch, 'kind-change');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'thing'), 'was a file\n');

    const initial = await takeWorkspaceSnapshot(root);
    await unlink(join(root, 'thing'));
    await symlink('elsewhere', join(root, 'thing'));
    const final = await takeWorkspaceSnapshot(root);

    const manifest = buildChangeManifest({ initial, final });

    expect(manifest.changes).toHaveLength(1);
    expect(manifest.changes[0]).toMatchObject({
      path: 'thing',
      status: 'modified',
      before: { kind: 'file', symlinkTarget: null },
      after: { kind: 'symlink', symlinkTarget: 'elsewhere' },
    });
  });

  it('refuses to compare two different roots', async () => {
    const left = await repo('root-left', { 'a.txt': 'a\n' });
    const right = await repo('root-right', { 'a.txt': 'a\n' });

    const initial = await takeWorkspaceSnapshot(left);
    const final = await takeWorkspaceSnapshot(right);

    expect(() => buildChangeManifest({ initial, final })).toThrow(/different roots/);
  });
});

describe('buildChangeManifest — a bounded manifest is not authority', () => {
  it('marks itself incomplete when the change list hits its cap', async () => {
    const root = join(scratch, 'too-many-changes');
    await mkdir(root, { recursive: true });

    const initial = await takeWorkspaceSnapshot(root);
    for (let index = 0; index < 10; index += 1) {
      await writeFile(join(root, `f${String(index)}.txt`), 'x\n');
    }
    const final = await takeWorkspaceSnapshot(root);

    const complete = buildChangeManifest({ initial, final });
    const capped = buildChangeManifest({ initial, final, maxChanges: 3 });

    expect(complete.complete).toBe(true);
    expect(complete.changeCount).toBe(10);

    expect(capped.complete).toBe(false);
    expect(capped.stopReason).toBe('max-changes');
    expect(capped.changeCount).toBe(3);

    // The digest covers completeness, so a truncated manifest cannot be passed off as a
    // whole one by copying its hash onto a longer body.
    expect(capped.digest).not.toBe(complete.digest);
  });

  it('marks itself incomplete when either snapshot was bounded', async () => {
    const root = join(scratch, 'bounded-snapshot');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'a.txt'), 'a\n');
    await writeFile(join(root, 'b.txt'), 'b\n');

    const initial = await takeWorkspaceSnapshot(root, { maxEntries: 1 });
    await writeFile(join(root, 'a.txt'), 'changed\n');
    const final = await takeWorkspaceSnapshot(root);

    const manifest = buildChangeManifest({ initial, final });

    expect(manifest.complete).toBe(false);
    expect(manifest.stopReason).toBe('initial-incomplete');
  });
});

describe('buildChangeManifest — the canonical form is what the digest covers', () => {
  it('recomputes to the recorded digest, and any edit changes it', async () => {
    const root = await repo('digest', { 'a.txt': 'one\n' });

    const initial = await takeWorkspaceSnapshot(root);
    await writeFile(join(root, 'a.txt'), 'two\n');
    const final = await takeWorkspaceSnapshot(root);

    const manifest = buildChangeManifest({ initial, final });
    const serialised = serialiseManifest(manifest);

    expect(sha256(serialised)).toBe(manifest.digest);

    // The three things a forger would change, one at a time. Each must move the digest,
    // because content and provenance are covered by the same hash.
    const edited = [
      { ...manifest, changes: manifest.changes.map((change) => ({ ...change, status: 'added' as const })) },
      { ...manifest, initial: { ...manifest.initial, digest: final.digest } },
      { ...manifest, complete: false, stopReason: 'max-changes' as const },
    ];

    for (const variant of edited) {
      expect(serialiseManifest(variant)).not.toBe(serialised);
    }
  });
});
