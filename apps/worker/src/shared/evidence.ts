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
  /** The file to persist, described by the worker that wrote it. */
  readonly artifact: {
    readonly kind: typeof CHANGE_MANIFEST_KIND;
    readonly uri: string;
    readonly checksum: string;
    readonly sizeBytes: number;
    readonly mediaType: string;
  };
}
