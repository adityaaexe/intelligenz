import type { SandboxMount } from '@intelligenz/workspace-manager';

/**
 * The opencode state a sandboxed run is allowed to see: **none of the host's**.
 *
 * ## What this replaces, and why the replacement is deletion
 *
 * Phase 3 mounted four host paths into the sandbox (`<data>/opencode`,
 * `<state>/opencode`, `<cache>/opencode`, and a legacy `auth.json`), then masked the
 * parts it could. The audit measured what remained readable from inside a run:
 *
 * ```
 * /xdg-data/opencode:
 *   opencode.db      1,068,654,592 bytes   <- the provider credential
 *   mcp-auth.json    masked
 *   shell/ storage/ tool-output/ snapshot/ repos/ log/   masked
 * ```
 *
 * Masking could not be extended to the database, because authentication lived in it:
 * opencode had to open the credential to call the model, so the agent could open it
 * too. The residual was stated honestly in the Phase 3 addendum and it was still a
 * live provider key, shared by every org's runs, inside a shell-capable sandbox.
 *
 * Phase 4 removes the requirement instead of narrowing the mount. Authentication is
 * terminated by the host egress broker (`@intelligenz/egress-broker`), so the agent
 * never needs a credential and never needs this directory. What it gets is an empty,
 * writable, per-run tree on the sandbox's own tmpfs:
 *
 * | Path | Content | Lifetime |
 * |---|---|---|
 * | `/xdg-data/opencode` | the run's own session SQLite file | dies with the sandbox |
 * | `/xdg-state/opencode` | locks and service metadata | dies with the sandbox |
 * | `/xdg-cache/opencode` | model catalogue cache | dies with the sandbox |
 * | `/xdg-config` | writable, empty; the real config is read-only at `/cfg` | dies with the sandbox |
 *
 * The consequence is deliberate: this run cannot see another run's session, cannot see
 * the operator's history, and has no credential to leak. A session database written
 * here contains only what this agent did.
 *
 * ## The signature is the control
 *
 * This function takes no arguments. There is no `dataHome`, no `configHome`, and no
 * path it could mount even if a future caller passed one — a caller cannot reintroduce
 * the Phase 3 mount without changing this file and its tests. That is a stronger
 * guarantee than a comment saying "do not mount $HOME".
 */

export interface EphemeralStatePlan {
  /** Always empty. The host mounts nothing into the state tree. */
  readonly mounts: SandboxMount[];
  /** Directories to create inside the sandbox root. Empty and writable. */
  readonly dirs: string[];
  /** Always empty. There is nothing to mask when nothing is mounted. */
  readonly masks: string[];
}

/** XDG base directories. Created even when nothing is mounted over them. */
export const XDG_DIRECTORIES = [
  '/xdg-data',
  '/xdg-state',
  '/xdg-cache',
  '/xdg-config',
] as const;

/** Per-run opencode state directories. Empty, writable, and ephemeral. */
export const OPENCODE_STATE_DIRECTORIES = [
  '/xdg-data/opencode',
  '/xdg-state/opencode',
  '/xdg-cache/opencode',
] as const;

export function buildEphemeralStatePlan(): EphemeralStatePlan {
  return {
    mounts: [],
    dirs: [...XDG_DIRECTORIES, ...OPENCODE_STATE_DIRECTORIES],
    masks: [],
  };
}
