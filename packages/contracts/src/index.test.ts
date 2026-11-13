import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from './index';

/**
 * Toolchain smoke test, not a behaviour test. It proves that vitest resolves
 * workspace sources and that the TS path mapping works, which is the only thing
 * this unit can honestly verify about the test runner.
 */
describe('@intelligenz/contracts', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@intelligenz/contracts');
  });
});
