import { ExecutionArtifactSummary } from '@intelligenz/contracts';

import { verifyArtifact, type ArtifactLocator } from './artifact-locator';

/**
 * The one place an `Artifact` row becomes a wire object.
 *
 * Used by the artifact endpoints and by the attempt detail, so ``integrity`` means the
 * same thing in both — computed from the bytes on this request, `unknown` when they
 * cannot be read, never a stored claim.
 *
 * The `uri` is the locator's logical form. A row whose stored path is outside every
 * configured root still keeps its metadata readable (kind, checksum, size) but is
 * reported as `external/...` and `integrity: unknown`.
 */
export interface ArtifactRecord {
  readonly id: string;
  readonly taskId: string;
  /** Phase 4 provenance. `null` means "unattributed", never "assume the latest run". */
  readonly attemptId: string | null;
  readonly runtimeId: string;
  readonly kind: string;
  readonly uri: string;
  readonly checksum: string;
  readonly sizeBytes: bigint;
  /**
   * Phase 6 provenance. `null` means the row predates the distinction — reported as
   * unknown, never guessed from `kind`.
   */
  readonly evidenceSource: string | null;
  readonly authoritative: boolean;
  readonly manifestDigest: string | null;
  readonly createdAt: Date;
}

export interface ArtifactSummaryWithMedia extends ExecutionArtifactSummary {
  readonly mediaType: string;
}

export async function summariseArtifact(
  locator: ArtifactLocator,
  record: ArtifactRecord,
  mediaType: string,
): Promise<ArtifactSummaryWithMedia> {
  const resolution = await locator.resolve(record.uri);
  const verified = await verifyArtifact(resolution, record.checksum);

  const summary = ExecutionArtifactSummary.parse({
    id: record.id,
    taskId: record.taskId,
    attemptId: record.attemptId,
    // Denormalised so a UI cannot accidentally render a null link as the current run.
    unattributed: record.attemptId === null,
    runtimeId: record.runtimeId,
    kind: record.kind,
    uri: resolution?.logicalUri ?? locator.logicalUri(record.uri),
    checksum: record.checksum,
    // The bytes' size when they exist, the recorded size when they do not: a row
    // whose file is gone still has a known intended size, and `integrity` says why
    // the two may disagree.
    sizeBytes: verified.sizeBytes ?? Number(record.sizeBytes),
    integrity: verified.integrity,
    // Phase 6, verbatim from the row. Not derived from `kind`: a `diff` is not authority
    // because of what it is called, and a legacy row is not authority because of when it
    // was written.
    evidenceSource: record.evidenceSource,
    authoritative: record.authoritative,
    manifestDigest: record.manifestDigest,
    createdAt: record.createdAt.toISOString(),
  });

  return { ...summary, mediaType };
}
