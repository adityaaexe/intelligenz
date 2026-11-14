import { createHash } from 'node:crypto';

import type { RiskClass } from '@intelligenz/contracts';

import { DEFAULT_EXECUTION_PROFILE, RISK_POLICY_VERSION } from '../risk/risk-policy';

/**
 * Approval binding — what an `APPROVED` row actually authorises.
 *
 * ## The problem this closes
 *
 * In Phase 3 an approval was a standing authorisation keyed by task id. It said "this
 * task may run", forever, whatever the task had become in the meantime, and every
 * retry reused it. The Phase 4 grant is narrower: it is bound to the exact content,
 * class, profile and source the approver saw, it expires, and it is spent once.
 *
 * ## Why a hash and not a copy of the content
 *
 * An approval row is read on every execution attempt. Copying title/goal/criteria into
 * it would duplicate user text into a second table with its own retention story. A
 * digest is enough to detect any change and leaks nothing if the row is exposed.
 *
 * ## Why canonical JSON instead of string concatenation
 *
 * `title + goal` is ambiguous: `("ab", "c")` and `("a", "bc")` concatenate identically,
 * so two different tasks could share a hash. A JSON array of labelled segments has no
 * such collisions and is stable across processes and database drivers. `v1` is inside
 * the preimage so a future change to the list is detectable rather than silent.
 *
 * ## What is deliberately not in the hash
 *
 * The policy version is recorded beside the grant (`ApprovalRequest.policyVersion`)
 * but not hashed. A policy bump that does not move the class should not invalidate a
 * grant that is otherwise still exactly what was approved.
 */

export const TASK_CONTENT_HASH_VERSION = 'v1';

export interface TaskContentInput {
  readonly title: string;
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
  /** The **derived** class. A client-supplied class must never reach this function. */
  readonly riskClass: RiskClass;
  readonly executionProfile: string;
  readonly sourceRef: string | null;
  readonly baseCommit: string | null;
}

/** The execution facts that are bound alongside the content. */
export interface TaskBinding {
  readonly executionProfile: string;
  readonly sourceRef: string | null;
  readonly baseCommit: string | null;
}

/** Lower-case hex SHA-256 of the canonical preimage. */
export function computeTaskContentHash(input: TaskContentInput): string {
  const preimage = JSON.stringify([
    TASK_CONTENT_HASH_VERSION,
    input.title,
    input.goal,
    // The array, not a joined string: order and grouping are part of what was approved.
    [...input.acceptanceCriteria],
    input.riskClass,
    input.executionProfile,
    input.sourceRef ?? '',
    input.baseCommit ?? '',
  ]);

  return createHash('sha256').update(preimage, 'utf8').digest('hex');
}

/**
 * Reads the binding a task was classified with, out of `Task.riskFactors`.
 *
 * `riskFactors` is untyped JSON written by an earlier version of this code, so it is
 * parsed defensively: a missing or malformed binding means "standard profile, no
 * source", which is the same state as a task that never declared one. It never throws
 * — an execution gate that 500s on an old row is worse than one that refuses it.
 */
export function readTaskBinding(riskFactors: unknown): TaskBinding {
  const record = asRecord(riskFactors);
  const binding = asRecord(record?.['binding']);

  const executionProfile = asNonEmptyString(binding?.['executionProfile']);
  const sourceRef = asNonEmptyString(binding?.['sourceRef']);
  const baseCommit = asNonEmptyString(binding?.['baseCommit']);

  return {
    executionProfile: executionProfile ?? DEFAULT_EXECUTION_PROFILE,
    sourceRef: sourceRef ?? null,
    baseCommit: baseCommit ?? null,
  };
}

/** The binding a task *would* use right now, including any assertion from the request. */
export function resolveBinding(
  recorded: TaskBinding,
  assertion: Partial<TaskBinding> | undefined,
): TaskBinding {
  return {
    // `??` and not `||`: an assertion is only an assertion when it is present. Absent
    // means "use what was approved", which is why an empty `POST /run` body keeps
    // working and still verifies the binding.
    executionProfile: assertion?.executionProfile ?? recorded.executionProfile,
    sourceRef: assertion?.sourceRef ?? recorded.sourceRef,
    baseCommit: assertion?.baseCommit ?? recorded.baseCommit,
  };
}

/**
 * Names the bound fields that differ between two bindings. Used as the `details` of a
 * `409 APPROVAL_STALE` so a client can say *what* changed instead of guessing. Field
 * names only — no values, because a source path or commit is not the caller's business
 * on a refusal.
 */
export function diffBinding(left: TaskBinding, right: TaskBinding): string[] {
  const changed: string[] = [];

  if (left.executionProfile !== right.executionProfile) changed.push('executionProfile');
  if (left.sourceRef !== right.sourceRef) changed.push('sourceRef');
  if (left.baseCommit !== right.baseCommit) changed.push('baseCommit');

  return changed;
}

/** The policy version an approval should record. Falls back to the current table. */
export function resolvePolicyVersion(riskPolicyVersion: string | null | undefined): string {
  return riskPolicyVersion ?? RISK_POLICY_VERSION;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
