import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@intelligenz/database';
import type { Role } from '@intelligenz/contracts';

import { AppError } from '../common/errors';
import { satisfiesRole } from '../auth/auth.decorators';
import { PRISMA_CLIENT } from '../database/database.module';
import {
  ARTIFACT_LOCATOR,
  mediaTypeForArtifact,
  verifyArtifact,
  type ArtifactLocator,
} from './artifact-locator';
import { summariseArtifact, type ArtifactRecord, type ArtifactSummaryWithMedia } from './artifact-summary';

/**
 * Artifact reads.
 *
 * The database row is the index; the bytes are the truth. Every read here resolves the
 * stored path, proves it is inside a configured root, and re-computes SHA-256 before
 * saying anything about integrity.
 *
 * ## Why `checksumVerified` is not a column
 *
 * A stored "verified" flag is a claim about the past. A file can be truncated by a
 * full disk, replaced by a restore, or moved by an operator — the flag would still say
 * `true`. Computing it on read is cheap at Phase 3 sizes and cannot go stale.
 *
 * ## Cross-tenant reads are 404
 *
 * Every query is `(id, orgId)`. Another organisation's artifact is indistinguishable
 * from one that does not exist; a 403 would confirm the id.
 *
 * ## Raw transcripts are `ADMIN`+
 *
 * A transcript is model and shell output: whatever the agent read, printed or was
 * told. Even with redaction at collection time it is the highest-risk artifact the
 * platform stores, and downloading it is an administrative act (debugging a run), not
 * a viewing one. `VIEWER` and `MEMBER` keep the metadata and the `diff`/`report`
 * artifacts; the raw stream is refused. The check lives here rather than in `@Roles`
 * because it depends on the artifact's `kind`, which is only known after the row is
 * loaded.
 */

export interface ArtifactContent {
  readonly absolutePath: string;
  readonly sizeBytes: number;
  readonly checksum: string;
  readonly mediaType: string;
  readonly filename: string;
}

/** The artifact kind whose raw bytes are administrative. */
const TRANSCRIPT_KIND = 'transcript';

/** Minimum role for a raw transcript download. Metadata stays member-readable. */
const TRANSCRIPT_MIN_ROLE: Role = 'ADMIN';

@Injectable()
export class ArtifactsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(ARTIFACT_LOCATOR) private readonly locator: ArtifactLocator,
  ) {}

  /** Safe logical uri for list responses (`TaskDetail.artifacts`). Never absolute. */
  logicalUri(uri: string): string {
    return this.locator.logicalUri(uri);
  }

  async metadata(orgId: string, artifactId: string): Promise<ArtifactSummaryWithMedia> {
    const artifact = await this.find(orgId, artifactId);

    return summariseArtifact(this.locator, artifact, mediaTypeForArtifact(artifact.kind));
  }

  /**
   * Resolves the bytes for streaming, but only after the digest matches.
   *
   * The order matters: a mismatch is a `409` with a code, not a partial body. A client
   * that receives the first kilobyte of a corrupted transcript has already been told
   * the wrong thing.
   *
   * The role check runs **before** the file is touched: a `VIEWER` requesting a
   * transcript learns that the artifact exists (they can already read its metadata) and
   * that the download is refused, in that order and with no bytes served.
   */
  async content(orgId: string, artifactId: string, role: Role): Promise<ArtifactContent> {
    const artifact = await this.find(orgId, artifactId);

    if (artifact.kind === TRANSCRIPT_KIND && !satisfiesRole(role, TRANSCRIPT_MIN_ROLE)) {
      throw AppError.forbidden(
        'Raw transcripts require the ADMIN role or higher. The redacted diff and report artifacts remain available.',
      );
    }

    const resolution = await this.locator.resolve(artifact.uri);

    if (resolution === undefined) {
      // Outside every configured root. Treat it as absent: the alternative is telling
      // the caller that a path exists somewhere they cannot be served.
      throw AppError.notFound('Artifact content');
    }

    const verified = await verifyArtifact(resolution, artifact.checksum);

    if (verified.integrity === 'unknown') {
      throw new AppError(
        410,
        'ARTIFACT_GONE',
        'The artifact file is no longer present on this host.',
      );
    }

    if (verified.integrity === 'failed') {
      throw new AppError(
        409,
        'ARTIFACT_INTEGRITY_FAILED',
        'The artifact bytes do not match the recorded checksum; refusing to serve them.',
        { checksum: [`Expected ${artifact.checksum} for artifact ${artifact.id}.`] },
      );
    }

    return {
      absolutePath: resolution.absolutePath,
      sizeBytes: verified.sizeBytes ?? Number(artifact.sizeBytes),
      checksum: artifact.checksum,
      mediaType: mediaTypeForArtifact(artifact.kind),
      filename: safeFilename(resolution.logicalUri, artifact.kind),
    };
  }

  private async find(orgId: string, artifactId: string): Promise<ArtifactRecord> {
    const artifact = await this.prisma.artifact.findFirst({
      // Tenant scoping: an id from another organisation resolves to null.
      where: { id: artifactId, orgId },
      select: {
        id: true,
        taskId: true,
        attemptId: true,
        runtimeId: true,
        kind: true,
        uri: true,
        checksum: true,
        sizeBytes: true,
        evidenceSource: true,
        authoritative: true,
        manifestDigest: true,
        createdAt: true,
      },
    });

    if (artifact === null) throw AppError.notFound('Artifact');

    return artifact;
  }
}

/**
 * A download name derived from the logical path, never from the stored absolute path.
 * A `"` or a newline in a `Content-Disposition` header is a header-injection primitive,
 * so everything outside a conservative allowlist is replaced.
 */
export function safeFilename(logicalUri: string, kind: string): string {
  const base = logicalUri.split('/').pop() ?? kind;
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');

  return cleaned.length === 0
    ? `${kind.replace(/[^A-Za-z0-9._-]+/g, '_') || 'artifact'}.bin`
    : cleaned;
}
