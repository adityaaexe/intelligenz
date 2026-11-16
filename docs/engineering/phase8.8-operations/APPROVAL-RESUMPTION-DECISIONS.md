# Approval-resumption decisions — D1–D5

**Status: BLOCKED_POLICY.** No resumption code exists and none is proposed for merge
until these are answered. This document is the decision package, not an implementation.

---

## 0. Current behaviour, verified

| Step | Code | Behaviour |
|---|---|---|
| Reservation | `apps/worker/src/activities/programme.ts` `reserveProgrammeTaskActivity` | `requiresApproval(task.riskClass)` → `{ outcome: 'approval_required' }` **before any write**. No run, no attempt. |
| Node | `run-programme.ts` dispatch switch | checkpoint `waiting_for_approval`; dependents block. |
| Programme | `programmeStatus` / `finishProgrammeActivity` | only all-`succeeded` is `succeeded`; this node yields `blocked`, `failureCode='APPROVAL_PENDING'`. |
| Workflow | `runProgrammeWorkflow` | **returns**. The execution closes. |
| Approval | `POST /run` | spends the grant: a conditional UPDATE on `status='APPROVED' AND consumedAt IS NULL AND revokedAt IS NULL`, bound to the attempt. |
| Programme row | `finishProgrammeActivity` | only `pending|running → terminal`. A `blocked` row cannot be moved back. |
| Reservation after that | `reserveProgrammeTaskActivity` | refuses any programme not `pending|running` (`programme_terminal`). This is a Phase 8.7 control, not an accident. |

So the grant is spendable and the task is runnable by a human, but **nothing resumes the
programme**, and the programme's own row is terminal.

## 1. The constraint that shapes every answer

The programme's authority check is exact equality:

```
workflowId === `programme-<programmeId>`   // activities/programme.ts
```

`requireProgrammeAuthority` rebuilds the expected id from the activity input and refuses
anything else. A resumed execution must therefore run under **the same workflow id**, or the
authority check has to be widened.

- Running under the same id is refused today by `WORKFLOW_ID_REUSE_POLICY =
  ALLOW_DUPLICATE_FAILED_ONLY`: a `blocked` programme did not close as failed.
- Running under `programme-<id>-r2` would require accepting a second id shape — a real
  widening of the one control that stops arbitrary workflows minting reservations. **Not
  recommended.**

**D1 must therefore choose an option that keeps the exact id.** The only remaining lever is
the reuse policy at the *resume* call site.

Temporal's policies do not express "allow a duplicate only if the previous execution has
closed". `ALLOW_DUPLICATE` also permits a duplicate of a **running** execution. The guard must
therefore be a runtime `describe()` of the previous execution: refuse unless its status is
`COMPLETED | FAILED | CANCELLED | TERMINATED`, **and** a conditional `blocked → running`
update so two resume requests cannot both proceed.

---

## D1 — May an ADMIN reopen a blocked programme, on the same `Programme` row?

| | |
|---|---|
| **Current behaviour** | No. The row is terminal, the workflow is closed, and a reservation against it is refused. |
| **Security implications** | The scheduler gains the ability to dispatch again after a human stop. It cannot dispatch an approval-gated node (reservation still refuses it), cannot spend a grant, and cannot bypass the claim. The risk is repeated dispatch of *non-gated* nodes, bounded by D3. |
| **Operational implications** | A blocked programme can be completed after its approval arrives. Requires a new endpoint, a new audit event, and a resume counter. |
| **Alternatives** | (a) Never resume; require a new programme over the same tasks — duplicates the objective and the graph, and the checkpoints no longer explain the run. (b) Resume on the same row with a conditional transition + `describe()` guard — **recommended**. (c) Resume under a derived workflow id — rejected: widens `requireProgrammeAuthority`. |
| **Safest default** | Same row, same workflow id, `blocked → running` under a CAS, and `describe()` must report the previous execution closed. Only when no node is `failed`. |
| **Affected APIs** | New `POST /v1/orgs/:orgId/programmes/:id/resume`, `@Roles('ADMIN')`, four-eyes not applicable (no approval is being decided). |
| **Workflow states** | New legal edge `blocked → running`; `resumedAt`, `resumeCount` on `Programme`. |
| **Test implications** | Resume twice → one execution; resume while the previous execution is still open → refused; resume a `failed` programme → refused; resume after the grant expired → node stays blocked. |
| **Migration implications** | One additive migration (`resumedAt`, `resumeCount`); no back-fill. |

## D2 — May an approval decision cause a dispatch attempt?

| | |
|---|---|
| **Current behaviour** | No. `ApprovalsService.decide` records a decision and knows nothing about programmes. Execution is triggered by `POST /run`, which spends the grant. |
| **Security implications** | If a decision triggers dispatch, an approval becomes a *cause* of execution rather than a *permission* for it. That is the boundary Phase 6 spent four review rounds drawing. It also creates fan-out: one decision can unblock several programmes, each needing durable retry. |
| **Operational implications** | Automatic resumption is convenient; manual resumption is one extra call and needs a human who knows the approval landed. |
| **Alternatives** | (a) Human calls `POST /run`, then an ADMIN calls resume — **recommended**. (b) Decision writes a durable outbox row; a worker resumes matching programmes — safe only built on top of (a)'s machinery, with its own retry and poison handling. (c) Decision calls the scheduler inline — rejected: couples governance to scheduling inside the decision transaction. |
| **Safest default** | (a). The scheduler never spends a grant; the human still runs the task. |
| **Affected APIs** | None for (a) beyond D1's resume route. (b) adds an outbox table and a consumer. |
| **Workflow states** | None for (a). (b) adds a `resume_pending` notion outside Temporal. |
| **Test implications** | For (a): approve + run + resume completes the programme; duplicate approval signals produce no duplicate claim. For (b): outbox exactly-once delivery, poison isolation. |
| **Migration implications** | None for (a). (b) needs an outbox model. |

## D3 — How many resumes, and does the original deadline survive?

| | |
|---|---|
| **Current behaviour** | No resumes exist. The deadline is in the workflow **input**, not a column; the API computes `now + 6h` at each start, so a re-start would silently grant a fresh 6-hour budget. |
| **Security implications** | An uncapped resume is a scheduling loop with a human in it; a reset deadline silently extends the budget an operator thought they set. |
| **Operational implications** | A cap needs an audited counter and a clear error when exhausted. |
| **Alternatives** | (a) Preserve the original deadline, cap at 3 — **recommended**. (b) Reset the deadline on resume — rejected unless the operator explicitly asks, because it changes the meaning of a deadline. (c) No cap — rejected. |
| **Safest default** | (a). Store `resumeCount`; refuse at 4; carry the original `deadlineAt` (the workflow already carries input across Continue-As-New, so this is a property to preserve, not invent). |
| **Affected APIs** | Resume returns `resumeCount` and the deadline it will obey. |
| **Workflow states** | `blocked → running` once per grant; a fourth resume is `409 RESUME_LIMIT_REACHED`. |
| **Test implications** | Four resumes → the fourth refused; the deadline across a resume equals the original; a resume after the deadline ends `timed_out`. |
| **Migration implications** | Same additive migration as D1. |

## D4 — Confirm expiry-at-claim

| | |
|---|---|
| **Current behaviour** | `approval-gate.service.ts` treats `expiresAt ?? createdAt + TTL` and refuses `APPROVAL_EXPIRED`. Resume does not evaluate expiry at all. |
| **Security implications** | If resume evaluated expiry and skipped it, resume would become an expiry bypass. |
| **Safest default** | No new evaluation point. Expiry is decided where it is decided today — at claim. Resume only re-dispatches, and an expired grant makes the node `waiting_for_approval` again. |
| **Test implications** | Grant expires between approval and resume → the node returns to `waiting_for_approval`, programme `blocked`, no attempt. |

## D5 — Confirm reconciliation of an externally-run task

| | |
|---|---|
| **Current behaviour** | `reconcileInterruptedNodes` adopts a node whose task is `succeeded` as `already_succeeded`, but only for nodes in `running`. A node in `waiting_for_approval` whose task succeeds outside the programme would **not** be reconciled today. |
| **Security implications** | None: the task succeeded under its own claim and approval. The programme is recording an observation, not granting authority. |
| **Safest default** | Yes — extend the reconcile pass to `waiting_for_approval` nodes, recording `already_succeeded` with the external run in evidence. Without this, D1's resume would re-dispatch the node even though the task already succeeded, and the reservation would answer `already_succeeded` anyway — so the extension makes the record truthful rather than changing authority. |
| **Test implications** | A HIGH node, grant spent via `POST /run`, task succeeds, then resume → node `already_succeeded`, no second attempt. |

---

## What is required before any implementation

1. Answers to **D1, D2, D3** from an operator, with an owner and a date.
2. Confirmation (or correction) of D4 and D5.
3. Acceptance that resume does **not** change `requireProgrammeAuthority`, does not spend a
   grant, does not alter `WORKFLOW_ID_REUSE_POLICY` globally, and adds no bypass.

Until then **P87-009 stays BLOCKED_POLICY**, and the absence of resumption is a reported
limitation rather than a partial feature. No endpoint, no column and no event is added
"ready for later": a field with no writer is the same class of defect as a comment that
claims a control the code does not implement.
