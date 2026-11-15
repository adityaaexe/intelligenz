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
  SnapshotError,
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
  evidencePath,
} from './paths';

export {
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_TOTAL_BYTES,
  GIT_DIRECTORY,
  SNAPSHOT_VERSION,
  serialiseSnapshot,
  snapshotDigest,
  takeWorkspaceSnapshot,
  type SnapshotDigestInput,
  type SnapshotEntry,
  type SnapshotEntryKind,
  type SnapshotGitMetadata,
  type SnapshotHook,
  type SnapshotLimits,
  type SnapshotStopReason,
  type TakeSnapshotOptions,
  type WorkspaceSnapshot,
} from './snapshot';

export {
  DEFAULT_MAX_CHANGES,
  MANIFEST_VERSION,
  buildChangeManifest,
  manifestCounts,
  manifestDigest,
  serialiseManifest,
  type ChangeEntry,
  type ChangeManifest,
  type ChangeStatus,
  type EntryFingerprint,
  type ManifestDigestInput,
  type ManifestSide,
  type ManifestStopReason,
} from './manifest';

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
  type WorkspaceVolumeBinding,
  type WorkspaceVolumeOptions,
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
  type ExecSandboxedOptions,
  type ExecSandboxedResult,
} from './sandbox';

export {
  DEFAULT_VOLUME_MOUNT_ROOT,
  DEFAULT_VOLUME_REGISTRY,
  VOLUME_LOCK_FILE,
  VOLUME_REPO_DIR,
  VolumeError,
  clearVolume,
  createVolumePool,
  describeVolumes,
  discoverVolumes,
  isBounded,
  isMountPoint,
  readVolumeLock,
  readVolumeUsage,
  resolveVolumeMountRoot,
  resolveVolumeRegistry,
  volumesDisabled,
  writeVolumeLock,
  type VolumeClaimRefusal,
  type VolumeDescriptor,
  type VolumeDiscovery,
  type VolumeLease,
  type VolumeLockPayload,
  type VolumeLockState,
  type VolumePool,
  type VolumePoolOptions,
  type VolumeSet,
  type VolumeUnavailable,
  type VolumeUnavailableCode,
  type VolumeUsage,
} from './volumes';

export {
  BoundedCapture,
  TRUNCATION_MARKER_PREFIX,
  boundedCopyFile,
  captureStream,
  enforceTextCap,
  formatTruncationMarker,
  readTruncationMarker,
  removeTruncationSidecar,
  withArtifactBudget,
  type ArtifactBudget,
  type ArtifactBudgetResult,
  type BoundedCopyResult,
  type CaptureResult,
  type TruncationMarker,
} from './output-cap';
