import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Suite } from './helpers/app';
import { createTestApp, probeTemporal, startSuite } from './helpers/app';

/**
 * `/health` and `/health/ready` (contract §6, §15 A6).
 *
 * The readiness test does not assert "Temporal is up" — that would make the suite a
 * report on the host rather than on the code. It asserts the *contract of the probe*:
 * an unreachable orchestrator produces `503` with a per-dependency body, and the
 * answer always agrees with a direct probe of the configured address.
 */

let suite: Suite;
let unreachableApp: Awaited<ReturnType<typeof createTestApp>>;
let realApp: Awaited<ReturnType<typeof createTestApp>>;

beforeAll(async () => {
  suite = await startSuite();

  // A second instance pointed at a port nothing listens on. This is the only way to
  // test the failure branch deterministically without stopping a server other agents
  // on this host may be using.
  unreachableApp = await createTestApp({
    temporal: {
      address: '127.0.0.1:1',
      namespace: 'default',
      taskQueue: 'intelligenz-tasks',
    },
    readinessTimeoutMs: 750,
  });

  realApp = await createTestApp();
});

afterAll(async () => {
  await realApp.close();
  await unreachableApp.close();
  await suite.close();
});

interface HealthBody {
  status: string;
  service: string;
  uptimeSeconds: number;
}

interface ReadinessBody {
  status: 'ready' | 'not_ready';
  service: string;
  checks: {
    postgres: { status: 'up' | 'down'; latencyMs: number; detail?: string };
    temporal: { status: 'up' | 'down'; latencyMs: number; detail?: string };
  };
}

describe('GET /health', () => {
  it('answers without authentication and does not touch a dependency', async () => {
    const response = await request(suite.app.getHttpServer()).get('/health').expect(200);
    const body = response.body as HealthBody;

    expect(body.status).toBe('ok');
    expect(body.service).toBe('intelligenz-api');
    expect(typeof body.uptimeSeconds).toBe('number');
  });
});

describe('GET /health/ready', () => {
  it('reports 503 with per-dependency status when Temporal is unreachable', async () => {
    const response = await request(unreachableApp.getHttpServer()).get('/health/ready');

    expect(response.status).toBe(503);

    const body = response.body as ReadinessBody;

    expect(body.status).toBe('not_ready');
    expect(body.checks.postgres.status).toBe('up');
    expect(body.checks.temporal.status).toBe('down');
    expect(typeof body.checks.temporal.latencyMs).toBe('number');
    // A classification, never a raw driver message.
    expect(body.checks.temporal.detail).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('postgresql://');
  });

  it('never reports ready while a dependency is down', async () => {
    const body = (await request(unreachableApp.getHttpServer()).get('/health/ready'))
      .body as ReadinessBody;

    const bothUp =
      body.checks.postgres.status === 'up' && body.checks.temporal.status === 'up';

    // The invariant, stated independently of the asserted status code.
    expect(body.status === 'ready').toBe(bothUp);
    expect(body.status === 'not_ready').toBe(!bothUp);
  });

  it('agrees with a direct probe of the configured Temporal address', async () => {
    const probe = await probeTemporal();
    const response = await request(realApp.getHttpServer()).get('/health/ready');
    const body = response.body as ReadinessBody;

    expect(body.checks.postgres.status).toBe('up');

    if (probe.ok) {
      expect(response.status).toBe(200);
      expect(body.status).toBe('ready');
      expect(body.checks.temporal.status).toBe('up');
    } else {
      // Reachable proof for the skip: printing the reason makes the environment
      // visible in the reporter instead of hidden in a passing assertion.
      console.warn(`[health] Temporal is down in this environment: ${probe.reason}`);
      expect(response.status).toBe(503);
      expect(body.checks.temporal.status).toBe('down');
    }
  });
});
