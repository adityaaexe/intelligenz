# Approval-gated programme resumption — design and required decisions

**Status: BLOCKED on governance decisions D1–D5.** No resumption code is proposed for
merge until they are answered. Nothing in this document authorises execution.

---

## 1. What happens today, verified

A programme node whose task requires approval:

| Step | Code | Observed behaviour |
|---|---|---|
| Reservation is requested | `reserveProgrammeTaskActivity`, `apps/worker/src/activities/programme.ts` | `requiresApproval(task.riskClass)` → returns `{ outcome: 'approval_required' }` **before any write**. No `WorkflowRun`, no `ExecutionAttempt`. |
| Node recorded | `run-programme.ts` dispatch switch | checkpoint `waiting_for_approval`; `NODE_STATUS_BY_OUTCOME` maps it to node status `waiting_for_approval`. |
| Dependents | `blockDependents` (`run-programme.ts`) | a dependency that is `waiting_for_approval` blocks its dependents, exactly like `failed`. |
| Programme verdict | `programmeStatus` (`run-programme.ts`) | only all-`succeeded` yields `succeeded`; `waiting_for_approval` yields `blocked`. |
| Programme row | `finishProgrammeActivity` | `pending|running → blocked`. `failureReason` is prose ("Waiting for approval on <task ids>"). |
| Workflow | `runProgrammeWorkflow` | **returns**. The execution is closed. |

So the scheduler correctly refuses to authorise. It also stops. The task can still be run
by a human through `POST /run` once a grant exists — that path is unchanged and it is the
only path that spends a grant.

## 2. Why resumption does not work, stated precisely

Three independent blockers. All three must be addressed; fixing one does nothing.

1. **The workflow is closed and its id cannot be reused.**
   `startProgrammeWorkflow` uses `WORKFLOW_ID_REUSE_POLICY =
   ALLOW_DUPLICATE_FAILED_ONLY` (`apps/api/src/orchestrator/orchestrator.service.ts`).
   A `blocked` programme did not close as failed, so a second start under
   `programme-<id>` is refused by Temporal.

2. **Nothing observes an approval decision.**
   `ApprovalsService.decide` writes the decision and its audit row. It does not, and
   should not, know that a programme is waiting on that task. There is no listener, no
   outbox consumer, and no signal target — the parent is gone.

3. **The programme row is terminal by design.**
   `finishProgrammeActivity` only moves `pending|running` rows. And since Phase 8.7's
   AUTH-05 fix, `reserveProgrammeTaskActivity` refuses a reservation for any status other
   than `pending`/`running`. A `blocked` row therefore cannot dispatch even if a new
   execution existed. This is deliberate: a cancelled programme must not be revivable by a
   stale execution.

Consequence: a user who approves a task inside a blocked programme must run it manually,
and **nothing re-reads the result**. The programme stays `blocked` forever, with a
checkpoint that is truthful about why.

## 3. The decision that is missing

The governance model answers *who may approve*, *when a grant expires*, *how it is
revoked*, and *how identity is established* — all defined and enforced:

- role: `@Roles('ADMIN')` on the decision endpoint;
- four-eyes: `allowsSelfApproval(orgId)` in `apps/api/src/approvals/org-policy.ts`,
  default refuse, refusal audited;
- expiry: `expiresAt`, defaulted to `createdAt + approvalTtlHours`, `EXPIRED` status,
  `approval.expired.v1`;
- revocation: `revokedAt`/`revokedById`, `REVOKED`, `approval.revoked.v1`;
- single use: `consumedAt` + `consumedByAttemptId`, compare-and-swap.

What the model does **not** answer is whether a programme may be *re-opened* after it has
correctly stopped. That is a scheduling-authority question, not an approval question, and
it cannot be inferred from the existing policy. Hence D1–D5 below.

## 4. Options

### Option A — operator-triggered reconcile-only resume  (recommended)

`POST /v1/orgs/:orgId/programmes/:id/resume`, `@Roles('ADMIN')`, four-eyes does not apply
(the operator is not approving anything).

1. Require `status = blocked`, no node `failed`, and the previous execution closed.
2. Transition `blocked → running` on the same row, audited (`programme.resumed.v1`,
   deterministic key including a resume counter).
3. Start a new execution of `programme-<id>` with `ALLOW_DUPLICATE` — permitted only
   because step 1 proved the previous execution closed.
4. The scheduler reloads. Extend `reconcileInterruptedNodes` (today it only inspects
   nodes in `running`) to also inspect `waiting_for_approval`: if the task is now
   `succeeded`, record `already_succeeded` and let dependents proceed. If it is still
   `ready`, the node remains `waiting_for_approval` and the programme ends `blocked` again.
5. The scheduler never spends, mints or consumes a grant. Execution still happened via
   `POST /run`, under the existing claim and launch-site gate.

Authority impact: an ADMIN can cause a *re-read* of state and a resumption of dispatch for
tasks that are not approval-gated. It cannot cause an approval-gated task to execute.

### Option B — approval-triggered automatic resume

`ApprovalsService.decide` triggers a programme re-run.

Rejected for now: it makes an approval decision the direct cause of a dispatch attempt and
couples governance to scheduling. It also produces an unbounded fan-out (one decision may
unblock several programmes) and needs its own outbox, retry and poison-message handling.
It may become correct later, on top of Option A, if the operator wants automation — but
then the trigger must be a durable outbox row, not a call inside the decision transaction.

### Option C — keep the workflow open and wait for a signal

Rejected. A wait that lasts days grows history, needs `Continue-As-New` across the wait,
needs a maximum-wait policy, and turns a settled record into an open execution that must
be cancelled explicitly. The current design's "the programme stops and says why" is a
feature.

## 5. Decisions required (each needs a named human owner)

| ID | Question | Recommended answer | If answered differently |
|---|---|---|---|
| **D1** | May an ADMIN re-open a `blocked` programme, and is that the same row or a new Programme? | Same row, new legal edge `blocked → running`, audited, allowed only when no node is `failed` | A new programme duplicates the objective and the graph, and the old row's checkpoints no longer explain the new run |
| **D2** | Does an approval decision cause a dispatch attempt, or must a human still call `POST /run`? | Human `POST /run` remains the only grant spender; resume only reconciles | Option B is required, with a durable outbox; the scheduler gains the ability to cause execution |
| **D3** | How many resumes per programme, and does the original deadline survive? | Preserve the original `deadlineAt`; cap at 3 resumes with an audited counter | An uncapped resume is a scheduler loop; a reset deadline silently extends a programme's budget |
| **D4** | If a grant expires between decision and resume, may the node run? | No — expiry is evaluated at claim time by existing code, unchanged | A resumed programme could spend an expired grant, which is a new authority |
| **D5** | May a programme report `succeeded` when a node succeeded under an external `POST /run`? | Yes, recorded as `already_succeeded` with the external run in evidence — this is what `reconcile` already does | Requires a distinct terminal status such as `succeeded_externally`, and the API contract changes |

D1, D2 and D3 are blocking. D4 and D5 have a safe default consistent with existing code
and can be confirmed rather than decided.

## 6. Invariants any implementation must satisfy

These restate §5 of the master directive and are not negotiable:

1. The programme parent never mints or spends an approval grant.
2. Resume re-checks node state from the database; it never trusts in-memory state.
3. A resumed execution re-enters through `reserveProgrammeTaskActivity`, so the authority
   check, the terminal-programme refusal and the task compare-and-swap all still apply.
4. Duplicate resume requests cannot produce two executions — the workflow id plus a
   conditional `blocked → running` update is the arbiter.
5. A duplicate approval notification cannot produce a duplicate claim — the claim CAS is
   unchanged.
6. Revocation and expiry are evaluated where they are evaluated today; resume adds no new
   evaluation point.
7. Every resume writes an audit row with a deterministic key.
8. A `failed` node is never revived by resume; only blocked-on-approval work is eligible.
9. The programme's terminal verdict remains derivable from node states alone.
10. If the policy is not decided, no endpoint is added. The absence of resumption is
    reported as a limitation, not hidden behind a partial feature.

## 7. What is deliberately not built

- No `resume` endpoint.
- No signal target on `runProgrammeWorkflow`.
- No change to `WORKFLOW_ID_REUSE_POLICY` as a shortcut.
- No column, status or event added "ready for later".

A schema field with no writer is the same class of defect as a comment that claims a
control the code does not implement.
