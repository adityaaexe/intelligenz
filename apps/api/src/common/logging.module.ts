import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { Logger } from 'pino';

import { LOGGER } from './logger';

/**
 * Provides the process-wide pino instance under the `LOGGER` symbol. Kept separate
 * from `createLogger` so a test can supply a silent logger without touching the
 * real configuration path.
 */
@Global()
@Module({})
export class LoggingModule {
  static forRoot(logger: Logger): DynamicModule {
    return {
      module: LoggingModule,
      global: true,
      providers: [{ provide: LOGGER, useValue: logger }],
      exports: [LOGGER],
    };
  }
}
