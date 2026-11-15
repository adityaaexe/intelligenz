import { Prisma } from '@intelligenz/database';
import { LOCAL_SIMULATED_ID, type ExecutionResult } from '@intelligenz/agent-runtime';

import type { PersistResultActivityInput, PersistResultActivityResult } from '../shared/contracts';
import { RUN_STATUS } from './attempts';
import { executionIdentity, requireExecutionClaim } from './claim';
import { agentRunIdFor, artifactIdFor, evidenceIdFor } from './ids';
import { db, nonRetryable } from './support';

/**
 * `persistResultActivity` — contract §16.
 *
 * Writes the durable record of a run: `AgentRun`, `ToolInvocation`, the attempt link,
 * `Artifact`, `Evidence`, and the terminal state of `WorkflowRun`.
 *
 * ## Idempotency
 *
 * Every row id is **derived** from the value that identifies the row (`activities/
 * ids.ts`), so a retried activity computes the same id and every write is an
 * `upsert`/`deleteMany + createMany`. A retry therefore updates the same rows. It
 * cannot create a second `Artifact` or a second attempt link.
 *
 * ## `simulated` is not decoration
 *
 * The value persisted is `result.simulated` — never a default, never inferred from
 * the runtime id. The one combination that is provably false (`local-simulated`
 * claiming `false`) is refused outright: a database that records a simulated run as
 * real makes every later "was this real?" query wrong.
 *
 * ## Tool invocations
 *
 * `ToolInvocation.summary` is already redacted by the adapter. This activity caps the
 * trace at 200 rows per run — a table every activity feed scans is the wrong home for
 * an unbounded trace — and records the truncation in `AgentRun.providerMeta` so the
 * gap is visible rather than silent.
 */

const SIMULATED_MODEL = 'simulated';

/** Phase 3 cap. A run that calls more tools than this has its trace truncated, not lost. */
const TOOL_INVOCATION_LIMIT = 200;

/**
 * The activity: **authority first, then the write** — Phase 6 re-review N4.
 *
 * `persistResultActivity` is a registered activity, so it is dispatched *by name* and any
 * workflow on this worker's task queue can call it without ever calling validation. It
 * used to read no claim: a Temporal caller could write an `AgentRun`, the attempt link and
 * the terminal `WorkflowRun` state for a task that never executed, which is the same
 * "dispatched by name" class as F1. It now requires the claim first, so a caller that holds
 * none gets a refusal and zero writes.
 *
 * The split is deliberate: `persistResult` is the ~350-line persistence body and is tested
 * directly as persistence; this wrapper is one guard and is tested as authority. Neither
 * test has to pretend to be the other.
 */
export async function persistResultActivity(
  input: PersistResultActivityInput,
): Promise<PersistResultActivityResult> {
  await requireExecutionClaim({
    orgId: input.orgId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    executionRunId: executionIdentity(),
  });

  return persistResult(input);
}

/** The persistence itself, with no authority check. Exported for its own tests. */
export async function persistResult(
  input: PersistResultActivityInput,
): Promise<PersistResultActivityResult> {
  const { taskId, orgId, result } = input;

  if (result.runtimeId === LOCAL_SIMULATED_ID && result.simulated === false) {
    throw nonRetryable(
      'SIMULATED_FLAG_INCONSISTENT',
      'A local-simulated result cannot be persisted with simulated=false.',
    );
  }

  return db().$transaction(async (transaction) => {
    const task = await transaction.task.findFirst({
      // Tenant scoping.
      where: { id: taskId, orgId },
      select: { id: true },
    });

    if (task === null) {
      throw nonRetryable('TASK_NOT_FOUND', `Task ${taskId} does not exist in this org.`);
    }

    // The run this result belongs to. There is exactly one live workflow per task
    // (workflow id `task-<taskId>` with REJECT_DUPLICATE), so "newest" is unambiguous.
    const run = await transaction.workflowRun.findFirst({
      where: { orgId, taskId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, startedAt: true },
    });

    if (run === null) {
      throw nonRetryable(
        'WORKFLOW_RUN_NOT_FOUND',
        `No WorkflowRun exists for task ${taskId}. recordStartActivity must run first.`,
      );
    }

    // The attempt `executeAgentActivity` opened. The newest one is the one this result
    // belongs to; a retried persist finds it already linked and recomputes the same
    // agent run id, which is what makes the retry idempotent rather than a duplicate.
    const attempt = await transaction.executionAttempt.findFirst({
      where: { orgId, workflowRunId: run.id },
      orderBy: { attemptNumber: 'desc' },
      select: { id: true, attemptNumber: true, agentRunId: true },
    });

    if (attempt === null) {
      throw nonRetryable(
        'EXECUTION_ATTEMPT_NOT_FOUND',
        `No ExecutionAttempt exists for workflow run ${run.id}; executeAgentActivity must run first.`,
      );
    }

    const finishedAt = new Date();
    const startedAt = run.startedAt ?? finishedAt;
    const status = RUN_STATUS[result.status];
    const error = result.error ?? null;

    const agentRunId =
      attempt.agentRunId ?? agentRunIdFor(run.id, result.runtimeId, attempt.attemptNumber);

    const workspaceId = await resolveWorkspaceId(transaction, {
      orgId,
      taskId,
      candidate: result.providerMeta?.['workspaceId'],
    });

    const invocations = normaliseInvocations(result);
    const truncation =
      invocations.total > TOOL_INVOCATION_LIMIT
        ? {
            total: invocations.total,
            persisted: TOOL_INVOCATION_LIMIT,
            truncated: true,
            reason: `ToolInvocation is capped at ${String(TOOL_INVOCATION_LIMIT)} rows per run.`,
          }
        : undefined;

    const providerMeta = mergeProviderMeta(result.providerMeta, truncation);
    const model = result.simulated
      ? SIMULATED_MODEL
      : ((result.providerMeta?.['model'] as string | undefined) ?? result.runtimeId);

    await transaction.agentRun.upsert({
      where: { id: agentRunId },
      create: {
        id: agentRunId,
        orgId,
        workflowRunId: run.id,
        runtimeId: result.runtimeId,
        model,
        status,
        startedAt,
        finishedAt,
        // The columns are `Int @default(0)`, so an unknown count is indistinguishable
        // from zero here. ADR-006 wants `undefined`; the schema cannot express it.
        tokensIn: result.usage.tokensIn ?? 0,
        tokensOut: result.usage.tokensOut ?? 0,
        costUsd: result.usage.usd ?? null,
        error: error === null ? Prisma.JsonNull : { ...error },
        attemptNumber: attempt.attemptNumber,
        workspaceId,
        // The adapter's own report, not a default (ADR-006, Phase 3 §7).
        simulated: result.simulated,
        runtimeVersion: result.runtimeVersion ?? null,
        providerMeta:
          providerMeta === undefined ? Prisma.JsonNull : (providerMeta as Prisma.InputJsonValue),
      },
      update: {
        status,
        finishedAt,
        tokensIn: result.usage.tokensIn ?? 0,
        tokensOut: result.usage.tokensOut ?? 0,
        costUsd: result.usage.usd ?? null,
        error: error === null ? Prisma.JsonNull : { ...error },
        attemptNumber: attempt.attemptNumber,
        workspaceId,
        simulated: result.simulated,
        runtimeVersion: result.runtimeVersion ?? null,
        providerMeta:
          providerMeta === undefined ? Prisma.JsonNull : (providerMeta as Prisma.InputJsonValue),
      },
      select: { id: true },
    });

    await transaction.executionAttempt.updateMany({
      where: { id: attempt.id, orgId },
      data: { agentRunId },
    });

    if (workspaceId !== null) {
      await transaction.executionWorkspace.updateMany({
        where: { id: workspaceId, orgId, taskId },
        data: { agentRunId },
      });
    }

    // Delete-then-insert, not upsert-per-row: the trace is replaced as a unit, so a
    // retry cannot leave a stale row from a longer previous trace.
    await transaction.toolInvocation.deleteMany({ where: { orgId, agentRunId } });

    if (invocations.rows.length > 0) {
      await transaction.toolInvocation.createMany({
        data: invocations.rows.map((row) => ({
          orgId,
          agentRunId,
          sequence: row.sequence,
          tool: row.tool,
          summary: row.summary,
          occurredAt: row.occurredAt,
        })),
      });
    }

    const artifactIds: string[] = [];
    const evidenceIds: string[] = [];

    for (const artifact of result.artifacts) {
      const artifactId = artifactIdFor(taskId, artifact.kind, artifact.checksum);
      const sizeBytes = BigInt(artifact.sizeBytes);

      await transaction.artifact.upsert({
        where: { id: artifactId },
        create: {
          id: artifactId,
          orgId,
          taskId,
          runtimeId: result.runtimeId,
          kind: artifact.kind,
          uri: artifact.uri,
          checksum: artifact.checksum,
          sizeBytes,
        },
        // `uri` can legitimately move (a different artifact root); the checksum is what
        // identifies the content, and it is part of the id.
        update: { uri: artifact.uri, sizeBytes },
        select: { id: true },
      });

      artifactIds.push(artifactId);

      const evidenceId = evidenceIdFor(taskId, artifact.kind, artifact.checksum);

      await transaction.evidence.upsert({
        where: { id: evidenceId },
        create: {
          id: evidenceId,
          orgId,
          taskId,
          kind: 'artifact_checksum',
          uri: artifact.uri,
          // The runtime instance, not a user: evidence says what produced the claim.
          producedBy: result.runtimeId,
        },
        update: { uri: artifact.uri },
        select: { id: true },
      });

      evidenceIds.push(evidenceId);
    }

    await transaction.workflowRun.updateMany({
      // Tenant scoping on the write, even though the row was resolved under a filter.
      where: { id: run.id, orgId },
      data: {
        status,
        finishedAt,
        error: error === null ? Prisma.JsonNull : { ...error },
      },
    });

    return { workflowRunId: run.id, agentRunId, artifactIds, evidenceIds };
  });
}

interface InvocationRow {
  readonly sequence: number;
  readonly tool: string;
  readonly summary: string;
  readonly occurredAt: Date;
}

/**
 * Validates the adapter's trace before it reaches the table.
 *
 * - **Sequence uniqueness** is a database constraint; a duplicate would abort the whole
 *   transaction, so duplicates are dropped here and counted as invalid.
 * - **Timestamps**: `occurredAt` is the adapter's observation. An unparsable value is
 *   dropped rather than replaced with "now" — inventing a time for something that
 *   happened elsewhere is exactly the mistake the schema comment warns about.
 */
function normaliseInvocations(result: ExecutionResult): {
  readonly rows: readonly InvocationRow[];
  readonly total: number;
} {
  const all = result.toolInvocations ?? [];
  const seen = new Set<number>();
  const rows: InvocationRow[] = [];

  for (const invocation of all) {
    if (rows.length >= TOOL_INVOCATION_LIMIT) break;
    if (seen.has(invocation.sequence)) continue;

    const occurredAt = new Date(invocation.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) continue;

    seen.add(invocation.sequence);
    rows.push({
      sequence: invocation.sequence,
      tool: invocation.tool,
      summary: invocation.summary,
      occurredAt,
    });
  }

  return { rows, total: all.length };
}

async function resolveWorkspaceId(
  transaction: Prisma.TransactionClient,
  input: { readonly orgId: string; readonly taskId: string; readonly candidate: unknown },
): Promise<string | null> {
  if (typeof input.candidate !== 'string' || input.candidate.length === 0) return null;

  const workspace = await transaction.executionWorkspace.findFirst({
    where: { id: input.candidate, orgId: input.orgId, taskId: input.taskId },
    select: { id: true },
  });

  return workspace?.id ?? null;
}

function mergeProviderMeta(
  meta: Record<string, unknown> | undefined,
  truncation: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (meta === undefined && truncation === undefined) return undefined;

  return jsonSafe({
    ...(meta ?? {}),
    ...(truncation === undefined ? {} : { toolInvocations: truncation }),
  }) as Record<string, unknown>;
}

/**
 * Prisma's JSON writer rejects `undefined` inside an object, and adapter metadata
 * legitimately contains it (`sessionId: undefined`). Round-tripping through JSON
 * drops those keys — the alternative is a persistence failure caused by a field that
 * is absent, which is the least interesting bug in the system.
 */
function jsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}
