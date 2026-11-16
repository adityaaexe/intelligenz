import { describe, expect, it } from 'vitest';

import { PROGRAMME_REASON_CODES } from '@intelligenz/contracts';

import { toFailureCode } from '../src/programmes/programmes.response';

/**
 * `Programme.failureCode` → the wire value.
 *
 * The column is nullable and the API must not turn that NULL into a second meaning. Three
 * cases, and the difference between them is the whole point of the column:
 *
 *   - a **succeeded** programme has no failure code (`null`), and `UNSPECIFIED` must never
 *     be returned for it — that value means "terminal, and this build cannot say why";
 *   - a programme that has not finished has no failure code either (`null`), because no
 *     failure has happened;
 *   - a **terminal non-success with a NULL column** — a row that predates the column, or one
 *     closed by an older worker — is `UNSPECIFIED`, explicitly.
 *
 * This is a unit test because the function is pure. The end-to-end half lives in
 * `apps/worker/test/programme-execution.test.ts`, which asserts what the workflow actually
 * writes (`null` on success, `APPROVAL_PENDING`/`DEADLINE_EXCEEDED`/`TASK_FAILED` on the
 * terminal failures it reaches).
 */
describe('programme failureCode on the wire', () => {
  it('answers null for a succeeded programme, never UNSPECIFIED', () => {
    // A success has no failure to classify. The column is NULL for one, and `UNSPECIFIED`
    // must not be manufactured from it — that value is reserved for a terminal non-success
    // this build cannot explain. (`finishProgrammeActivity` also clears the column on
    // success, so a `succeeded` row never carries a stale code to pass through.)
    expect(toFailureCode('succeeded', null)).toBeNull();
  });

  it('answers null for a programme that has not finished', () => {
    expect(toFailureCode('pending', null)).toBeNull();
    expect(toFailureCode('running', null)).toBeNull();
  });

  it('answers UNSPECIFIED for a terminal non-success with no stored code', () => {
    for (const status of ['failed', 'blocked', 'cancelled', 'timed_out']) {
      expect(toFailureCode(status, null), status).toBe('UNSPECIFIED');
    }
  });

  it('passes every known code through unchanged', () => {
    for (const code of PROGRAMME_REASON_CODES) {
      // `UNSPECIFIED` is a real stored value too: a workflow may write it deliberately.
      expect(toFailureCode('failed', code), code).toBe(code);
    }
  });

  it('degrades an unknown code to UNSPECIFIED instead of emitting it', () => {
    // Rolling deploy: a newer worker writes a code this build has never heard of. The field
    // is typed as the union, so returning the raw string would break the declared contract.
    expect(toFailureCode('failed', 'SOMETHING_A_NEWER_WORKER_WROTE')).toBe('UNSPECIFIED');
  });

  it('declares exactly the ten codes the contract documents', () => {
    expect([...PROGRAMME_REASON_CODES]).toEqual([
      'TASK_FAILED',
      'APPROVAL_PENDING',
      'DEPENDENCY_BLOCKED',
      'NO_READY_NODE',
      'DEADLINE_EXCEEDED',
      'ORCHESTRATOR_UNAVAILABLE',
      'START_FAILED',
      'GRAPH_INVALID',
      'CANCELLED',
      'UNSPECIFIED',
    ]);
  });
});
