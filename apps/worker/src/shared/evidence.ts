import type { ChangeStatus, WorkspaceSnapshot } from '@intelligenz/workspace-manager';

/**
 * The worker's evidence vocabulary, with no Node and no filesystem imports.
 *
 * Split out of `activities/evidence.ts` for one reason: the workflow bundle imports
 * `shared/contracts.ts`, and the Temporal sandbox rejects `node:fs`. Keeping the types and
 * the two string constants here means the workflow's type graph never reaches a module that
 * reads a file — and the constants are values, so they must not live in a module the
 * workflow pulls in at runtime.
 */

/** The only source a manifest can have. A string in the database, a constant in code. */
export const EVIDENCE_SOURCE_HOST_SNAPSHOT = 'host-snapshot';

/**
 * The demoted source.
 *
 * `git-in-sandbox` means: bytes produced by `git diff` running against a repository the
 * agent can configure. Kept, displayed, never authority.
 */
export const EVIDENCE_SOURCE_GIT_IN_SANDBOX = 'git-in-sandbox';

/**
 * The artifact kind reserved for a host manifest.
 *
 * Reserved is a rule, not a convention: `persistResult` refuses this kind when it arrives
 * through `result.artifacts[]`, because that list is adapter output. The only path is
 * `result.evidence`, which `executeAgentActivity` writes after the adapter returns.
 */
export const CHANGE_MANIFEST_KIND = 'change-manifest';

export const CHANGE_MANIFEST_MEDIA_TYPE = 'application/json';

/** The baseline, as it travels from the capture site to the manifest build. */
export interface InitialEvidence {
  readonly snapshot: WorkspaceSnapshot;
  readonly digest: string;
  readonly capturedAt: string;
}

/**
 * Why a manifest could not be produced, or was produced without authority.
 *
 * A reason, not an exception: the attempt's outcome is decided elsewhere, and an evidence
 * failure changes that outcome rather than replacing it with an infrastructure error.
 *
 * Three codes, because the three facts are different and an operator filters on them:
 *
 * - `SNAPSHOT_CAPTURE_FAILED` — the final walk threw; the attempt has **no** manifest.
 * - `SNAPSHOT_INCOMPLETE` — the final walk finished but stopped early (`maxEntries`,
 *   `maxTotalBytes`, an unreadable entry), so the manifest exists and is not authority.
 * - `BASELINE_CAPTURE_FAILED` — the baseline walk threw, so this attempt never had a tree
 *   to compare against.
 */
export type EvidenceFailureCode =
  | 'SNAPSHOT_CAPTURE_FAILED'
  | 'SNAPSHOT_INCOMPLETE'
  | 'BASELINE_CAPTURE_FAILED';

export interface EvidenceCaptureFailure {
  readonly code: EvidenceFailureCode;
  /** Which capture failed. A durable record names the phase it belongs to. */
  readonly phase: 'initial' | 'final';
  readonly reason: string;
  /** The manifest's stop reason (`final-incomplete`, `max-changes`) when there is one. */
  readonly stopReason: string | null;
  /** The final walk's own stop reason (`max-entries`, `max-total-bytes`, …). */
  readonly snapshotStopReason: string | null;
  /** Counts the bounded walk actually reached; `null` when the walk threw. */
  readonly entryCount: number | null;
  readonly totalBytes: number | null;
  readonly changeCount: number | null;
}

/**
 * The attempt-level error code for each failure.
 *
 * Distinct on purpose — F-G13. `EVIDENCE_MISSING` means "there is no manifest";
 * `EVIDENCE_INCOMPLETE` means "there is one, it says it stopped early, and it is not
 * authority"; `EVIDENCE_BASELINE_FAILED` means "there was never a tree to compare". An
 * operator filtering on `EVIDENCE_MISSING` to find runs with no report must not also get
 * runs that have a bounded report, and a reviewer reading a `failed` attempt must be able
 * to tell which of the three happened without parsing prose. Overloading one code with
 * two facts is how "no evidence" became indistinguishable from "nothing changed" in the
 * first place.
 */
export const EVIDENCE_ERROR_CODES: Readonly<Record<EvidenceFailureCode, string>> = {
  SNAPSHOT_CAPTURE_FAILED: 'EVIDENCE_MISSING',
  SNAPSHOT_INCOMPLETE: 'EVIDENCE_INCOMPLETE',
  BASELINE_CAPTURE_FAILED: 'EVIDENCE_BASELINE_FAILED',
};

/** The `ExecutionResult.error.message` for a failure, naming the fact that happened. */
export function evidenceFailureMessage(failure: EvidenceCaptureFailure): string {
  if (failure.code === 'SNAPSHOT_INCOMPLETE') {
    // The counts are in the message because an incomplete manifest's whole value is the
    // bound it reached: "stopped at 8 GiB after 12,004 entries" is actionable, "incomplete"
    // is not.
    const reached = [
      failure.entryCount === null ? null : `${String(failure.entryCount)} entries`,
      failure.totalBytes === null ? null : `${String(failure.totalBytes)} bytes`,
      failure.changeCount === null ? null : `${String(failure.changeCount)} changes`,
    ]
      .filter((part): part is string => part !== null)
      .join(', ');

    return (
      `The final workspace snapshot stopped early (${failure.snapshotStopReason ?? 'unknown'}), ` +
      `so this attempt's change manifest is incomplete` +
      `${reached.length > 0 ? ` (${reached} reached)` : ''} and cannot be reviewed: ` +
      failure.reason
    );
  }

  if (failure.code === 'BASELINE_CAPTURE_FAILED') {
    return (
      'The baseline workspace snapshot could not be taken, so this attempt has no tree to ' +
      `compare against and cannot be reviewed: ${failure.reason}`
    );
  }

  return (
    'The final workspace snapshot could not be taken, so this attempt has no change ' +
    `manifest and cannot be reviewed: ${failure.reason}`
  );
}

/**
 * What `executeAgentActivity` tells persistence about the evidence it captured.
 *
 * Every field is written by the worker. Nothing here is copied from the adapter's result,
 * which is why it can be trusted for provenance at all.
 */
export interface EvidenceSummary {
  readonly kind: typeof CHANGE_MANIFEST_KIND;
  /** SHA-256 of the manifest's canonical body. Equal to `artifact.checksum`. */
  readonly manifestDigest: string;
  readonly initialManifestDigest: string;
  readonly finalManifestDigest: string;
  readonly evidenceSource: typeof EVIDENCE_SOURCE_HOST_SNAPSHOT;
  /**
   * False when either snapshot was bounded or the change list hit its cap.
   *
   * Copied verbatim into `Artifact.authoritative`. A truncated manifest is still written —
   * what was seen is evidence — but it must never be presented as the answer to "what
   * changed", which is the failure mode the whole gate exists to remove.
   */
  readonly authoritative: boolean;
  readonly complete: boolean;
  readonly stopReason: string | null;
  readonly changeCount: number;
  readonly counts: Readonly<Record<ChangeStatus, number>>;
  /**
   * `.git` metadata that was recorded but could not be described normally — a symlinked
   * hooks directory, an unreadable gitfile, an oversize `config`, or a `.git` directory
   * below the root (a nested repository, which is content — F-G11).
   *
   * These are inside the manifest digest already. They are carried here so the worker can
   * write a durable record for them (F-G14): an `authoritative: true, changeCount: 0`
   * artifact must not be able to hide an anomaly that is only visible to someone who
   * parses the body.
   */
  readonly gitAnomalies: readonly string[];
  /** The file to persist, described by the worker that wrote it. */
  readonly artifact: {
    readonly kind: typeof CHANGE_MANIFEST_KIND;
    readonly uri: string;
    readonly checksum: string;
    readonly sizeBytes: number;
    readonly mediaType: string;
  };
}
