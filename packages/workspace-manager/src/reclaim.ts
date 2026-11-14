import { cp, lstat, readdir, realpath, rm, rmdir } from 'node:fs/promises';
import { join, sep } from 'node:path';

import { ContainmentError, UnsafeSegmentError, WorkspaceError } from './errors';
import { artifactsPath, assertContained, safeSegment, workspacePath } from './paths';

/**
 * Reclaiming a workspace directory whose owner is gone.
 *
 * This is deliberately **not** part of `WorkspaceManager`: the manager holds in-memory
 * handles for workspaces it provisioned, and a reaper acts on rows whose process is
 * dead — there is no handle, no state machine instance and no `this`. What the reaper
 * needs is a *validated removal*, and validation is the whole difficulty:
 *
 *   1. The ids come from a database row, which may itself be wrong. They are re-validated
 *      as single path segments (`safeSegment`), so `../..` cannot be a task id.
 *   2. The path is **recomputed** from the ids. The row's `rootPath` is only a claim; it
 *      is used to check agreement, never as the thing to delete.
 *   3. Every component between the root and the workspace is `lstat`ed and refused if it
 *      is a symbolic link. `realpath` alone would follow the link and report a *resolved*
 *      path that happens to be inside the root — which is precisely how a symlinked
 *      `orgId` turns `rm -rf` into a host deletion.
 *   4. The resolved path must equal the resolved expected path and be inside the root.
 *   5. Only then is anything removed, and `artifacts/` survives by default.
 *
 * "Never delete on age alone" is enforced by the caller (the reaper requires an expired
 * lease and no live workflow); "never recursively delete an unvalidated path" is enforced
 * here.
 */

export interface ReclaimIds {
  readonly orgId: string;
  readonly taskId: string;
  readonly workspaceId: string;
}

export interface ReclaimRequest {
  /** `WORKSPACE_ROOT`, resolved to a real path. */
  readonly root: string;
  readonly ids: ReclaimIds;
  /** The row's `rootPath`. Compared against the recomputed path; never the target. */
  readonly recordedRootPath: string;
  readonly keepArtifacts?: boolean;
}

export interface ReclaimResult {
  /** Canonical path that was inspected. */
  readonly resolvedPath: string;
  /** True when the workspace directory itself is gone. */
  readonly removed: boolean;
  /** True when `<rootPath>/artifacts` was found and kept. */
  readonly artifactsKept: boolean;
  /** True when there was nothing to remove. Idempotent, not an error. */
  readonly alreadyAbsent: boolean;
}

export type ReclaimRefusal = 'symlinked_ancestor' | 'path_mismatch' | 'not_a_directory';

export class ReclaimRefusedError extends WorkspaceError {
  readonly refusal: ReclaimRefusal;
  readonly path: string;

  constructor(refusal: ReclaimRefusal, path: string, message: string) {
    super(
      refusal === 'path_mismatch' ? 'WORKSPACE_ESCAPE' : 'WORKSPACE_PATH_UNSAFE',
      `${message} (${refusal}: ${path})`,
    );
    this.name = 'ReclaimRefusedError';
    this.refusal = refusal;
    this.path = path;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuse any symbolic link between the root and the workspace.
 *
 * `realpath` is not enough: if `root/org-1` is a symlink to `/etc`, `realpath` says
 * `/etc/task/ws` and a containment check against `root` fails — good — but if the link
 * points *inside* the root (`root/org-1 -> root/other-org`) the check passes while the
 * reaper deletes someone else's workspace. Walking with `lstat` and rejecting links
 * closes both, and a legitimate workspace never has a symlinked component because
 * `provision()` creates real directories.
 */
async function assertNoSymlinkedAncestors(
  root: string,
  ids: ReclaimIds,
): Promise<{ root: string; taskDir: string; workspaceDir: string }> {
  const resolvedRoot = await realpath(root).catch(() => root);
  const segments = [ids.orgId, ids.taskId, ids.workspaceId];
  const walked: string[] = [];
  let current = resolvedRoot;

  for (const segment of segments) {
    current = join(current, segment);

    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Missing means nothing to delete; the caller treats it as already absent.
        walked.push(current);
        continue;
      }

      throw error;
    }

    if (stats.isSymbolicLink()) {
      throw new ReclaimRefusedError(
        'symlinked_ancestor',
        current,
        'Refusing to reclaim through a symbolic link',
      );
    }

    if (!stats.isDirectory()) {
      throw new ReclaimRefusedError(
        'not_a_directory',
        current,
        'Refusing to reclaim a path component that is not a directory',
      );
    }

    walked.push(current);
  }

  const workspaceDir = walked[2] ?? current;
  const taskDir = walked[1] ?? resolvedRoot;

  return { root: resolvedRoot, taskDir, workspaceDir };
}

/**
 * Validate, then remove. Throws on anything it cannot prove; returns a result otherwise.
 *
 * Throwing rather than returning a soft failure is deliberate: the reaper distinguishes
 * "could not prove containment" (quarantine) from "the `rm` failed" (retry), and those
 * must not look the same.
 */
export async function reclaimWorkspace(request: ReclaimRequest): Promise<ReclaimResult> {
  let ids: ReclaimIds;

  try {
    ids = {
      orgId: safeSegment(request.ids.orgId),
      taskId: safeSegment(request.ids.taskId),
      workspaceId: safeSegment(request.ids.workspaceId),
    };
  } catch (error) {
    if (error instanceof UnsafeSegmentError) {
      throw new ReclaimRefusedError('path_mismatch', error.value, error.message);
    }

    throw error;
  }

  const expected = workspacePath(request.root, ids);
  const walked = await assertNoSymlinkedAncestors(request.root, ids);

  // Containment on the *bytes the kernel would open*, against the real root.
  const resolvedExpected = await assertContained(walked.root, expected);

  if (resolvedExpected !== resolveRecorded(walked.root, request.recordedRootPath)) {
    throw new ReclaimRefusedError(
      'path_mismatch',
      request.recordedRootPath,
      `The row's rootPath does not match the path its ids derive (${resolvedExpected})`,
    );
  }

  if (!(await exists(resolvedExpected))) {
    return {
      resolvedPath: resolvedExpected,
      removed: true,
      artifactsKept: false,
      alreadyAbsent: true,
    };
  }

  const keepArtifacts = request.keepArtifacts ?? true;
  const artifacts = artifactsPath(resolvedExpected);
  const artifactsPresent = keepArtifacts && (await exists(artifacts));

  if (artifactsPresent) {
    for (const entry of await readdir(resolvedExpected)) {
      if (entry === 'artifacts') continue;

      await rm(join(resolvedExpected, entry), { recursive: true, force: true });
    }
  } else {
    await rm(resolvedExpected, { recursive: true, force: true });
  }

  // The parent directories are empty once the workspace is gone; leaving them behind
  // accumulates one directory per attempt forever. `rmdir` is non-recursive and fails on
  // a non-empty directory, which is exactly the guard wanted here: a sibling that still
  // exists stops the sweep.
  if (!artifactsPresent) {
    await rmdir(walked.taskDir).catch(() => undefined);
  }

  return {
    resolvedPath: resolvedExpected,
    removed: !artifactsPresent,
    artifactsKept: artifactsPresent,
    alreadyAbsent: false,
  };
}

/**
 * The row's `rootPath` compared as a resolved path. It may be relative to the root in an
 * older row, so a bare `resolve` is not enough; containment is checked by the caller.
 */
function resolveRecorded(root: string, recorded: string): string {
  if (recorded.length === 0) return '';
  if (recorded.startsWith(root + sep) || recorded === root) return recorded;

  return join(root, recorded);
}

/**
 * Copy `<workspace>/artifacts` into the artifact store before the directory is removed.
 *
 * The reaper's job is to reclaim bytes, but a run's evidence is the only thing that
 * explains what happened; deleting it to reclaim a few megabytes would destroy the
 * audit trail to save nothing. Copied, then the source is removed with the workspace.
 */
export async function preserveArtifacts(input: {
  readonly workspaceRootPath: string;
  readonly destination: string;
}): Promise<{ preserved: boolean; files: number; bytes: number }> {
  const source = artifactsPath(input.workspaceRootPath);

  if (!(await exists(source))) return { preserved: false, files: 0, bytes: 0 };

  await cp(source, input.destination, { recursive: true, force: true, dereference: false });

  let files = 0;
  let bytes = 0;

  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }

      files += 1;
      bytes += (await lstat(path)).size;
    }
  };

  await walk(input.destination);

  return { preserved: true, files, bytes };
}

/** Re-exported for callers that want the containment error type without a deep import. */
export { ContainmentError };
