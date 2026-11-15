# Phase 6 — Trust Boundary Closure (AG-602)

**Defect source:** `FINAL-INDEPENDENT-REVIEW.md` (SEC-601), verdict FAIL on `3aed33d`.
**Branch:** `phase-6/trust-boundary-closure`, created from `3aed33d`.
**Method:** the review's own reproductions, re-run against the fix, plus a negative control
for every release decision. Real PostgreSQL, no mocks; the two Temporal tests use the real
server and skip when none is reachable.

---

## What was wrong in one sentence

The execution claim was **written** by `validateTaskActivity` and never **read** where
execution actually starts, so the only path that honoured it was the one path that chose to.

| Finding | Where it lived | What it allowed |
|---|---|---|
| F1 | `execute-agent.ts:160` entry | Any workflow on the worker's task queue could call the executor by name, skipping validation: an unapproved `HIGH` task ran with no claim |
| F2 | `attempts.ts:170-203` adoption CAS | An attempt claimed by execution X could be adopted and run by execution Y, and finish still naming X |
| F3 | `validate-task.ts:228` | A direct start naming no attempt skipped the claim entirely; two of them ran concurrently |
| F4 | reaper (`reaper.ts:290`) | A crash between claim and adoption stranded the reservation permanently |

---

## The fix

### F1 — the claim is an entry condition of the launch site

`apps/worker/src/activities/claim.ts:427` — `requireExecutionClaim()`. Called as the **first
act** of `executeAgentActivity`, before `getWorkerConfig()`, before the runtime adapter is
constructed, before the task read, before `startAttempt`, before the cgroup probe, before
the workspace lease, before the broker and before `runtime.execute`. It resolves the
activity's run id from the Temporal **context and nowhere else**, resolves the named attempt
inside the tenant and task, and requires the row's `claimedByWorkflowRunId` to equal it.
Anything else throws `EXECUTION_IDENTITY_UNAVAILABLE` (no context),
`EXECUTION_CLAIM_REFUSED` or `EXECUTION_ALREADY_CLAIMED`, non-retryable, with zero writes.

**Corrected by AG-603.** This section used to say the run id was read from the context
"input only when there is no context". That fallback was the N1 defect: a standalone
activity has no context, so it took the input, and the gate accepted whatever claim the
input named. The fallback is gone and the input field with it — see
`AG-603-IDENTITY-AND-AUTHORITY.md`.

Immediately after it (`execute-agent.ts:223`), `assertTaskAuthorised({ altitude: 'launch' })` re-runs the approval
gate — **the same function validation calls**, extracted to
`apps/worker/src/approvals/authorisation.ts` rather than copied, so the two call sites
cannot drift. The extraction moved `selectApprovalGrant`, `evaluateApprovalGrant`,
`decideAttemptBinding`/`decideGrantBinding` and `refusalFailure` out of
`activities/validate-task.ts` unchanged; the only behavioural difference between the two
altitudes is that the reservation-altitude `status === 'queued'` clause is not applied at
launch, because a Temporal retry of *this* execution legitimately re-enters with the
attempt `running` or terminal — the claim is the exact control there.

It sits at the same altitude as the isolation gate (`execute-agent.ts:211-213` before this
change) and for the same reason: a control one activity upstream of the only launch site is
advice.

### F2 — adoption is claim-conditional

`apps/worker/src/activities/attempts.ts:184-270`. The `startAttempt` compare-and-swap now
includes `claimedByWorkflowRunId: input.executionRunId`, and `executionRunId` is a required
input with no default (a default would silently restore the bypass). The `findFirst` is
deliberately **not** filtered on the claim: filtering it would turn "this row is not yours"
into "you have no row" and let a non-owner fall through to allocating a fresh attempt.
Finding it and failing the CAS refuses instead (`EXECUTION_ATTEMPT_TAKEN`).

The allocation path (a retry after the reserved attempt was adopted or finalised) stamps
the same claim on the new row, so no attempt that ran is left with a NULL holder — the
audit-truth gap the review listed as item 6 under "what cannot be guaranteed".

### F3 — an execution with no reservation does not launch

`apps/worker/src/activities/validate-task.ts:174-206` refuses with
`EXECUTION_CLAIM_REFUSED` when `attemptId` is absent, before `claimForExecution`.
`requireExecutionClaim` refuses the same case independently at the executor, so a caller
that dispatches by name gains nothing.

**Documented cost:** the "start the workflow by hand with no attempt id" convenience path
is gone. `apps/api/api-contract.md` §6.1 records the removal and why; the attempt id needed
to start manually is already returned by `POST /run` in its `202` body.

### F4 — a vanished workflow's claim is released, and only then

`apps/worker/src/claim-release.ts` — `runClaimReleasePass()`, called from the reaper's tick
(`reaper.ts:735`). Candidates are `queued` + claimed + older than two reaper intervals;
that age filter selects candidates and never decides a release. The release requires the
probe's answer for **that specific run** (`WorkflowLivenessProbe.execution`, backed by
`describeWorkflowExecution` with the workflow id *and* run id):

| Temporal | Outcome |
|---|---|
| not found | release |
| terminal | release |
| running / continued-as-new | skip |
| unreachable / anything else | skip |

The release itself is one conditional `updateMany` (still `queued`, still claimed by *that*
run) inside a transaction with an `execution.claim_released.v1` audit row carrying the
liveness evidence. The row becomes `failed` / `ATTEMPT_ABANDONED` / `terminationReason:
'crashed'`, and both claim columns go NULL — keeping `NULL` meaning "never claimed", with
the release recorded in the audit trail instead of disguised as an unclaimed row carrying a
suspicious timestamp.

The module is imported by the reaper and by tests, and by nothing under `src/activities/`.
`test/execution-boundary.test.ts` asserts that structurally, so a future import cannot
quietly hand an execution the ability to release its own claim.

---

## Verification

| Gate | Result |
|---|---|
| `pnpm -w typecheck` | clean (7 workspace projects) |
| `pnpm -w lint` | clean (`--max-warnings=0`) |
| `pnpm -w test` | see the AG-602 report |
| `pnpm --filter @intelligenz/api test:e2e` | unchanged by this commit; see the report |
| `apps/worker/test/isolation-gate.test.ts` ×5 | see the report |
| `apps/worker/test/execution-boundary.test.ts` | 17/17 — F1 (×4), F2 (×2), F3 (×3), legitimate path + retry (×2), F4 (×5), structural (×1) |

---

## Residuals after this change

1. **Task and workflow-run status are not reconciled by the release pass.** A stranded
   reservation still leaves `Task.status = 'queued'` and `WorkflowRun.status = 'queued'`,
   and `POST /run` requires `ready` (`tasks.service.ts:778`), so re-running a task whose
   reservation was released still needs an operator to move it back to `ready`. What
   changed is that the claim no longer *also* blocks it. A run/task reconciler is the
   missing component, not a claim operation.
2. **Temporal access remains a trusted capability.** F1 and F3 assume an attacker can
   start arbitrary workflows and dispatch activities by name. The boundary now refuses an
   execution that holds no claim, but a caller who can create an attempt *and* claim it
   (direct database access) is outside every control here.
3. **Two real-Temporal tests still do not run in CI.** `.github/workflows/ci.yml` has no
   Temporal service, so the F3-through-Temporal test and the pre-existing e2e claim test
   skip on every push (O8/T2 of the SEC-601 review).
4. **The release pass kills nothing.** A stranded claim never provisioned a process, so
   there is nothing to reap — but if the claim was committed and `startAttempt` succeeded
   before the crash, the attempt is `running`, not `queued`, and the pre-existing reaper
   path applies instead.
