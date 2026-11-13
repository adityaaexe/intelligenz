import { Module } from '@nestjs/common';

import { ExecutionsController } from './executions.controller';
import { ExecutionsService } from './executions.service';

/**
 * Execution history.
 *
 * `ARTIFACT_LOCATOR` comes from the global `ArtifactsModule`; `PRISMA_CLIENT` from the
 * global `DatabaseModule`. Nothing else is imported on purpose — this module reads,
 * and a module that reads should not be able to pull a writer in by accident.
 */
@Module({
  controllers: [ExecutionsController],
  providers: [ExecutionsService],
  exports: [ExecutionsService],
})
export class ExecutionsModule {}
