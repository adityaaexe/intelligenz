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
  readonly runtimeId: string;
  readonly kind: string;
  readonly uri: string;
  readonly checksum: string;
  readonly sizeBytes: bigint;
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
    runtimeId: record.runtimeId,
    kind: record.kind,
    uri: resolution?.logicalUri ?? locator.logicalUri(record.uri),
    checksum: record.checksum,
    // The bytes' size when they exist, the recorded size when they do not: a row
    // whose file is gone still has a known intended size, and `integrity` says why
    // the two may disagree.
    sizeBytes: verified.sizeBytes ?? Number(record.sizeBytes),
    integrity: verified.integrity,
    createdAt: record.createdAt.toISOString(),
  });

  return { ...summary, mediaType };
}
