import { createReadStream } from 'node:fs';

import {
  Controller,
  Get,
  Inject,
  Param,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';

import type { ApiRequest, ApiResponse } from '../common/request-context';
import type { ArtifactSummaryWithMedia } from './artifact-summary';
import { ArtifactsService } from './artifacts.service';

/**
 * Artifact routes.
 *
 * Metadata is available to every member of the organisation. Content is not uniformly
 * so: `diff` and `report` are member-readable, while a raw `transcript` requires
 * `ADMIN` — it is model and shell output, and downloading it is an administrative
 * debugging act. The restriction is enforced in `ArtifactsService.content` because it
 * depends on the artifact's kind, which a route decorator cannot see.
 *
 * The content response is streamed rather than buffered: a transcript is a log, and
 * reading it whole to hand it back would make a large run's evidence the API's memory
 * problem.
 */
@Controller('v1/orgs/:orgId/artifacts')
export class ArtifactsController {
  constructor(@Inject(ArtifactsService) private readonly artifacts: ArtifactsService) {}

  @Get(':artifactId')
  async metadata(
    @Param('orgId') orgId: string,
    @Param('artifactId') artifactId: string,
  ): Promise<{ data: ArtifactSummaryWithMedia }> {
    return { data: await this.artifacts.metadata(orgId, artifactId) };
  }

  @Get(':artifactId/content')
  async content(
    @Param('orgId') orgId: string,
    @Param('artifactId') artifactId: string,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse & {
      setHeader(name: string, value: string): void;
    },
  ): Promise<StreamableFile> {
    // The org guard ran before this handler, so `org` is present; an absent role is
    // treated as the lowest privilege rather than as a reason to allow.
    const role = request.org?.role ?? 'VIEWER';

    // Everything that can fail happens here, before a single header is written: an
    // integrity failure must be a 409 JSON body, not a 200 with a truncated stream.
    const file = await this.artifacts.content(orgId, artifactId, role);

    response.setHeader('Content-Type', file.mediaType);
    response.setHeader('Content-Length', String(file.sizeBytes));
    // The digest is the identity of the bytes; `ETag` lets a client revalidate a
    // download without trusting the filename.
    response.setHeader('ETag', `"sha256-${file.checksum}"`);
    response.setHeader('X-Artifact-Checksum', file.checksum);
    response.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);

    return new StreamableFile(createReadStream(file.absolutePath));
  }
}
