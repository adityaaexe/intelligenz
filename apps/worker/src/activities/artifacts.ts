import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';

import {
  boundedCopyFile,
  type TruncationMarker,
  withArtifactBudget,
} from '@intelligenz/workspace-manager';
import type { ArtifactReference } from '@intelligenz/agent-runtime';

/**
 * Artifact materialisation.
 *
 * The adapter writes its output next to the run (a scratch directory owned by the
 * adapter). The platform's evidence, however, must live in one place per workspace:
 * `<rootPath>/artifacts`, the directory `workspace-manager.cleanup({ keepArtifacts:
 * true })` refuses to delete. This module copies each referenced file there, computes
 * its SHA-256 from the bytes it actually writes, and returns references that point at the
 * durable location.
 *
 * Why re-hash instead of trusting the adapter's checksum: the adapter computed it before
 * the copy. A copy that silently truncated would otherwise carry a checksum that no
 * longer matches the bytes on disk — the exact failure an artifact checksum exists to
 * catch.
 *
 * ## The ceiling (Gate E)
 *
 * `outputCapBytes` is the **sum** of bytes an attempt may leave behind. Phase 4 declared
 * it and read it nowhere, which made "5 MiB of evidence" a comment. Two limits apply
 * here, and they are different:
 *
 * - **`maxArtifactBytes`** — one file's guard (64 MiB), unchanged from Phase 3.
 * - **`outputCapBytes`** — the profile's ceiling, shared across every artifact through an
 *   `ArtifactBudget`. A 2 GiB `diff.patch` an adapter claims to have produced is not
 *   evidence, it is a denial of service against the artifact store.
 *
 * The copy is **streamed**, so a huge source costs a fixed 64 KiB buffer rather than its
 * own size in the worker's heap. Truncation is recorded twice: a marker appended inline
 * for text media (where it cannot be mistaken for content), and a
 * `<name>.truncation.json` sidecar for every kind, including binary ones.
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

/** Media types whose bytes are text, and can therefore carry an inline marker. */
function isTextual(mediaType: string | undefined, kind: string): boolean {
  if (mediaType !== undefined) {
    return (
      mediaType.startsWith('text/') ||
      mediaType.includes('json') ||
      mediaType.includes('xml') ||
      mediaType.includes('yaml')
    );
  }

  return kind === 'transcript' || kind === 'diff' || kind === 'report';
}

export interface ArtifactTruncation {
  readonly kind: string;
  readonly uri: string;
  readonly originalBytes: number;
  readonly capturedBytes: number;
  readonly markerPath: string | null;
  readonly marker: TruncationMarker;
}

export interface MaterializeResult {
  /** References rewritten to point inside `<rootPath>/artifacts`. */
  readonly artifacts: ArtifactReference[];
  /** Kinds whose source file could not be copied; the original reference is kept. */
  readonly missing: readonly string[];
  /** Absolute path of the durable transcript, when one was materialised. */
  readonly transcriptPath: string | null;
  /** Artifacts that were written but clipped at the profile's ceiling. */
  readonly truncated: readonly ArtifactTruncation[];
  /** True when the shared ceiling ran out and at least one artifact got nothing. */
  readonly budgetExhausted: boolean;
  /** Total bytes written across every artifact, for the attempt log. */
  readonly totalBytes: number;
}

export async function materializeArtifacts(input: {
  readonly artifactsDirectory: string;
  readonly artifacts: readonly ArtifactReference[];
  /**
   * The profile's `outputCapBytes`: the **sum** allowed across every artifact.
   * Omitted means "the per-file guard only", which is the Phase 3 behaviour and is only
   * correct for callers that are not an agent attempt.
   */
  readonly outputCapBytes?: number;
  /** Per-file guard override, mainly for tests. */
  readonly maxArtifactBytes?: number;
}): Promise<MaterializeResult> {
  await mkdir(input.artifactsDirectory, { recursive: true, mode: 0o700 });

  const perFileMax = input.maxArtifactBytes ?? MAX_ARTIFACT_BYTES;
  const budget =
    input.outputCapBytes === undefined ? undefined : withArtifactBudget(input.outputCapBytes);

  const used = new Set<string>();
  const artifacts: ArtifactReference[] = [];
  const missing: string[] = [];
  const truncated: ArtifactTruncation[] = [];
  let transcriptPath: string | null = null;
  let totalBytes = 0;
  let budgetExhausted = false;

  for (const artifact of input.artifacts) {
    const source = artifact.uri;

    if (!isAbsolute(source)) {
      missing.push(artifact.kind);
      artifacts.push(artifact);
      continue;
    }

    let size: number;

    try {
      const info = await stat(source);
      if (!info.isFile() || info.size > perFileMax) {
        missing.push(artifact.kind);
        artifacts.push(artifact);
        continue;
      }

      size = info.size;
    } catch {
      missing.push(artifact.kind);
      artifacts.push(artifact);
      continue;
    }

    const destination = join(input.artifactsDirectory, uniqueName(artifact, used));
    const mediaType = artifact.mediaType ?? MEDIA_TYPES[artifact.kind];

    // The allocation is `min(this file, what is left of the profile's ceiling)`. Zero
    // means the evidence budget is gone: the artifact is not written at all, which is
    // recorded rather than silently producing an empty file that looks real.
    const allowance = budget === undefined ? size : budget.allocate(size);

    if (allowance === 0) {
      budgetExhausted = true;
      missing.push(artifact.kind);
      artifacts.push(artifact);
      continue;
    }

    const copy = await boundedCopyFile({
      source,
      destination,
      capBytes: allowance,
      scope: `artifact:${artifact.kind}`,
      inlineMarker: isTextual(mediaType, artifact.kind),
    });

    budget?.commit(copy.capturedBytes);
    totalBytes += copy.capturedBytes;

    if (copy.truncated) {
      budgetExhausted = true;

      if (copy.marker !== null) {
        truncated.push({
          kind: artifact.kind,
          uri: destination,
          originalBytes: copy.originalBytes,
          capturedBytes: copy.capturedBytes,
          markerPath: copy.markerPath,
          marker: copy.marker,
        });
      }
    }

    artifacts.push({
      kind: artifact.kind,
      uri: destination,
      checksum: copy.sha256,
      sizeBytes: copy.capturedBytes,
      ...(mediaType === undefined ? {} : { mediaType }),
    });

    if (artifact.kind === 'transcript') transcriptPath = destination;
  }

  return {
    artifacts,
    missing,
    transcriptPath,
    truncated,
    budgetExhausted,
    totalBytes,
  };
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

/** Write a small derived file (a summary, a count) inside the artifacts directory. */
export async function writeArtifactFile(
  directory: string,
  name: string,
  body: string,
): Promise<string> {
  const destination = join(directory, name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(destination, body, { mode: 0o600 });

  return destination;
}
