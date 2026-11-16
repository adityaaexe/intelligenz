import { describe, expect, it } from 'vitest';

import { loadConfig } from '../config/app-config';
import { isPlannerConfigured } from './planner-provider';

/**
 * The planner's boot-time configuration.
 *
 * Two properties are security properties, not preferences:
 *
 *   1. a base URL that is not HTTP(S) is refused at boot — `fetch` would happily read
 *      `file:///etc/passwd` and the response would then be parsed as a plan;
 *   2. an incomplete configuration means "not configured", never "fall back to
 *      something". A heuristic planner wearing a model's name is the failure this
 *      phase exists to prevent.
 */

const DATABASE_URL = 'postgresql://intelligenz:intelligenz@localhost:5432/intelligenz_test';
const JWT_SECRET = 'a3f1c9d47b2e80615af3c7d92b0e6481f5a9c3d7e2b4061893acd5f72e6b8140';

function load(extra: NodeJS.ProcessEnv) {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL,
    JWT_SECRET,
    ...extra,
  });
}

describe('loadConfig — PLANNER_*', () => {
  it('is unconfigured when no planner variable is set', () => {
    const config = load({});

    expect(config.planner).toEqual({
      baseUrl: null,
      apiKey: null,
      model: null,
      timeoutMs: 30_000,
      approvalTtlHours: 24,
    });
    expect(isPlannerConfigured(config.planner)).toBe(false);
  });

  it('is configured only when base URL, key and model are all present', () => {
    expect(
      isPlannerConfigured(
        load({
          PLANNER_BASE_URL: 'https://planner.example.test/v1',
          PLANNER_API_KEY: 'not-a-real-key',
          PLANNER_MODEL: 'some-model',
        }).planner,
      ),
    ).toBe(true);

    // A partial configuration is a deployment mistake, not "mostly working".
    expect(
      isPlannerConfigured(
        load({
          PLANNER_BASE_URL: 'https://planner.example.test/v1',
          PLANNER_MODEL: 'some-model',
        }).planner,
      ),
    ).toBe(false);
  });

  it('refuses a base URL that is not http: or https:', () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.test/plans', 'data:text/plain,hi']) {
      expect(() => load({ PLANNER_BASE_URL: url })).toThrow(/http:/i);
    }
  });

  it('refuses a base URL that is not a URL at all', () => {
    expect(() => load({ PLANNER_BASE_URL: 'not a url' })).toThrow(/valid URL/i);
  });

  it('strips a trailing slash so the request path is not doubled', () => {
    const config = load({ PLANNER_BASE_URL: 'http://127.0.0.1:8080/v1///' });

    expect(config.planner.baseUrl).toBe('http://127.0.0.1:8080/v1');
  });

  it('refuses a zero timeout or TTL rather than accepting an instant expiry', () => {
    expect(() => load({ PLANNER_TIMEOUT_MS: '0' })).toThrow(/at least 1/);
    expect(() => load({ PLANNER_APPROVAL_TTL_HOURS: '0' })).toThrow(/at least 1/);
  });
});
