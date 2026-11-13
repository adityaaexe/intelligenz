import {
  LOCAL_SIMULATED_ID,
  LocalSimulatedRuntime,
  OPENCODE_CLI_ID,
  OpencodeCliRuntime,
  runtimes,
  type AgentRuntime,
} from '@intelligenz/agent-runtime';

import { loadWorkerConfig, type WorkerConfig } from './config';

/**
 * **The runtime seam.** This is the only module that constructs an `AgentRuntime`, and
 * the only module an adapter swap has to touch.
 *
 * `executeAgentActivity` calls `getAgentRuntime()`; the workflow knows nothing about
 * it. Selection comes from `AGENT_RUNTIME` and defaults to `local-simulated`:
 *
 * | `AGENT_RUNTIME` | Adapter | Where it runs |
 * |---|---|---|
 * | `local-simulated` (default) | `LocalSimulatedRuntime` | nowhere; deterministic, $0 |
 * | `opencode-cli` | `OpencodeCliRuntime` | `bwrap`, in a disposable clone |
 *
 * The default is the simulated adapter on purpose. A real run spends provider credit
 * and touches a filesystem; making it the default would mean a deployment that forgot
 * one environment variable silently starts spending money (Phase 3 baseline §7).
 *
 * The instance is lazy and process-wide because an adapter owns connection state — a
 * per-activity instance would re-launch a sandbox for every task.
 */

let instance: AgentRuntime | undefined;

export function createAgentRuntime(config: WorkerConfig): AgentRuntime {
  if (config.execution.runtimeId === OPENCODE_CLI_ID) {
    return new OpencodeCliRuntime({
      // Both are required by the adapter; a real run never guesses its boundary.
      workspaceRoot: config.workspace.root,
      // The adapter's per-run config, egress socket and raw transcript live here.
      // Deliberately **not** `artifactRoot`: its run layout adds
      // `opencode-cli/<uuid>-<suffix>/egress/egress.sock`, and a unix socket path over
      // 107 bytes is silently truncated by libuv — which presents as `ECONNRESET` on
      // every provider call, not as a configuration error. Evidence is copied into the
      // workspace by the worker; this directory is scratch.
      artifactsRoot: config.execution.scratchRoot,
      ...(config.execution.model === undefined ? {} : { model: config.execution.model }),
      maxUsd: config.execution.maxUsd,
      ...(config.execution.bwrapPath === undefined
        ? {}
        : { bwrapPath: config.execution.bwrapPath }),
    });
  }

  return new LocalSimulatedRuntime({
    root: config.artifactRoot,
    stepDelayMs: config.runtime.stepDelayMs,
  });
}

export function getAgentRuntime(config: WorkerConfig = loadWorkerConfig()): AgentRuntime {
  if (instance !== undefined) return instance;

  instance = createAgentRuntime(config);

  if (!runtimes.has(instance.id)) runtimes.register(instance);

  return instance;
}

/**
 * Whether an adapter needs a leased directory to execute in.
 *
 * Only the real adapter does. Provisioning a git clone for `local-simulated` would
 * make every test and every demo pay for a filesystem boundary that nothing uses —
 * and would create `ExecutionWorkspace` rows that claim a directory mattered when it
 * did not. The decision is keyed on the adapter id, not on a capability probe,
 * because "needs a workspace" is a property of the implementation.
 */
export function runtimeRequiresWorkspace(runtimeId: string): boolean {
  return runtimeId !== LOCAL_SIMULATED_ID;
}

/** Test seam: drop the instance so a different configuration can be applied. */
export function resetAgentRuntime(): void {
  if (instance !== undefined && runtimes.has(instance.id)) runtimes.clear();
  instance = undefined;
}

export { LOCAL_SIMULATED_ID, OPENCODE_CLI_ID };
