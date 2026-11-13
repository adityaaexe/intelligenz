import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { ContainmentError, UnsafeSegmentError } from './errors';

/**
 * The filesystem boundary, expressed as three functions that are small enough to
 * audit and strict enough to be boring.
 *
 * Nothing in this file touches Prisma, a route handler, or an HTTP type. The ids it
 * receives come from a URL, so every one of them is treated as hostile input.
 */

/** One path segment: no separators, no dots, no NUL, 1–64 characters. */
const SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Validate a route-supplied id for use as a single path segment.
 *
 * The pattern is an allowlist, not a denylist: `.`, `..`, `a/b`, `a\b`, `C:`,
 * `\0` and every unicode confusable are rejected because none of them match.
 * Length is capped so a crafted id cannot exceed a filesystem's name limit and
 * turn a containment bug into an `ENAMETOOLONG` that is handled differently.
 */
export function safeSegment(value: unknown): string {
  if (typeof value !== 'string' || !SEGMENT_PATTERN.test(value)) {
    throw new UnsafeSegmentError(typeof value === 'string' ? value : String(value));
  }

  return value;
}

/**
 * Resolve `p` with `realpath`, following symlinks. When `p` does not exist yet, the
 * nearest existing ancestor is resolved and the remaining segments are appended
 * verbatim — appending does not re-enter the filesystem, so a component that does
 * not exist cannot be a symlink yet.
 */
async function realpathTolerant(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;

    const parent = dirname(p);
    if (parent === p) return p;

    return join(await realpathTolerant(parent), p.slice(parent.length + 1));
  }
}

/**
 * Assert that `candidate`, once symlinks are resolved, is `base` or inside it.
 *
 * Both sides go through `realpath`, so a symlink inside the workspace pointing at
 * `/etc/passwd` resolves to `/etc/passwd` and is rejected — the check is on the
 * bytes the kernel would open, not on the string a caller supplied.
 */
export async function assertContained(base: string, candidate: string): Promise<string> {
  const [resolvedBase, resolvedCandidate] = await Promise.all([
    realpathTolerant(base),
    realpathTolerant(candidate),
  ]);

  if (resolvedCandidate !== resolvedBase && !resolvedCandidate.startsWith(resolvedBase + sep)) {
    throw new ContainmentError(resolvedBase, resolvedCandidate);
  }

  return resolvedCandidate;
}

/** Synchronous variant, used where the caller cannot await (construction). */
export function assertContainedSync(base: string, candidate: string): string {
  const resolvedBase = realpathSync(base);
  const resolvedCandidate = realpathSync(candidate);

  if (resolvedCandidate !== resolvedBase && !resolvedCandidate.startsWith(resolvedBase + sep)) {
    throw new ContainmentError(resolvedBase, resolvedCandidate);
  }

  return resolvedCandidate;
}

/**
 * The workspace root: `WORKSPACE_ROOT`, default `.workspaces`, resolved to an
 * absolute real path **once** at construction. Resolving once means a symlinked or
 * relative root cannot change meaning halfway through a run.
 */
export function resolveWorkspaceRoot(root?: string): string {
  // A relative value is resolved against the process cwd exactly once. Everything
  // downstream sees an absolute path, so a later `chdir` cannot move the boundary.
  const configured = root ?? process.env.WORKSPACE_ROOT ?? '.workspaces';
  const absolute = resolve(configured);

  // `realpathSync` fails when the root does not exist yet; create-on-demand is the
  // manager's job, so fall back to the resolved path and let `provision` make it.
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** `<root>/<orgId>/<taskId>/<workspaceId>` — the only path layout this package knows. */
export function workspacePath(
  root: string,
  ids: { orgId: string; taskId: string; workspaceId: string },
): string {
  return join(root, safeSegment(ids.orgId), safeSegment(ids.taskId), safeSegment(ids.workspaceId));
}

/** The checkout a run may write into. Always inside `rootPath`. */
export function repositoryPath(rootPath: string): string {
  return join(rootPath, 'repo');
}

/** Where a run leaves evidence that survives `cleanup({ keepArtifacts: true })`. */
export function artifactsPath(rootPath: string): string {
  return join(rootPath, 'artifacts');
}
