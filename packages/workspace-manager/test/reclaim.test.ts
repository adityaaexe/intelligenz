import { mkdir, mkdtemp, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { preserveArtifacts, reclaimWorkspace, ReclaimRefusedError } from '../src/reclaim';
import { workspacePath } from '../src/paths';

/**
 * The reaper's removal primitive, tested for the ways it must **refuse**.
 *
 * A cleanup that deletes the wrong directory is unrecoverable, so the interesting cases
 * here are the refusals: a symlinked ancestor, a row whose `rootPath` does not match its
 * ids, and an id that is not a single path segment. Each one is a way `rm -rf` becomes a
 * host deletion if the check is missing.
 */

const roots: string[] = [];

async function fixture(): Promise<{
  root: string;
  ids: { orgId: string; taskId: string; workspaceId: string };
}> {
  const root = await mkdtemp(join(tmpdir(), 'iz-reclaim-'));
  roots.push(root);

  return { root, ids: { orgId: 'org-1', taskId: 'task-1', workspaceId: 'ws-1' } };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('reclaimWorkspace', () => {
  it('removes the checkout and keeps artifacts/ by default', async () => {
    const { root, ids } = await fixture();
    const path = workspacePath(root, ids);

    await mkdir(join(path, 'repo', 'src'), { recursive: true });
    await mkdir(join(path, 'artifacts'), { recursive: true });
    await writeFile(join(path, 'repo', 'src', 'index.ts'), 'export {};');
    await writeFile(join(path, 'artifacts', 'report.md'), '# evidence');

    const result = await reclaimWorkspace({ root, ids, recordedRootPath: path });

    expect(result.artifactsKept).toBe(true);
    expect(result.evidenceKept).toBe(false);
    expect(result.removed).toBe(false);
    expect(await readdir(path)).toEqual(['artifacts']);
    expect(await readdir(join(path, 'artifacts'))).toEqual(['report.md']);
  });

  /**
   * The reaper is the unattended cleanup path, so it is the one where "evidence disappeared
   * but the digest stayed in the row" would go unnoticed longest. A workspace whose adapter
   * reported nothing still has host evidence, and the old `exists(artifacts)` guard would
   * have removed it with the checkout.
   */
  it('keeps evidence/ when there are no artifacts, and preserves nothing else', async () => {
    const { root, ids } = await fixture();
    const path = workspacePath(root, ids);

    await mkdir(join(path, 'repo', 'src'), { recursive: true });
    await mkdir(join(path, 'evidence'), { recursive: true });
    await writeFile(join(path, 'repo', 'src', 'index.ts'), 'export {};');
    await writeFile(join(path, 'evidence', 'change-manifest.json'), '{"digest":"d"}');

    const result = await reclaimWorkspace({ root, ids, recordedRootPath: path });

    expect(result.artifactsKept).toBe(false);
    expect(result.evidenceKept).toBe(true);
    expect(result.removed).toBe(false);
    expect(await readdir(path)).toEqual(['evidence']);
    expect(await readdir(join(path, 'evidence'))).toEqual(['change-manifest.json']);
  });

  it('removes everything when asked to keep nothing', async () => {
    const { root, ids } = await fixture();
    const path = workspacePath(root, ids);

    await mkdir(join(path, 'repo'), { recursive: true });
    await mkdir(join(path, 'artifacts'), { recursive: true });

    const result = await reclaimWorkspace({
      root,
      ids,
      recordedRootPath: path,
      keepArtifacts: false,
    });

    expect(result.removed).toBe(true);
    await expect(readdir(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a symlinked ancestor even when the link points inside the root', async () => {
    const { root, ids } = await fixture();

    // `root/org-1` is a link to a sibling tenant. `realpath` would happily resolve it to
    // a path inside the root, so a containment-only check passes and deletes a workspace
    // belonging to someone else.
    const victim = join(root, 'org-2', 'task-1', 'ws-1');
    await mkdir(victim, { recursive: true });
    await writeFile(join(victim, 'important.txt'), 'not ours');
    await symlink(join(root, 'org-2'), join(root, 'org-1'));

    await expect(reclaimWorkspace({ root, ids, recordedRootPath: victim })).rejects.toBeInstanceOf(
      ReclaimRefusedError,
    );

    // The sibling survived.
    expect(await readdir(victim)).toEqual(['important.txt']);
  });

  it('refuses a recorded path that disagrees with the ids', async () => {
    const { root, ids } = await fixture();
    const path = workspacePath(root, ids);
    const other = workspacePath(root, { ...ids, workspaceId: 'ws-other' });

    await mkdir(path, { recursive: true });
    await mkdir(other, { recursive: true });

    await expect(reclaimWorkspace({ root, ids, recordedRootPath: other })).rejects.toMatchObject({
      refusal: 'path_mismatch',
    });
  });

  it('refuses an id that is not a single path segment', async () => {
    const { root } = await fixture();

    await expect(
      reclaimWorkspace({
        root,
        ids: { orgId: '..', taskId: 'task-1', workspaceId: 'ws-1' },
        recordedRootPath: join(root, '..', 'task-1', 'ws-1'),
      }),
    ).rejects.toMatchObject({ refusal: 'path_mismatch' });
  });

  it('is idempotent: a missing workspace is already absent, not an error', async () => {
    const { root, ids } = await fixture();
    const path = workspacePath(root, ids);

    const first = await reclaimWorkspace({ root, ids, recordedRootPath: path });
    const second = await reclaimWorkspace({ root, ids, recordedRootPath: path });

    expect(first.alreadyAbsent).toBe(true);
    expect(second.alreadyAbsent).toBe(true);
  });
});

describe('preserveArtifacts', () => {
  it('copies artifacts into the store and counts them', async () => {
    const { root, ids } = await fixture();
    const path = workspacePath(root, ids);
    const destination = join(root, 'store', ids.workspaceId);

    await mkdir(join(path, 'artifacts'), { recursive: true });
    await writeFile(join(path, 'artifacts', 'transcript.ndjson'), '{"line":1}\n{"line":2}\n');

    const result = await preserveArtifacts({ workspaceRootPath: path, destination });

    expect(result).toMatchObject({ preserved: true, files: 1 });
    expect(result.bytes).toBeGreaterThan(0);
    expect(await readdir(destination)).toEqual(['transcript.ndjson']);
  });

  it('reports absence rather than throwing when there is no artifacts directory', async () => {
    const { root, ids } = await fixture();

    const result = await preserveArtifacts({
      workspaceRootPath: workspacePath(root, ids),
      destination: join(root, 'store'),
    });

    expect(result).toEqual({ preserved: false, files: 0, bytes: 0 });
  });
});
