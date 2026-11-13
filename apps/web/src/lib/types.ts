import type { ApprovalStatus, RiskClass, TaskStatus } from '@intelligenz/contracts';

/**
 * Wire types, transcribed from `apps/api/api-contract.md`.
 *
 * These live here rather than in `@intelligenz/contracts` because that package
 * is the *request* contract (Zod inputs and the enums); response shapes are not
 * modelled there. Enum names are imported so a value cannot drift between the
 * API and the client. If a shape here disagrees with the contract, the contract
 * wins and this file is the bug.
 */

export interface UserRef {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export interface WorkspaceRef {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

export interface Membership {
  readonly orgId: string;
  readonly orgName: string;
  readonly orgSlug: string;
  readonly role: Role;
  readonly workspaces: readonly WorkspaceRef[];
}

export interface LoginResponse {
  readonly accessToken: string;
  readonly tokenType: string;
  /** Seconds until the token expires. 15 minutes per contract §5. */
  readonly expiresIn: number;
  readonly user: UserRef;
  readonly memberships: readonly Membership[];
}

/* --- health ------------------------------------------------------------ */

export interface HealthCheck {
  readonly status: 'up' | 'down';
  readonly latencyMs: number;
  /** Classification only (`timeout`, `unavailable`, …), never a driver message. */
  readonly detail?: string;
}

export interface HealthReady {
  readonly status: 'ready' | 'not_ready' | string;
  readonly service: string;
  readonly checks: Readonly<Record<string, HealthCheck>>;
}

/* --- projects ---------------------------------------------------------- */

export type Environment = 'prod' | 'staging' | 'dev';

export interface Project {
  readonly id: string;
  readonly orgId: string;
  readonly workspaceId: string;
  readonly key: string;
  readonly name: string;
  readonly environment: Environment;
  readonly taskCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/* --- tasks ------------------------------------------------------------- */

export interface Task {
  readonly id: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly goal: string;
  readonly status: TaskStatus;
  readonly riskClass: RiskClass;
  readonly priority: 'low' | 'normal' | 'high' | 'urgent';
  readonly acceptanceCriteria: readonly string[];
  readonly createdById: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentRunSummary {
  readonly id: string;
  readonly runtimeId: string;
  readonly model: string;
  readonly status: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** Decimal serialised as a string, so `0.1985` cannot become `0.19850001`. */
  readonly costUsd: string | null;
}

export interface RunSummary {
  readonly id: string;
  readonly workflowId: string;
  readonly temporalRunId: string | null;
  readonly status: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly error: unknown;
  readonly createdAt: string;
  readonly agentRuns: readonly AgentRunSummary[];
}

export interface ArtifactSummary {
  readonly id: string;
  readonly kind: string;
  readonly uri: string;
  readonly checksum: string;
  readonly sizeBytes: number;
  readonly runtimeId: string;
  readonly createdAt: string;
}

export interface TaskApprovalSummary {
  readonly id: string;
  readonly status: string;
  readonly riskClass: RiskClass;
  readonly requestedById: string;
  readonly decidedById: string | null;
  readonly decisionNote: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

export interface TaskDetail extends Task {
  readonly project: { readonly id: string; readonly key: string; readonly name: string };
  readonly workspace: { readonly id: string; readonly name: string; readonly slug: string };
  readonly latestRun: RunSummary | null;
  readonly artifacts: readonly ArtifactSummary[];
  readonly approvals: readonly TaskApprovalSummary[];
}

/* --- executions (Phase 3) ---------------------------------------------- */

/** Mirrors `RunStatus` in `@intelligenz/contracts` — lower-case on the wire. */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

/** Mirrors the Prisma `WorkspaceState` enum (`packages/contracts/src/execution.ts`). */
export type ExecutionWorkspaceState =
  | 'requested'
  | 'provisioning'
  | 'ready'
  | 'executing'
  | 'preserving'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Integrity is computed at read time by the API hashing the bytes
 * (`api-contract.md` §Artifacts). `unknown` is not a soft pass: it means the
 * bytes could not be read at all.
 */
export type ArtifactIntegrity = 'verified' | 'failed' | 'unknown';

export interface ExecutionWorkspace {
  readonly id: string;
  readonly state: ExecutionWorkspaceState;
  readonly sourceKind: string;
  readonly baseCommit: string | null;
  readonly branch: string | null;
  readonly readyAt: string | null;
  readonly cleanedAt: string | null;
}

/**
 * One attempt, transcribed from `api-contract.md` §Executions.
 *
 * `simulated` is **required** in the contract and required here: a nullable flag
 * would let a component default to "real", which is the one lie the column
 * exists to prevent (ADR-006). Nothing in this app infers provenance from
 * `runtimeId`; see `lib/execution-state.ts`.
 */
export interface ExecutionAttempt {
  readonly id: string;
  readonly taskId: string;
  readonly workflowRunId: string;
  readonly attemptNumber: number;
  readonly runtimeId: string;
  readonly runtimeVersion: string | null;
  readonly simulated: boolean;
  readonly status: RunStatus;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** Decimal serialised as a string; `null` means "not reported", which is not `0`. */
  readonly costUsd: string | null;
  /** Shape is `ExecutionResult.error` or a pre-dispatch failure: not uniform. */
  readonly error: unknown;
  readonly workspace: ExecutionWorkspace | null;
}

/** One redacted tool call. `sequence` is monotonic inside a run, starting at 1. */
export interface ToolInvocation {
  readonly id: string;
  readonly sequence: number;
  readonly tool: string;
  readonly summary: string;
  readonly occurredAt: string;
}

export interface ExecutionArtifact {
  readonly id: string;
  readonly taskId: string;
  readonly runtimeId: string;
  readonly kind: string;
  readonly uri: string;
  readonly checksum: string;
  readonly sizeBytes: number;
  readonly integrity: ArtifactIntegrity;
  readonly createdAt: string;
  /** Added by the attempt-detail route; selects the download media type. */
  readonly mediaType?: string;
}

export interface ExecutionAttemptDetail {
  readonly attempt: ExecutionAttempt;
  readonly toolInvocations: readonly ToolInvocation[];
  readonly artifacts: readonly ExecutionArtifact[];
}

/* --- approvals --------------------------------------------------------- */

export interface Approval {
  readonly id: string;
  readonly taskId: string;
  readonly riskClass: RiskClass;
  readonly status: ApprovalStatus;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly task: {
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly riskClass: RiskClass;
    readonly projectId: string;
    readonly workspaceId: string;
  };
  readonly requestedBy: UserRef | null;
  readonly decidedBy: UserRef | null;
}

/* --- envelopes --------------------------------------------------------- */

export interface PageMeta {
  readonly limit: number;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly meta: PageMeta;
}

export interface DataEnvelope<T> {
  readonly data: T;
}
