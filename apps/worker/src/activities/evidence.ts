import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  buildChangeManifest,
  evidencePath,
  manifestCounts,
  manifestDigest,
  serialiseManifest,
  takeWorkspaceSnapshot,
  type ManifestDigestInput,
  type WorkspaceHandle,
  type WorkspaceSnapshot,
} from '@intelligenz/workspace-manager';

import { workerLogger } from '../log';
import {
  CHANGE_MANIFEST_KIND,
  CHANGE_MANIFEST_MEDIA_TYPE,
  EVIDENCE_SOURCE_HOST_SNAPSHOT,
  type EvidenceCaptureFailure,
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
 * attempt: a run that produced a result must not be replaced by an evidence bookkeeping
 * error. But "never throws" is not "never fails" — and the distinction is the whole of F-G2:
 *
 * **if a baseline exists, a missing manifest is a failure of the attempt.** An empty
 * manifest would be a lying claim; a *silently absent* one is worse, because the run reports
 * success and only a reader who knows to look for an absence can tell. So this module
 * reports *why* the manifest is missing (`captureFinalEvidenceOutcome`) and the caller
 * decides the outcome. A missing manifest with **no** baseline is not a failure: that attempt
 * leased no tree, so it owed no description.
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
 * The digests the workspace row recorded for this attempt, when it recorded any.
 *
 * Supplied by the caller (which can read the database) so this function stays a pure
 * verification of bytes against a claim. `null` means "not recorded" — a row that predates
 * the columns, or a fixture — and is not the same fact as a disagreement.
 */
export interface ManifestExpectation {
  readonly initialManifestDigest: string | null;
  readonly finalManifestDigest: string | null;
}

/**
 * The manifest body, checked for the fields this function relies on.
 *
 * Hand-rolled rather than a schema because `zod` is not a dependency of this package and a
 * new one for six primitive checks is not a trade worth making. What matters is that every
 * field the digest covers is present and has the right shape: `manifestDigest` re-derives
 * the canonical form from these values, so a missing field would silently produce a
 * different string, and a wrong type would throw.
 */
function parseManifestBody(bytes: Buffer): { ok: true; body: ManifestDigestInput } | { ok: false; reason: string } {
  let parsed: unknown;

  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    return { ok: false, reason: `manifest is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'manifest body is not an object' };
  }

  const body = parsed as Record<string, unknown>;
  const rejection = (field: string): { ok: false; reason: string } => ({
    ok: false,
    reason: `manifest body has no valid ${field}`,
  });

  if (typeof body['version'] !== 'number') return rejection('version');
  if (typeof body['root'] !== 'string') return rejection('root');
  if (typeof body['changeCount'] !== 'number') return rejection('changeCount');
  if (typeof body['complete'] !== 'boolean') return rejection('complete');
  if (!Array.isArray(body['changes'])) return rejection('changes');

  for (const sideName of ['initial', 'final'] as const) {
    const side = body[sideName];

    if (typeof side !== 'object' || side === null) return rejection(`${sideName} side`);

    const record = side as Record<string, unknown>;

    if (typeof record['digest'] !== 'string') return rejection(`${sideName}.digest`);
    if (typeof record['complete'] !== 'boolean') return rejection(`${sideName}.complete`);
    if (typeof record['entryCount'] !== 'number') return rejection(`${sideName}.entryCount`);
    if (typeof record['totalBytes'] !== 'number') return rejection(`${sideName}.totalBytes`);
    if (typeof record['capturedAt'] !== 'string') return rejection(`${sideName}.capturedAt`);
  }

  // The digest is re-derived from the parsed body through the same canonical writer the
  // producer used, so key order in the file cannot matter and extra keys cannot vote.
  return { ok: true, body: body as unknown as ManifestDigestInput };
}

/**
 * Check the manifest the worker says it wrote against the bytes that are actually there,
 * and against the record that was written before the run.
 *
 * This is not distrust of `executeAgentActivity` — it is the only place the claim and the
 * bytes meet. A truncated write, a full disk, an operator's `mv`, or a persist retry that
 * runs after someone edited the file all look identical from the row: a digest that
 * happened to be true once. Refusing to write a claim we cannot re-derive keeps
 * `Artifact.checksum` meaning what it says.
 *
 * An earlier version checked only self-consistency — checksum equal to digest, file length,
 * file hash. That accepts a body rewritten to `complete: false, changeCount: 0` and
 * presented with a matching envelope, because every value agrees with every other value in
 * the envelope and none of them agrees with the run. So the body is now parsed, its digest
 * re-derived, and its two snapshot digests compared with the summary **and** with
 * `ExecutionWorkspace`, which the worker wrote before the agent existed.
 *
 * Returns a reason rather than throwing so the caller can decide the error code.
 */
export async function verifyManifestFile(
  evidence: EvidenceSummary,
  expected: ManifestExpectation | null = null,
): Promise<string | null> {
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

  if (actual !== evidence.manifestDigest) {
    return `manifest hashes to ${actual}, not ${evidence.manifestDigest}`;
  }

  const parsed = parseManifestBody(bytes);

  if (!parsed.ok) return parsed.reason;

  // ── The body must mean what the envelope says ──────────────────────────────
  const derived = manifestDigest(parsed.body);

  if (derived !== evidence.manifestDigest) {
    return `manifest body derives ${derived}, not ${evidence.manifestDigest}`;
  }

  if (parsed.body.complete !== evidence.complete) {
    return `manifest body is complete=${String(parsed.body.complete)} but the summary says complete=${String(evidence.complete)}`;
  }

  // `complete` and `stopReason` are two spellings of one fact in the producer
  // (`buildChangeManifest` sets one from the other). A body where they disagree was not
  // produced by that function.
  if (parsed.body.complete !== (parsed.body.stopReason === null)) {
    return `manifest body is complete=${String(parsed.body.complete)} with stopReason=${String(parsed.body.stopReason)}`;
  }

  // Authority on an incomplete manifest is a contradiction, not a lesser claim: the body
  // itself says the walk stopped early.
  if (evidence.authoritative && !parsed.body.complete) {
    return 'an authoritative manifest cannot describe an incomplete walk';
  }

  if (parsed.body.initial.digest !== evidence.initialManifestDigest) {
    return `manifest compares initial ${parsed.body.initial.digest}, not ${evidence.initialManifestDigest}`;
  }

  if (parsed.body.final.digest !== evidence.finalManifestDigest) {
    return `manifest compares final ${parsed.body.final.digest}, not ${evidence.finalManifestDigest}`;
  }

  if (parsed.body.changeCount !== evidence.changeCount) {
    return `manifest lists ${String(parsed.body.changeCount)} changes, not ${String(evidence.changeCount)}`;
  }

  // ── And it must be the manifest for *this* attempt ────────────────────────
  //
  // `ExecutionWorkspace.initialManifestDigest` was written the instant the lease was
  // granted, before anything the agent can reach, and the final one the moment the process
  // tree was gone. They are the only record of the two trees that the summary cannot
  // rewrite. A row that records nothing cannot contradict; a row that records something
  // else is refused.
  if (expected !== null) {
    if (
      expected.initialManifestDigest !== null &&
      expected.initialManifestDigest !== evidence.initialManifestDigest
    ) {
      return `the workspace recorded initial ${expected.initialManifestDigest}, not ${evidence.initialManifestDigest}`;
    }

    if (
      expected.finalManifestDigest !== null &&
      expected.finalManifestDigest !== evidence.finalManifestDigest
    ) {
      return `the workspace recorded final ${expected.finalManifestDigest}, not ${evidence.finalManifestDigest}`;
    }
  }

  return null;
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
 *
 * The attempt does **not** continue silently any more: `captureInitialEvidenceOutcome`
 * reports the failure beside the evidence, and `executeAgentActivity` fails the attempt
 * with `EVIDENCE_BASELINE_FAILED` and writes a durable record (F-G19). This wrapper is kept
 * for callers that only need the evidence — a test that arranged a readable tree — and its
 * `null` means "the baseline could not be taken", never "measured and unchanged".
 */
export async function captureInitialEvidence(
  handle: WorkspaceHandle,
  options: { readonly maxEntries?: number; readonly maxTotalBytes?: number } = {},
): Promise<InitialEvidence | null> {
  return (await captureInitialEvidenceOutcome(handle, options)).evidence;
}

/**
 * The baseline, or the reason it could not be taken.
 *
 * `evidence === null` and `failure === null` cannot both happen: a capture that returns no
 * evidence always carries the reason. They are separate fields because the caller records
 * the evidence on `ExecutionWorkspace` and the failure in the audit trail, and one value
 * could not do both without making "absent" ambiguous again.
 */
export async function captureInitialEvidenceOutcome(
  handle: WorkspaceHandle,
  options: { readonly maxEntries?: number; readonly maxTotalBytes?: number } = {},
): Promise<{
  readonly evidence: InitialEvidence | null;
  readonly failure: EvidenceCaptureFailure | null;
}> {
  try {
    const snapshot = await takeWorkspaceSnapshot(handle.repoPath, {
      ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
      ...(options.maxTotalBytes === undefined ? {} : { maxTotalBytes: options.maxTotalBytes }),
    });

    const directory = await ensureEvidenceDirectory(handle);
    await writeSnapshotFile(directory, INITIAL_SNAPSHOT_FILE, snapshot);

    return {
      evidence: { snapshot, digest: snapshot.digest, capturedAt: snapshot.capturedAt },
      failure: null,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    workerLogger().warn(
      { workspaceId: handle.id, reason },
      'Initial workspace snapshot failed; this attempt has no change manifest',
    );

    return {
      evidence: null,
      // F-G19: this used to be silence. A run whose baseline could not be taken has no
      // manifest, so it cannot be reviewed — and it is not an infrastructure retry, it is
      // an attempt that must not report success.
      failure: {
        code: 'BASELINE_CAPTURE_FAILED',
        phase: 'initial',
        reason,
        stopReason: null,
        snapshotStopReason: null,
        entryCount: null,
        totalBytes: null,
        changeCount: null,
      },
    };
  }
}

/**
 * Why a manifest could not be produced, or was produced without authority — F-G13, F-G19.
 *
 * The vocabulary and the attempt-level codes live in `shared/evidence.ts` because they are
 * the worker's evidence language, not this module's implementation: a value here would sit
 * behind a `node:fs` import for every reader that only needs to name a failure. Re-exported
 * so the capture sites and the executor import one module.
 */
export type { EvidenceCaptureFailure, EvidenceFailureCode } from '../shared/evidence';
export { EVIDENCE_ERROR_CODES, evidenceFailureMessage } from '../shared/evidence';

/**
 * The result of trying to capture the final evidence.
 *
 * `summary: null` alone was ambiguous, and the ambiguity was the bug: "there was no
 * baseline, so there is nothing to compare" and "there was a baseline, and I could not
 * read the tree" both arrived as `null`, and the caller treated them the same. They are
 * different facts and only one of them is a failure.
 */
export interface FinalEvidenceOutcome {
  readonly summary: EvidenceSummary | null;
  /** Set only when a baseline exists and the final manifest could not be built from it. */
  readonly failure: EvidenceCaptureFailure | null;
}

/**
 * Take the final snapshot and build the manifest.
 *
 * `checksum` of the returned artifact is the manifest's own digest, because the file
 * written is exactly the canonical body `serialiseManifest` produces. One hash, not two:
 * a reviewer who recomputes `checksum` from the bytes on disk has verified the content,
 * the ordering, the counts and both snapshot digests at once.
 */
export async function captureFinalEvidenceOutcome(input: {
  readonly handle: WorkspaceHandle;
  readonly initial: InitialEvidence | null;
  readonly maxChanges?: number;
}): Promise<FinalEvidenceOutcome> {
  try {
    const finalSnapshot = await takeWorkspaceSnapshot(input.handle.repoPath);
    const directory = await ensureEvidenceDirectory(input.handle);
    await writeSnapshotFile(directory, FINAL_SNAPSHOT_FILE, finalSnapshot);

    if (input.initial === null) {
      // A final snapshot without a baseline answers "what is there", not "what changed".
      // Recorded on disk for forensics, never dressed up as a manifest — and not a failure,
      // because this attempt never had a tree whose change it could have described.
      return { summary: null, failure: null };
    }

    const manifest = buildChangeManifest({
      initial: input.initial.snapshot,
      final: finalSnapshot,
      ...(input.maxChanges === undefined ? {} : { maxChanges: input.maxChanges }),
    });

    const body = Buffer.from(serialiseManifest(manifest), 'utf8');
    const uri = join(directory, CHANGE_MANIFEST_FILE);

    await writeFile(uri, body, { mode: 0o600 });

    // ── An incomplete manifest is written, and is a failure of the attempt ───────
    //
    // The file is still written: what was seen is evidence, and deleting it would throw
    // away the bounded answer. But `complete: false` is not authority, and before F-G13
    // nothing consumed the flag — one `truncate` to 9 GiB made the manifest
    // non-authoritative and the task still reported `succeeded`. The failure travels with
    // the summary so the caller fails the attempt and records why, with the counts the
    // walk actually reached.
    const failure: EvidenceCaptureFailure | null = manifest.complete
      ? null
      : {
          code: 'SNAPSHOT_INCOMPLETE',
          phase: 'final',
          reason:
            `the final walk stopped early (${finalSnapshot.stopReason ?? 'unknown'}), so the ` +
            `change manifest is incomplete: ${manifest.stopReason ?? 'unknown'}`,
          stopReason: manifest.stopReason,
          snapshotStopReason: finalSnapshot.stopReason,
          entryCount: finalSnapshot.entryCount,
          totalBytes: finalSnapshot.totalBytes,
          changeCount: manifest.changeCount,
        };

    return {
      summary: {
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
        gitAnomalies: finalSnapshot.git.anomalies,
        artifact: {
          kind: CHANGE_MANIFEST_KIND,
          uri,
          // Equal by construction: the file *is* the canonical body.
          checksum: sha256(body),
          sizeBytes: body.byteLength,
          mediaType: CHANGE_MANIFEST_MEDIA_TYPE,
        },
      },
      failure,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    workerLogger().warn(
      {
        workspaceId: input.handle.id,
        reason,
        hadBaseline: input.initial !== null,
      },
      'Final workspace snapshot failed; this attempt has no change manifest',
    );

    return {
      summary: null,
      // A baseline existed, so a manifest was owed. `chmod 000` on one directory inside the
      // repository is not an infrastructure fault — it is a choice not to be measured, and
      // it must be visible as a failure of this attempt rather than as silence.
      failure:
        input.initial === null
          ? null
          : {
              code: 'SNAPSHOT_CAPTURE_FAILED',
              phase: 'final',
              reason,
              stopReason: null,
              snapshotStopReason: null,
              entryCount: null,
              totalBytes: null,
              changeCount: null,
            },
    };
  }
}

/**
 * The manifest, or `null`.
 *
 * Kept for callers that only need the summary (and for the fixtures that build one). A
 * caller that decides an attempt's outcome must use `captureFinalEvidenceOutcome`: `null`
 * here cannot distinguish "no baseline" from "the tree could not be read".
 */
export async function captureFinalEvidence(input: {
  readonly handle: WorkspaceHandle;
  readonly initial: InitialEvidence | null;
  readonly maxChanges?: number;
}): Promise<EvidenceSummary | null> {
  return (await captureFinalEvidenceOutcome(input)).summary;
}
