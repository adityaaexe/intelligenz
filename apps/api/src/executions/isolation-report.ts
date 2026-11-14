import { ExecutionIsolation, IsolationRefusalError } from '@intelligenz/contracts';

/**
 * Reading an attempt's isolation report — one reader, two columns.
 *
 * The tier is recorded in two places because the platform has two outcomes, and neither
 * record can be invented at read time:
 *
 *   - **an attempt that ran** has an `AgentRun`, and the worker puts the report in
 *     `providerMeta.isolation` (the attempt has no JSON column of its own, and D-007
 *     forbids a migration). The run's own report is authoritative: it was written by the
 *     code that launched the process.
 *   - **a refused attempt** has no `AgentRun` at all — that is the point of the refusal —
 *     so the report rides on the attempt's `error` JSON, which is the only row that exists.
 *
 * `null` means **not recorded**: an attempt from before the tier existed, or one that ended
 * before the launch decision. It is deliberately not defaulted to
 * `restricted-shared-kernel`; a default would let the API describe an unrecorded run as
 * sandboxed, which is the exact claim D-007 exists to prevent.
 *
 * Both shapes are parsed with the same schemas the writer used, so a legacy or hand-edited
 * row that does not match becomes `null` instead of failing the whole executions response.
 */
export function readIsolationReport(input: {
  readonly providerMeta: unknown;
  readonly error: unknown;
}): ExecutionIsolation | null {
  const recorded = ExecutionIsolation.safeParse(providerMetaIsolation(input.providerMeta));

  if (recorded.success) return recorded.data;

  const refusal = IsolationRefusalError.safeParse(input.error);

  return refusal.success ? refusal.data.isolation : null;
}

function providerMetaIsolation(meta: unknown): unknown {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined;

  return (meta as Record<string, unknown>)['isolation'];
}
