/**
 * Observing a workspace as the run left it.
 *
 * "Changed" always means *changed relative to the fixture's base commit*, not relative
 * to `HEAD`. An agent that commits its work is ordinary; an agent that commits its work
 * and is then measured as having changed nothing is a measurement bug that would award
 * full diff-quality credit to a large unintended refactor.
 */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { git, listFiles, sha256Bytes, sha256File } from './exec';
import type { ArtifactHash } from './types';

export interface ChangedFile {
  readonly path: string;
  readonly absolute: string;
  readonly status: 'added' | 'modified' | 'deleted';
}

function lines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('.git/'));
}

/**
 * Files added, modified or deleted since `baseCommit`, tracked or not.
 *
 * `git diff --name-only <base>` compares the working tree to the base commit and
 * therefore already covers staged and unstaged edits to tracked files; `ls-files
 * --others` adds the untracked ones. Both are needed: a fix written into a new file and
 * a fix written into an existing one are equally changed.
 */
export async function changedFiles(
  workspace: string,
  baseCommit: string,
): Promise<readonly ChangedFile[]> {
  const all = lines(
    await git(['diff', '--name-only', '--no-renames', baseCommit, '--'], workspace),
  );
  const untracked = lines(await git(['ls-files', '--others', '--exclude-standard'], workspace));
  const deleted = new Set(
    lines(await git(['diff', '--name-only', '--no-renames', '--diff-filter=D', baseCommit, '--'], workspace)),
  );

  const modified = new Set(all);
  const paths = new Set<string>([...all, ...untracked]);

  const changed: ChangedFile[] = [];
  for (const path of [...paths].sort()) {
    changed.push({
      path,
      absolute: join(workspace, path),
      status: deleted.has(path) ? 'deleted' : modified.has(path) ? 'modified' : 'added',
    });
  }

  return changed;
}

/** A hash per changed file, capped so a pathological run cannot bloat the ledger. */
export async function hashChangedFiles(
  changed: readonly ChangedFile[],
  limit = 200,
): Promise<{ hashes: readonly ArtifactHash[]; truncated: boolean }> {
  const hashes: ArtifactHash[] = [];
  let truncated = false;

  for (const file of changed) {
    if (hashes.length >= limit) {
      truncated = true;
      break;
    }

    if (file.status === 'deleted') continue;

    const digest = await sha256File(file.absolute);
    if (digest === null) continue;

    const bytes = await stat(file.absolute)
      .then((value) => value.size)
      .catch(() => 0);

    hashes.push({ path: file.path, sha256: digest, bytes });
  }

  return { hashes, truncated };
}

/** A single digest over a change set: sorted `path\0sha256` pairs. */
export function changeSetDigest(hashes: readonly ArtifactHash[]): string {
  const canonical = [...hashes]
    .map((entry) => `${entry.path}\u0000${entry.sha256}`)
    .sort()
    .join('\n');
  return sha256Bytes(canonical);
}

/** Every regular file under `root`, with digests. Used for adapter-written artifacts. */
export async function hashTree(
  root: string,
  limit = 200,
): Promise<{ hashes: readonly ArtifactHash[]; truncated: boolean }> {
  const listing = await listFiles(root, { skipDotGit: true, limit });
  const hashes: ArtifactHash[] = [];

  for (const file of listing.files.slice(0, limit)) {
    const digest = await sha256File(file.absolute);
    if (digest === null) continue;
    hashes.push({ path: file.path, sha256: digest, bytes: file.bytes });
  }

  return { hashes, truncated: listing.truncated };
}
