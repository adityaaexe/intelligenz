import type { RiskClass } from './enums';

/**
 * Approval precondition — contract §15 A3.
 *
 * A task with a HIGH or CRITICAL risk class cannot move `ready → queued` until an
 * `APPROVED` ApprovalRequest exists for it. LOW and MEDIUM proceed without one.
 *
 * This is a precondition check, not a state: the task state machine is unchanged,
 * and the refusal is a `409 APPROVAL_REQUIRED` plus an audit event — never a silent
 * no-op.
 */
export function requiresApproval(riskClass: RiskClass): boolean {
  return riskClass === 'HIGH' || riskClass === 'CRITICAL';
}
