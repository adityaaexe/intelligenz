import { Module, type DynamicModule } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../config/app-config';
import {
  ARTIFACT_LOCATOR,
  createArtifactLocator,
  type ArtifactLocator,
} from './artifact-locator';
import { ArtifactsController } from './artifacts.controller';
import { ArtifactsService } from './artifacts.service';

/**
 * Artifact reads, plus the path locator other modules reuse.
 *
 * `ARTIFACT_LOCATOR` is a token rather than a static import because its roots come
 * from boot config: a relative `ARTIFACT_ROOT` must resolve the same way in the API as
 * in the worker, and resolving it once at boot is how the two agree.
 *
 * The locator is in a global module so `TasksService` can render a logical `uri` in
 * the task detail without importing the controller layer. Two roots, one answer to
 * "where may this process read from".
 */
@Module({})
export class ArtifactsModule {
  static forRoot(): DynamicModule {
    return {
      module: ArtifactsModule,
      global: true,
      controllers: [ArtifactsController],
      providers: [
        {
          provide: ARTIFACT_LOCATOR,
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig): ArtifactLocator =>
            createArtifactLocator([config.artifactRoot, config.workspaceRoot]),
        },
        ArtifactsService,
      ],
      exports: [ARTIFACT_LOCATOR, ArtifactsService],
    };
  }
}
