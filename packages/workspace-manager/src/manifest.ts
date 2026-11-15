import { createHash } from 'node:crypto';

import { SnapshotError } from './errors';
import type { SnapshotEntry, SnapshotEntryKind, WorkspaceSnapshot } from './snapshot';

/**
 * The change manifest: what actually differs between two host snapshots.
 *
 * This replaces `git diff` as *authority*. It is a comparison of two observations, not an
 * interpretation of a repository, so there is no configuration inside the workspace that
 * can change its answer:
 *
 * | Attack | `git diff` hunks | this manifest |
 * |---|---|---|
 * | `git add -A` (staged, nothing else) | 0 | `modified`, before/after digests |
 * | `.gitattributes` `clean` filter | 0 | `modified`, of the bytes on disk |
 * | `git add` + `git commit` | 0 | `modified` for every changed file |
 *
 * The third row is why this exists. Staging and committing leave `git diff` empty while
 * changing every byte of the tree; an approver reading that patch is told "nothing
 * happened" by a command that is not lying about anything it was asked. A snapshot pair
 * has no such blind spot, because it never asks the repository what changed.
 *
 * ## One status per path, and why
 *
 * A file can be both rewritten and re-chmodded. Emitting two rows for one path would make
 * "how many files changed" ambiguous, so each path gets one status by precedence:
 * `added`/`deleted` (structural) beat `symlink_retargeted`, which beats `modified`, which
 * beats `mode_changed`. The losing fact is not discarded — `before`/`after` carry the mode
 * and the digest, so a reader can see a rewrite *and* a chmod in one row.
 */

/** The `maxChanges` default. A manifest that lists 20,000 paths is already unreadable. */
export const DEFAULT_MAX_CHANGES = 20_000;

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'mode_changed' | 'symlink_retargeted';

/** The facts about one side of a change, sufficient to re-check it. */
export interface EntryFingerprint {
  readonly kind: SnapshotEntryKind;
  readonly mode: number;
  readonly sizeBytes: number;
  readonly sha256: string | null;
  readonly symlinkTarget: string | null;
}

export interface ChangeEntry {
  /** Relative POSIX path, byte-sorted within the manifest. */
  readonly path: string;
  readonly status: ChangeStatus;
  /** `null` when the path did not exist before (an addition). */
  readonly before: EntryFingerprint | null;
  /** `null` when the path does not exist after (a deletion). */
  readonly after: EntryFingerprint | null;
}

/** The half of the manifest that identifies which observation is being compared. */
export interface ManifestSide {
  readonly digest: string;
  readonly capturedAt: string;
  readonly complete: boolean;
  readonly entryCount: number;
  readonly totalBytes: number;
}

export type ManifestStopReason =
  | 'initial-incomplete'
  | 'final-incomplete'
  | 'max-changes'
  | null;

export interface ChangeManifest {
  readonly version: number;
  readonly root: string;
  readonly initial: ManifestSide;
  readonly final: ManifestSide;
  readonly changes: readonly ChangeEntry[];
  readonly changeCount: number;
  /**
   * False when either snapshot was truncated, or the change list hit `maxChanges`.
   *
   * An incomplete manifest is **not** authority. The artifact is still written — what was
   * seen is evidence — but `Artifact.authoritative` must be false, because "here are the
   * first 20,000 changes" and "here are the changes" are different claims and only one of
   * them is true.
   */
  readonly complete: boolean;
  readonly stopReason: ManifestStopReason;
  /** SHA-256 of `serialiseManifest(this)`. */
  readonly digest: string;
}

/** Bumped when the canonical form changes. */
export const MANIFEST_VERSION = 1;

function comparePathBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function fingerprint(entry: SnapshotEntry): EntryFingerprint {
  return {
    kind: entry.kind,
    mode: entry.mode,
    sizeBytes: entry.sizeBytes,
    sha256: entry.sha256,
    symlinkTarget: entry.symlinkTarget,
  };
}

function side(snapshot: WorkspaceSnapshot): ManifestSide {
  return {
    digest: snapshot.digest,
    capturedAt: snapshot.capturedAt,
    complete: snapshot.complete,
    entryCount: snapshot.entryCount,
    totalBytes: snapshot.totalBytes,
  };
}

/**
 * Compare one path's two descriptions.
 *
 * `undefined` means "this change is invisible here", which is a real outcome: a directory
 * whose contents changed has the same mode and no digest of its own, and reporting it as
 * `modified` would double-count every file beneath it.
 */
function compareEntry(before: SnapshotEntry, after: SnapshotEntry): ChangeStatus | undefined {
  if (before.kind !== after.kind) {
    // A file that became a symlink is a modification with a new kind, not two changes.
    return 'modified';
  }

  if (before.kind === 'symlink') {
    if (before.symlinkTarget !== after.symlinkTarget) return 'symlink_retargeted';
    if (before.mode !== after.mode) return 'mode_changed';
    return undefined;
  }

  if (before.kind === 'file') {
    // A rewrite wins over a chmod: it is the fact a reviewer must not miss.
    if (before.sha256 !== after.sha256) return 'modified';
    if (before.mode !== after.mode) return 'mode_changed';
    return undefined;
  }

  if (before.kind === 'dir' || before.kind === 'special') {
    if (before.mode !== after.mode) return 'mode_changed';
    return undefined;
  }

  return undefined;
}

/**
 * Build the manifest for one attempt.
 *
 * The two snapshots must describe the same root. Comparing different trees would produce a
 * manifest in which every path is simultaneously added and deleted — technically true and
 * completely useless, which is the failure mode this whole module exists to avoid.
 */
export function buildChangeManifest(input: {
  readonly initial: WorkspaceSnapshot;
  readonly final: WorkspaceSnapshot;
  readonly maxChanges?: number;
}): ChangeManifest {
  const { initial, final } = input;

  if (initial.root !== final.root) {
    throw new SnapshotError(
      'SNAPSHOT_INCOMPLETE',
      `Cannot compare snapshots of different roots: ${initial.root} and ${final.root}`,
    );
  }

  const maxChanges = input.maxChanges ?? DEFAULT_MAX_CHANGES;

  if (!Number.isInteger(maxChanges) || maxChanges <= 0) {
    throw new SnapshotError('SNAPSHOT_LIMITS_INVALID', 'maxChanges must be a positive integer');
  }

  const before = new Map(initial.entries.map((entry) => [entry.path, entry]));
  const after = new Map(final.entries.map((entry) => [entry.path, entry]));

  const paths = [...new Set([...before.keys(), ...after.keys()])].sort(comparePathBytes);

  const changes: ChangeEntry[] = [];
  let stopReason: ManifestStopReason = null;

  for (const path of paths) {
    if (changes.length >= maxChanges) {
      stopReason = 'max-changes';
      break;
    }

    const left = before.get(path);
    const right = after.get(path);

    if (left === undefined && right === undefined) continue;

    if (left === undefined && right !== undefined) {
      changes.push({ path, status: 'added', before: null, after: fingerprint(right) });
      continue;
    }

    if (left !== undefined && right === undefined) {
      changes.push({ path, status: 'deleted', before: fingerprint(left), after: null });
      continue;
    }

    if (left === undefined || right === undefined) continue;

    const status = compareEntry(left, right);
    if (status !== undefined) {
      changes.push({ path, status, before: fingerprint(left), after: fingerprint(right) });
    }
  }

  if (stopReason === null) {
    if (!initial.complete) stopReason = 'initial-incomplete';
    else if (!final.complete) stopReason = 'final-incomplete';
  }

  const body = {
    version: MANIFEST_VERSION,
    root: initial.root,
    initial: side(initial),
    final: side(final),
    changes,
    changeCount: changes.length,
    complete: stopReason === null,
    stopReason,
  };

  return { ...body, digest: manifestDigest(body) };
}

/** The subset a manifest's digest covers. */
export interface ManifestDigestInput {
  readonly version: number;
  readonly root: string;
  readonly initial: ManifestSide;
  readonly final: ManifestSide;
  readonly changes: readonly ChangeEntry[];
  readonly changeCount: number;
  readonly complete: boolean;
  readonly stopReason: ManifestStopReason;
}

/**
 * The one deterministic form of a manifest.
 *
 * A verifier re-derives the digest from the parsed artifact body. Editing a single
 * `before.sha256`, or swapping a status, changes the body and therefore the digest, which
 * is compared against both the stored column and the artifact's content checksum. Content
 * and provenance cannot drift apart independently because both are covered.
 */
export function serialiseManifest(input: ManifestDigestInput): string {
  return JSON.stringify({
    version: input.version,
    root: input.root,
    initial: {
      digest: input.initial.digest,
      capturedAt: input.initial.capturedAt,
      complete: input.initial.complete,
      entryCount: input.initial.entryCount,
      totalBytes: input.initial.totalBytes,
    },
    final: {
      digest: input.final.digest,
      capturedAt: input.final.capturedAt,
      complete: input.final.complete,
      entryCount: input.final.entryCount,
      totalBytes: input.final.totalBytes,
    },
    changes: input.changes.map((change) => ({
      path: change.path,
      status: change.status,
      before:
        change.before === null
          ? null
          : {
              kind: change.before.kind,
              mode: change.before.mode,
              sizeBytes: change.before.sizeBytes,
              sha256: change.before.sha256,
              symlinkTarget: change.before.symlinkTarget,
            },
      after:
        change.after === null
          ? null
          : {
              kind: change.after.kind,
              mode: change.after.mode,
              sizeBytes: change.after.sizeBytes,
              sha256: change.after.sha256,
              symlinkTarget: change.after.symlinkTarget,
            },
    })),
    changeCount: input.changeCount,
    complete: input.complete,
    stopReason: input.stopReason,
  });
}

/** SHA-256 of `serialiseManifest(input)`. */
export function manifestDigest(input: ManifestDigestInput): string {
  return createHash('sha256').update(serialiseManifest(input)).digest('hex');
}

/** Per-status counts, for the attempt log. Never used as a verdict. */
export function manifestCounts(manifest: ChangeManifest): Readonly<Record<ChangeStatus, number>> {
  const counts: Record<ChangeStatus, number> = {
    added: 0,
    modified: 0,
    deleted: 0,
    mode_changed: 0,
    symlink_retargeted: 0,
  };

  for (const change of manifest.changes) counts[change.status] += 1;

  return counts;
}
