import type { PrismaClient } from '@intelligenz/database';
import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiResponse } from '../src/common/request-context';
import type { AppConfig } from '../src/config/app-config';
import { HealthController } from '../src/health/health.controller';
import { READINESS_CACHE_TTL_MS, ReadinessCache } from '../src/health/readiness-cache';
import type { OrchestratorService } from '../src/orchestrator/orchestrator.service';

/**
 * `/health/ready` is unauthenticated. Before the cache it opened a Temporal
 * connection and ran a Postgres query on every request, so anyone who could reach
 * the port could drive connection setup against both dependencies at request rate.
 */

const config: AppConfig = {
  nodeEnv: 'test',
  port: 4100,
  host: '127.0.0.1',
  databaseUrl: 'postgresql://unused/unused',
  jwtSecret: 'Kq7-tR2#vLm9!pXz4w8@nB3yS6',
  jwtTtlSeconds: 900,
  logLevel: 'silent',
  corsOrigins: [],
  temporal: { address: 'localhost:7233', namespace: 'default', taskQueue: 'intelligenz-tasks' },
  readinessTimeoutMs: 2_000,
  artifactRoot: '/tmp/intelligenz-test-artifacts',
  workspaceRoot: '/tmp/intelligenz-test-workspaces',
};

function responseStub(): ApiResponse & { statusCalls: number[] } {
  const statusCalls: number[] = [];

  const response = {
    statusCalls,
    status(code: number) {
      statusCalls.push(code);
      return response;
    },
    setHeader: () => undefined,
    json: () => undefined,
  };

  return response as unknown as ApiResponse & { statusCalls: number[] };
}

interface Harness {
  controller: HealthController;
  postgresCalls: () => number;
  temporalCalls: () => number;
  loggerWarnings: () => number;
  setDependenciesUp: (up: boolean) => void;
}

function makeHarness(): Harness {
  let up = true;
  let postgresCalls = 0;
  let temporalCalls = 0;
  const warnings: unknown[] = [];

  const prisma = {
    $queryRaw: async () => {
      postgresCalls += 1;
      if (!up) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'P1001' });
      return [{ '?column?': 1 }];
    },
  } as unknown as PrismaClient;

  const orchestrator = {
    probe: async () => {
      temporalCalls += 1;
      return up ? { ok: true, latencyMs: 3 } : { ok: false, latencyMs: 3, detail: 'unavailable' };
    },
  } as unknown as OrchestratorService;

  const logger = {
    warn: (...args: unknown[]) => warnings.push(args),
    error: () => undefined,
    info: () => undefined,
  } as unknown as Logger;

  return {
    controller: new HealthController(prisma, config, logger, orchestrator),
    postgresCalls: () => postgresCalls,
    temporalCalls: () => temporalCalls,
    loggerWarnings: () => warnings.length,
    setDependenciesUp: (next) => {
      up = next;
    },
  };
}

describe('ReadinessCache — monotonic TTL', () => {
  it('returns the document with its age inside the window and nothing at the TTL', () => {
    let now = 0n;
    const cache = new ReadinessCache<{ status: string }>(2_000, () => now);

    expect(cache.get()).toBeUndefined();

    cache.set({ status: 'ready' });
    expect(cache.get()).toEqual({ value: { status: 'ready' }, ageMs: 0 });

    now += 1_999_000_000n; // 1999 ms
    expect(cache.get()?.ageMs).toBe(1_999);

    now += 1_000_000n; // exactly 2000 ms — stale
    expect(cache.get()).toBeUndefined();
  });

  it('ages with a clock that cannot go backwards', () => {
    // The injected clock is a monotonic nanosecond counter; a backwards step is
    // not representable, which is the property `Date.now()` does not have.
    let now = 5_000_000_000n;
    const cache = new ReadinessCache<string>(2_000, () => now);

    cache.set('doc');
    now += 1_500_000_000n;

    expect(cache.get()).toEqual({ value: 'doc', ageMs: 1_500 });
  });
});

describe('HealthController.readiness — cached probe', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('probes once for repeated requests inside the window and reports ageMs', async () => {
    const harness = makeHarness();

    const first = await harness.controller.readiness(responseStub());
    const second = await harness.controller.readiness(responseStub());
    const third = await harness.controller.readiness(responseStub());

    expect(harness.postgresCalls()).toBe(1);
    expect(harness.temporalCalls()).toBe(1);
    expect(first.ageMs).toBe(0);
    expect(second.ageMs).toBeGreaterThanOrEqual(0);
    expect(third.ageMs).toBeGreaterThanOrEqual(second.ageMs);
    expect(third.status).toBe('ready');
  });

  it('keeps a cached not_ready a 503 and does not re-probe', async () => {
    const harness = makeHarness();
    harness.setDependenciesUp(false);

    const firstResponse = responseStub();
    const secondResponse = responseStub();

    const first = await harness.controller.readiness(firstResponse);
    const second = await harness.controller.readiness(secondResponse);

    expect(first.status).toBe('not_ready');
    expect(second.status).toBe('not_ready');
    expect(firstResponse.statusCalls).toEqual([503]);
    expect(secondResponse.statusCalls).toEqual([503]);
    // One probe, one warning: a cached failure must not write a log line per hit.
    expect(harness.postgresCalls()).toBe(1);
    expect(harness.temporalCalls()).toBe(1);
    expect(harness.loggerWarnings()).toBe(1);
  });

  it('collapses concurrent misses into one probe', async () => {
    const harness = makeHarness();

    await Promise.all([
      harness.controller.readiness(responseStub()),
      harness.controller.readiness(responseStub()),
      harness.controller.readiness(responseStub()),
    ]);

    // Single-flight: the three calls arrived before the first probe finished.
    expect(harness.postgresCalls()).toBe(1);
    expect(harness.temporalCalls()).toBe(1);
  });

  it('re-probes after the window expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const harness = makeHarness();

    await harness.controller.readiness(responseStub());
    expect(harness.postgresCalls()).toBe(1);

    vi.advanceTimersByTime(READINESS_CACHE_TTL_MS + 1);

    await harness.controller.readiness(responseStub());
    expect(harness.postgresCalls()).toBe(2);

    vi.useRealTimers();
  });

  it('leaves liveness free of dependency I/O', () => {
    const harness = makeHarness();

    expect(harness.controller.liveness().status).toBe('ok');
    expect(harness.postgresCalls()).toBe(0);
    expect(harness.temporalCalls()).toBe(0);
  });
});
