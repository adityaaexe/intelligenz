import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';

import type { ArtifactReference } from '@intelligenz/agent-runtime';

/**
 * Artifact materialisation.
 *
 * The adapter writes its output next to the run (a scratch directory owned by the
 * adapter). The platform's evidence, however, must live in one place per workspace:
 * `<rootPath>/artifacts`, the directory `workspace-manager.cleanup({ keepArtifacts:
 * true })` refuses to delete. This module writes each referenced file there,
 * recomputes its SHA-256 from the bytes it writes, and returns references that point
 * at the durable location.
 *
 * Why re-hash instead of trusting the adapter's checksum: the adapter computed it
 * before the copy. A copy that silently truncated would otherwise carry a checksum
 * that no longer matches the bytes on disk — the exact failure an artifact checksum
 * exists to catch.
 *
 * ## What it will not do
 *
 * - **No overwrite of a different artifact.** Two artifacts of the same kind get
 *   `-2`, `-3` suffixes rather than one silently replacing the other.
 * - **No failure on a missing source.** An adapter that references a file it did not
 *   write is a bug, but discarding a successful run's other evidence because of it is
 *   worse. The reference is kept as-is and the caller records the gap.
 */

/** A single artifact is evidence, not a dataset. 64 MiB is a guard, not a policy. */
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

const CANONICAL_NAMES: Readonly<Record<string, string>> = {
  transcript: 'transcript.ndjson',
  diff: 'diff.patch',
  report: 'report.md',
};

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  transcript: 'application/x-ndjson',
  diff: 'text/x-diff',
  report: 'text/markdown; charset=utf-8',
};

export interface MaterializeResult {
  /** References rewritten to point inside `<rootPath>/artifacts`. */
  readonly artifacts: ArtifactReference[];
  /** Kinds whose source file could not be copied; the original reference is kept. */
  readonly missing: readonly string[];
  /** Absolute path of the durable transcript, when one was materialised. */
  readonly transcriptPath: string | null;
}

export async function materializeArtifacts(input: {
  readonly artifactsDirectory: string;
  readonly artifacts: readonly ArtifactReference[];
}): Promise<MaterializeResult> {
  await mkdir(input.artifactsDirectory, { recursive: true, mode: 0o700 });

  const used = new Set<string>();
  const artifacts: ArtifactReference[] = [];
  const missing: string[] = [];
  let transcriptPath: string | null = null;

  for (const artifact of input.artifacts) {
    const source = artifact.uri;

    if (!isAbsolute(source)) {
      missing.push(artifact.kind);
      artifacts.push(artifact);
      continue;
    }

    let bytes: Buffer;

    try {
      const info = await stat(source);
      if (!info.isFile() || info.size > MAX_ARTIFACT_BYTES) {
        missing.push(artifact.kind);
        artifacts.push(artifact);
        continue;
      }

      bytes = await readFile(source);
    } catch {
      missing.push(artifact.kind);
      artifacts.push(artifact);
      continue;
    }

    const destination = join(input.artifactsDirectory, uniqueName(artifact, used));

    // 0600: evidence is readable by the worker and its operators, not by every local
    // account. The directory is 0700 for the same reason.
    await writeFile(destination, bytes, { mode: 0o600 });

    const mediaType = artifact.mediaType ?? MEDIA_TYPES[artifact.kind];

    artifacts.push({
      kind: artifact.kind,
      uri: destination,
      checksum: sha256(bytes),
      sizeBytes: bytes.byteLength,
      ...(mediaType === undefined ? {} : { mediaType }),
    });

    if (artifact.kind === 'transcript') transcriptPath = destination;
  }

  return { artifacts, missing, transcriptPath };
}

/** The canonical name first, then `-2`, `-3` for a second artifact of the same kind. */
function uniqueName(artifact: ArtifactReference, used: Set<string>): string {
  const base = CANONICAL_NAMES[artifact.kind] ?? fallbackName(artifact);
  const extension = extname(base);
  const stem = extension.length === 0 ? base : base.slice(0, base.length - extension.length);

  let candidate = base;
  let index = 2;

  while (used.has(candidate)) {
    candidate = `${stem}-${String(index)}${extension}`;
    index += 1;
  }

  used.add(candidate);

  return candidate;
}

function fallbackName(artifact: ArtifactReference): string {
  const safeKind = artifact.kind.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40) || 'artifact';
  const extension = extname(basename(artifact.uri));

  return `${safeKind}${extension.length > 0 && extension.length <= 8 ? extension : '.bin'}`;
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
