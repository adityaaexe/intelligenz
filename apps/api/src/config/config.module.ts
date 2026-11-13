import { Global, Module, type DynamicModule } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from './app-config';

/**
 * Injects the boot config under `APP_CONFIG`. Global because every module needs it
 * (JWT secret, Temporal address, readiness budget) and threading it through eight
 * `imports` arrays would add noise without adding safety.
 */
@Global()
@Module({})
export class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      global: true,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
