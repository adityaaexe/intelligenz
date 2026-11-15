import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, open, rm, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, describe, expect, it } from 'vitest';

import { hashRegularFile, takeWorkspaceSnapshot } from '../src/snapshot';

/**
 * F-G5 — the `lstat` → `open` race, made deterministic.
 *
 * A walk decides a path is a regular file by `lstat`, then opens it to hash the contents.
 * Between those two calls the path can become a symlink, and a plain `createReadStream`
 * follows it: the tree boundary is crossed after the check that was supposed to enforce it,
 * and if the target happens to be the same size, the size check agrees too.
 *
 * F-G17 adds the second half of the same window: a path swapped for a **FIFO** must be
 * refused, not opened, because `open()` on a FIFO with no writer blocks forever.
 *
 * F-G4 adds the check that the size/`mtime` pair could not provide: `ctime` cannot be set
 * by an unprivileged process, so a same-size rewrite with `mtime` restored exactly is
 * still contested.
 *
 * The race cannot be won on demand in a test, but the *window* can be held open: keep a
 * `Stats` from before a swap and hand it to the function that is supposed to detect exactly
 * that. That is the shape below, and it is why `hashRegularFile` is exported from the
 * module rather than kept private.
 */

const execFileAsync = promisify(execFile);

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const roots: string[] = [];

afterAll(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'intelligenz-race-'));
  roots.push(root);

  return root;
}

describe('F-G5 — a swapped final component is contested, not hashed', () => {
  it('refuses a descriptor that is not the inode lstat described', async () => {
    const root = await scratch();
    const victim = join(root, 'target.txt');
    const replacement = join(root, 'replacement.txt');

    await writeFile(victim, 'SAFE\n');
    // Same size and same content, so only the identity check can tell them apart — a
    // size-only check would have called this stable.
    await writeFile(replacement, 'SAFE\n');

    const stale = await lstat(victim);

    await unlink(victim);
    await symlink(replacement, victim);

    await expect(hashRegularFile(victim, stale)).rejects.toMatchObject({
      name: 'UnstableEntryError',
    });
  });

  it('hashes an unchanged file, so the refusal above is about the swap', async () => {
    const root = await scratch();
    const victim = join(root, 'target.txt');

    await writeFile(victim, 'SAFE\n');

    const current = await lstat(victim);

    // The positive control: the same function, the same file, no swap.
    await expect(hashRegularFile(victim, current)).resolves.toEqual({
      sha256: sha256('SAFE\n'),
      sizeBytes: 5,
    });
  });

  it('refuses a file that changed size after it was budgeted', async () => {
    const root = await scratch();
    const victim = join(root, 'grow.txt');

    await writeFile(victim, 'short\n');

    const stale = await lstat(victim);
    await writeFile(victim, 'much longer than before\n');

    await expect(hashRegularFile(victim, stale)).rejects.toMatchObject({
      name: 'UnstableEntryError',
    });
  });

  it('refuses a file swapped for a FIFO instead of blocking on open — F-G17', async () => {
    const root = await scratch();
    const victim = join(root, 'swapped-to-fifo');

    await writeFile(victim, 'SAFE\n');
    const stale = await lstat(victim);

    await unlink(victim);
    await execFileAsync('mkfifo', [victim]);

    // `open()` on this FIFO would wait for a writer for ever. The refusal must be immediate:
    // `O_NONBLOCK` opens it and the descriptor kind check refuses it before any read. If
    // the fix is reverted, this test times out rather than observing a hang.
    const error = await hashRegularFile(victim, stale).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: 'UnstableEntryError' });
  }, 20_000);
});

/**
 * F-G4 — `ctime` is the timestamp a writer cannot restore.
 *
 * Measured before the fix: a same-size in-place write with `mtime` restored at
 * nanosecond precision produced `complete: true`, `changeCount: 0`, and a final digest
 * equal to the baseline. The size and `mtime` checks both agreed because both values were
 * restored. `ctime` moved, and nothing compared it.
 *
 * `touch -r <reference>` copies the reference file's timestamps at the filesystem's full
 * precision, which is how the first test restores `mtime` *exactly* and proves the old
 * check would have accepted the file.
 */
describe('F-G4 — a same-size rewrite is contested, even with mtime restored', () => {
  /** Set `path`'s timestamps to `reference`'s, at whatever precision the filesystem keeps. */
  async function touchFrom(reference: string, path: string): Promise<void> {
    await execFileAsync('touch', ['-r', reference, path]);
  }

  it('refuses a same-size in-place rewrite whose mtime is restored exactly', async () => {
    const root = await scratch();
    const reference = join(root, 'mtime-reference.txt');
    const victim = join(root, 'payload.bin');

    await writeFile(reference, 'reference\n');
    await writeFile(victim, 'A'.repeat(4_096));
    await touchFrom(reference, victim);

    const before = await lstat(victim);

    // Same size, same inode, same mtime. Only ctime can tell this file apart from the one
    // the caller is about to hash.
    const handle = await open(victim, 'r+');
    try {
      await handle.write(Buffer.alloc(16, 0x42), 0, 16, 0);
    } finally {
      await handle.close();
    }

    await touchFrom(reference, victim);

    const after = await lstat(victim);

    expect(after.size).toBe(before.size);
    // The assertion that makes this a test of ctime and not of the existing mtime check.
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ctimeMs).not.toBe(before.ctimeMs);

    const error = await hashRegularFile(victim, before).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: 'UnstableEntryError' });
    expect((error as Error).message).toMatch(/ctime/);
  });

  it('refuses a same-size rewrite that lands while the file is being hashed', async () => {
    const root = await scratch();
    const reference = join(root, 'mtime-reference.txt');
    const victim = join(root, 'large-payload.bin');

    await writeFile(reference, 'reference\n');
    // Large enough that the read is still in progress when the write below lands; the
    // window is held by the size of the file, not by a sleep. Sparse on purpose: the
    // bytes read are zeroes, so the fixture costs no blocks on a quota-bound /tmp.
    await writeFile(victim, '');
    await truncate(victim, 64 * 1024 * 1024);
    await touchFrom(reference, victim);

    const before = await lstat(victim);
    const hashing = hashRegularFile(victim, before);

    const handle = await open(victim, 'r+');
    try {
      await handle.write(Buffer.alloc(4_096, 0x42), 0, 4_096, 0);
    } finally {
      await handle.close();
    }

    await touchFrom(reference, victim);

    const error = await hashing.catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: 'UnstableEntryError' });
    // Size did not move and `mtime` was restored; the message naming `ctime` is what shows
    // the detection is the new comparison and not the old size check.
    expect((error as Error).message).toMatch(/ctime/);
  }, 30_000);

  it('control: an untouched file still hashes', async () => {
    const root = await scratch();
    const victim = join(root, 'untouched.txt');

    await writeFile(victim, 'SAFE\n');
    const current = await lstat(victim);

    await expect(hashRegularFile(victim, current)).resolves.toEqual({
      sha256: sha256('SAFE\n'),
      sizeBytes: 5,
    });
  });
});

/**
 * F-G20 — the `readdir` → child-`lstat` window, which the entry-level check cannot see.
 *
 * A parent directory is classified as a directory, then listed. Between that listing and
 * the classification of its children, the path can be replaced with a symbolic link to a
 * directory outside the tree. Every child then resolves through the link: the child's
 * `lstat` and the descriptor's `fstat` agree with **each other** because both were resolved
 * through the same link, so `hashRegularFile`'s identity check reports nothing and the
 * off-tree bytes are hashed into an otherwise `complete: true` snapshot.
 *
 * The mitigation is a parent identity re-check after the children: the walked path must
 * still be the `dev`/`ino` that classified it. The swap is held open with the walk's
 * `afterDirectoryListed` seam — the same shape as handing a stale `Stats` to
 * `hashRegularFile`, for the same reason: the window cannot be reached from outside.
 *
 * This is detection, not prevention. Without `openat2(RESOLVE_BENEATH)` the open is
 * path-based, so bytes can be hashed from a momentarily substituted path; what the fix
 * guarantees is that the snapshot never says `complete: true` and never keeps the subtree's
 * entries, and that the attempt fails (F-G13).
 */
describe('F-G20 — a parent swapped for a link is detected, and its subtree withdrawn', () => {
  /** Build `<root>/parent/inside.txt` and an outside tree with the same name, different bytes. */
  async function arrange(): Promise<{
    readonly root: string;
    readonly outside: string;
    readonly insideBytes: string;
    readonly outsideBytes: string;
  }> {
    const root = await scratch();
    const outside = await scratch();
    const insideBytes = 'bytes the workspace really contains\n';
    const outsideBytes = 'bytes from outside the workspace\n';

    await mkdir(join(root, 'parent'), { recursive: true });
    await writeFile(join(root, 'parent', 'inside.txt'), insideBytes);
    // The same name, so the listed child resolves through the link to content that was
    // never in the tree. A different name would make this a "file vanished" test.
    await writeFile(join(outside, 'inside.txt'), outsideBytes);

    return { root, outside, insideBytes, outsideBytes };
  }

  it('is not complete, and keeps no off-tree digest in the snapshot', async () => {
    const { root, outside, outsideBytes } = await arrange();

    const snapshot = await takeWorkspaceSnapshot(root, {
      afterDirectoryListed: async (relativePath) => {
        if (relativePath !== 'parent') return;

        // The window: `parent` has been listed, its children have not been classified.
        await rm(join(root, 'parent'), { recursive: true, force: true });
        await symlink(outside, join(root, 'parent'));
      },
    });

    // The assertion the finding is about: this is not a clean bill of health.
    expect(snapshot.complete).toBe(false);
    expect(snapshot.stopReason).toBe('parent-replaced');

    // And the off-tree bytes are not in the body — not in `entries`, not in `totalBytes`,
    // not anywhere a reader would find them. Withdrawing the subtree is what makes this
    // hold; flagging alone would leave the hash in the file.
    expect(JSON.stringify(snapshot)).not.toContain(sha256(outsideBytes));
    expect(snapshot.entries.map((entry) => entry.path)).toEqual(
      expect.not.arrayContaining(['parent', 'parent/inside.txt']),
    );
    expect(snapshot.totalBytes).toBe(0);
  });

  it('negative control: the same tree walked without a swap is complete', async () => {
    const { root, insideBytes } = await arrange();

    const snapshot = await takeWorkspaceSnapshot(root);

    // If this failed, the check above would be evidence that every snapshot is incomplete
    // rather than that the swap was detected.
    expect(snapshot.complete).toBe(true);
    expect(snapshot.stopReason).toBeNull();
    expect(snapshot.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'parent', kind: 'dir' }),
        expect.objectContaining({ path: 'parent/inside.txt', sha256: sha256(insideBytes) }),
      ]),
    );
  });

  it('marks a directory whose child appeared mid-walk as unstable, and keeps its entries', async () => {
    const root = await scratch();

    await mkdir(join(root, 'parent'), { recursive: true });
    await writeFile(join(root, 'parent', 'inside.txt'), 'inside\n');

    const snapshot = await takeWorkspaceSnapshot(root, {
      afterDirectoryListed: async (relativePath) => {
        if (relativePath !== 'parent') return;
        // Same inode, new child: `ctime` moves, `dev`/`ino` do not. This is a tree that
        // moved under the walk, not a path that resolves somewhere else — the distinction
        // the two stop reasons exist to keep.
        await writeFile(join(root, 'parent', 'appeared.txt'), 'later\n');
      },
    });

    expect(snapshot.complete).toBe(false);
    expect(snapshot.stopReason).toBe('unstable');
    // The entries read from that directory are what they were at read time, so they stay.
    expect(snapshot.entries.map((entry) => entry.path)).toContain('parent/inside.txt');
  });
});
