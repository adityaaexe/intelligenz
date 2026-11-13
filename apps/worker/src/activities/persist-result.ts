import { Prisma } from '@intelligenz/database';
import type { RunStatus } from '@intelligenz/database';
import type { ExecutionResult } from '@intelligenz/agent-runtime';

import type {
  PersistResultActivityInput,
  PersistResultActivityResult,
} from '../shared/contracts';
import {
  agentRunIdFor,
  artifactIdFor,
  evidenceIdFor,
} from './ids';
import { db, nonRetryable } from './support';

/**
 * `persistResultActivity` — contract §16.
 *
 * Writes the durable record of a run: `AgentRun`, `Artifact`, `Evidence`, and the
 * terminal state of `WorkflowRun`.
 *
 * ## Idempotency, and why it is not a constraint
 *
 * The schema has **no** unique constraint on `(taskId, kind, checksum)` for `Artifact`,
 * none for `AgentRun`, and none for `Evidence` (see the follow-up in this unit's
 * report). Contract §16 asks for the nullability to be closed by a constraint; this
 * unit may not alter the schema, so it closes it structurally instead:
 *
 *   - every row id is **derived** from the value that identifies the row
 *     (`activities/ids.ts`), so a retried activity computes the same id;
 *   - every write is an `upsert` on that primary key;
 *   - the whole set is one transaction, so a crash cannot leave an artifact without its
 *     evidence row.
 *
 * A retry therefore updates the same rows. It cannot create a second `Artifact`, and the
 * proof is a `SELECT count(*)`, not a claim.
 *
 * ## AgentRun.model
 *
 * `AgentRun.model` is non-null and means "which model produced this". A simulated
 * runtime calls no model, so the value is `simulated` rather than a plausible-looking
 * model name. A real adapter fills it from its own metadata.
 */

/** The schema's `RunStatus` vocabulary, mapped from the port's narrower one. */
const RUN_STATUS: Record<ExecutionResult['status'], RunStatus> = {
  succeeded: 'succeeded',
  failed: 'failed',
  timeout: 'timed_out',
  cancelled: 'cancelled',
};

const SIMULATED_MODEL = 'simulated';

export async function persistResultActivity(
  input: PersistResultActivityInput,
): Promise<PersistResultActivityResult> {
  const { taskId, orgId, result } = input;

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

    const finishedAt = new Date();
    const startedAt = run.startedAt ?? finishedAt;
    const status = RUN_STATUS[result.status];
    const error = result.error ?? null;

    const agentRunId = agentRunIdFor(run.id, result.runtimeId);

    await transaction.agentRun.upsert({
      where: { id: agentRunId },
      create: {
        id: agentRunId,
        orgId,
        workflowRunId: run.id,
        runtimeId: result.runtimeId,
        // A simulated runtime calls no model. `simulated` is the honest value; a model
        // name here would be an invented fact in the UI (ADR-006).
        model: result.simulated ? SIMULATED_MODEL : result.runtimeId,
        status,
        startedAt,
        finishedAt,
        // The columns are `Int @default(0)`, so an unknown count is indistinguishable
        // from zero here. ADR-006 wants `undefined`; the schema cannot express it —
        // reported as a follow-up rather than worked around with a sentinel.
        tokensIn: result.usage.tokensIn ?? 0,
        tokensOut: result.usage.tokensOut ?? 0,
        costUsd: result.usage.usd ?? null,
        error: error === null ? Prisma.JsonNull : { ...error },
      },
      update: {
        status,
        finishedAt,
        tokensIn: result.usage.tokensIn ?? 0,
        tokensOut: result.usage.tokensOut ?? 0,
        costUsd: result.usage.usd ?? null,
        error: error === null ? Prisma.JsonNull : { ...error },
      },
      select: { id: true },
    });

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
