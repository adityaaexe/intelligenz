import { describe, expect, it } from 'vitest';

import {
  RESOURCE_PROFILES,
  ResourceProfileError,
  assertProfileAvailable,
  cpuCeilingFor,
  executionProfileLabel,
  getResourceProfile,
  selectResourceProfile,
} from '../src/resource-profiles';

/**
 * The profile table is a promise; these tests are the promise written down twice so a
 * silent edit to one copy fails.
 *
 * The numbers are the Phase 4 directive's, transcribed once into `resource-profiles.ts`.
 * Asserting them here is not redundancy: a resource ceiling that drifts because someone
 * "tidied" a constant is exactly the class of change that never gets reviewed.
 */

const MIB = 1024 * 1024;

describe('resource profile table', () => {
  it('has exactly the three profiles the directive defines', () => {
    expect(Object.keys(RESOURCE_PROFILES).sort()).toEqual(['HEAVY', 'SMALL', 'STANDARD']);
  });

  it.each([
    ['SMALL', 512 * MIB, 64, 50_000, 120_000, 5 * MIB, 0.1],
    ['STANDARD', 1024 * MIB, 128, 100_000, 300_000, 5 * MIB, 0.5],
    ['HEAVY', 2048 * MIB, 256, 200_000, 600_000, 10 * MIB, 2.0],
  ] as const)(
    '%s is memory=%i pids=%i cpuQuota=%i wall=%i output=%i usd=%f',
    (name, memory, pids, quota, wall, output, usd) => {
      const profile = getResourceProfile(name);

      expect(profile.memoryMaxBytes).toBe(memory);
      expect(profile.pidsMax).toBe(pids);
      expect(profile.cpuQuotaMicros).toBe(quota);
      expect(profile.cpuPeriodMicros).toBe(100_000);
      expect(profile.wallClockMs).toBe(wall);
      expect(profile.outputCapBytes).toBe(output);
      expect(profile.usdCapUsd).toBe(usd);
    },
  );

  it('is monotonically increasing in every dimension', () => {
    const order = ['SMALL', 'STANDARD', 'HEAVY'] as const;

    for (let index = 1; index < order.length; index += 1) {
      const previous = getResourceProfile(order[index - 1]!);
      const current = getResourceProfile(order[index]!);

      expect(current.memoryMaxBytes).toBeGreaterThan(previous.memoryMaxBytes);
      expect(current.pidsMax).toBeGreaterThan(previous.pidsMax);
      expect(current.cpuQuotaMicros).toBeGreaterThan(previous.cpuQuotaMicros);
      expect(current.wallClockMs).toBeGreaterThan(previous.wallClockMs);
      expect(current.usdCapUsd).toBeGreaterThan(previous.usdCapUsd);
    }
  });

  it('rejects an unknown name instead of defaulting', () => {
    expect(() => getResourceProfile('MEDIUM' as never)).toThrow(ResourceProfileError);
  });
});

describe('profile selection — server-owned', () => {
  it('maps risk class to profile when there is no override', () => {
    expect(
      selectResourceProfile({ riskClass: 'LOW', realRuntime: false, configured: undefined }).profile
        .name,
    ).toBe('SMALL');
    expect(
      selectResourceProfile({ riskClass: 'MEDIUM', realRuntime: false, configured: undefined })
        .profile.name,
    ).toBe('STANDARD');
    expect(
      selectResourceProfile({ riskClass: 'HIGH', realRuntime: false, configured: undefined }).profile
        .name,
    ).toBe('STANDARD');
    expect(
      selectResourceProfile({ riskClass: 'CRITICAL', realRuntime: false, configured: undefined })
        .profile.name,
    ).toBe('HEAVY');
  });

  it('raises a LOW task to STANDARD when a real adapter will run', () => {
    const selection = selectResourceProfile({
      riskClass: 'LOW',
      realRuntime: true,
      configured: undefined,
    });

    expect(selection.profile.name).toBe('STANDARD');
    expect(selection.reason).toContain('floor');
  });

  it('lets an operator override the policy, and says so', () => {
    const selection = selectResourceProfile({
      riskClass: 'LOW',
      realRuntime: true,
      configured: 'HEAVY',
    });

    expect(selection.profile.name).toBe('HEAVY');
    expect(selection.reason).toContain('WORKER_RESOURCE_PROFILE');
  });

  it('carries no input an agent could set', () => {
    // Whitespace-delimited and exhaustive on purpose: the input object is the whole
    // surface, and adding a field that a request body can reach should fail this test.
    const input = selectResourceProfile({ riskClass: 'LOW', realRuntime: true, configured: undefined });

    expect(Object.keys(input).sort()).toEqual(['profile', 'reason']);
  });
});

describe('enforcement availability', () => {
  it('refuses HEAVY when cgroup isolation is unavailable, with a reason that names the fix', () => {
    expect(() => assertProfileAvailable(getResourceProfile('HEAVY'), 'unavailable')).toThrow(
      /setup-cgroups\.sh/,
    );
  });

  it('allows SMALL and STANDARD without cgroups — they run as rlimit-only', () => {
    expect(() => assertProfileAvailable(getResourceProfile('SMALL'), 'unavailable')).not.toThrow();
    expect(() =>
      assertProfileAvailable(getResourceProfile('STANDARD'), 'unavailable'),
    ).not.toThrow();
  });

  it('allows every profile when cgroups are enforced', () => {
    for (const name of ['SMALL', 'STANDARD', 'HEAVY'] as const) {
      expect(() => assertProfileAvailable(getResourceProfile(name), 'enforced')).not.toThrow();
    }
  });

  it('labels the recorded profile truthfully in both modes', () => {
    expect(executionProfileLabel(getResourceProfile('STANDARD'), 'enforced')).toBe('standard');
    expect(executionProfileLabel(getResourceProfile('HEAVY'), 'enforced')).toBe('heavy');
    // The one value a downgraded run may write: it says what bounded the attempt, not
    // what was intended.
    expect(executionProfileLabel(getResourceProfile('STANDARD'), 'unavailable')).toBe(
      'rlimit-only',
    );
  });
});

describe('cpu ceiling', () => {
  it('derives quota × wall clock with 10% headroom', () => {
    // STANDARD: 1 CPU × 300 s = 300 000 000 µs, +10%.
    expect(cpuCeilingFor(getResourceProfile('STANDARD'))).toBe(330_000_000);
    // SMALL: 0.5 CPU × 120 s = 60 000 000 µs, +10%.
    expect(cpuCeilingFor(getResourceProfile('SMALL'))).toBe(66_000_000);
  });
});
