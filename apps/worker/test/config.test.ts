import { describe, expect, it } from 'vitest';

import { DEFAULT_AGENT_MAX_USD, loadWorkerConfig, resolveArtifactRoot } from '../src/config';

/**
 * Configuration is a boot-time decision. A wrong artifact root is discovered when the
 * API cannot resolve a stored URI, long after the run that wrote it; a missing
 * `DATABASE_URL` should be a refusal to start, not a 500 on the first activity.
 */
describe('resolveArtifactRoot', () => {
  it('resolves a relative root against the workspace, not the process directory', () => {
    expect(resolveArtifactRoot('.artifacts', '/home/dev/intelligenz')).toBe(
      '/home/dev/intelligenz/.artifacts',
    );
  });

  it('defaults to .artifacts when unset or blank', () => {
    expect(resolveArtifactRoot(undefined, '/repo')).toBe('/repo/.artifacts');
    expect(resolveArtifactRoot('   ', '/repo')).toBe('/repo/.artifacts');
  });

  it('leaves an absolute root alone', () => {
    expect(resolveArtifactRoot('/var/lib/intelligenz/artifacts', '/repo')).toBe(
      '/var/lib/intelligenz/artifacts',
    );
  });
});

describe('loadWorkerConfig', () => {
  const base = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  };

  it('fails fast when DATABASE_URL is absent', () => {
    expect(() => loadWorkerConfig({})).toThrow(/DATABASE_URL is not set/);
  });

  it('applies the contract defaults', () => {
    const config = loadWorkerConfig({ ...base });

    expect(config.temporal.address).toBe('localhost:7233');
    expect(config.temporal.namespace).toBe('default');
    expect(config.temporal.taskQueue).toBe('intelligenz-tasks');
    // Below the activity's 60s start-to-close, so a timeout is reported as a timeout.
    expect(config.runtime.timeoutMs).toBeLessThan(60_000);
    expect(config.faultInjection.failExecuteOnce).toBe(false);
  });

  it('parses the documented dev levers', () => {
    const config = loadWorkerConfig({
      ...base,
      WORKER_FAULT_INJECT: 'noise, EXECUTE-ONCE',
      AGENT_TIMEOUT_MS: '1500',
      ARTIFACT_ROOT: '/tmp/artifacts',
    });

    expect(config.faultInjection.failExecuteOnce).toBe(true);
    expect(config.runtime.timeoutMs).toBe(1500);
    expect(config.artifactRoot).toBe('/tmp/artifacts');
  });

  /**
   * F3/F11: a real adapter with no cap is an unlimited purchase order.
   *
   * `AGENT_MAX_USD` used to be commented out in `.env.example` and `undefined` meant
   * "whatever the adapter defaults to" — which was also "no cap". Now it has a shipped
   * default, and a real runtime refuses to boot with a non-positive value.
   */
  it('ships a default spend cap rather than leaving a real runtime uncapped', () => {
    const config = loadWorkerConfig({ ...base, AGENT_RUNTIME: 'opencode-cli' });

    expect(config.execution.maxUsd).toBe(DEFAULT_AGENT_MAX_USD);
    expect(config.execution.maxUsd).toBeGreaterThan(0);
  });

  it('honours an explicit cap', () => {
    const config = loadWorkerConfig({ ...base, AGENT_RUNTIME: 'opencode-cli', AGENT_MAX_USD: '1.25' });

    expect(config.execution.maxUsd).toBe(1.25);
  });

  it('refuses a real runtime with a non-positive cap instead of running unlimited', () => {
    expect(() =>
      loadWorkerConfig({ ...base, AGENT_RUNTIME: 'opencode-cli', AGENT_MAX_USD: '0' }),
    ).toThrow(/AGENT_MAX_USD must be greater than 0/);
  });

  it('does not require a cap for the simulated runtime, which cannot spend', () => {
    const config = loadWorkerConfig({ ...base, AGENT_MAX_USD: '0' });

    expect(config.execution.runtimeId).toBe('local-simulated');
  });

  it('rejects a nonsense log level rather than silently logging everything', () => {
    expect(() => loadWorkerConfig({ ...base, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });
});
