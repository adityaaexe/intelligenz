import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createPrismaClient, type PrismaClient } from '@intelligenz/database';

import { APP_CONFIG, type AppConfig } from '../config/app-config';

/**
 * One Prisma client per process (contract §5). Prisma owns a connection pool; a
 * client per request would exhaust Postgres under any real load, and a client per
 * module would multiply the pool by the module count.
 *
 * The client is provided through a token rather than a subclassed service because
 * `@intelligenz/database` exposes the client as a *type* plus a factory — that is
 * deliberate, so the package can decide how a pool is built without every consumer
 * knowing about driver adapters.
 */
export const PRISMA_CLIENT = Symbol('PRISMA_CLIENT');

@Injectable()
export class PrismaShutdownService implements OnApplicationShutdown {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  /**
   * Called by `app.enableShutdownHooks()` on SIGTERM/SIGINT. Draining the pool
   * before exit is the difference between a clean restart and Postgres logging
   * "unexpected EOF on client connection" on every deploy.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PRISMA_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): PrismaClient => createPrismaClient(config.databaseUrl),
    },
    PrismaShutdownService,
  ],
  exports: [PRISMA_CLIENT],
})
export class DatabaseModule {}
