import { createHash } from 'node:crypto';
import { lstat, mkdtemp, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { hashRegularFile } from '../src/snapshot';

/**
 * F-G5 — the `lstat` → `open` race, made deterministic.
 *
 * A walk decides a path is a regular file by `lstat`, then opens it to hash the contents.
 * Between those two calls the path can become a symlink, and a plain `createReadStream`
 * follows it: the tree boundary is crossed after the check that was supposed to enforce it,
 * and if the target happens to be the same size, the size check agrees too.
 *
 * The fix is `open(O_RDONLY | O_NOFOLLOW)` plus an `fstat` of the descriptor compared with
 * the `lstat` that classified the entry. The race cannot be won on demand in a test, but the
 * *window* can be held open: keep a `Stats` from before a swap and hand it to the function
 * that is supposed to detect exactly that. That is the shape below, and it is why
 * `hashRegularFile` is exported from the module rather than kept private.
 */

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
});
