import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Artifact path resolution and integrity.
 *
 * An `Artifact.uri` in the database is an **absolute host path** written by the
 * worker. Two things follow from that, and both are security rules rather than
 * formatting preferences:
 *
 * 1. **A client never receives the stored value.** The wire `uri` is relative to the
 *    artifact root that stores the bytes. A host path names a filesystem layout —
 *    usernames, mount points, tenant directory names — that a caller has no business
 *    learning from an error message or a JSON field.
 * 2. **A read is contained.** The value comes from our own writer, but "our own
 *    writer" is not a proof against a bad row, a restored backup, or a future code
 *    path. Every read resolves the path and asserts it is under one of the configured
 *    roots **after symlink resolution**, so a link inside a workspace cannot be used
 *    to serve `/etc/passwd`.
 *
 * The roots are the two places the worker writes evidence:
 *
 * | Root | What lives there |
 * |---|---|
 * | `ARTIFACT_ROOT` | simulated runs' reports, per-tenant directories |
 * | `WORKSPACE_ROOT` | a real run's `<workspace>/artifacts/{transcript,diff}` |
 */

/**
 * Injection token for the locator. Declared beside the interface rather than in the
 * module so `ArtifactsService` and `ExecutionsService` can import it without importing
 * the module that provides them (a cycle whose only symptom is an `undefined` token).
 */
export const ARTIFACT_LOCATOR = Symbol('ARTIFACT_LOCATOR');

export interface ArtifactResolution {
  /** Canonical absolute path (`realpath` when the file exists). */
  readonly absolutePath: string;
  /** Safe, client-facing path: relative to `root`, posix separators. */
  readonly logicalUri: string;
  readonly root: string;
}

export type ArtifactIntegrity = 'verified' | 'failed' | 'unknown';

export interface ArtifactLocator {
  readonly roots: readonly string[];
  /**
   * `undefined` when the stored value resolves outside every configured root. The
   * caller turns that into a 404 — never into "here is the absolute path, decide for
   * yourself".
   */
  resolve(uri: string): Promise<ArtifactResolution | undefined>;
  /** Synchronous best effort for list responses; never returns an absolute path. */
  logicalUri(uri: string): string;
}

export function createArtifactLocator(roots: readonly string[]): ArtifactLocator {
  const resolvedRoots = dedupe(roots.map((root) => resolve(root)));

  function match(absolute: string): { root: string; relativePath: string } | undefined {
    for (const root of resolvedRoots) {
      if (!isContained(root, absolute)) continue;

      return { root, relativePath: relative(root, absolute) };
    }

    return undefined;
  }

  return {
    roots: resolvedRoots,

    async resolve(uri: string): Promise<ArtifactResolution | undefined> {
      for (const root of resolvedRoots) {
        const absolute = isAbsolute(uri) ? resolve(uri) : resolve(root, uri);
        if (!isContained(root, absolute)) continue;

        // `realpath` follows every symlink. A file that exists must resolve inside the
        // root too; a file that does not exist is reported as missing later, but its
        // parent must still be contained so a symlinked directory cannot be used to
        // probe the host through 410-vs-404.
        try {
          const canonical = await realpath(absolute);

          if (!isContained(root, canonical)) return undefined;

          return {
            absolutePath: canonical,
            logicalUri: toLogical(root, canonical),
            root,
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;

          const parent = dirname(absolute);

          try {
            const canonicalParent = await realpath(parent);
            if (!isContained(root, canonicalParent)) return undefined;
          } catch {
            // The parent is missing too: the path cannot be a symlink yet, and the
            // containment check above already ran on the resolved string.
          }

          return {
            absolutePath: absolute,
            logicalUri: toLogical(root, absolute),
            root,
          };
        }
      }

      return undefined;
    },

    logicalUri(uri: string): string {
      const absolute = isAbsolute(uri) ? resolve(uri) : undefined;
      const matched = absolute === undefined ? undefined : match(absolute);

      if (matched !== undefined) return toLogical(matched.root, absolute as string);

      // Not under a configured root. Returning the stored value would leak the layout;
      // returning the basename alone would suggest it is servable. `external/` says
      // both things honestly.
      return `external/${basename(uri)}`;
    },
  };
}

/**
 * Computes integrity by reading the bytes, never by trusting the column.
 *
 * - `unknown`: the file could not be read (gone, moved artifact root, permissions).
 * - `failed`: bytes exist and disagree with the stored digest.
 * - `verified`: bytes exist and match.
 */
export async function verifyArtifact(
  resolution: ArtifactResolution | undefined,
  expectedChecksum: string,
): Promise<{ integrity: ArtifactIntegrity; sizeBytes: number | null }> {
  if (resolution === undefined) return { integrity: 'unknown', sizeBytes: null };

  try {
    const info = await stat(resolution.absolutePath);
    if (!info.isFile()) return { integrity: 'unknown', sizeBytes: null };

    const digest = await hashFile(resolution.absolutePath);

    return {
      integrity: digest === expectedChecksum.toLowerCase() ? 'verified' : 'failed',
      sizeBytes: info.size,
    };
  } catch {
    return { integrity: 'unknown', sizeBytes: null };
  }
}

/** Streaming, so a large transcript is hashed without being buffered whole. */
export function hashFile(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);

    stream.on('error', reject);
    stream.on('data', (chunk: string | Buffer) => {
      hash.update(chunk);
    });
    stream.on('end', () => {
      resolvePromise(hash.digest('hex'));
    });
  });
}

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  transcript: 'application/x-ndjson',
  diff: 'text/x-diff',
  report: 'text/markdown; charset=utf-8',
  patch: 'text/x-diff',
  'change-manifest': 'application/json',
};

export function mediaTypeForArtifact(kind: string): string {
  return MEDIA_TYPES[kind] ?? 'application/octet-stream';
}

function toLogical(root: string, absolute: string): string {
  const offset = relative(root, absolute);

  return (offset.length === 0 ? basename(absolute) : offset).split(sep).join('/');
}

function isContained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
