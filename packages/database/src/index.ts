import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client';
import { readDatabaseUrl } from './env';

/**
 * `@intelligenz/database` — the only place a Prisma client is constructed.
 *
 * Prisma 7 has no bundled query engine: a driver adapter is mandatory, which is why
 * `@prisma/adapter-pg` is a dependency of this package and not an optional extra.
 *
 * A client owns a connection pool. One instance per process, reused across hot
 * reloads in development; a second instance per request would exhaust Postgres.
 * `apps/api` will wrap this in `forTenant(orgId)` (ADR-004) so tenant scoping is
 * structural; until that unit lands, callers own their `orgId` predicates.
 *
 * Construction is lazy on purpose. Importing this package must not require a
 * database URL — a build step, a unit test or the migration CLI imports types
 * without ever connecting, and an import-time throw turns that into a runtime
 * failure far from the real cause.
 */

export type { PrismaClient } from '../generated/prisma/client';
export { Prisma } from '../generated/prisma/client';
export * from '../generated/prisma/enums';
export type * from '../generated/prisma/models';

export function createPrismaClient(connectionString: string = readDatabaseUrl()): PrismaClient {
  const adapter = new PrismaPg({ connectionString });

  return new PrismaClient({ adapter });
}

const globalForPrisma = globalThis as unknown as {
  intelligenzPrisma?: PrismaClient;
};

let moduleClient: PrismaClient | undefined;

/**
 * The process-wide singleton. Safe to call from anywhere: the first call opens the
 * pool, every later call returns the same client. In development the instance is
 * also parked on `globalThis`, so a hot reload does not leak a pool per reload.
 */
export function getPrismaClient(): PrismaClient {
  if (moduleClient) return moduleClient;

  moduleClient = globalForPrisma.intelligenzPrisma ?? createPrismaClient();

  if (process.env['NODE_ENV'] !== 'production') {
    globalForPrisma.intelligenzPrisma = moduleClient;
  }

  return moduleClient;
}

/**
 * Ergonomic facade for `getPrismaClient()`. The proxy exists so `prisma.task.findMany()`
 * reads naturally while the pool is still created on first query rather than at import.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property) {
    const client = getPrismaClient();
    const value = Reflect.get(client, property);

    return typeof value === 'function' ? value.bind(client) : value;
  },
});
