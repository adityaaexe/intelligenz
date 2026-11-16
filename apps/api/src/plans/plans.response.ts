import type { PlanIssue, PlanValidation } from '@intelligenz/contracts';

import type { ProgrammeResponse } from '../programmes/programmes.response';

/**
 * The plan wire shape.
 *
 * ## What is returned
 *
 * A proposal is reviewed by a person, so the response carries what a reviewer needs:
 * the objective, the status, the deterministic validation, the tasks as proposed, the
 * planner's own assumptions and open questions, and who decided what and when. The
 * design's minimum field list is extended with `projectId`, `createdBy`, `rejectedBy`,
 * `decidedAt` and `decisionNote`: without the proposer a reviewer cannot apply the
 * separation-of-duties rule by eye, and without the rejection fields a rejection is
 * invisible in the UI.
 *
 * ## What is never returned
 *
 * `approvedContentHash` (it is a binding, not information a client acts on),
 * `idempotencyKey` (a client key belonging to whoever sent it) and the raw provider
 * response (untrusted text that may echo the prompt). The stored `proposal` is returned
 * field-by-field through the parsed schema, never echoed as the provider sent it.
 */
export interface PlanTaskResponse {
  readonly key: string;
  readonly title: string;
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
  /** Task keys this task waits for, as proposed. */
  readonly dependsOn: readonly string[];
  /**
   * The **claimed** class from the proposal. The effective class is derived by the
   * server when the task is created (Phase 4, D-006) and is not what this field means.
   */
  readonly riskClass: string;
}

export interface PlanResponse {
  readonly id: string;
  readonly projectId: string;
  readonly objective: string;
  /** `proposed` | `invalid` | `approved` | `rejected` | `submitted`. */
  readonly status: string;
  readonly provider: string;
  readonly providerModel: string | null;
  readonly simulated: boolean;
  readonly validation: PlanValidation;
  readonly tasks: readonly PlanTaskResponse[];
  readonly assumptions: readonly string[];
  readonly unresolved: readonly string[];
  readonly createdBy: string;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly approvalExpiresAt: string | null;
  /** True when an approval exists and its expiry has passed. */
  readonly approvalExpired: boolean;
  readonly rejectedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly programmeId: string | null;
  readonly createdAt: string;
}

export interface PlanDecisionBody {
  readonly data: PlanResponse;
  readonly meta: { readonly created: boolean };
}

export interface PlanSubmitBody {
  readonly data: {
    readonly planId: string;
    readonly programme: ProgrammeResponse;
  };
  readonly meta: { readonly created: boolean };
}

/** The stored `validation` JSON, narrowed for the wire. A malformed row reports as not-ok. */
export function toValidationResponse(value: unknown): PlanValidation {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, issues: [] };
  }

  const candidate = value as { ok?: unknown; issues?: unknown };

  if (typeof candidate.ok !== 'boolean' || !Array.isArray(candidate.issues)) {
    return { ok: false, issues: [] };
  }

  return {
    ok: candidate.ok,
    issues: candidate.issues.filter(isPlanIssue),
  };
}

function isPlanIssue(value: unknown): value is PlanIssue {
  if (typeof value !== 'object' || value === null) return false;

  const issue = value as { code?: unknown; taskKey?: unknown; message?: unknown };

  return (
    typeof issue.code === 'string' &&
    typeof issue.message === 'string' &&
    (issue.taskKey === null || typeof issue.taskKey === 'string')
  );
}
