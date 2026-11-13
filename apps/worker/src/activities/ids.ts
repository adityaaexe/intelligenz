import { createHash } from 'node:crypto';

/**
 * Deterministic row ids.
 *
 * The schema has **no** uniqueness that would make the persistence activities
 * idempotent: `AgentRun` has no natural key, `Artifact` has no
 * `(taskId, kind, checksum)` constraint, and `Evidence` has none at all. This unit may
 * not alter the schema, and adding constraints is not a substitute for the application
 * being correct anyway — so the id is derived from the thing that identifies the row.
 *
 * A retried activity therefore re-computes the same id and hits `upsert`, which is
 * idempotent by primary key. Two different ids cannot be created for one artifact, and
 * the follow-up (a real unique constraint) becomes a performance and integrity
 * improvement rather than a correctness fix.
 *
 * RFC 4122 version 5 (SHA-1, name-based) is used rather than a bare hash so that the
 * result is a valid UUID: these ids are returned by the API and compared with the
 * `@default(uuid())` values Prisma produces elsewhere.
 */

/** A fixed namespace. Changing it re-ids every existing row — never change it in place. */
const NAMESPACE = '1a2b3c4d-5e6f-5a7b-8c9d-0e1f2a3b4c5d';

export function deterministicId(name: string): string {
  const digest = createHash('sha1')
    .update(Buffer.from(NAMESPACE.replace(/-/g, ''), 'hex'))
    .update(name, 'utf8')
    .digest();

  // Version 5 and the RFC 4122 variant, in the two bytes that carry them.
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;

  const hex = digest.subarray(0, 16).toString('hex');

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** One agent run per `(workflow run, runtime, attempt)`. A retried attempt is a new row. */
export function agentRunIdFor(workflowRunId: string, runtimeId: string, attemptNumber = 1): string {
  return deterministicId(`agent-run:${workflowRunId}:${runtimeId}:${attemptNumber}`);
}

/**
 * One attempt per `(workflow run, attemptNumber)`. Both halves are needed: the
 * database's `@@unique([workflowRunId, attemptNumber])` is the authority, and a
 * deterministic id means a retried activity that re-computes the row hits the same
 * primary key instead of racing a second insert.
 */
export function executionAttemptIdFor(workflowRunId: string, attemptNumber: number): string {
  return deterministicId(`execution-attempt:${workflowRunId}:${attemptNumber}`);
}

/**
 * One lease per `(workflow run, attempt)`. A retry gets a **new** directory rather
 * than reusing the failed one: the failed workspace is evidence, and provisioning
 * over it would make the failure unreproducible (`workspace-manager` `state.ts`).
 */
export function executionWorkspaceIdFor(workflowRunId: string, attemptNumber: number): string {
  return deterministicId(`execution-workspace:${workflowRunId}:${attemptNumber}`);
}

/**
 * One artifact per `(task, kind, checksum)`. Content-addressed: a re-run that produces
 * identical bytes is the same artifact, and a re-run that produces different bytes is
 * not — which is exactly the semantics a checksum is for.
 */
export function artifactIdFor(taskId: string, kind: string, checksum: string): string {
  return deterministicId(`artifact:${taskId}:${kind}:${checksum}`);
}

/** One evidence row per artifact checksum, so the trail cannot double-count. */
export function evidenceIdFor(taskId: string, kind: string, checksum: string): string {
  return deterministicId(`evidence:${taskId}:${kind}:${checksum}`);
}

/** One workflow run per Temporal run id, for the case where the API did not create one. */
export function workflowRunIdFor(temporalRunId: string): string {
  return deterministicId(`workflow-run:${temporalRunId}`);
}
