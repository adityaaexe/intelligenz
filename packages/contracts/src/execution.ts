import { z } from 'zod';

import { RunStatus } from './enums';

/**
 * Execution identity, as the client sees it (Phase 3).
 *
 * These are **response** shapes, not request DTOs: nothing here is accepted from a
 * caller. They exist so `apps/api`, `apps/web` and any future client agree on one
 * description of "which attempt ran where, and what did it do" without importing
 * Prisma model types into the browser.
 *
 * Two rules are structural, not stylistic:
 *
 *   - **No absolute paths.** `ExecutionWorkspace.rootPath` and `Artifact.uri` are
 *     host paths. A client receives a workspace `id` and an artifact `uri` that is
 *     relative to a configured artifact root. A host path names a filesystem layout
 *     that the caller has no business knowing.
 *   - **`simulated` is required.** ADR-006: a client must be able to label every row
 *     real or simulated from the payload alone. A nullable flag would let a UI
 *     default to "real", which is the one lie this column exists to prevent.
 */

/**
 * Mirrors the Prisma `WorkspaceState` enum exactly. Postgres enum labels are
 * case-sensitive, so this list is the storage vocabulary and a rename in either
 * place is a migration — `workspace-manager`'s test suite asserts the two agree.
 */
export const WorkspaceState = z.enum([
  'requested',
  'provisioning',
  'ready',
  'executing',
  'preserving',
  'completed',
  'failed',
  'cancelled',
]);
export type WorkspaceState = z.infer<typeof WorkspaceState>;

/**
 * A workspace as reported to a client. `sourceKind` and `baseCommit` are the
 * reproducibility facts; `rootPath` is deliberately absent.
 */
export const ExecutionWorkspaceSummary = z
  .object({
    id: z.string().min(1),
    state: WorkspaceState,
    /** `clone` | `worktree` | `empty`. A string, because adapters add sources. */
    sourceKind: z.string().min(1),
    baseCommit: z.string().nullable(),
    branch: z.string().nullable(),
    readyAt: z.string().nullable(),
    cleanedAt: z.string().nullable(),
  })
  .strict();

export type ExecutionWorkspaceSummary = z.infer<typeof ExecutionWorkspaceSummary>;

/**
 * One redacted tool call. `summary` is already redacted by the adapter and capped
 * by the database at 500 characters; this schema repeats the cap so a caller can
 * validate before it renders, not after.
 */
export const ToolInvocationSummary = z
  .object({
    id: z.string().min(1),
    /** Monotonic within one run, starting at 1. Order by this, never by time. */
    sequence: z.number().int().positive(),
    tool: z.string().min(1),
    summary: z.string().max(500),
    occurredAt: z.string().min(1),
  })
  .strict();

export type ToolInvocationSummary = z.infer<typeof ToolInvocationSummary>;

/**
 * The worker persists `ExecutionResult.error` (`{ code, message, retryable }`)
 * verbatim, but a pre-dispatch failure can carry a different shape. `unknown`
 * keeps the wire schema honest instead of pretending every row is uniform.
 */
const ExecutionErrorShape = z.unknown();

/**
 * One execution of one workflow run.
 *
 * `runtimeVersion`, `tokensIn`, `tokensOut` and `costUsd` live on `AgentRun`; they
 * are flattened here because an attempt without its run's cost is not a useful row
 * to render. `durationMs` is derived (finished − started) and `null` while the
 * attempt is still open.
 */
export const ExecutionAttemptSummary = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    workflowRunId: z.string().min(1),
    /** 1-based position inside the workflow run. Unique with `workflowRunId`. */
    attemptNumber: z.number().int().positive(),
    runtimeId: z.string().min(1),
    runtimeVersion: z.string().nullable(),
    simulated: z.boolean(),
    status: RunStatus,
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    tokensIn: z.number().int().nonnegative(),
    tokensOut: z.number().int().nonnegative(),
    /** Decimal serialised as a string: `0.1985` must not become `0.19850000000000001`. */
    costUsd: z.string().nullable(),
    error: ExecutionErrorShape.nullable(),
    workspace: ExecutionWorkspaceSummary.nullable(),
  })
  .strict();

export type ExecutionAttemptSummary = z.infer<typeof ExecutionAttemptSummary>;

/**
 * Integrity is computed at **read** time, never stored as a boolean.
 *
 * `unknown` is not a soft `true`: it means the bytes could not be read (the file is
 * gone, or the artifact root moved). A UI must render it as "unverified", not as a
 * pass — the whole point of a checksum is that it is checked.
 */
export const ArtifactIntegrity = z.enum(['verified', 'failed', 'unknown']);
export type ArtifactIntegrity = z.infer<typeof ArtifactIntegrity>;

/**
 * Artifact metadata. `uri` is logical: relative to the artifact root that stores
 * the bytes, with posix separators, never an absolute host path.
 */
export const ExecutionArtifactSummary = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    runtimeId: z.string().min(1),
    kind: z.string().min(1),
    uri: z.string().min(1),
    checksum: z.string().regex(/^[a-f0-9]{64}$/, 'checksum must be lowercase hex SHA-256'),
    sizeBytes: z.number().int().nonnegative(),
    integrity: ArtifactIntegrity,
    createdAt: z.string().min(1),
  })
  .strict();

export type ExecutionArtifactSummary = z.infer<typeof ExecutionArtifactSummary>;
