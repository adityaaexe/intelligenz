/**
 * `@intelligenz/agent-runtime` — the runtime-neutral port (contract §8, §15 A4) and the
 * two implementations that exist in Phase 3: `LocalSimulatedRuntime` and
 * `OpencodeCliRuntime`.
 *
 * The port exists so that `apps/worker` never names a vendor (ADR-006).
 *
 * ## What each adapter guarantees
 *
 * - `LocalSimulatedRuntime` performs no work, spends nothing, and is labelled
 *   `simulated: true`. It is the default on purpose.
 * - `OpencodeCliRuntime` runs a real agent inside `bwrap`: read-only root, one
 *   read-write workspace bind, no network namespace, cleared environment. Its `network`
 *   capability is **false for the agent** — no general egress — with one adapter-owned
 *   channel: a proxy that accepts `CONNECT` only to an exact provider allowlist on port
 *   443. Resource ceilings (`prlimit`) and a mandatory spend cap apply. Post-run git
 *   evidence is collected inside the same sandbox, never on the host.
 *
 * ## What is still absent
 *
 * - **Port-level cost enforcement.** `budgetUsd` on the request remains advisory
 *   (contract §15 A7). The real adapter enforces its own `maxUsd`, which is a different
 *   thing: a cap on what the provider reports, not on what the platform authorised.
 * - **A container.** `bwrap` is namespaces and mounts, not a VM; the kernel is shared
 *   and the sandbox runs as the worker uid. See the Phase 3 security addendum.
 */

export * from './types';
export * from './errors';
export * from './registry';
export {
  LocalSimulatedRuntime,
  LOCAL_SIMULATED_ID,
  type LocalSimulatedRuntimeOptions,
} from './runtimes/local-simulated';
export {
  OpencodeCliRuntime,
  OPENCODE_CLI_ID,
  collectWorkspaceEvidence,
  type OpencodeCliRuntimeOptions,
  type WorkspaceEvidence,
} from './runtimes/opencode-cli';
export {
  parseOpencodeStream,
  type ParsedStream,
} from './runtimes/opencode-stream';
export {
  EGRESS_PORT,
  permitted,
  splitAuthority,
  startEgressProxy,
  type EgressProxy,
  type EgressProxyOptions,
  type EgressRequestLog,
} from './sandbox/egress-proxy';
export { runInProcessGroup, type GroupedProcessResult, type KillReason } from './process-group';
export { redact, redactAndTruncate, summarizeToolPayload } from './redact';
