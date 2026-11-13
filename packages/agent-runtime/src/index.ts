/**
 * `@intelligenz/agent-runtime` — the runtime-neutral port (contract §8, §15 A4) and
 * the one implementation Phase 2 ships: `LocalSimulatedRuntime`.
 *
 * The port exists so that `apps/worker` never names a vendor (ADR-006). It has never
 * been exercised against a real adapter, so treat `ExecutionRequest` as provisional:
 * there is no field for a repository checkout, an environment allowlist, a container
 * image, streaming progress, mid-run approval, or a partial artifact from a run that
 * failed after writing output. Expect a v2 at the first real adapter.
 *
 * ## What is deliberately absent
 *
 * - **No cost enforcement.** `budgetUsd` is recorded, never enforced (contract §15 A7).
 * - **No sandbox.** `allowedPaths` / `allowedActions` are advisory; this environment
 *   has no container runtime to enforce them with.
 * - **No vendor.** Not a single import, string or capability belongs to one.
 */

export * from './types';
export * from './errors';
export * from './registry';
export {
  LocalSimulatedRuntime,
  LOCAL_SIMULATED_ID,
  type LocalSimulatedRuntimeOptions,
} from './runtimes/local-simulated';
