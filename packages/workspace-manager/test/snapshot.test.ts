import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SNAPSHOT_VERSION,
  SnapshotError,
  serialiseSnapshot,
  snapshotDigest,
  takeWorkspaceSnapshot,
  type WorkspaceSnapshot,
} from '../src';
import { addAll, commit, initRepo } from './helpers/git';

/**
 * The host walk.
 *
 * Every test here is a property the evidence claim depends on. If any of them fails, the
 * change manifest is not authority — it is another report from a program that could be
 * wrong in a way nobody can see.
 */

const execFileAsync = promisify(execFile);

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'intelligenz-snapshot-'));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function tree(name: string): Promise<string> {
  const root = join(scratch, name);
  await mkdir(root, { recursive: true });
  return root;
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function entryOf(snapshot: WorkspaceSnapshot, path: string) {
  return snapshot.entries.find((entry) => entry.path === path);
}

describe('takeWorkspaceSnapshot — what a snapshot describes', () => {
  it('records files, directories and permission bits, and nothing else', async () => {
    const root = await tree('kinds');
    await writeFile(join(root, 'a.txt'), 'alpha\n');
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested', 'b.txt'), 'beta\n', { mode: 0o640 });

    const snapshot = await takeWorkspaceSnapshot(root);

    expect(snapshot.complete).toBe(true);
    expect(snapshot.stopReason).toBeNull();
    expect(snapshot.entryCount).toBe(snapshot.entries.length);

    // Permission bits are read from the filesystem, not assumed: the host's umask is not
    // part of the contract, and a test that encoded it would pass here and fail in CI.
    const aMode = (await lstat(join(root, 'a.txt'))).mode & 0o7777;
    const nestedMode = (await lstat(join(root, 'nested'))).mode & 0o7777;

    expect(entryOf(snapshot, 'a.txt')).toEqual({
      path: 'a.txt',
      kind: 'file',
      mode: aMode,
      sizeBytes: 6,
      sha256: sha256('alpha\n'),
      symlinkTarget: null,
    });

    expect(entryOf(snapshot, 'nested')).toEqual({
      path: 'nested',
      kind: 'dir',
      mode: nestedMode,
      sizeBytes: 0,
      sha256: null,
      symlinkTarget: null,
    });

    expect(entryOf(snapshot, 'nested/b.txt')?.mode).toBe(0o640);
  });

  it('hashes binary content by bytes and never decodes it', async () => {
    const root = await tree('binary');
    // Every one of these is invalid UTF-8 on its own. A walker that decoded to a string
    // and re-encoded would produce a different digest, and the difference would only
    // appear on files nobody reads.
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28, 0x00, 0x0a]);
    await writeFile(join(root, 'blob.bin'), bytes);

    const snapshot = await takeWorkspaceSnapshot(root);
    const entry = entryOf(snapshot, 'blob.bin');

    expect(entry?.sha256).toBe(sha256(bytes));
    expect(entry?.sizeBytes).toBe(bytes.byteLength);
  });

  it('records a symlink as a link with its target, and never reads what it points at', async () => {
    const root = await tree('symlink');
    const outside = await tree('symlink-outside');
    await writeFile(join(outside, 'target.txt'), 'outside content\n');
    await symlink('/etc/passwd', join(root, 'passwd-link'));
    await symlink(join(outside, 'target.txt'), join(root, 'outside-link'));

    const snapshot = await takeWorkspaceSnapshot(root);

    expect(entryOf(snapshot, 'passwd-link')).toMatchObject({
      kind: 'symlink',
      symlinkTarget: '/etc/passwd',
      sha256: null,
      sizeBytes: 0,
    });

    expect(entryOf(snapshot, 'outside-link')).toMatchObject({
      kind: 'symlink',
      symlinkTarget: join(outside, 'target.txt'),
      sha256: null,
    });

    // Neither target's bytes are in the manifest: a link is a fact about a name, not a
    // read primitive. This is the assertion that would fail if the walk used `stat`
    // instead of `lstat`, or if it followed a link to hash "the file it points at".
    const passwdDigest = sha256(await readFile('/etc/passwd'));
    expect(snapshot.entries.some((entry) => entry.sha256 === passwdDigest)).toBe(false);
    expect(snapshot.entries.some((entry) => entry.sha256 === sha256('outside content\n'))).toBe(
      false,
    );
  });

  it('classifies a FIFO without opening it, so the walk does not block', async () => {
    const root = await tree('fifo');
    await writeFile(join(root, 'ordinary.txt'), 'x\n');
    await execFileAsync('mkfifo', [join(root, 'pipe')]);

    // `open()` on a FIFO with no writer blocks forever, so the assertion is also the
    // liveness proof: this test finishing at all is half of it.
    const snapshot = await takeWorkspaceSnapshot(root);

    expect(entryOf(snapshot, 'pipe')).toMatchObject({
      path: 'pipe',
      kind: 'special',
      sizeBytes: 0,
      sha256: null,
      symlinkTarget: null,
    });
    expect(snapshot.complete).toBe(true);
  });

  it('records names with spaces, unicode and a newline, sorted by path bytes', async () => {
    const root = await tree('names');
    const names = ['file with spaces.txt', 'ünïcode-文件.txt', 'new\nline.txt', 'z.txt', 'A.txt'];

    for (const name of names) await writeFile(join(root, name), `${name}\n`);

    const snapshot = await takeWorkspaceSnapshot(root);
    const recorded = snapshot.entries.map((entry) => entry.path);

    expect([...recorded].sort()).toEqual([...names].sort());

    // Byte order, not UTF-16 order. `Array.prototype.sort` would put the astral/unicode
    // names in a different place than `Buffer.compare`, and a digest computed from that
    // order is a digest of the host's collation rather than of the tree.
    const expected = [...recorded].sort((left, right) =>
      Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')),
    );
    expect(recorded).toEqual(expected);
  });

  it('excludes `.git/` from the content manifest but digests its config, index, HEAD and hooks', async () => {
    const root = await tree('git-metadata');
    await initRepo(root, { 'src/index.ts': 'export const a = 1;\n' });
    await writeFile(
      join(root, '.git', 'hooks', 'pre-commit'),
      '#!/bin/sh\necho hostile\n',
      { mode: 0o755 },
    );

    const snapshot = await takeWorkspaceSnapshot(root);

    expect(snapshot.entries.some((entry) => entry.path.startsWith('.git'))).toBe(false);
    expect(snapshot.git.present).toBe(true);
    expect(snapshot.git.kind).toBe('directory');
    expect(snapshot.git.head).toMatch(/^ref: refs\/heads\/main$|^[a-f0-9]{40}$/);
    expect(snapshot.git.configSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.git.indexSha256).toMatch(/^[a-f0-9]{64}$/);
    // `git init` installs its own `*.sample` hooks; every one is digested, because "which
    // hooks exist" is the fact that matters and a sample can be renamed into place.
    expect(snapshot.git.hooks).toContainEqual({
      name: 'pre-commit',
      kind: 'file',
      sha256: sha256('#!/bin/sh\necho hostile\n'),
    });
    expect(snapshot.git.hooks.length).toBeGreaterThan(1);
  });

  it('changes the git metadata digest when the config changes, without touching entries', async () => {
    const root = await tree('git-config-change');
    await initRepo(root, { 'a.txt': 'one\n' });

    const before = await takeWorkspaceSnapshot(root);
    await writeFile(join(root, '.git', 'config'), `${await readFile(join(root, '.git', 'config'), 'utf8')}\n[core]\n\tfsmonitor = /tmp/evil\n`);
    const after = await takeWorkspaceSnapshot(root);

    // The tree is unchanged; the *repository configuration* is not. A snapshot that only
    // hashed files would call this "nothing happened", which is precisely how
    // `core.fsmonitor` stayed invisible.
    expect(after.entries).toEqual(before.entries);
    expect(after.git.configSha256).not.toBe(before.git.configSha256);
    expect(after.digest).not.toBe(before.digest);
  });
});

describe('takeWorkspaceSnapshot — the digest', () => {
  it('is stable across two walks of an unchanged tree, and moves when one byte moves', async () => {
    const root = await tree('digest');
    await writeFile(join(root, 'a.txt'), 'one\n');

    const first = await takeWorkspaceSnapshot(root);
    const second = await takeWorkspaceSnapshot(root);

    expect(second.digest).toBe(first.digest);
    expect(second.capturedAt).not.toBe('');
    // The timestamp is outside the digested body on purpose: "the tree is the same" must
    // be a fact, not an inference from two equal-looking timestamps.
    expect(second.digest).toBe(snapshotDigest(first));

    await writeFile(join(root, 'a.txt'), 'two\n');
    const third = await takeWorkspaceSnapshot(root);

    expect(third.digest).not.toBe(first.digest);
  });

  it('is the SHA-256 of the canonical serialisation, one deterministic JSON form', async () => {
    const root = await tree('canonical');
    await writeFile(join(root, 'b.txt'), 'b\n');
    await writeFile(join(root, 'a.txt'), 'a\n');

    const snapshot = await takeWorkspaceSnapshot(root);
    const serialised = serialiseSnapshot(snapshot);

    expect(sha256(serialised)).toBe(snapshot.digest);
    expect(JSON.parse(serialised)).toMatchObject({ version: SNAPSHOT_VERSION, complete: true });

    // Field order is literal, so the same tree serialises to the same bytes.
    expect(serialiseSnapshot({ ...snapshot })).toBe(serialised);
  });

  it('refuses a root that is a file or a symlink', async () => {
    const root = await tree('bad-root');
    const file = join(root, 'not-a-directory');
    await writeFile(file, 'x');

    await expect(takeWorkspaceSnapshot(file)).rejects.toBeInstanceOf(SnapshotError);

    await symlink(root, join(scratch, 'root-link'));
    await expect(takeWorkspaceSnapshot(join(scratch, 'root-link'))).rejects.toBeInstanceOf(
      SnapshotError,
    );
  });
});

describe('takeWorkspaceSnapshot — bounds are reported, never hidden', () => {
  it('stops at maxEntries and reports `complete: false` with the count it reached', async () => {
    const root = await tree('max-entries');
    for (let index = 0; index < 20; index += 1) {
      await writeFile(join(root, `f${String(index).padStart(2, '0')}.txt`), 'x\n');
    }

    const snapshot = await takeWorkspaceSnapshot(root, { maxEntries: 7 });

    expect(snapshot.complete).toBe(false);
    expect(snapshot.stopReason).toBe('max-entries');
    expect(snapshot.entryCount).toBe(7);
    expect(snapshot.entries).toHaveLength(7);
    expect(snapshot.limits).toEqual({ maxEntries: 7, maxTotalBytes: 8 * 1024 * 1024 * 1024 });

    // Deterministic truncation: the first seven names in byte order, not "whichever
    // seven the filesystem happened to return".
    expect(snapshot.entries.map((entry) => entry.path)).toEqual([
      'f00.txt',
      'f01.txt',
      'f02.txt',
      'f03.txt',
      'f04.txt',
      'f05.txt',
      'f06.txt',
    ]);
  });

  it('stops before a file that would exceed maxTotalBytes, and does not hash it', async () => {
    const root = await tree('max-bytes');
    await writeFile(join(root, 'a.txt'), 'a'.repeat(10));
    await writeFile(join(root, 'b.txt'), 'b'.repeat(10));

    const snapshot = await takeWorkspaceSnapshot(root, { maxTotalBytes: 15 });

    expect(snapshot.complete).toBe(false);
    expect(snapshot.stopReason).toBe('max-total-bytes');
    expect(snapshot.entries.map((entry) => entry.path)).toEqual(['a.txt']);
    expect(snapshot.totalBytes).toBe(10);
  });

  it('treats a bounded snapshot as a different digest from a complete one', async () => {
    const root = await tree('bounded-digest');
    await writeFile(join(root, 'a.txt'), 'a\n');
    await writeFile(join(root, 'b.txt'), 'b\n');

    const complete = await takeWorkspaceSnapshot(root);
    const bounded = await takeWorkspaceSnapshot(root, { maxEntries: 1 });

    // A partial digest that equalled a complete one would let "I could not see
    // everything" be presented as "I saw everything".
    expect(bounded.digest).not.toBe(complete.digest);
  });

  it('rejects nonsensical limits instead of silently clamping them', async () => {
    const root = await tree('bad-limits');
    await writeFile(join(root, 'a.txt'), 'a\n');

    await expect(takeWorkspaceSnapshot(root, { maxEntries: 0 })).rejects.toBeInstanceOf(
      SnapshotError,
    );
    await expect(takeWorkspaceSnapshot(root, { maxTotalBytes: -1 })).rejects.toBeInstanceOf(
      SnapshotError,
    );
  });
});

describe('takeWorkspaceSnapshot — structural guarantee', () => {
  it('cannot spawn a process: the module has no subprocess import', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../src/snapshot.ts', import.meta.url)),
      'utf8',
    );

    // ESLint already forbids `node:child_process` under this package (`SEC-403`), so this
    // is the second lock on the same door — and the one a reader can see without running
    // the linter. The prohibition is the point: a walk that can shell out can be made to
    // run a program the agent wrote.
    for (const forbidden of [
      "from 'node:child_process'",
      'from "node:child_process"',
      'execFile',
      'execSync',
      'spawn(',
      'spawnSync',
    ]) {
      expect(source.includes(forbidden), `snapshot.ts must not reference ${forbidden}`).toBe(
        false,
      );
    }
  });
});

describe('takeWorkspaceSnapshot — the three attacks it exists to survive', () => {
  /**
   * These are the same three operations the contract measured against `git diff`. Here the
   * subject is the *walk*: each attack changes the tree, and the walk must describe the
   * tree. `change-manifest.test.ts` asserts the manifest produced from these snapshots.
   */
  it('describe: a staged change is visible to the walk even though `git diff` is empty', async () => {
    const root = await tree('attack-staged');
    await initRepo(root, { 'answer.txt': 'original\n' });

    const initial = await takeWorkspaceSnapshot(root);

    await writeFile(join(root, 'answer.txt'), 'COMPROMISED\n');
    await addAll(root);

    const final = await takeWorkspaceSnapshot(root);

    expect(initial.digest).not.toBe(final.digest);
    expect(entryOf(final, 'answer.txt')?.sha256).toBe(sha256('COMPROMISED\n'));
    expect(entryOf(final, 'answer.txt')?.sha256).not.toBe(
      entryOf(initial, 'answer.txt')?.sha256,
    );
  });

  it('describe: a committed change is visible to the walk even though the tree is clean', async () => {
    const root = await tree('attack-committed');
    await initRepo(root, { 'answer.txt': 'original\n' });

    const initial = await takeWorkspaceSnapshot(root);

    await writeFile(join(root, 'answer.txt'), 'COMPROMISED\n');
    await addAll(root);
    await commit(root, 'rewrite');

    const final = await takeWorkspaceSnapshot(root);

    expect(final.digest).not.toBe(initial.digest);
    expect(entryOf(final, 'answer.txt')?.sha256).toBe(sha256('COMPROMISED\n'));
  });
});
