/**
 * `@intelligenz/workspace-manager` — the filesystem boundary of one agent run.
 *
 * It owns three decisions and nothing else:
 *
 *   1. **where** a run may execute (`<root>/<orgId>/<taskId>/<workspaceId>`);
 *   2. **what** the run can touch once it is there (`bwrap` mount table);
 *   3. **when** the directory is doomed (the lifecycle state machine).
 *
 * It has no Prisma dependency on purpose: it takes plain ids and returns a handle,
 * and `apps/worker` persists that handle into `ExecutionWorkspace`. A package that
 * could write the database would eventually write the database.
 */

export {
  WorkspaceError,
  UnsafeSegmentError,
  ContainmentError,
  IllegalTransitionError,
  type WorkspaceErrorCode,
} from './errors';

export {
  safeSegment,
  assertContained,
  assertContainedSync,
  resolveWorkspaceRoot,
  workspacePath,
  repositoryPath,
  artifactsPath,
} from './paths';

export {
  WORKSPACE_STATES,
  WORKSPACE_TRANSITIONS,
  canTransition,
  assertTransition,
  isTerminal,
  isAbandonable,
  isReclaimable,
  type WorkspaceState,
} from './state';

export {
  reclaimWorkspace,
  preserveArtifacts,
  ReclaimRefusedError,
  type ReclaimIds,
  type ReclaimRefusal,
  type ReclaimRequest,
  type ReclaimResult,
} from './reclaim';

export {
  createWorkspaceManager,
  type CleanupOptions,
  type CleanupResult,
  type ProvisionRequest,
  type WorkspaceFailure,
  type WorkspaceHandle,
  type WorkspaceManager,
  type WorkspaceManagerOptions,
  type WorkspaceSource,
} from './manager';

export {
  buildSandboxCommand,
  bwrapFeatures,
  execSandboxed,
  probeSandbox,
  resolveBwrap,
  sandboxSpawnEnv,
  type SandboxCommand,
  type SandboxFeatures,
  type SandboxMount,
  type SandboxOptions,
  type SandboxProbeResult,
  type SandboxRlimits,
} from './sandbox';
