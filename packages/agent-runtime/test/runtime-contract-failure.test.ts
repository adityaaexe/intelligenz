import { describe, expect, it } from 'vitest';

import type { ExecutionResult } from '../src';
import { explainNoSucceededExecution } from './runtime-contract';

/**
 * The probe failure is the message an operator reads at 2am. It must name the cause:
 * "no succeeded execution in 6 attempts" sent at least one reader looking for an
 * adapter defect when the provider's free tier was simply exhausted.
 */

function result(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    status: 'failed',
    summary: 'refused',
    artifacts: [],
    events: [],
    usage: {},
    runtimeId: 'opencode-cli',
    simulated: false,
    ...overrides,
  };
}

describe('explainNoSucceededExecution', () => {
  it('names quota for a 429 provider refusal instead of the attempt count', () => {
    const message = explainNoSucceededExecution(
      result({
        error: {
          code: 'PROVIDER_REFUSED',
          message:
            'The upstream provider answered 429 for all 6 model request(s). The credential was ' +
            'injected and accepted by the transport, so this is a provider-side refusal (quota, ' +
            'balance, or entitlement), not a sandbox or broker defect.',
          retryable: true,
        },
      }),
    );

    expect(message).toContain('quota');
    expect(message).toContain('HTTP 429');
    expect(message).not.toContain('no succeeded execution');
  });

  it('names quota for a RESOURCE_EXHAUSTED body even without a parsed status', () => {
    const message = explainNoSucceededExecution(
      result({
        error: {
          code: 'OPENCODE_EXIT_NONZERO',
          message: 'upstream error: RESOURCE_EXHAUSTED: free tier request limit reached',
          retryable: true,
        },
      }),
    );

    expect(message).toContain('quota');
    expect(message).not.toContain('no succeeded execution');
  });

  it('calls a non-429 refusal a refusal, not quota', () => {
    const message = explainNoSucceededExecution(
      result({
        error: {
          code: 'PROVIDER_REFUSED',
          message:
            'The upstream provider answered 403 for all 6 model request(s). The credential was ' +
            'injected and accepted by the transport.',
          retryable: false,
        },
      }),
    );

    expect(message).toContain('HTTP 403');
    expect(message).toContain('provider-side refusal');
    expect(message).not.toContain('quota');
  });

  it('keeps the attempt-count message for a failure that is not a provider refusal', () => {
    const message = explainNoSucceededExecution(result({ status: 'timeout' }));

    expect(message).toContain('no succeeded execution');
    expect(message).toContain('last status: timeout');
  });

  it('handles a probe that produced no result at all', () => {
    expect(explainNoSucceededExecution(undefined)).toContain('last status: none');
  });
});
