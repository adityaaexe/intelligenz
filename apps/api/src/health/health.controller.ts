import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { PrismaClient } from '@intelligenz/database';
import type { Logger } from 'pino';

import { Public } from '../auth/auth.decorators';
import { LOGGER } from '../common/logger';
import type { ApiResponse } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { PRISMA_CLIENT } from '../database/database.module';
import { OrchestratorService } from '../orchestrator/orchestrator.service';
import { ReadinessCache } from './readiness-cache';

/**
 * `GET /health` and `GET /health/ready` — contract §6, §16 and §15 A6.
 *
 * These two routes are the Overview's "System health" region, so the distinction
 * matters:
 *
 *   - `/health` is liveness. It answers "is this process able to serve HTTP". No
 *     dependency is touched, so a Postgres outage does not get the container
 *     restarted for a problem a restart cannot fix.
 *   - `/health/ready` is readiness. It touches Postgres and Temporal with a deadline
 *     and returns `503` with the status of each. A readiness probe that reports
 *     "ready" while Temporal is down is worse than no probe: the Overview would
 *     claim the orchestrator can accept work, and every `POST /run` would fail.
 *
 * The readiness body is a health document, not the API error envelope. That is
 * deliberate and documented in `api-contract.md`: a per-dependency status cannot be
 * expressed in `{ error: { code, message } }`, and the contract asks for one.
 */

export type DependencyState = 'up' | 'down';

export interface DependencyCheck {
  readonly status: DependencyState;
  readonly latencyMs: number;
  readonly detail?: string;
}

export interface ReadinessResponse {
  readonly status: 'ready' | 'not_ready';
  readonly service: 'intelligenz-api';
  readonly checks: {
    readonly postgres: DependencyCheck;
    readonly temporal: DependencyCheck;
  };
  /**
   * Age of the document in milliseconds. `0` on the request that performed the
   * probe, up to the 2 s cache window on a hit. Exposed so a caller can tell a
   * fresh probe from a replay — a cached "ready" is a 2-second-old fact.
   */
  readonly ageMs: number;
}

const SERVICE = 'intelligenz-api' as const;

@Controller('health')
export class HealthController {
  /**
   * One document per process, refreshed at most every 2 s. `inFlight` collapses
   * concurrent misses into a single probe: without it, a burst of probes would
   * each open their own Temporal connection, which is the amplification the cache
   * exists to prevent.
   */
  private readonly readinessCache = new ReadinessCache<ReadinessResponse>();
  private inFlight: Promise<ReadinessResponse> | undefined;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(OrchestratorService) private readonly orchestrator: OrchestratorService,
  ) {}

  @Public()
  @Get()
  liveness(): { status: 'ok'; service: typeof SERVICE; uptimeSeconds: number } {
    return { status: 'ok', service: SERVICE, uptimeSeconds: Math.floor(process.uptime()) };
  }

  @Public()
  @Get('ready')
  async readiness(@Res({ passthrough: true }) response: ApiResponse): Promise<ReadinessResponse> {
    const cached = this.readinessCache.get();

    if (cached !== undefined) {
      // A cached "not_ready" is still a 503: the status code is part of the
      // document, not a property of the request that produced it.
      if (cached.value.status === 'not_ready') response.status(503);

      return { ...cached.value, ageMs: cached.ageMs };
    }

    const fresh = await this.probeWithSingleFlight();

    if (fresh.status === 'not_ready') response.status(503);

    return fresh;
  }

  /**
   * The probe itself. `ageMs` is 0 by construction: this is the request that
   * measured the dependencies.
   */
  private async probe(): Promise<ReadinessResponse> {
    const [postgres, temporal] = await Promise.all([
      this.checkPostgres(),
      this.orchestrator.probe(),
    ]);

    const temporalCheck: DependencyCheck = temporal.ok
      ? { status: 'up', latencyMs: temporal.latencyMs }
      : { status: 'down', latencyMs: temporal.latencyMs, detail: temporal.detail };

    const body: ReadinessResponse = {
      status: postgres.status === 'up' && temporalCheck.status === 'up' ? 'ready' : 'not_ready',
      service: SERVICE,
      checks: { postgres, temporal: temporalCheck },
      ageMs: 0,
    };

    if (body.status === 'not_ready') {
      // Logged once per probe, not once per cache hit — otherwise a single failing
      // dependency would write a warning line for every probe request.
      this.logger.warn({ checks: body.checks }, 'readiness probe failed');
    }

    this.readinessCache.set(body);

    return body;
  }

  private probeWithSingleFlight(): Promise<ReadinessResponse> {
    if (this.inFlight !== undefined) return this.inFlight;

    this.inFlight = this.probe().finally(() => {
      this.inFlight = undefined;
    });

    return this.inFlight;
  }

  private async checkPostgres(): Promise<DependencyCheck> {
    const startedAt = Date.now();

    try {
      await withTimeout(
        this.prisma.$queryRaw`SELECT 1`,
        this.config.readinessTimeoutMs,
        'Postgres readiness check',
      );

      return { status: 'up', latencyMs: Date.now() - startedAt };
    } catch (error) {
      return {
        status: 'down',
        latencyMs: Date.now() - startedAt,
        detail: classifyDatabaseError(error),
      };
    }
  }
}

/**
 * Classified, not echoed. A Prisma connection error can contain the host, the port
 * and occasionally the role name; `/health/ready` is unauthenticated.
 */
function classifyDatabaseError(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
  if (error instanceof Error && 'code' in error) return String((error as { code: unknown }).code);
  return 'error';
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} exceeded ${timeoutMs}ms.`);
      error.name = 'TimeoutError';
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
