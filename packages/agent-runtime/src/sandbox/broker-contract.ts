import type { SandboxMount } from '@intelligenz/workspace-manager';

import { buildEphemeralStatePlan } from './state-mounts';

/**
 * The sandbox invocation, as data.
 *
 * This module exists so there is exactly one description of what a real run can see.
 * `OpencodeCliRuntime.execute()` builds its `bwrap` argv from it, and the isolation
 * tests build a probe from the same function. A test that re-typed the mount list would
 * pass while the adapter mounted something else — which is how the Phase 3 exposure
 * survived its own regression test.
 */

/**
 * Port the in-sandbox relay listens on. Loopback inside the sandbox's own network
 * namespace: reachable by the agent, and not a route to anything.
 */
export const BROKER_RELAY_PORT = 8899;

/** Container path of the broker socket, bound read-only from the per-attempt dir. */
export const BROKER_RELAY_SOCKET = '/run/agent-broker/broker.sock';

/**
 * Provider id in the generated config. Deliberately not a vendor name: the sandbox does
 * not know, and must not be able to choose, which provider the broker talks to.
 */
export const BROKER_PROVIDER_ID = 'izbroker';

/**
 * Environment variable carrying the per-attempt canary into the sandbox.
 *
 * The name does not match `/KEY|TOKEN|SECRET|PASSWORD/i`, which `buildSandboxCommand`
 * rejects — and it must not, because this is not a secret. It is a capability: proof
 * that a request came from this attempt's relay. It authenticates nothing upstream.
 */
export const BROKER_CANARY_ENV = 'IZ_BROKER_CAPABILITY';

/**
 * Resource ceilings, applied by `prlimit` in the entry shim.
 *
 * `bwrap` 0.11.1 on this host does not parse `--rlimit-*`, so these environment values
 * are the enforcement path; the builder emits the flags too on a bwrap that supports
 * them. They are also the reason `RLIMIT_FSIZE` is absent: the credential database used
 * to be copied up by an overlay and any per-file limit below 1 GiB killed the run. With
 * the database gone, a file-size ceiling would now be affordable — it is not added here
 * because it is a resource decision for the cgroup work (F3), not a credential one.
 */
export const RUNTIME_RLIMITS = {
  nofile: '1024',
  nproc: '4096',
  asBytes: String(6 * 1024 * 1024 * 1024),
} as const;

export interface RuntimeSandboxInput {
  /** Directory containing the `node` binary the shim and agent run on. */
  readonly nodeBinDir: string;
  /** Node installation root, mounted read-only (it also contains `opencode`). */
  readonly nodeRoot: string;
  /** Per-run config directory holding the generated `opencode.json`. */
  readonly configDir: string;
  /** Per-run directory holding `broker.sock`. */
  readonly brokerDir: string;
  /** Per-run directory holding the entry shim. */
  readonly entryDir: string;
  /** Per-attempt capability. A canary, never a provider credential. */
  readonly capability: string;
}

export interface RuntimeSandbox {
  readonly mounts: SandboxMount[];
  readonly env: Readonly<Record<string, string>>;
  readonly extraArgs: string[];
}

export function buildRuntimeSandbox(input: RuntimeSandboxInput): RuntimeSandbox {
  const state = buildEphemeralStatePlan();

  const mounts: SandboxMount[] = [
    { hostPath: input.entryDir, containerPath: '/opt/agent', mode: 'ro' },
    // The node installation that also contains `opencode`. Read-only: the agent must
    // not be able to modify its own runtime.
    { hostPath: input.nodeRoot, mode: 'ro' },
    { hostPath: input.configDir, containerPath: '/cfg', mode: 'ro' },
    // Connecting to a unix socket needs no write access, and a read-only bind means the
    // agent cannot replace the socket with one of its own.
    { hostPath: input.brokerDir, containerPath: '/run/agent-broker', mode: 'ro' },
  ];

  const env: Record<string, string> = {
    PATH: `${input.nodeBinDir}:/usr/local/bin:/usr/bin:/bin`,
    OPENCODE_CONFIG_DIR: '/cfg',
    XDG_DATA_HOME: '/xdg-data',
    XDG_STATE_HOME: '/xdg-state',
    XDG_CACHE_HOME: '/xdg-cache',
    XDG_CONFIG_HOME: '/xdg-config',
    // The relay's destination, and the per-attempt capability. No proxy variable is
    // set: there is no proxy, and a stale `HTTPS_PROXY` would send the model call
    // somewhere that does not exist.
    IZ_BROKER_SOCKET: BROKER_RELAY_SOCKET,
    IZ_BROKER_PORT: String(BROKER_RELAY_PORT),
    [BROKER_CANARY_ENV]: input.capability,
    AGENT_RLIMIT_NOFILE: RUNTIME_RLIMITS.nofile,
    AGENT_RLIMIT_NPROC: RUNTIME_RLIMITS.nproc,
    AGENT_RLIMIT_AS: RUNTIME_RLIMITS.asBytes,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    CI: '1',
  };

  return {
    mounts: [...mounts, ...state.mounts],
    env,
    // The XDG directories are created empty inside the sandbox root. Nothing is mounted
    // over them and nothing is copied up: the agent's session database is written here
    // and dies with the sandbox.
    extraArgs: state.dirs.flatMap((dir) => ['--dir', dir]),
  };
}
