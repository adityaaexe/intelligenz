import type { RiskClass, TaskPriority, TaskStatus } from '@intelligenz/contracts';

export type { TaskStatus };

export interface TaskResponse {
  readonly id: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly goal: string;
  readonly status: TaskStatus;
  readonly riskClass: RiskClass;
  readonly priority: TaskPriority;
  readonly acceptanceCriteria: readonly string[];
  readonly createdById: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
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

export interface AgentRunSummary {
  readonly id: string;
  readonly runtimeId: string;
  readonly model: string;
  readonly status: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** Decimal serialised as a string: `0.1985` must not become `0.19850000000000001`. */
  readonly costUsd: string | null;
}

export interface ArtifactSummary {
  readonly id: string;
  readonly kind: string;
  readonly uri: string;
  readonly checksum: string;
  readonly sizeBytes: number;
  readonly runtimeId: string;
  /**
   * Phase 4 provenance link. `null` means the artifact predates the column (or its
   * attempt was pruned); `unattributed` makes that explicit instead of letting a
   * consumer read `null` as "assume the latest run".
   */
  readonly attemptId: string | null;
  readonly unattributed: boolean;
  readonly createdAt: string;
}

export interface ApprovalSummary {
  readonly id: string;
  readonly status: string;
  readonly riskClass: RiskClass;
  readonly requestedById: string;
  readonly decidedById: string | null;
  readonly decisionNote: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  /** Phase 4 grant lifetime. Null on rows written before the columns existed. */
  readonly expiresAt: string | null;
  readonly consumedAt: string | null;
  readonly revokedAt: string | null;
}

export interface TaskDetailResponse extends TaskResponse {
  readonly project: { readonly id: string; readonly key: string; readonly name: string };
  readonly workspace: { readonly id: string; readonly name: string; readonly slug: string };
  /** Contract §6: "task detail incl. latest run + artifacts". */
  readonly latestRun: RunSummary | null;
  readonly artifacts: readonly ArtifactSummary[];
  /** Not in the table, but the approval gate is invisible without it on the detail screen. */
  readonly approvals: readonly ApprovalSummary[];
}

export interface PageMeta {
  readonly limit: number;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

export interface TaskPage {
  readonly data: TaskResponse[];
  readonly meta: PageMeta;
}

export interface RunResponse {
  readonly taskId: string;
  readonly workflowRunId: string;
  readonly workflowId: string;
  readonly temporalRunId: string;
  readonly status: 'queued';
}

export interface CancelResponse {
  readonly taskId: string;
  readonly status: 'cancelled';
  readonly workflowRunId: string | null;
  /** `not_found` is not a failure: Temporal had no execution to cancel. */
  readonly orchestrator: 'cancelled' | 'not_found';
}
