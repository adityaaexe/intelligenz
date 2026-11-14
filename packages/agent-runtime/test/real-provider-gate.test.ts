import { describe, expect, it } from 'vitest';

import { realProviderGate } from './real-provider-gate';

/**
 * The gate is what keeps the default suite offline. If it ever returns `enabled: true`
 * without an explicit opt-in, `pnpm -w test` starts spending provider quota again — so
 * each branch is asserted here, with plain objects and no environment contact.
 */

describe('realProviderGate', () => {
  it('skips when IZ_REAL_PROVIDER is unset, even with a model configured', () => {
    const gate = realProviderGate({ AGENT_MODEL: 'gemini-3.5-flash-lite' });

    expect(gate.enabled).toBe(false);
    expect(gate.reason).toContain('IZ_REAL_PROVIDER not set');
    expect(gate.reason).toContain('contract cases 7 and 8 need a live provider');
  });

  it('skips when IZ_REAL_PROVIDER is set to anything but "1"', () => {
    const gate = realProviderGate({
      IZ_REAL_PROVIDER: 'true',
      AGENT_MODEL: 'gemini-3.5-flash-lite',
    });

    expect(gate.enabled).toBe(false);
    expect(gate.reason).toContain('rather than "1"');
  });

  it('skips when opted in but AGENT_MODEL is missing', () => {
    const gate = realProviderGate({ IZ_REAL_PROVIDER: '1' });

    expect(gate.enabled).toBe(false);
    expect(gate.reason).toContain('AGENT_MODEL not set');
  });

  it('skips when AGENT_MODEL is only whitespace', () => {
    const gate = realProviderGate({ IZ_REAL_PROVIDER: '1', AGENT_MODEL: '   ' });

    expect(gate.enabled).toBe(false);
    expect(gate.reason).toContain('AGENT_MODEL not set');
  });

  it('runs only when opted in and a model is named', () => {
    const gate = realProviderGate({
      IZ_REAL_PROVIDER: '1',
      AGENT_MODEL: 'gemini-3.5-flash-lite',
    });

    expect(gate).toEqual({ enabled: true, reason: null });
  });
});
