/**
 * Runtime identity.
 *
 * Contract §8 ships exactly one runtime: `LocalSimulatedRuntime`, which makes no
 * external calls. The product must never imply that a real coding agent ran
 * (contract §8, §13), so every surface that shows a row produced by a runtime
 * asks this module whether the row is simulated — the chip is derived from the
 * identifier the API reported, not from a build-time flag that can drift.
 */

/** Known simulated runtime identifiers, lower-cased. */
const SIMULATED_RUNTIME_IDS: ReadonlySet<string> = new Set(['local-simulated', 'simulated']);

export function isSimulatedRuntime(runtimeId: string | null | undefined): boolean {
  if (!runtimeId) {
    return false;
  }
  return SIMULATED_RUNTIME_IDS.has(runtimeId.trim().toLowerCase());
}

/**
 * `local-simulated` → `Simulated`; anything else is the reported identifier
 * verbatim. No prettifying of a real runtime name: an operator matching a log
 * line needs the same string.
 */
export function runtimeLabel(runtimeId: string | null | undefined): string {
  if (!runtimeId) {
    return '—';
  }
  return isSimulatedRuntime(runtimeId) ? 'Simulated' : runtimeId;
}
