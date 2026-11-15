import { Inject, Injectable } from '@nestjs/common';
import {
  ExecutionAttemptSummary,
  ToolInvocationSummary,
  type ExecutionWorkspaceSummary,
  type RunStatus,
} from '@intelligenz/contracts';
import type { Prisma, PrismaClient } from '@intelligenz/database';

import {
  ARTIFACT_LOCATOR,
  mediaTypeForArtifact,
  type ArtifactLocator,
} from '../artifacts/artifact-locator';
import { summariseArtifact, type ArtifactSummaryWithMedia } from '../artifacts/artifact-summary';
import { AppError } from '../common/errors';
import { PRISMA_CLIENT } from '../database/database.module';
import { readIsolationReport } from './isolation-report';

/**
 * Execution history.
 *
 * Answers three questions an operator asks after a run, in the order they ask them:
 *
 *   - "how many attempts were there, and did any of them really run?"  → list
 *   - "what did the third one do?"                                     → detail
 *   - "which of its files are still intact?"                           → artifacts
 *
 * ## Provenance is a foreign key, not a guess
 *
 * Phase 3 attributed an artifact to an attempt by comparing `(taskId, runtimeId,
 * createdAt)` against the attempt's time window. Two attempts in the same second, or a
 * clock that steps, produced the wrong answer and nothing detected it. Phase 4 adds
 * `Artifact.attemptId`, and this service reads it directly.
 *
 * Artifacts with `attemptId IS NULL` are **not** attributed by the heuristic any more:
 * they are reported as `unattributed: true`. That is the honest description of every
 * artifact written before the column existed, and of any whose attempt row was pruned
 * (the FK is `SetNull`, so the bytes' record survives and the link becomes unknown).
 */

/** The columns every attempt response needs. Kept as one `satisfies` so drift is a type error. */
const ATTEMPT_SELECT = {
  id: true,
  taskId: true,
  workflowRunId: true,
  attemptNumber: true,
  runtimeId: true,
  simulated: true,
  status: true,
  startedAt: true,
  finishedAt: true,
  error: true,
  agentRun: {
    select: {
      id: true,
      runtimeVersion: true,
      tokensIn: true,
      tokensOut: true,
      costUsd: true,
      simulated: true,
      error: true,
      // Phase 5 (D-007). The worker records the effective isolation tier here; without it
      // the API could only guess a tier from the profile label.
      providerMeta: true,
      executionWorkspace: {
        select: {
          id: true,
          state: true,
          sourceKind: true,
          baseCommit: true,
          branch: true,
          readyAt: true,
          cleanedAt: true,
        },
      },
    },
  },
} as const satisfies Prisma.ExecutionAttemptSelect;

type AttemptRow = Prisma.ExecutionAttemptGetPayload<{ select: typeof ATTEMPT_SELECT }>;

export interface ExecutionAttemptDetailResponse {
  readonly attempt: ExecutionAttemptSummary;
  readonly toolInvocations: readonly ToolInvocationSummary[];
  readonly artifacts: readonly ArtifactSummaryWithMedia[];
}

/** Results are capped, not paginated: a trace is browsed, not scrolled forever. */
const TOOL_INVOCATION_PAGE = 500;
const ARTIFACT_PAGE = 100;

@Injectable()
export class ExecutionsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(ARTIFACT_LOCATOR) private readonly locator: ArtifactLocator,
  ) {}

  async list(orgId: string, taskId: string): Promise<ExecutionAttemptSummary[]> {
    await this.assertTask(orgId, taskId);

    const attempts = await this.prisma.executionAttempt.findMany({
      // Tenant scoping.
      where: { orgId, taskId },
      // Newest first. `createdAt` leads because a task can have more than one
      // workflow run (a retry after a terminal failure starts its own run), and each
      // run numbers its attempts from 1 — so attempt number alone is not chronological
      // across runs. `attemptNumber` breaks the tie inside one run deterministically.
      orderBy: [{ createdAt: 'desc' }, { attemptNumber: 'desc' }],
      select: ATTEMPT_SELECT,
    });

    return attempts.map(toAttemptSummary);
  }

  async detail(
    orgId: string,
    taskId: string,
    attemptId: string,
  ): Promise<ExecutionAttemptDetailResponse> {
    await this.assertTask(orgId, taskId);

    const attempt = await this.prisma.executionAttempt.findFirst({
      // Tenant scoping plus the task in the path: an attempt id from another task is
      // not this task's history.
      where: { id: attemptId, orgId, taskId },
      select: ATTEMPT_SELECT,
    });

    if (attempt === null) throw AppError.notFound('Execution attempt');

    const [toolInvocations, artifacts] = await Promise.all([
      this.toolInvocations(orgId, attempt),
      this.artifactsFor(orgId, taskId, attempt),
    ]);

    return {
      attempt: toAttemptSummary(attempt),
      toolInvocations,
      artifacts,
    };
  }

  private async assertTask(orgId: string, taskId: string): Promise<void> {
    const task = await this.prisma.task.findFirst({
      // Tenant scoping: a task id from another organisation resolves to null → 404.
      where: { id: taskId, orgId },
      select: { id: true },
    });

    if (task === null) throw AppError.notFound('Task');
  }

  private async toolInvocations(
    orgId: string,
    attempt: AttemptRow,
  ): Promise<ToolInvocationSummary[]> {
    if (attempt.agentRun === null) return [];

    const rows = await this.prisma.toolInvocation.findMany({
      where: { orgId, agentRunId: attempt.agentRun.id },
      orderBy: { sequence: 'asc' },
      take: TOOL_INVOCATION_PAGE,
      select: {
        id: true,
        sequence: true,
        tool: true,
        summary: true,
        occurredAt: true,
      },
    });

    return rows.map((row) =>
      ToolInvocationSummary.parse({
        id: row.id,
        sequence: row.sequence,
        tool: row.tool,
        summary: row.summary,
        occurredAt: row.occurredAt.toISOString(),
      }),
    );
  }

  private async artifactsFor(
    orgId: string,
    taskId: string,
    attempt: AttemptRow,
  ): Promise<ArtifactSummaryWithMedia[]> {
    const rows = await this.prisma.artifact.findMany({
      // Tenant scoping, the task in the path, and the Phase 4 provenance link. No
      // time window: an artifact either names the attempt that produced it or says it
      // cannot. The old heuristic is deliberately gone — it guessed.
      where: { orgId, taskId, attemptId: attempt.id },
      orderBy: { createdAt: 'asc' },
      take: ARTIFACT_PAGE,
      select: {
        id: true,
        taskId: true,
        attemptId: true,
        runtimeId: true,
        kind: true,
        uri: true,
        checksum: true,
        sizeBytes: true,
        evidenceSource: true,
        authoritative: true,
        manifestDigest: true,
        createdAt: true,
      },
    });

    return Promise.all(
      rows.map((row) => summariseArtifact(this.locator, row, mediaTypeForArtifact(row.kind))),
    );
  }
}

function toAttemptSummary(row: AttemptRow): ExecutionAttemptSummary {
  const run = row.agentRun;
  const durationMs =
    row.startedAt !== null && row.finishedAt !== null
      ? Math.max(0, row.finishedAt.getTime() - row.startedAt.getTime())
      : null;

  return ExecutionAttemptSummary.parse({
    id: row.id,
    taskId: row.taskId,
    workflowRunId: row.workflowRunId,
    attemptNumber: row.attemptNumber,
    runtimeId: row.runtimeId,
    runtimeVersion: run?.runtimeVersion ?? null,
    // The attempt's own column is authoritative: it is written by the executor from
    // the adapter's report, and it exists even when no agent run was persisted (a
    // provisioning failure). The run's value is only used when the attempt has none.
    simulated: row.simulated,
    status: row.status satisfies RunStatus,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    durationMs,
    tokensIn: run?.tokensIn ?? 0,
    tokensOut: run?.tokensOut ?? 0,
    // Decimal → string, not number: `0.1985` must not become `0.19850000000000001`.
    costUsd: run?.costUsd?.toString() ?? null,
    error: row.error ?? run?.error ?? null,
    // Phase 5 (D-007): the tier the attempt required, the tier it ran under, and what that
    // tier does not provide. `null` is "not recorded", never a default.
    isolation: readIsolationReport({
      providerMeta: run?.providerMeta ?? null,
      error: row.error ?? null,
    }),
    workspace: run?.executionWorkspace === null || run?.executionWorkspace === undefined
      ? null
      : toWorkspaceSummary(run.executionWorkspace),
  });
}

function toWorkspaceSummary(workspace: {
  readonly id: string;
  readonly state: string;
  readonly sourceKind: string;
  readonly baseCommit: string | null;
  readonly branch: string | null;
  readonly readyAt: Date | null;
  readonly cleanedAt: Date | null;
}): ExecutionWorkspaceSummary {
  return {
    id: workspace.id,
    // Parsed by `ExecutionAttemptSummary.parse` above; the workspace state is the same
    // enum the database enforces, so a mismatch is a schema drift, not a runtime shape.
    state: workspace.state as ExecutionWorkspaceSummary['state'],
    sourceKind: workspace.sourceKind,
    baseCommit: workspace.baseCommit,
    branch: workspace.branch,
    readyAt: workspace.readyAt?.toISOString() ?? null,
    cleanedAt: workspace.cleanedAt?.toISOString() ?? null,
  };
}
