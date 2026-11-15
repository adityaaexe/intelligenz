import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  buildChangeManifest,
  evidencePath,
  manifestCounts,
  serialiseManifest,
  takeWorkspaceSnapshot,
  type WorkspaceHandle,
  type WorkspaceSnapshot,
} from '@intelligenz/workspace-manager';

import { workerLogger } from '../log';
import {
  CHANGE_MANIFEST_KIND,
  CHANGE_MANIFEST_MEDIA_TYPE,
  EVIDENCE_SOURCE_HOST_SNAPSHOT,
  type EvidenceSummary,
  type InitialEvidence,
} from '../shared/evidence';

/**
 * Re-exported so the capture sites import one module, and the type-only module stays the
 * single definition. `shared/evidence.ts` exists because the workflow imports
 * `shared/contracts.ts` and must not reach anything that reads a file.
 */
export type { EvidenceSummary, InitialEvidence };
export { CHANGE_MANIFEST_KIND, CHANGE_MANIFEST_MEDIA_TYPE, EVIDENCE_SOURCE_HOST_SNAPSHOT };
export { EVIDENCE_SOURCE_GIT_IN_SANDBOX } from '../shared/evidence';

/**
 * Host-owned evidence for one attempt.
 *
 * ## The rule this module implements
 *
 * **The agent must not control the evidence used to judge what it changed.** Before this
 * module, it did. The patch an approver read was `git diff` against a repository the agent
 * could write, and three ordinary operations made that patch empty for a fully rewritten
 * tree:
 *
 * - `git add -A` — `git diff` is index↔worktree, so staging empties it;
 * - a `.gitattributes` `clean` filter — `--no-textconv` governs textconv, not filters;
 * - `git add && git commit` — status and diff both empty, content entirely different.
 *
 * The third is not a tampering signal, it is a confident **negative**: "nothing changed"
 * while nothing is the same. So the authority became a host walk (`takeWorkspaceSnapshot`)
 * and its comparison (`buildChangeManifest`), and this module is the only thing that
 * writes those bytes.
 *
 * ## Where the bytes live, and why
 *
 * `<workspaceId>/evidence/`, a sibling of `repo/` and `artifacts/`. The sandbox binds
 * exactly one host directory — `<rootPath>/repo` at `/workspace` (`sandbox.ts`) — so
 * `evidence/` is not on the mount table and the agent cannot read, write, or overwrite its
 * own report. A test asserts that from inside a real sandbox.
 *
 * `cleanup` preserves it the way it preserves `artifacts/`; without that, the digests would
 * outlive the bytes they describe.
 *
 * ## Two snapshots, one manifest
 *
 * The baseline is taken **immediately after the lease is granted** and before the cgroup,
 * the heartbeat, `markExecuting` and `runtime.execute` — before anything the agent can
 * reach. A baseline taken later is not a baseline. Reused workspaces are expected: this is
 * a per-attempt baseline, so a previous attempt's changes correctly appear as pre-existing.
 *
 * The final snapshot is taken as soon as `runtime.execute` returns, on the success, failure
 * and cancellation paths, and the manifest is the comparison. Capture never throws into the
 * attempt: a run that produced a result must not be failed by evidence bookkeeping, and an
 * *absent* manifest is an honest "no claim" where an empty one would be a lying claim.
 */

export const INITIAL_SNAPSHOT_FILE = 'initial-snapshot.json';
export const FINAL_SNAPSHOT_FILE = 'final-snapshot.json';
export const CHANGE_MANIFEST_FILE = 'change-manifest.json';

/**
 * A snapshot file carries its own digest beside the body.
 *
 * The body's digest deliberately excludes `capturedAt` (see `serialiseSnapshot`), so an
 * unchanged tree has an unchanged digest — which is what makes "nothing changed" a fact
 * rather than an inference. The timestamp therefore has to live outside the digested body,
 * and this envelope is where.
 */
interface SnapshotFile {
  readonly kind: 'workspace-snapshot';
  readonly capturedAt: string;
  readonly digest: string;
  readonly snapshot: unknown;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Check the manifest the worker says it wrote against the bytes that are actually there.
 *
 * This is not distrust of `executeAgentActivity` — it is the only place the claim and the
 * bytes meet. A truncated write, a full disk, an operator's `mv`, or a persist retry that
 * runs after someone edited the file all look identical from the row: a digest that
 * happened to be true once. Refusing to write a claim we cannot re-derive keeps
 * `Artifact.checksum` meaning what it says.
 *
 * Returns a reason rather than throwing so the caller can decide the error code.
 */
export async function verifyManifestFile(evidence: EvidenceSummary): Promise<string | null> {
  if (evidence.kind !== CHANGE_MANIFEST_KIND) {
    return `evidence.kind is ${String(evidence.kind)}, not ${CHANGE_MANIFEST_KIND}`;
  }

  if (evidence.evidenceSource !== EVIDENCE_SOURCE_HOST_SNAPSHOT) {
    return `evidence.evidenceSource is ${String(evidence.evidenceSource)}`;
  }

  // The file *is* the canonical body, so the two hashes must be the same value. A
  // disagreement means one of them is not describing these bytes.
  if (evidence.artifact.checksum !== evidence.manifestDigest) {
    return 'artifact checksum and manifest digest disagree';
  }

  let bytes: Buffer;

  try {
    bytes = await readFile(evidence.artifact.uri);
  } catch (error) {
    return `manifest is unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }

  if (bytes.byteLength !== evidence.artifact.sizeBytes) {
    return `manifest is ${String(bytes.byteLength)} bytes, not ${String(evidence.artifact.sizeBytes)}`;
  }

  const actual = sha256(bytes);

  return actual === evidence.manifestDigest
    ? null
    : `manifest hashes to ${actual}, not ${evidence.manifestDigest}`;
}


async function ensureEvidenceDirectory(handle: WorkspaceHandle): Promise<string> {
  const directory = evidencePath(handle.rootPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  return directory;
}

async function writeSnapshotFile(
  directory: string,
  file: string,
  snapshot: WorkspaceSnapshot,
): Promise<void> {
  const body: SnapshotFile = {
    kind: 'workspace-snapshot',
    capturedAt: snapshot.capturedAt,
    digest: snapshot.digest,
    snapshot: JSON.parse(JSON.stringify(snapshot)),
  };

  await writeFile(join(directory, file), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Take the baseline.
 *
 * Returns `null` if the tree cannot be described (a missing checkout, a permission refusal).
 * The attempt continues: no manifest is an honest absence, and failing a run because a
 * directory read failed would make the evidence path a new availability risk. The caller
 * logs the gap and the eventual summary is simply missing.
 */
export async function captureInitialEvidence(
  handle: WorkspaceHandle,
  options: { readonly maxEntries?: number; readonly maxTotalBytes?: number } = {},
): Promise<InitialEvidence | null> {
  try {
    const snapshot = await takeWorkspaceSnapshot(handle.repoPath, {
      ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
      ...(options.maxTotalBytes === undefined ? {} : { maxTotalBytes: options.maxTotalBytes }),
    });

    const directory = await ensureEvidenceDirectory(handle);
    await writeSnapshotFile(directory, INITIAL_SNAPSHOT_FILE, snapshot);

    return { snapshot, digest: snapshot.digest, capturedAt: snapshot.capturedAt };
  } catch (error) {
    workerLogger().warn(
      {
        workspaceId: handle.id,
        reason: error instanceof Error ? error.message : String(error),
      },
      'Initial workspace snapshot failed; this attempt will have no change manifest',
    );

    return null;
  }
}

/**
 * Take the final snapshot and build the manifest.
 *
 * `checksum` of the returned artifact is the manifest's own digest, because the file
 * written is exactly the canonical body `serialiseManifest` produces. One hash, not two:
 * a reviewer who recomputes `checksum` from the bytes on disk has verified the content,
 * the ordering, the counts and both snapshot digests at once.
 */
export async function captureFinalEvidence(input: {
  readonly handle: WorkspaceHandle;
  readonly initial: InitialEvidence | null;
  readonly maxChanges?: number;
}): Promise<EvidenceSummary | null> {
  try {
    const finalSnapshot = await takeWorkspaceSnapshot(input.handle.repoPath);
    const directory = await ensureEvidenceDirectory(input.handle);
    await writeSnapshotFile(directory, FINAL_SNAPSHOT_FILE, finalSnapshot);

    if (input.initial === null) {
      // A final snapshot without a baseline answers "what is there", not "what changed".
      // Recorded on disk for forensics, never dressed up as a manifest.
      return null;
    }

    const manifest = buildChangeManifest({
      initial: input.initial.snapshot,
      final: finalSnapshot,
      ...(input.maxChanges === undefined ? {} : { maxChanges: input.maxChanges }),
    });

    const body = Buffer.from(serialiseManifest(manifest), 'utf8');
    const uri = join(directory, CHANGE_MANIFEST_FILE);

    await writeFile(uri, body, { mode: 0o600 });

    return {
      kind: CHANGE_MANIFEST_KIND,
      manifestDigest: manifest.digest,
      initialManifestDigest: input.initial.digest,
      finalManifestDigest: finalSnapshot.digest,
      evidenceSource: EVIDENCE_SOURCE_HOST_SNAPSHOT,
      authoritative: manifest.complete,
      complete: manifest.complete,
      stopReason: manifest.stopReason,
      changeCount: manifest.changeCount,
      counts: manifestCounts(manifest),
      artifact: {
        kind: CHANGE_MANIFEST_KIND,
        uri,
        // Equal by construction: the file *is* the canonical body.
        checksum: sha256(body),
        sizeBytes: body.byteLength,
        mediaType: CHANGE_MANIFEST_MEDIA_TYPE,
      },
    };
  } catch (error) {
    workerLogger().warn(
      {
        workspaceId: input.handle.id,
        reason: error instanceof Error ? error.message : String(error),
      },
      'Final workspace snapshot failed; this attempt will have no change manifest',
    );

    return null;
  }
}
