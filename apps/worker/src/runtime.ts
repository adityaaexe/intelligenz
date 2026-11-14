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
    const model = config.execution.model;
    const upstreamBaseUrl = config.execution.broker.upstreamBaseUrl;
    const credential = config.execution.broker.credential;

    // `loadWorkerConfig` refuses this combination at boot; the check is repeated here
    // because `createAgentRuntime` is also reachable from tests and scripts, and a
    // non-null assertion is how a security invariant becomes a runtime crash.
    if (model === undefined || upstreamBaseUrl === undefined || credential === undefined) {
      throw new Error(
        'opencode-cli requires AGENT_MODEL, AGENT_BROKER_UPSTREAM_URL and a credential ' +
          'source (AGENT_BROKER_CREDENTIAL or AGENT_BROKER_CREDENTIAL_ENV).',
      );
    }

    return new OpencodeCliRuntime({
      // Both are required by the adapter; a real run never guesses its boundary.
      workspaceRoot: config.workspace.root,
      // The adapter's per-run config, broker socket and raw transcript live here.
      // Deliberately **not** `artifactRoot`: its run layout adds
      // `opencode-cli/<uuid>-<suffix>/broker/broker.sock`, and a unix socket path over
      // 107 bytes is silently truncated by libuv — which presents as `ECONNRESET` on
      // every provider call, not as a configuration error. Evidence is copied into the
      // workspace by the worker; this directory is scratch.
      artifactsRoot: config.execution.scratchRoot,
      model,
      broker: {
        upstreamBaseUrl,
        credential,
        maxRequests: config.execution.broker.maxRequests,
      },
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
