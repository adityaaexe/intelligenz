import { LOCAL_SIMULATED_ID, LocalSimulatedRuntime, runtimes } from '@intelligenz/agent-runtime';

import { loadWorkerConfig, type WorkerConfig } from './config';

/**
 * **The runtime seam.** This is the only module that constructs an `AgentRuntime`, and
 * the only module an adapter swap has to touch.
 *
 * `executeAgentActivity` calls `getAgentRuntime()`; the workflow knows nothing about
 * it. Replacing `LocalSimulatedRuntime` with a real adapter is: implement the port in
 * `packages/agent-runtime`, register it here, keep the `AgentRuntime` return type.
 * Nothing in `src/workflows` changes.
 *
 * The instance is lazy and process-wide because an adapter owns connection state — a
 * per-activity instance would re-connect (or re-launch a sandbox) for every task.
 */

let instance: LocalSimulatedRuntime | undefined;

export function getAgentRuntime(config: WorkerConfig = loadWorkerConfig()): LocalSimulatedRuntime {
  if (instance !== undefined) return instance;

  instance = new LocalSimulatedRuntime({
    root: config.artifactRoot,
    stepDelayMs: config.runtime.stepDelayMs,
  });

  if (!runtimes.has(instance.id)) runtimes.register(instance);

  return instance;
}

/** Test seam: drop the instance so a different artifact root can be configured. */
export function resetAgentRuntime(): void {
  if (instance !== undefined && runtimes.has(instance.id)) runtimes.clear();
  instance = undefined;
}

export { LOCAL_SIMULATED_ID };
