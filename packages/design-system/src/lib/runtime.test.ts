import { describe, expect, it } from 'vitest';

import { isSimulatedRuntime, runtimeLabel } from './runtime';

/**
 * Contract §8 and §13: the product must never imply that a real coding agent
 * ran. The chip is derived from the reported `runtimeId`, so these two
 * functions are the guard.
 */
describe('isSimulatedRuntime', () => {
  it('recognises the identifier the worker actually persists', () => {
    expect(isSimulatedRuntime('local-simulated')).toBe(true);
  });

  it('is case and whitespace tolerant', () => {
    expect(isSimulatedRuntime(' Local-Simulated ')).toBe(true);
  });

  it('does not claim a real runtime is simulated', () => {
    expect(isSimulatedRuntime('claude-code')).toBe(false);
    expect(isSimulatedRuntime('opencode')).toBe(false);
  });

  it('treats absent identifiers as not simulated rather than asserting either way', () => {
    expect(isSimulatedRuntime(null)).toBe(false);
    expect(isSimulatedRuntime(undefined)).toBe(false);
    expect(isSimulatedRuntime('')).toBe(false);
  });
});

describe('runtimeLabel', () => {
  it('replaces the simulated identifier with the word Simulated', () => {
    expect(runtimeLabel('local-simulated')).toBe('Simulated');
  });

  it('passes a real runtime identifier through unchanged', () => {
    // An operator matching a log line needs the same string.
    expect(runtimeLabel('claude-code')).toBe('claude-code');
  });

  it('renders an absent identifier as an em dash', () => {
    expect(runtimeLabel(null)).toBe('—');
  });
});
