import { Prisma } from '@intelligenz/database';
import { LOCAL_SIMULATED_ID, type ExecutionResult } from '@intelligenz/agent-runtime';

import type { PersistResultActivityInput, PersistResultActivityResult } from '../shared/contracts';
import { RUN_STATUS } from './attempts';
import { executionIdentity, requireExecutionClaim } from './claim';
import {
  CHANGE_MANIFEST_KIND,
  EVIDENCE_SOURCE_GIT_IN_SANDBOX,
  EVIDENCE_SOURCE_HOST_SNAPSHOT,
  verifyManifestFile,
  type ManifestExpectation,
} from './evidence';
import { agentRunIdFor, artifactIdFor, evidenceIdFor, executionWorkspaceIdFor } from './ids';
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

  /**
   * Verify the manifest against the bytes before writing anything.
   *
   * Outside the transaction on purpose: file I/O inside a database transaction is a lock
   * held for the duration of a read. The claim and the bytes are separate facts, and this
   * is the only place both are available.
   */
  if (result.evidence !== undefined) {
    // The record the worker wrote *before* the agent ran, read outside the transaction for
    // the same reason the bytes are: file I/O and a lock are a bad pair. This resolves the
    // same (newest) run → attempt → derived workspace the transaction does, so the value
    // compared and the value written cannot be about different attempts.
    const expected = await workspaceEvidenceBinding({ orgId, taskId });
    const problem = await verifyManifestFile(result.evidence, expected);

    if (problem !== null) {
      throw nonRetryable(
        'EVIDENCE_INTEGRITY_FAILED',
        `Refusing to persist a change manifest that does not describe its own bytes: ${problem}.`,
      );
    }
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

    // The directory this attempt leased, from the database only. `result.providerMeta` is
    // adapter output and is deliberately not consulted: it used to carry a `workspaceId`
    // that was accepted if it named *any* workspace of this task, which let an adapter
    // attribute its artifacts to a sibling attempt's directory.
    const workspaceId = await resolveWorkspaceId(transaction, {
      orgId,
      taskId,
      workflowRunId: run.id,
      attemptNumber: attempt.attemptNumber,
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

    /**
     * `change-manifest` is a reserved kind.
     *
     * `result.artifacts` is adapter output. If an adapter can name this kind, it can make
     * its own file look like the host's evidence — the exact inversion this gate removes.
     * The only way in is `result.evidence`, which `executeAgentActivity` writes after the
     * adapter returns. A refusal here is cheap and the alternative is a forged authority
     * record, so it is a hard failure rather than a skip.
     */
    const reserved = result.artifacts.find((artifact) => artifact.kind === CHANGE_MANIFEST_KIND);

    if (reserved !== undefined) {
      throw nonRetryable(
        'EVIDENCE_KIND_RESERVED',
        `Artifact kind "${CHANGE_MANIFEST_KIND}" may only be produced by the worker's host snapshot, not by "${result.runtimeId}".`,
      );
    }

    for (const artifact of result.artifacts) {
      const artifactId = artifactIdFor(taskId, artifact.kind, artifact.checksum);
      const sizeBytes = BigInt(artifact.sizeBytes);

      /**
       * `diff` is what `git diff` said, inside a sandbox, against a repository the agent
       * can configure. `git add` makes it empty for a fully rewritten tree; a `clean`
       * filter makes it empty for a rewritten file; a commit makes it empty for
       * everything. It is kept — it is still the most readable view of a change — and it
       * is labelled so no consumer can mistake it for the answer.
       */
      const isGitReport = artifact.kind === 'diff';

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
          ...(isGitReport
            ? { evidenceSource: EVIDENCE_SOURCE_GIT_IN_SANDBOX, authoritative: false }
            : {}),
        },
        // `uri` can legitimately move (a different artifact root); the checksum is what
        // identifies the content, and it is part of the id.
        //
        // The demotion is re-asserted on update: a row that once carried a different
        // label must not keep it after this code is deployed, and `false` is the only
        // value this column may hold for a git report.
        update: {
          uri: artifact.uri,
          sizeBytes,
          ...(isGitReport
            ? { evidenceSource: EVIDENCE_SOURCE_GIT_IN_SANDBOX, authoritative: false }
            : {}),
        },
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

    // ── The host manifest, bound to the worker's own context ───────────────────
    //
    // `attemptId` is the attempt row the worker opened (resolved from the workflow run,
    // not from the result), and `workspaceId` is the tenant-scoped workspace this
    // execution leased. Neither is copied from `result.artifacts`, and `result.evidence`
    // is the only way a `change-manifest` reaches this point — so a forged artifact list
    // cannot claim provenance, and an adapter cannot point evidence at another attempt's
    // workspace.
    //
    // `authoritative` is `evidence.authoritative && workspaceId !== null`: a manifest that
    // cannot be bound is not authority, because nobody can say which tree it describes.
    // `authoritative` defaults to false in the schema, so the failure direction is always
    // "less claim", never more.
    if (result.evidence !== undefined) {
      const evidence = result.evidence;
      const artifactId = artifactIdFor(taskId, evidence.kind, evidence.manifestDigest);
      const sizeBytes = BigInt(evidence.artifact.sizeBytes);
      const authoritative = evidence.authoritative && workspaceId !== null;

      await transaction.artifact.upsert({
        where: { id: artifactId },
        create: {
          id: artifactId,
          orgId,
          taskId,
          // The adapter whose run this describes; the producer is `evidenceSource`.
          runtimeId: result.runtimeId,
          kind: evidence.kind,
          uri: evidence.artifact.uri,
          checksum: evidence.artifact.checksum,
          sizeBytes,
          attemptId: attempt.id,
          ...(workspaceId === null ? {} : { workspaceId }),
          evidenceSource: EVIDENCE_SOURCE_HOST_SNAPSHOT,
          authoritative,
          manifestDigest: evidence.manifestDigest,
          initialManifestDigest: evidence.initialManifestDigest,
          finalManifestDigest: evidence.finalManifestDigest,
        },
        // Deliberately **not** rebinding on update. The id is content-addressed, so a
        // second attempt that produced byte-identical evidence reaches this row; moving
        // the attempt link would re-attribute history to the newest run. `uri` may move
        // legitimately (a different workspace root), so it is refreshed.
        update: { uri: evidence.artifact.uri, sizeBytes },
        select: { id: true },
      });

      artifactIds.push(artifactId);

      const evidenceId = evidenceIdFor(taskId, evidence.kind, evidence.manifestDigest);

      await transaction.evidence.upsert({
        where: { id: evidenceId },
        create: {
          id: evidenceId,
          orgId,
          taskId,
          kind: 'change_manifest',
          uri: evidence.artifact.uri,
          // `host-snapshot` is the producer, and it is not an adapter name on purpose:
          // this claim came from a walk, not from a runtime.
          producedBy: EVIDENCE_SOURCE_HOST_SNAPSHOT,
        },
        update: { uri: evidence.artifact.uri },
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

/**
 * The directory attempt *N* of run *R* leased — resolved from the database, and nothing
 * else.
 *
 * `result.providerMeta` used to be an input here. It accepted any string that named an
 * `ExecutionWorkspace` row in the same `orgId` + `taskId`, so an adapter could attribute
 * its artifacts to a **sibling** workspace of the same task — a previous attempt's
 * directory — and the row would say those bytes came from there. No cross-tenant read, but
 * the agent deciding the provenance Gate G exists to establish, which is the inversion this
 * gate removes.
 *
 * The routing key is therefore the attempt's own identity, not a value anyone can propose:
 * `executionWorkspaceIdFor(workflowRunId, attemptNumber)` is derived from the `WorkflowRun`
 * row and the `ExecutionAttempt` row read in this transaction, and both of those are the
 * worker's own record of what it started. `execute-agent.ts` leases the directory under the
 * same derivation, from the same pair, so the mapping is 1:1 by construction
 * (`activities/ids.ts`). The row is looked up scoped to `orgId` and `taskId`, so a
 * same-named row under another tenant or task is not this attempt's.
 *
 * The *recorded* links (`AgentRun.workspaceId`, `ExecutionWorkspace.agentRunId`) cannot
 * answer this on the first pass: `persistResult` is what writes them, below, so they are
 * empty exactly when the answer is first needed. They remain the read path for "[which
 * directory did this run use]" once this transaction has committed.
 *
 * `null` is a real answer, not a missing one: no row means no directory was leased for this
 * attempt (a runtime that needs none, a provisioning failure, a row written before Phase 3).
 * The caller turns that into `authoritative = false` — less claim, never more.
 */
/**
 * The two snapshot digests `ExecutionWorkspace` recorded for the attempt this result
 * belongs to.
 *
 * "Belongs to" is resolved exactly as the write resolves it — newest run for the task,
 * newest attempt of that run, workspace id derived from the pair — because a comparison
 * against a different attempt's record would be a check that can pass for the wrong reason.
 * `null` means there is nothing to compare with (no run yet, or a row that predates the
 * columns); `verifyManifestFile` treats that as "cannot contradict" rather than as a match.
 */
async function workspaceEvidenceBinding(input: {
  readonly orgId: string;
  readonly taskId: string;
}): Promise<ManifestExpectation | null> {
  const run = await db().workflowRun.findFirst({
    where: { orgId: input.orgId, taskId: input.taskId },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

  if (run === null) return null;

  const attempt = await db().executionAttempt.findFirst({
    where: { orgId: input.orgId, workflowRunId: run.id },
    orderBy: { attemptNumber: 'desc' },
    select: { attemptNumber: true },
  });

  if (attempt === null) return null;

  const workspace = await db().executionWorkspace.findFirst({
    where: {
      id: executionWorkspaceIdFor(run.id, attempt.attemptNumber),
      orgId: input.orgId,
      taskId: input.taskId,
    },
    select: { initialManifestDigest: true, finalManifestDigest: true },
  });

  if (workspace === null) return null;

  return {
    initialManifestDigest: workspace.initialManifestDigest,
    finalManifestDigest: workspace.finalManifestDigest,
  };
}

async function resolveWorkspaceId(
  transaction: Prisma.TransactionClient,
  input: {
    readonly orgId: string;
    readonly taskId: string;
    readonly workflowRunId: string;
    readonly attemptNumber: number;
  },
): Promise<string | null> {
  const workspace = await transaction.executionWorkspace.findFirst({
    where: {
      id: executionWorkspaceIdFor(input.workflowRunId, input.attemptNumber),
      orgId: input.orgId,
      taskId: input.taskId,
    },
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
