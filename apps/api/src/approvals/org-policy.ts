/**
 * Per-organisation approval policy. **Empty by default.**
 *
 * ## What is here
 *
 * `allowSelfApproval` is the org-level escape hatch for the "four eyes" rule that
 * `ApprovalsService.decide` enforces by default: a requester may not approve their own
 * request (`403 SELF_APPROVAL_FORBIDDEN`).
 *
 * ## Why the escape hatch exists at all
 *
 * An organisation with exactly one `ADMIN` deadlocks the moment that admin needs a
 * `HIGH` change: they cannot approve their own request and there is nobody else to do
 * it. That is a real availability failure, not a hypothetical. D-001 recorded the
 * deadlock as the reason the rule needs an out.
 *
 * ## Why it is off, and why it is not an environment variable
 *
 * The control is only credible if turning it off is a **reviewed code change with an
 * owner's name on it**. An env var would be a one-line, unaudited bypass that nobody
 * reviewing the approval queue would ever see — exactly the class of control the
 * approval screen is supposed to make visible. So: a map, compiled in, empty, with
 * this comment as the record. Enabling it for an org is a diff that says which org and
 * why, in the same place the rule lives.
 *
 * Every self-approval refusal is audited (`approval.self_approval_refused.v1`), so the
 * default being in force is observable rather than assumed.
 */
export interface OrgApprovalPolicy {
  /**
   * True permits `requestedById === decidedById` for an `approve` decision in this org.
   * Never affects `reject` or `request_changes`: refusing your own request is not a
   * separation-of-duties problem.
   */
  readonly allowSelfApproval: boolean;
}

/**
 * Compiled-in org overrides. Intentionally empty: no organisation may self-approve
 * until someone adds an entry, in code, with a reason.
 */
export const ORG_POLICY: ReadonlyMap<string, OrgApprovalPolicy> = new Map();

/** True only when the org has an explicit override. Absence of an entry means "refuse". */
export function allowsSelfApproval(orgId: string): boolean {
  return ORG_POLICY.get(orgId)?.allowSelfApproval === true;
}
