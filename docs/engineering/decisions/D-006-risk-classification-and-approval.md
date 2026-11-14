# D-006 — Server-derived risk classification and bound, single-use approvals

**Status:** ACCEPTED · **Decided:** 2026-11-14 (Phase 4) · **Raised:** 2026-11-13 (Phase 3 security audit, finding F5)
**Supersedes:** the `OPEN` D-006 entry in [`docs/decisions/OPEN-DECISIONS.md`](../../decisions/OPEN-DECISIONS.md) (kept unamended as the Phase 3 record)
**Decision owner:** product owner (risk appetite). **Recorded and implemented by:** Phase 4 backend unit (BE-401).

---

## 1. The original issue

Phase 3 accepted `riskClass` **from the request body** on `POST /v1/orgs/:orgId/projects/:projectId/tasks`.
Approval was required only for `HIGH` and `CRITICAL`, and a `LOW` task got no
`ApprovalRequest` at all. So a `MEMBER` could type `"riskClass": "LOW"` next to any
work — a production deploy, a credential read, a `delete` — and run it with no second
pair of eyes.

That is not a broken check. The check did exactly what it said. The defect was
**who was allowed to answer the question**. A control whose subject fills in its own
classification is not a control; the approvals queue presented one anyway, which is
worse than presenting none.

Phase 3 also recorded the second half: an `APPROVED` row was a **standing**
authorisation. It said "this task may run", forever, whatever the task had become,
and every retry reused it. Both halves have the same shape — an authorisation that is
wider than the thing a human actually reviewed.

## 2. The chosen rule

Four rules, all enforced in the API:

1. **Risk is server-derived.** `classify()` in `apps/api/src/risk/` computes the class
   from the task content, the execution profile, the source/commit and the repository
   trust policy. The caller's `riskClass` is **evidence, never input**: it is compared
   with the derived class and the comparison is recorded
   (`clientAttemptedDowngrade` / `clientAttemptedEscalation`) plus a
   `task.risk_class_overridden.v1` audit event. It is never obeyed, and there is no
   branch that returns it.
2. **The policy is versioned.** `RISK_POLICY_VERSION` (`2026-11-14.1`) is stored on
   every classified task (`Task.riskPolicyVersion`) and every approval
   (`ApprovalRequest.policyVersion`). A class recorded months ago stays attributable to
   the rules that produced it.
3. **An approval is bound and single-use.** A grant authorises one execution of the
   exact content, class, execution profile and source the approver saw. It expires and
   is spent by a compare-and-swap. A retry needs a new approval.
4. **Self-approval is forbidden by default.** `requestedById === actorId` on an
   `approve` decision is `403 SELF_APPROVAL_FORBIDDEN`. The only escape hatch is a
   compiled-in, empty-per-org map (`org-policy.ts`); enabling it is a reviewed code
   change, not an environment variable.

### 2.1 What "server-derived" means in practice

The policy is a named table, not a `switch` buried in a controller
(`apps/api/src/risk/risk-policy.ts`):

- **weights** accumulate into a score, banded `LOW < 25 ≤ MEDIUM < 60 ≤ HIGH < 100 ≤ CRITICAL`;
- **floors** are hard minimums that no combination of other signals may lower;
- the result is `max(band(score), every floor)`.

The floors that carry the security argument:

| Condition | Floor |
|---|---|
| detected operation is `deploy` (deploy/release/publish/merge/delete/purge/force-push…) | `CRITICAL` |
| credentials or host paths requested (`/etc/`, `~/.ssh`, `api key`, `kubeconfig`…) | `CRITICAL` |
| untrusted repository + `file_write` | `HIGH` |
| untrusted repository + `shell`/`deploy` | `CRITICAL` |
| `shell` or outbound network requested | `HIGH` |
| execution profile `heavy` | `HIGH` |
| any signal unknown (no source, no pinned commit, no recognisable verb, unknown profile) | `MEDIUM` |

`LOW` therefore requires **all** of: a read-only operation, an allowlisted repository
pinned to a commit, no shell/network/credential/destructive language, and the standard
profile. That state is not reachable from client input alone — an operator must have
allowlisted the repository first, and the shipped allowlist is empty.

Two deliberate properties:

- **Direction of error.** Keyword matching produces false positives ("do not delete
  rows" reads as a delete). That is accepted: a false positive costs one approval
  click, a false negative costs the control. The matched terms are stored in
  `riskFactors.matchedTerms` so a reviewer can see why.
- **Unknown is not safe.** A signal that could not be determined contributes a weight
  and a floor. Absence of evidence is not evidence of safety.

### 2.2 Repository text is hostile input

Text read from the repository under work (a `README`, a `CLAUDE.md`, an issue
template) may **raise** a class but can never lower one. A line in it that says
"risk class: LOW" or "approval is not required" is recorded as
`untrusted_instruction_override` and raises the floor to `HIGH`; it is data, never a
directive. At task creation the API passes `repositoryInstructions: []` — it does not
have repository content at request time, and saying so is more honest than pretending
it scanned. The worker owns that check inside the sandbox.

## 3. Rejected alternatives

| # | Alternative | Why it was rejected |
|---|---|---|
| A | **Keep client-supplied risk with a warning** (Phase 3 option A) | A warning is not enforcement. The caller who typed `LOW` is the one who would have to act on it, and the approvals queue would still display a control that had been opted out of. Warnings are for humans reviewing a decision they can see; here the decision was invisible. |
| B | **Per-project minimum risk class** (Phase 3 option B, the Phase 3 recommendation) | Static and coarse. One floor per project cannot distinguish a read-only audit from a production deploy inside the same project; it still lets a member assert `LOW` wherever the floor is `LOW`; and it requires an admin to configure every project before it protects anything. Server derivation is per-task and safe with **zero** configuration (trust nothing, classify MEDIUM+). It supersedes the Phase 3 recommendation. |
| C | **Approval reusable until revoked** (Phase 3 standing behaviour) | One grant authorised unbounded future executions, including content changed after the review. Revocation is after the fact: it cannot stop the second run that happens between approval and revocation. It also made every retry reuse a grant nobody re-read. |
| D | **Approval keyed only by `runId`** (D-001 option C) | A `runId` is minted *after* the gate, so the gate cannot require one without restructuring the run path. More importantly, keying to a run does not bind *what* was approved — an edit to the task between approval and run would still spend the grant. The content hash binds the thing a human actually read. |
| E | **Trust the repo allowlist alone, accept a branch name as a pin** | A branch moves. `resolveRepositoryTrust` requires both an allowlisted source **and** a pinned commit; a branch name is `untrusted`, not `trusted`. |
| F | **Weighted score without floors** | Arithmetic can hide a nasty signal behind safe neighbours ("read the file, then deploy"—the word *read* does not cancel *deploy*). Floors express "no combination may make this LOW". Weights alone also cannot distinguish `read` from `edit` within a band. |
| G | **Backfill content hashes onto pre-Phase-4 approvals** | Would assert a review nobody performed. A null hash is honest and yields `409 APPROVAL_UNBOUND`. |
| H | **Re-classify every existing task at migration time** | Rewriting `riskClass` on rows nobody re-reviewed would fabricate a decision and destroy the evidence that the old value was client-attested. Existing rows keep `riskSource='client'` (see §7). |

## 4. Requester / approver model

- **Requester:** any `MEMBER` may create a task. When the derived class is `HIGH` or
  `CRITICAL`, the `PENDING` `ApprovalRequest` is created in the same transaction as
  the task, with `requestedById = creator`. The queue is therefore always populated;
  it can never depend on someone remembering to ask.
- **Approver:** `ADMIN` or higher (`@Roles('ADMIN')` on the decision route).
- **Separation of duties:** an `approve` decision by the requester is refused —
  `403 SELF_APPROVAL_FORBIDDEN` — unless the org has an explicit override in
  `ORG_POLICY` (compiled in; empty). `reject` and `request_changes` on your own
  request are allowed: the control is about *granting*, not about withdrawing.
- **The decision binds.** Approving is the act of saying "yes, to **this**". The hash
  is computed at decision time from the task as the approver sees it, not when the
  request was opened. An approval that sat in the queue while the content changed is
  bound to the changed content the approver actually read.
- **A decision does not move the task.** Approval is a precondition, not a state. The
  task stays `ready`; someone still has to run it.

## 5. Binding scope

`computeTaskContentHash` is SHA-256 over canonical JSON:

```text
["v1", title, goal, [acceptanceCriteria…], derivedRiskClass,
 executionProfile, sourceRef ?? "", baseCommit ?? ""]
```

- The **array** of acceptance criteria, not a joined string: order and grouping are
  part of what was approved, and concatenation is ambiguous (`("ab","c")` vs
  `("a","bc")`).
- `v1` is inside the preimage so a future change to the field list is detectable.
- The **derived** class only. A client-supplied class never reaches this function.
- The **policy version is recorded beside the grant, not hashed.** A policy bump that
  does not move the class should not invalidate a grant that is otherwise exactly what
  was approved.

At execution the effective binding is the recorded binding (`riskFactors.binding`),
with any fields asserted in the `POST /run` body overriding it. The hash is
recomputed and compared:

- mismatch → `409 APPROVAL_STALE`, `details.approval` names the changed field
  (`executionProfile` / `sourceRef` / `baseCommit`) or `taskContent`;
- a body assertion is compared, never trusted: a grant for `standard` cannot
  authorise `heavy`, and a grant for `repo#main@a…` cannot authorise
  `repo#release@b…`.

Tenant scoping is part of the binding: the gate queries
`{ orgId, taskId }`, and the consumption CAS includes `orgId`. An approval id from
another organisation is `404`, not `403`.

## 6. Expiry, revocation, consumption

### Expiry

- Default **24 h**, configurable with `APPROVAL_TTL_HOURS` (must be a positive
  integer), counted **from the decision**, written to `ApprovalRequest.expiresAt`.
- A `null` expiry is treated as `createdAt + TTL` **for legacy/fixture rows**, never
  as "never expires".
- Expiry is enforced **lazily at the gate**: an expired `APPROVED` row is flipped to
  `EXPIRED` (guarded CAS, audited once as `approval.expired.v1`) and the request is
  refused with `409 APPROVAL_EXPIRED`. There is no background sweeper yet; the
  `expiresAt` index exists so one can be added without a migration.

### Revocation

- `POST /v1/orgs/:orgId/approvals/:approvalId/revoke` — `ADMIN+`.
- Only an `APPROVED` row can be revoked; anything else is
  `409 APPROVAL_NOT_REVOCABLE`. Revoking an already-revoked row is idempotent `200`.
- A **consumed** approval can still be revoked: `status = REVOKED`, `revokedAt` /
  `revokedById` set, and `consumedAt` **stays**. Revocation controls the future; it
  does not pretend the past run did not happen.
- Revocation is audited (`approval.revoked.v1`) with an `afterUse` flag.

### Consumption is a compare-and-swap

`POST /run` spends the grant inside the reservation transaction. The write is:

```ts
const consumed = await client.approvalRequest.updateMany({
  where: {
    id: approval.id,
    orgId: task.orgId,
    status: 'APPROVED',
    consumedAt: null,
    revokedAt: null,
  },
  data: { consumedAt, consumedByAttemptId: params.attemptId ?? null },
});

if (consumed.count === 0) {
  refusal ??= 'APPROVAL_CONSUMED';
  continue;
}
```

`count === 0` is a **refusal**, never a retry. A plain
`update({ where: { id } })` would let two concurrent runs both write
`consumedAt` and silently succeed; the second write would mean one approval
authorised two executions. Every predicate is load-bearing: `id + orgId` is the tenant
scope, `status` stops a revoked/expired row being spent, `consumedAt IS NULL` is
single-use, `revokedAt IS NULL` lets a revocation that arrived between the read and the
write win.

The refusal is audited **outside** the transaction (`task.transition_refused.v1`), so
it survives the rollback; the consumption is **inside** it, so a reservation that
fails does not spend the grant.

`PATCH → queued` runs the same checks with `consume: false` and cannot spend a grant:
the edge is system-managed, so a successful check is followed by
`409 TRANSITION_IS_SYSTEM_MANAGED`. Burning a grant there would spend it on a request
that was never going to start a run.

## 7. Migration honesty

The migration (`20261114035043_phase4_execution_trust`) adds the evidence columns
without redefining `Task.riskClass`:

- `Task.riskSource` is `TEXT NOT NULL DEFAULT 'client'`. **Existing rows keep
  `'client'`**, which is the truthful description of a column that was populated from
  the request body. It is not a backfill and it is not a guess.
- `Task.derivedRiskClass` is `NULL` on pre-Phase-4 rows: no server policy evaluated
  them.
- `Task.riskPolicyVersion` / `riskFactors` are `NULL` on those rows.
- Pre-existing `ApprovalRequest` rows get `taskContentHash = NULL` and
  `policyVersion = NULL`. The gate answers `409 APPROVAL_UNBOUND` for them. Backfilling
  a hash would claim a review that never happened.
- The effective class at the gate is `derivedRiskClass ?? riskClass`, so old rows still
  read coherently — and an old row that was asserted `LOW` remains `LOW` (see §9,
  residual limit 2).

`riskSource` is a string, not an enum, because its vocabulary is policy-owned and will
grow (`client`, `server`, later `replayed`).

## 8. Test inventory

Measured on 2026-11-14. All commands and their output are in the Phase 4 verification
record; the counts below are the ones this decision depends on.

| Suite | File | Tests | What it pins |
|---|---|---|---|
| Unit | `apps/api/src/risk/classify.test.ts` | **25 / 25 pass** | LOW boundary, hard floors, security signals, client assertion is evidence not input, hostile repository text, invariants (`policyVersion`, determinism, no content in factors), `resolveRepositoryTrust` |
| E2E | `apps/api/test/risk-approval.e2e-spec.ts` | **18 / 18 pass** | the 15 adversarial cases below, plus revoke-after-use, non-revocable, and an accepted assertion |

Adversarial cases (all against the real app, real guards, real database):

| # | Case | Result asserted | Covered by |
|---|---|---|---|
| 1 | `MEMBER` sends `riskClass:'LOW'` on deploy content | stored `CRITICAL`, `riskSource='server'`, `clientAttemptedDowngrade=true`, audit `task.risk_class_overridden.v1` | `1. …` |
| 2 | omit `riskClass` entirely | still server-derived (`HIGH` for shell content) | `2. …` |
| 3 | task content changed after approval | `409 APPROVAL_STALE`, grant **not** spent | `3. …` |
| 4 | repo/branch changed after approval | `409 APPROVAL_STALE` | `4. …` |
| 5 | execution profile changed after approval | `409 APPROVAL_STALE`, `details.approval=['executionProfile']`; asserting the approved profile passes the gate | `5. …` (2 tests) |
| 6 | same approval reused | `409 APPROVAL_CONSUMED` | `6. …` |
| 7 | two concurrent `POST /run`, one approval | exactly one `{409,503}` pair, one `approval.consumed.v1`, no live grant left | `7. …` |
| 8 | self-approval | `403 SELF_APPROVAL_FORBIDDEN`, row stays `PENDING`, refusal audited | `8. …` |
| 9 | expired | `409 APPROVAL_EXPIRED`, status flips to `EXPIRED`, `consumedAt` stays null, one audit event | `9. …` |
| 10 | revoked | `409 APPROVAL_REVOKED`; second revoke idempotent; revoke after use keeps `consumedAt`; `409 APPROVAL_NOT_REVOCABLE` on `PENDING` | `10. …` (3 tests) |
| 11 | approval id under another org | `404 NOT_FOUND` for decision and revoke; row unchanged | `11. …` |
| 12 | `taskContentHash = NULL` (Phase 3 legacy) | `409 APPROVAL_UNBOUND` | `12. …` |
| 13 | retry after consumption | every retry `409 APPROVAL_CONSUMED`; no replacement approval minted | `13. …` |
| 14 | client sets `riskSource`/`derivedRiskClass` in the body | fields stripped by the DTO transform; server values stored | `14. …` |
| 15 | `HIGH` task via `PATCH → queued`, no approval | `409 APPROVAL_REQUIRED`, task stays `ready`, zero `WorkflowRun` rows | `15. …` |

Cases 3 and 4 stand in for an out-of-band edit: there is no task-edit endpoint, so the
test mutates the row directly. That is the threat being modelled (a change that did not
go through the review), not a UI path.

## 9. Residual limits

1. **Classification reads the request, not the agent's behaviour.** A member can
   describe innocuous work that nevertheless causes the agent to run shell commands.
   The classifier is a gate on *what a human approved*, not a sandbox. Containment is
   the worker's sandbox and egress policy; this decision does not replace it.
2. **Pre-Phase-4 rows are still trusted at their client-asserted class.** A legacy task
   with `riskSource='client'` and `riskClass='LOW'` has no derived class, so
   `derivedRiskClass ?? riskClass` yields `LOW` and the gate is skipped. Re-classifying
   in the migration would fabricate a review; the honest mitigation is to enumerate
   those rows (`WHERE "riskSource" = 'client'`) and re-create or re-submit them. Not
   done in this unit because it is a data-policy act, not a code fix.
3. **The worker's own re-check is a separate unit.** The API gate is not the last line
   of defence: `executeAgentActivity` must re-check approval/risk at execution time or
   a bypass of the API leaves the gate a courtesy (Phase 3 finding F18). This document
   records the API contract; the worker's enforcement is not verified here.
4. **Repository text is not scanned at creation time.** `repositoryInstructions` is
   `[]` in the API; a malicious README can only be caught inside the worker. A task
   whose danger lives only in the repository is under-classified at creation.
5. **Keyword matching has false positives and false negatives.** The direction of
   error is deliberate (§2.1), and `matchedTerms` makes the evidence reviewable, but a
   novel phrasing will not match. This is a heuristic, not a proof.
6. **A policy bump does not invalidate existing grants.** The version is recorded
   beside the grant and excluded from the hash on purpose: a bump that does not move
   the class should not invalidate an otherwise-correct approval. A bump that *would*
   move the class of an already-approved task is not retroactively enforced.
7. **A failed start still spends the grant.** The reservation commits before Temporal
   is contacted, so `503 ORCHESTRATOR_UNAVAILABLE` leaves the approval consumed and the
   task back in `ready`. This is deliberate: a refund needs a second CAS against a run
   that may have started after all, and a refund that loses that race authorises two
   executions. The cost is one re-approval after an outage.
8. **`consumedByAttemptId` is null for grants spent by `POST /run`.** The attempt row
   does not exist yet — the worker creates it. `consumedAt` is the authoritative "this
   grant is gone" marker; the attempt link is filled in later when the worker can.
9. **No background expiry sweeper.** Expiry is enforced when the gate reads the row;
   an expired row can sit `APPROVED` in the database until something asks. The list
   endpoint shows only `PENDING`, so this is a data-hygiene issue, not a UI one, and
   the index exists for a future sweeper.
10. **The grant does not bind the runtime adapter or model.** `executionProfile` is the
    only execution-shape field in the hash. A configuration change that swaps the
    runtime/model between approval and run does not invalidate the grant.
11. **Self-approval can be enabled for an org only by a code change and a deploy.**
    That is intentional (an env var would be an unaudited one-line bypass), and every
    refusal is audited, so "the default is in force" is observable.
12. **Direct database access bypasses all of this.** As with every application-layer
    control, the database role is the real boundary.

## 10. References

- Finding F5 (Phase 3 security audit) and F18 (worker re-check) —
  `docs/engineering/PHASE-3-SECURITY-RESULTS.md`.
- Phase 3 record and options A–D — `docs/decisions/OPEN-DECISIONS.md` §D-006.
- Policy table and classifier — `apps/api/src/risk/risk-policy.ts`,
  `apps/api/src/risk/classify.ts`.
- Binding, gate, org policy — `apps/api/src/approvals/approval-binding.ts`,
  `apps/api/src/approvals/approval-gate.service.ts`,
  `apps/api/src/approvals/org-policy.ts`.
- Schema and migration — `packages/database/prisma/schema.prisma` (`Task`,
  `ApprovalRequest`), `packages/database/prisma/migrations/20261114035043_phase4_execution_trust/`.
- API surface — `apps/api/api-contract.md` §5–§6.
