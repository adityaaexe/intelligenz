/**
 * The opt-in predicate for contract cases that need a live model.
 *
 * Contract cases 7 (artifact checksums) and 8 (determinism) cannot pass against an
 * adapter that never runs, so they call a real provider. A suite whose *default* run
 * needs provider quota is not a gate: it turns red for environmental reasons and
 * teaches everyone to ignore red. The opt-in is therefore explicit and its absence is
 * printed, not implied.
 *
 * Deliberately a pure function of the environment: the default suite's behaviour is
 * testable without a provider, a credential, or a sandbox.
 */

export interface RealProviderGate {
  /** `true` only when `IZ_REAL_PROVIDER=1` **and** `AGENT_MODEL` is set. */
  readonly enabled: boolean;
  /** `null` when enabled; otherwise one line naming exactly what is missing. */
  readonly reason: string | null;
}

const LIVE_CASES = 'contract cases 7 and 8 need a live provider';

export function realProviderGate(env: NodeJS.ProcessEnv): RealProviderGate {
  const optIn = env['IZ_REAL_PROVIDER'];
  const model = (env['AGENT_MODEL'] ?? '').trim();

  if (optIn !== '1') {
    const detail =
      optIn === undefined || optIn.length === 0 ? 'not set' : `set to "${optIn}" rather than "1"`;

    return { enabled: false, reason: `IZ_REAL_PROVIDER ${detail} — ${LIVE_CASES}` };
  }

  if (model.length === 0) {
    return { enabled: false, reason: `AGENT_MODEL not set — ${LIVE_CASES} (IZ_REAL_PROVIDER=1)` };
  }

  return { enabled: true, reason: null };
}
