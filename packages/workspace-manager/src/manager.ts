import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { ContainmentError, WorkspaceError } from './errors';
import {
  artifactsPath,
  assertContained,
  repositoryPath,
  resolveWorkspaceRoot,
  safeSegment,
  workspacePath,
} from './paths';
import { canTransition, assertTransition, type WorkspaceState } from './state';
import { buildSandboxCommand, execSandboxed } from './sandbox';
import {
  createVolumePool,
  discoverVolumes,
  isBounded,
  type VolumeDiscovery,
  type VolumeLease,
  type VolumePool,
} from './volumes';

const execFileAsync = promisify(execFile);

/**
 * `WorkspaceManager` — the filesystem boundary, with no database in sight.
 *
 * It takes plain ids and returns handles; the worker persists the handle into
 * `ExecutionWorkspace`. That split is deliberate: the manager is the only code that
 * may decide a path, and it must be testable without Postgres.
 *
 * ```
 * <root>/<orgId>/<taskId>/<workspaceId>   rootPath     0700, the lease
 *          .../repo                       repositoryPath  the checkout a run writes
 *          .../artifacts                  artifactsPath   survives cleanup
 * ```
 *
 * ## Rules this class enforces
 *
 * 1. **Every id is a segment.** `safeSegment` runs before a path is built, so a route
 *    value like `../escape` throws before `mkdir` is ever called.
 * 2. **Every path is checked twice.** Once by construction (`workspacePath`), once by
 *    `assertContained` against the resolved root, which follows symlinks.
 * 3. **Only its own directory.** `cleanup` recomputes the expected path from the ids
 *    and refuses a handle whose `rootPath` is anything else — so a forged handle
 *    cannot delete a sibling.
 * 4. **No shell.** `git` is invoked through `execFile` with an argv array.
 */
export type WorkspaceSource =
  | { readonly kind: 'clone'; readonly repoPath: string; readonly baseCommit?: string }
  | { readonly kind: 'worktree'; readonly repoPath: string; readonly baseCommit?: string }
  | { readonly kind: 'empty' };

export interface ProvisionRequest {
  readonly orgId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly source: WorkspaceSource;
}

export interface WorkspaceFailure {
  readonly stage: string;
  readonly message: string;
  readonly code: string;
}

export interface WorkspaceHandle {
  readonly id: string;
  readonly orgId: string;
  readonly taskId: string;
  /** Absolute, canonical, inside `WORKSPACE_ROOT`. The lease. */
  readonly rootPath: string;
  readonly sourceKind: WorkspaceSource['kind'];
  readonly baseCommit: string | null;
  readonly branch: string | null;
  /** Not in the Prisma row's shape verbatim; the worker maps it to `state`. */
  readonly state: WorkspaceState;
  /**
   * The checkout the sandbox gets as `/workspace`.
   *
   * In the default layout this is `<rootPath>/repo`. When a bounded volume is leased
   * (Gate D) it is `<volume>/repo`, i.e. the same path *shape* on a fixed-size block
   * device — which is what makes `ENOSPC` real rather than reported. The workspace root
   * itself stays at the id-derived path so the reaper's re-derivation, the artifact
   * directory and `assertOwnPath` keep working unchanged.
   */
  readonly repoPath: string;
  readonly createdAt: string;
  /** Present only when this workspace's checkout lives on a leased bounded volume. */
  readonly volume?: WorkspaceVolumeBinding;
  readonly error?: WorkspaceFailure;
}

/** What a bounded volume contributes to a handle. A statement, not a promise. */
export interface WorkspaceVolumeBinding {
  /** `vol-<n>`. Stable for the life of the mount, and the lock is keyed on it. */
  readonly id: string;
  readonly mountPath: string;
  /** `<major>:<minor>` of the backing loop device — the key `io.max` is written to. */
  readonly device: string;
  /** What `statfs` reports for the mounted filesystem, not the image's nominal size. */
  readonly totalBytes: number;
  /** True when a previous attempt on this volume left a checkout that was adopted. */
  readonly warmStart: boolean;
}

export interface WorkspaceVolumeOptions {
  /** `WORKSPACE_VOLUMES_ROOT`; default `/var/lib/intelligenz/mnt`. */
  readonly root?: string;
  /** `WORKSPACE_VOLUMES_REGISTRY`; default the setup script's manifest. */
  readonly registry?: string;
  /** A volume smaller than this is refused. `profile.diskQuotaBytes` in the worker. */
  readonly minBytes?: number;
  /** `false` disables volume mode even when the environment asks for it. */
  readonly enabled?: boolean;
}

export interface CleanupOptions {
  /**
   * Remove the checkout, keep `artifacts/`. True is the default because the
   * evidence a run produced is worth more than the bytes it edited, and the
   * alternative (delete everything) is what a retry can always recreate.
   */
  readonly keepArtifacts?: boolean;
}

export interface CleanupResult {
  readonly workspaceId: string;
  readonly rootPath: string;
  /** True when the workspace directory itself is gone (nothing was preserved). */
  readonly removed: boolean;
  /** True when `artifacts/` survived, which is the default. */
  readonly artifactsKept: boolean;
}

export interface WorkspaceManagerOptions {
  /** `WORKSPACE_ROOT`; default `.workspaces`. Resolved once, here. */
  readonly root?: string;
  /** Overridable for tests and for hosts with git outside `PATH`. */
  readonly gitBinary?: string;
  /**
   * Test seam. Called after the workspace directory exists and before the first git
   * command, so a test can hold provisioning open and then abandon it — the exact
   * crash `recover()` exists to repair. Production passes nothing.
   */
  readonly provisionGate?: () => Promise<void>;
  /**
   * Bounded volumes (Gate D). `false` opts out; omitted means "use the environment",
   * which is `WORKSPACE_VOLUMES_ROOT` and `WORKSPACE_VOLUMES` — the same way
   * `WORKSPACE_ROOT` is resolved. This is a manager-level decision, not a per-call one:
   * an attempt cannot ask for a bigger disk any more than it can ask for a bigger
   * memory profile.
   */
  readonly volumes?: WorkspaceVolumeOptions | false;
  /** Test seam: skip the filesystem probe and use this discovery result. */
  readonly volumeDiscovery?: VolumeDiscovery;
}

export interface WorkspaceManager {
  readonly root: string;
  provision(request: ProvisionRequest): Promise<WorkspaceHandle>;
  /** Validate and apply an edge. Throws `IllegalTransitionError` on anything else. */
  transition(workspaceId: string, to: WorkspaceState): WorkspaceHandle;
  cleanup(handle: WorkspaceHandle, options?: CleanupOptions): Promise<CleanupResult>;
  /** Re-register a handle loaded from the database, after a worker restart. */
  adopt(handle: WorkspaceHandle): WorkspaceHandle;
  recover(workspaceId: string): Promise<WorkspaceHandle>;
  get(workspaceId: string): WorkspaceHandle | undefined;
  /** What the disk boundary actually is on this host. Read by the boot log. */
  volumes(): Promise<VolumeDiscovery>;
  /** Leases this process currently holds, for diagnostics and the auditor. */
  volumeLeases(): Promise<readonly VolumeLease[]>;
}

const DIRECTORY_MODE = 0o700;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function createWorkspaceManager(options: WorkspaceManagerOptions = {}): WorkspaceManager {
  const root = resolveWorkspaceRoot(options.root);
  const gitBinary = options.gitBinary ?? 'git';
  const handles = new Map<string, WorkspaceHandle>();

  // ── Bounded volumes (Gate D) ──────────────────────────────────────────────────
  //
  // Discovered lazily and once. A discovery that throws is a discovery that reports
  // `unavailable`, never one that silently leaves the workspace unbounded-but-labelled:
  // `provision` refuses to run a volume-requiring profile without it, and the boot log
  // prints the reason.
  let poolPromise: Promise<VolumePool> | undefined;

  async function volumePool(): Promise<VolumePool> {
    poolPromise ??= (async () => {
      const discovery =
        options.volumeDiscovery ??
        (await discoverVolumes(
          options.volumes === false
            ? { disabled: true }
            : {
                ...(options.volumes === undefined ? {} : { enabled: true }),
                ...(options.volumes?.root === undefined ? {} : { root: options.volumes.root }),
                ...(options.volumes?.registry === undefined
                  ? {}
                  : { registry: options.volumes.registry }),
                ...(options.volumes?.minBytes === undefined
                  ? {}
                  : { minBytes: options.volumes.minBytes }),
                ...(options.volumes?.enabled === undefined
                  ? {}
                  : { enabled: options.volumes.enabled }),
              },
        ));

      return createVolumePool(discovery, { owner: `manager:${String(process.pid)}` });
    })();

    return poolPromise;
  }

  function volumeBinding(lease: VolumeLease): WorkspaceVolumeBinding {
    return {
      id: lease.volume.id,
      mountPath: lease.volume.mountPath,
      device: lease.volume.device,
      totalBytes: lease.usage.totalBytes,
      warmStart: lease.warmStart,
    };
  }

  /** The paths a handle's own fields imply — one place, so they cannot drift. */
  function repoPathOf(handle: Pick<WorkspaceHandle, 'rootPath' | 'repoPath'>): string {
    return handle.repoPath.length > 0 ? handle.repoPath : repositoryPath(handle.rootPath);
  }

  async function git(cwd: string, args: readonly string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync(gitBinary, [...args], {
        cwd,
        maxBuffer: 8 * 1024 * 1024,
        // `GIT_TERMINAL_PROMPT=0`: a clone against a credential-requiring remote must
        // fail rather than hang waiting for input that will never arrive.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });

      return stdout.trim();
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? '';
      throw new WorkspaceError(
        'WORKSPACE_PROVISION_FAILED',
        `git ${args.join(' ')} failed in ${cwd}: ${(stderr || String(error)).slice(0, 500)}`,
        { cause: error },
      );
    }
  }

  async function readHead(repoPath: string): Promise<{ commit: string | null; branch: string | null }> {
    try {
      const commit = await git(repoPath, ['rev-parse', 'HEAD']);
      const head = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);

      return { commit: commit || null, branch: head === 'HEAD' ? null : head || null };
    } catch {
      return { commit: null, branch: null };
    }
  }

  /**
   * Read `HEAD` from a checkout that may have been written by an agent.
   *
   * `readHead` runs `git` on the host. That is fine for a clone this function just
   * created, and **not** fine for a directory an agent may have touched: `.git/config`
   * and `.git/hooks/*` are agent-controlled input, and a host `git` executes them.
   * This variant runs the same query inside `bwrap` with the workspace's usual profile
   * (read-only root, one rw bind, no network), plus the config overrides that make a
   * hook or an external diff driver irrelevant even there.
   *
   * Used by the two paths that adopt an existing directory: `provision()`'s
   * idempotency branch and `recover()`. Both may see a repository left behind by an
   * earlier run, which is exactly the untrusted case.
   */
  async function readHeadSandboxed(
    workspace: Pick<WorkspaceHandle, 'rootPath' | 'repoPath'>,
  ): Promise<{ commit: string | null; branch: string | null }> {
    const command = buildSandboxCommand(
      { rootPath: workspace.rootPath, repoPath: repoPathOf(workspace) },
      [
        'git',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'diff.external=',
        // A global flag, so it also covers `rev-parse`: no index refresh writes, no
        // opportunistic lock file. The repository is agent-writable; a lock is a write.
        '--no-optional-locks',
        'rev-parse',
        'HEAD',
        '--abbrev-ref',
        'HEAD',
      ],
      {
        // Inside the sandbox. `GIT_CONFIG_NOSYSTEM`/`GIT_CONFIG_GLOBAL` keep the host's
        // git configuration out of a repository an agent may have written, and
        // `GIT_ATTR_NOSYSTEM` does the same for the system attributes file. `filter.*`
        // entries in the *repository's* config cannot be cleared generically (the clean
        // command is keyed by an arbitrary name), which is why the environment carrying
        // no secret is the control and this is defence in depth.
        env: {
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_ATTR_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
        },
      },
    );

    try {
      // `execSandboxed` binds `env: command.env`: the worker's environment is not
      // inherited by `bwrap`, so it is not readable at `/proc/1/environ` from inside.
      // The host inheritance here used to be the leak (audit F1).
      const { stdout } = await execSandboxed(command, {
        timeoutMs: 20_000,
        maxBuffer: 1024 * 1024,
      });

      const [commit, branch] = stdout
        .trim()
        .split('\n')
        .map((line) => line.trim());

      return {
        commit: commit === undefined || commit.length === 0 ? null : commit,
        branch: branch === undefined || branch === 'HEAD' || branch.length === 0 ? null : branch,
      };
    } catch {
      // The sandbox itself is not optional: `buildSandboxCommand` throws before this
      // point when `bwrap` is missing, and that error is not swallowed here.
      return { commit: null, branch: null };
    }
  }

  function remember(handle: WorkspaceHandle): WorkspaceHandle {
    handles.set(handle.id, handle);
    return handle;
  }

  /**
   * Recompute the path from the ids and refuse a handle that disagrees. This is what
   * makes `cleanup` unable to touch a sibling workspace: the ids are the authority,
   * `rootPath` is only a cached derivation of them.
   */
  async function assertOwnPath(handle: WorkspaceHandle): Promise<string> {
    const expected = workspacePath(root, {
      orgId: handle.orgId,
      taskId: handle.taskId,
      workspaceId: handle.id,
    });
    const resolvedExpected = await assertContained(root, expected);

    if (resolvedExpected !== handle.rootPath) {
      throw new ContainmentError(root, handle.rootPath);
    }

    return resolvedExpected;
  }

  async function provision(request: ProvisionRequest): Promise<WorkspaceHandle> {
    const orgId = safeSegment(request.orgId);
    const taskId = safeSegment(request.taskId);
    const workspaceId = safeSegment(request.workspaceId);

    if (request.source.kind === 'clone' || request.source.kind === 'worktree') {
      if (typeof request.source.repoPath !== 'string' || request.source.repoPath.length === 0) {
        throw new WorkspaceError('WORKSPACE_SOURCE_INVALID', 'A source repository path is required');
      }
    }

    const rootPath = workspacePath(root, { orgId, taskId, workspaceId });
    await assertContained(root, rootPath);

    // Idempotency, part 1: this process already has the handle.
    const known = handles.get(workspaceId);
    if (known !== undefined && (await exists(known.repoPath))) {
      return known;
    }

    // ── The disk boundary, claimed before the first byte ───────────────────────
    //
    // The volume is leased before anything is written, so the checkout's ceiling is a
    // property of the device from the first `clone` rather than something applied later.
    // A pool with no free volume refuses here — admission control, not a retry loop: the
    // aggregate a set of concurrent attempts can consume is (volumes × size), and
    // overcommitting it would make the quota a lie under load.
    const pool = await volumePool();
    const discovery = pool.discovery;
    let lease: VolumeLease | undefined;

    if (isBounded(discovery)) {
      try {
        lease = await pool.claim({ workspaceId });
      } catch (error) {
        const failure: WorkspaceFailure = {
          stage: 'volume',
          message: error instanceof Error ? error.message : String(error),
          code: error instanceof Error && 'code' in error ? String(error.code) : 'VOLUME_EXHAUSTED',
        };

        return remember({
          id: workspaceId,
          orgId,
          taskId,
          rootPath,
          sourceKind: request.source.kind,
          baseCommit: null,
          branch: null,
          state: 'failed',
          repoPath: repositoryPath(rootPath),
          createdAt: new Date().toISOString(),
          error: failure,
        });
      }
    }

    const repoPath = lease === undefined ? repositoryPath(rootPath) : lease.repoPath;
    const volume = lease === undefined ? undefined : volumeBinding(lease);

    // Idempotency, part 2: a previous process provisioned it and the checkout is
    // usable. A worker restart must not fail because the row outlived the manager.
    // The directory may also carry whatever a previous agent wrote into `.git`, so the
    // query runs inside the sandbox — never as a host `git` against agent content.
    if (await exists(join(repoPath, '.git'))) {
      const head = await readHeadSandboxed({ rootPath, repoPath });

      return remember({
        id: workspaceId,
        orgId,
        taskId,
        rootPath,
        sourceKind: request.source.kind,
        baseCommit: head.commit,
        branch: head.branch,
        state: 'ready',
        repoPath,
        ...(volume === undefined ? {} : { volume }),
        createdAt: new Date().toISOString(),
      });
    }

    const requested: WorkspaceHandle = {
      id: workspaceId,
      orgId,
      taskId,
      rootPath,
      sourceKind: request.source.kind,
      baseCommit: null,
      branch: null,
      state: 'requested',
      repoPath,
      ...(volume === undefined ? {} : { volume }),
      createdAt: new Date().toISOString(),
    };

    remember(requested);
    let stage = 'mkdir';

    try {
      await mkdir(rootPath, { recursive: true, mode: DIRECTORY_MODE });
      // `mkdir`'s mode is masked by the umask; the boundary is 0700 regardless.
      await chmod(rootPath, DIRECTORY_MODE);

      assertTransition('requested', 'provisioning');
      remember({ ...requested, state: 'provisioning' });

      if (options.provisionGate) await options.provisionGate();

      stage = 'source';

      if (request.source.kind === 'clone') {
        // The destination is the volume when one is leased: `git clone` writes the whole
        // checkout, so this is the write the disk quota has to cover.
        await git(rootPath, ['clone', '--no-hardlinks', request.source.repoPath, repoPath]);

        if (request.source.baseCommit) {
          await git(repoPath, ['checkout', '--detach', request.source.baseCommit]);
        }
      } else if (request.source.kind === 'worktree') {
        await git(request.source.repoPath, [
          'worktree',
          'add',
          '--detach',
          repoPath,
          request.source.baseCommit ?? 'HEAD',
        ]);
      } else {
        await mkdir(repoPath, { recursive: true, mode: DIRECTORY_MODE });
      }

      stage = 'head';

      // A directory without a HEAD is not `ready`: "the clone seemed to work" is not
      // evidence that a checkout exists, and a workspace that lies about its base
      // commit makes every later diff unattributable. `empty` has no repository by
      // definition, so it has no commit to report.
      const head =
        request.source.kind === 'empty'
          ? { commit: null, branch: null }
          : await readHead(repoPath);

      if (request.source.kind !== 'empty' && head.commit === null) {
        throw new WorkspaceError(
          'WORKSPACE_PROVISION_FAILED',
          `No usable git checkout at ${repoPath} after ${request.source.kind}`,
        );
      }

      assertTransition('provisioning', 'ready');

      return remember({
        ...requested,
        state: 'ready',
        baseCommit: head.commit,
        branch: head.branch,
      });
    } catch (error) {
      // Leave nothing that looks usable: a half-cloned directory that later passes
      // for `ready` is worse than a clean failure. The error is recorded, not hidden.
      await rm(rootPath, { recursive: true, force: true }).catch(() => undefined);

      // The volume is released on a failed provision: holding it would turn one bad
      // clone into a permanently unavailable slot. `clear` is default-on, which also
      // removes the half-written checkout from the volume.
      if (lease !== undefined) {
        await pool.release(lease).catch(() => undefined);
      }

      const failure: WorkspaceFailure = {
        stage,
        message: error instanceof Error ? error.message : String(error),
        code: error instanceof WorkspaceError ? error.code : 'WORKSPACE_PROVISION_FAILED',
      };

      const failed: WorkspaceHandle = { ...requested, state: 'failed', error: failure };
      remember(failed);

      return failed;
    }
  }

  function transition(workspaceId: string, to: WorkspaceState): WorkspaceHandle {
    const handle = handles.get(safeSegment(workspaceId));

    if (handle === undefined) {
      throw new WorkspaceError('WORKSPACE_NOT_FOUND', `Unknown workspace ${workspaceId}`);
    }

    assertTransition(handle.state, to);

    return remember({ ...handle, state: to });
  }

  async function cleanup(handle: WorkspaceHandle, cleanupOptions: CleanupOptions = {}): Promise<CleanupResult> {
    safeSegment(handle.id);
    const resolved = await assertOwnPath(handle);
    const keepArtifacts = cleanupOptions.keepArtifacts ?? true;

    // `completed`/`cancelled`: the run ended and its bytes were already dealt with here
    // in Phase 3, so a second sweep would be a no-op. `quarantined` is an explicit hold
    // (incident, evidence) and must never be touched by a cleanup path.
    if (
      handle.state === 'completed' ||
      handle.state === 'cancelled' ||
      handle.state === 'quarantined' ||
      handle.state === 'cleaned' ||
      handle.state === 'cleanup_failed'
    ) {
      return { workspaceId: handle.id, rootPath: resolved, removed: false, artifactsKept: false };
    }

    const current = handles.get(handle.id) ?? handle;

    if (current.state === 'ready' || current.state === 'executing') {
      remember({ ...current, state: 'preserving' });
    }

    const artifacts = artifactsPath(resolved);
    let artifactsKept = false;

    if (keepArtifacts && (await exists(artifacts))) {
      for (const entry of await readdir(resolved)) {
        if (entry === 'artifacts') {
          artifactsKept = true;
          continue;
        }

        await rm(join(resolved, entry), { recursive: true, force: true });
      }
    } else {
      await rm(resolved, { recursive: true, force: true });
    }

    // ── The volume goes back to the pool ────────────────────────────────────────
    //
    // Released last, and only for a handle this process leases. `release` clears the
    // device and removes the lock — never the workspace root, which is on the host and
    // holds `artifacts/`. Clearing a volume that was never leased by us is refused by
    // the pool (it is not in `held()`), which is what stops a forged handle from wiping
    // another attempt's checkout.
    if (handle.volume !== undefined) {
      const pool = await volumePool();
      const lease = pool.held().find((candidate) => candidate.volume.id === handle.volume?.id);

      if (lease !== undefined) {
        await pool.release(lease);
      }
    }

    const latest = handles.get(handle.id) ?? current;

    // Where a removed directory belongs in the lifecycle depends on where it came from.
    // A run that finished cleanly lands on `completed`; a workspace the reaper took over
    // (`cleanup_pending`, `allocated`, `finalizing`) lands on `cleaned`, because no run
    // completed in it. A state with no legal path to either is left alone: the row is
    // the record, and inventing an edge to make the diagram tidy is how a state machine
    // starts lying.
    for (const target of ['completed', 'cleaned', 'failed'] as const) {
      if (canTransition(latest.state, target)) {
        remember({ ...latest, state: target });
        break;
      }
    }

    return { workspaceId: handle.id, rootPath: resolved, removed: !artifactsKept, artifactsKept };
  }

  function adopt(handle: WorkspaceHandle): WorkspaceHandle {
    safeSegment(handle.orgId);
    safeSegment(handle.taskId);
    safeSegment(handle.id);

    return remember(handle);
  }

  async function recover(workspaceId: string): Promise<WorkspaceHandle> {
    const handle = handles.get(safeSegment(workspaceId));

    if (handle === undefined) {
      throw new WorkspaceError(
        'WORKSPACE_NOT_FOUND',
        `Cannot recover unknown workspace ${workspaceId}; adopt its row first`,
      );
    }

    if (handle.state !== 'provisioning') return handle;

    const dirExists = await exists(handle.rootPath);
    const repoExists = await exists(join(repoPathOf(handle), '.git'));

    if (!dirExists) {
      // Died before the first byte was written. Indistinguishable from "never
      // started", so it is requeued rather than failed.
      assertTransition('provisioning', 'requested');
      return remember({ ...handle, state: 'requested' });
    }

    if (!repoExists) {
      assertTransition('provisioning', 'failed');
      return remember({
        ...handle,
        state: 'failed',
        error: {
          stage: 'recover',
          code: 'WORKSPACE_PROVISION_FAILED',
          message: 'Directory exists but contains no .git; provisioning was interrupted',
        },
      });
    }

    const head = await readHeadSandboxed(handle);
    assertTransition('provisioning', 'ready');

    return remember({
      ...handle,
      state: 'ready',
      baseCommit: head.commit,
      branch: head.branch,
    });
  }

  function get(workspaceId: string): WorkspaceHandle | undefined {
    return handles.get(workspaceId);
  }

  async function volumes(): Promise<VolumeDiscovery> {
    return (await volumePool()).discovery;
  }

  async function volumeLeases(): Promise<readonly VolumeLease[]> {
    return (await volumePool()).held();
  }

  return { root, provision, transition, cleanup, adopt, recover, get, volumes, volumeLeases };
}
