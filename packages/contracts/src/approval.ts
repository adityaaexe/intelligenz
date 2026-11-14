import type { RiskClass } from './enums';

/**
 * Approval precondition — contract §15 A3, tightened by D-006 in Phase 4.
 *
 * A task with a HIGH or CRITICAL risk class cannot move `ready → queued` until a
 * **live, bound, unconsumed** `APPROVED` ApprovalRequest exists for it (`apps/api`'s
 * approval gate). LOW and MEDIUM proceed without one.
 *
 * The class this reads must be the server-derived one (`Task.riskClass`, written from
 * `derivedRiskClass`). Before Phase 4 the caller supplied it, so `requiresApproval`
 * answered a question the caller had already answered for itself.
 *
 * This is a precondition check, not a state: the task state machine is unchanged,
 * and the refusal is a `409` plus an audit event — never a silent no-op.
 */
export function requiresApproval(riskClass: RiskClass): boolean {
  return riskClass === 'HIGH' || riskClass === 'CRITICAL';
}

/**
 * Ordinal position of each class. Declared explicitly rather than derived from the
 * Zod enum's option order, so a reordering of the enum cannot silently change every
 * comparison in the system.
 */
export const RISK_RANK: Readonly<Record<RiskClass, number>> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

/** The more severe of two classes. Used by the server-side floor/band composition. */
export function maxRiskClass(left: RiskClass, right: RiskClass): RiskClass {
  return RISK_RANK[left] >= RISK_RANK[right] ? left : right;
}

/** `-1` lower, `0` equal, `1` higher. Named so call sites read as intent. */
export function compareRiskClass(left: RiskClass, right: RiskClass): -1 | 0 | 1 {
  if (RISK_RANK[left] === RISK_RANK[right]) return 0;

  return RISK_RANK[left] > RISK_RANK[right] ? 1 : -1;
}
