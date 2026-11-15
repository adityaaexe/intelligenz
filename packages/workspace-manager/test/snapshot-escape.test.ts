import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildChangeManifest, serialiseManifest, takeWorkspaceSnapshot } from '../src';
import { initRepo } from './helpers/git';

/**
 * The two ways out of the tree, and the one way back in.
 *
 * ## F-G1 — a directory listing is a descent
 *
 * `readdir(<root>/.git/hooks)` follows a symlinked `hooks` directory. Every name it returns
 * is then joined to the root and checked with the lexical `isContained`, which always
 * agrees — so the walk hashed `/etc/passwd` and reported it as a hook, and the snapshot's
 * digest (which covers hook digests) became an oracle over arbitrary readable host files.
 *
 * The rule is not "never follow a link when hashing a file"; it is **never descend into a
 * path that is, or is reached through, a symlink**. `lstat` before every `readdir`, and a
 * link is described by its target instead of listed.
 *
 * ## The positive control is load-bearing
 *
 * `.git/hooks -> /etc` producing zero entries is only meaningful if a real hooks directory
 * produces its entries. The control below is the same fixture with a real directory and one
 * hook, and it demands that hook's exact digest. Without it, "hooks: []" would pass for an
 * implementation that never enumerates hooks at all.
 *
 * F-G5 — the `lstat` → `open` race — lives in `snapshot-race.test.ts`: it holds a stale
 * `lstat` across a deliberate swap, which needs `hashRegularFile` directly and has nothing
 * to do with a repository fixture.
 */

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'intelligenz-escape-'));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

let counter = 0;

/** A real repository, returned by absolute path. `counter` keeps fixture names distinct. */
async function repo(files: Readonly<Record<string, string>> = { 'a.txt': 'a\n' }): Promise<string> {
  counter += 1;
  const root = join(scratch, `repo-${String(counter)}`);
  await initRepo(root, files);

  return root;
}

describe('F-G1 — a symlinked .git/hooks is recorded, never enumerated', () => {
  it('does not read /etc through .git/hooks, and says the directory is a link', async () => {
    const root = await repo();
    const passwd = await readFile('/etc/passwd');

    await rm(join(root, '.git', 'hooks'), { recursive: true, force: true });
    await symlink('/etc', join(root, '.git', 'hooks'));

    const snapshot = await takeWorkspaceSnapshot(root);

    // The link is described the way every other link in this module is described: by its
    // target. That is a fact about the tree, so it belongs in the evidence.
    expect(snapshot.git.hooksDirectoryLinkTarget).toBe('/etc');

    // Nothing from /etc was enumerated, so nothing from /etc can be in the digest.
    expect(snapshot.git.hooks).toEqual([]);
    expect(snapshot.git.oversize).toEqual([]);

    // The blunt assertion, at both places the digest is written: neither the snapshot body
    // nor the manifest derived from it contains a byte count or hash of /etc/passwd.
    const serialised = JSON.stringify(snapshot);
    expect(serialised).not.toContain(sha256(passwd));

    const manifest = buildChangeManifest({ initial: snapshot, final: snapshot });
    expect(serialiseManifest(manifest)).not.toContain(sha256(passwd));

    // And the walk still completed: a hostile metadata layout is not a reason to stop
    // describing the content, which is the part the agent cannot hide.
    expect(snapshot.complete).toBe(true);
    expect(snapshot.entries.map((entry) => entry.path)).toContain('a.txt');
  });

  it('positive control: a real hooks directory still produces its hook, with its digest', async () => {
    const root = await repo();
    const hookPath = join(root, '.git', 'hooks', 'pre-commit');

    await mkdir(join(root, '.git', 'hooks'), { recursive: true });
    await writeFile(hookPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const snapshot = await takeWorkspaceSnapshot(root);
    const hook = snapshot.git.hooks.find((entry) => entry.name === 'pre-commit');

    // If this fails while the test above passes, the negative proves nothing: it would be
    // passing because hooks are never read at all.
    expect(snapshot.git.hooksDirectoryLinkTarget).toBeNull();
    expect(hook).toMatchObject({
      name: 'pre-commit',
      kind: 'file',
      sha256: sha256('#!/bin/sh\nexit 0\n'),
    });
  });

  it('records a fresh snapshot of the same tree with the same digest, link and all', async () => {
    const root = await repo();
    await rm(join(root, '.git', 'hooks'), { recursive: true, force: true });
    await symlink('/etc', join(root, '.git', 'hooks'));

    const first = await takeWorkspaceSnapshot(root);
    const second = await takeWorkspaceSnapshot(root);

    // The link target is part of the canonical body, so two captures of one tree agree —
    // which is what makes a change in the link visible as a change, not as noise.
    expect(second.digest).toBe(first.digest);
  });

  it('does not throw when .git/hooks is a regular file', async () => {
    const root = await repo();

    await rm(join(root, '.git', 'hooks'), { recursive: true, force: true });
    await writeFile(join(root, '.git', 'hooks'), 'not a directory\n');

    const snapshot = await takeWorkspaceSnapshot(root);

    expect(snapshot.git.hooksDirectoryLinkTarget).toBeNull();
    expect(snapshot.git.hooks).toEqual([]);
    expect(snapshot.complete).toBe(true);
  });
});

describe('F-G1 — .git itself, as a link and as a gitfile', () => {
  it('records a symlinked .git as a link and does not walk into its target', async () => {
    const root = await repo();
    const outside = join(scratch, 'outside-git');
    const marker = 'MARKER-THAT-MUST-NOT-BE-HASHED\n';

    await mkdir(join(outside, 'hooks'), { recursive: true });
    await writeFile(join(outside, 'hooks', 'pre-commit'), marker);
    await writeFile(join(outside, 'config'), marker);

    await rm(join(root, '.git'), { recursive: true, force: true });
    await symlink(outside, join(root, '.git'));

    const snapshot = await takeWorkspaceSnapshot(root);

    // A `.git` link is not a checkout layout this module describes; it is a string.
    expect(snapshot.git).toMatchObject({
      present: true,
      kind: 'file',
      head: null,
      configSha256: null,
      indexSha256: null,
      hooks: [],
      hooksDirectoryLinkTarget: null,
    });
    expect(snapshot.git.gitfileSha256).toBe(sha256(`symlink:${outside}`));
    expect(JSON.stringify(snapshot)).not.toContain(sha256(marker));
  });

  it('hashes a gitfile without following what it points at', async () => {
    const root = await repo();
    const target = join(scratch, 'gitdir-target');
    const pointer = `gitdir: ${target}\n`;

    await mkdir(join(target, 'hooks'), { recursive: true });
    await writeFile(join(target, 'hooks', 'pre-commit'), 'MARKER\n');

    await rm(join(root, '.git'), { recursive: true, force: true });
    await writeFile(join(root, '.git'), pointer);

    const snapshot = await takeWorkspaceSnapshot(root);

    expect(snapshot.git).toMatchObject({
      present: true,
      kind: 'file',
      head: null,
      hooks: [],
      hooksDirectoryLinkTarget: null,
    });
    expect(snapshot.git.gitfileSha256).toBe(sha256(pointer));
    expect(JSON.stringify(snapshot)).not.toContain(sha256('MARKER\n'));
  });

  it('does not read .git/HEAD through a symlink', async () => {
    const root = await repo();

    await unlink(join(root, '.git', 'HEAD'));
    await symlink('/etc/passwd', join(root, '.git', 'HEAD'));

    const snapshot = await takeWorkspaceSnapshot(root);

    // `readFile` would have followed this and put the first 512 bytes of /etc/passwd into
    // `head`. The only honest answer for "HEAD is a link" is that HEAD was not read.
    expect(snapshot.git.head).toBeNull();
    expect(JSON.stringify(snapshot)).not.toContain('root:x:0:0');
  });

  it('marks an unreadable .git file as a gap instead of hashing something else', async () => {
    const root = await repo();

    await rm(join(root, '.git'), { recursive: true, force: true });
    // A `gitdir:` pointer is one line. This is not one, and reading it would be a hash of
    // bytes that are not a pointer.
    await writeFile(join(root, '.git'), `gitdir: ${'x'.repeat(8 * 1024)}\n`);

    const snapshot = await takeWorkspaceSnapshot(root);

    expect(snapshot.git).toMatchObject({ present: true, kind: 'file', gitfileSha256: null });
    expect(snapshot.git.oversize).toEqual(['.git']);
    // A metadata field that could not be read is a gap in the evidence, and the failure
    // direction is "less claim": the snapshot says so rather than looking whole.
    expect(snapshot.complete).toBe(false);
    expect(snapshot.stopReason).toBe('unreadable');
  });
});
