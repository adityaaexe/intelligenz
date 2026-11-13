import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';

import type { SandboxMount } from '@intelligenz/workspace-manager';

/**
 * The part of opencode's host state that a sandboxed run is allowed to see.
 *
 * ## The failure this replaces
 *
 * The adapter mounted `$HOME/.local/share`, `$HOME/.local/state` and `$HOME/.cache`
 * wholesale. Measured from inside a run, that exposed six provider credentials (other
 * agents' tokens), 696 sessions of operator history, a 1.07 GB database, `mcp-auth.json`
 * with MCP OAuth tokens, the agentmemory secret and the browser's NSS `key4.db`. The
 * agent's tool output is written verbatim to a transcript, so "readable inside the
 * sandbox" and "downloadable from the platform" were the same sentence.
 *
 * ## The allowlist
 *
 * Only opencode's own paths, and only the ones that exist:
 *
 * | Host path | Container path | Mode | Why |
 * |---|---|---|---|
 * | `<data>/opencode` | `/xdg-data/opencode` | ephemeral | the SQLite DB that holds provider auth |
 * | `<state>/opencode` | `/xdg-state/opencode` | ephemeral | locks and service metadata written at startup |
 * | `<cache>/opencode` | `/xdg-cache/opencode` | ephemeral | model catalogue cache |
 * | `<config>/opencode/auth.json` | `/xdg-config/opencode/auth.json` | ro | legacy credential file, if this version used it |
 *
 * Nothing else under `$HOME` is mounted. `$HOME` itself never is.
 *
 * ## Masks
 *
 * Inside `<data>/opencode`, two categories are replaced after the overlay mount:
 *
 * - `mcp-auth.json` (a file, masked with `/dev/null`): OAuth tokens for MCP servers
 *   this sandbox does not run and cannot use;
 * - `shell/`, `storage/`, `tool-output/`, `snapshot/`, `repos/`, `log/` (directories,
 *   masked with empty tmpfs): previous sessions' output. A run may still write to them
 *   — opencode's shell tool needs to — but the host's history is not visible.
 *
 * The database itself cannot be masked or narrowed: auth lives in it, and the agent
 * must authenticate to think. That residual — a credential and the operator's session
 * rows inside one SQLite file — is stated in the Phase 3 security addendum, and moving
 * auth into the egress proxy is the only way to remove it.
 */

const fileExists = (path: string): Promise<boolean> =>
  access(path, fsConstants.F_OK).then(
    () => true,
    () => false,
  );

/** Directories inside the data dir that hold previous sessions' output. */
export const OPERATOR_DATA_DIRECTORIES = [
  'shell',
  'storage',
  'tool-output',
  'snapshot',
  'repos',
  'log',
] as const;

export interface StateMountInput {
  /** Host `XDG_DATA_HOME` (`~/.local/share`). */
  readonly dataHome: string;
  /** Host `XDG_STATE_HOME` (`~/.local/state`). */
  readonly stateHome: string;
  /** Host `XDG_CACHE_HOME` (`~/.cache`). */
  readonly cacheHome: string;
  /** Host `XDG_CONFIG_HOME` (`~/.config`). */
  readonly configHome: string;
}

export interface StateMountPlan {
  readonly mounts: SandboxMount[];
  /** XDG base directories to create inside the sandbox, mounted or not. */
  readonly dirs: string[];
  /** Container paths to replace with an empty tmpfs, after the overlay is applied. */
  readonly masks: string[];
}

export const XDG_DIRECTORIES = ['/xdg-data', '/xdg-state', '/xdg-cache', '/xdg-config'] as const;

export async function buildOpencodeStateMounts(input: StateMountInput): Promise<StateMountPlan> {
  const mounts: SandboxMount[] = [];
  const masks: string[] = [];

  const data = join(input.dataHome, 'opencode');

  if (await fileExists(data)) {
    // Ephemeral overlay: read the real database, write into an invisible tmpfs, never
    // modify the host copy, and never let one run poison the next run's session state.
    mounts.push({ hostPath: data, containerPath: '/xdg-data/opencode', mode: 'ephemeral' });

    const mcpAuth = join(data, 'mcp-auth.json');

    if (await fileExists(mcpAuth)) {
      // `/dev/null` is the cheapest way to make a file unreadable without deleting it.
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/xdg-data/opencode/mcp-auth.json',
        mode: 'ro',
      });
    }

    for (const directory of OPERATOR_DATA_DIRECTORIES) {
      if (await fileExists(join(data, directory))) {
        masks.push(`/xdg-data/opencode/${directory}`);
      }
    }
  }

  const state = join(input.stateHome, 'opencode');

  if (await fileExists(state)) {
    mounts.push({ hostPath: state, containerPath: '/xdg-state/opencode', mode: 'ephemeral' });
  }

  const cache = join(input.cacheHome, 'opencode');

  if (await fileExists(cache)) {
    mounts.push({ hostPath: cache, containerPath: '/xdg-cache/opencode', mode: 'ephemeral' });
  }

  const legacyAuth = join(input.configHome, 'opencode', 'auth.json');

  if (await fileExists(legacyAuth)) {
    mounts.push({
      hostPath: legacyAuth,
      containerPath: '/xdg-config/opencode/auth.json',
      mode: 'ro',
    });
  }

  return { mounts, dirs: [...XDG_DIRECTORIES], masks };
}
