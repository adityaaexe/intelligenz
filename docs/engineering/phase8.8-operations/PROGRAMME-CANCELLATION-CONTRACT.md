# Programme cancellation — contract

**Status: implemented.**
Route, role, status codes, the single-writer rule for the terminal state, what cancellation
does to children, and the two things it deliberately does not do. Known limitations are
recorded as limitations, not softened.

Scope: `POST /v1/orgs/:orgId/programmes/:programmeId/cancel`, `ProgrammesService.cancel`,
`OrchestratorService.cancelProgrammeWorkflow`, and the existing `runProgrammeWorkflow`
cancellation handler — which this unit reaches for the first time.

---

## 1. The problem this closes

`POST /cancel` cancels a **task**: it issues `workflow.getHandle('task-<taskId>').cancel()`.
Since `34eaedf` a programme-dispatched child runs under that id, so cancelling a task does
reach a programme's child. Nothing cancelled a **programme**: the parent runs under
`programme-<programmeId>` and had a cancellation handler that no public route could
trigger. A user could stop a programme only one task at a time, and stopping the tasks did
not stop future dispatch — the scheduler kept reading the graph and reserving the next
node.

No second engine, no scheduler, no new workflow: the route cancels the existing parent.

| Layer | File |
|---|---|
| Route + role | `apps/api/src/programmes/programmes.controller.ts` (`POST :programmeId/cancel`, `@Roles('MEMBER')`) |
| Decision + terminal write | `apps/api/src/programmes/programmes.service.ts` → `cancel()` |
| Orchestrator call | `apps/api/src/orchestrator/orchestrator.service.ts` → `cancelProgrammeWorkflow()` → private `cancelWorkflow()` |
| Cancellation handler | `apps/worker/src/workflows/run-programme.ts` → `runProgrammeWorkflow()` catch block |
| Terminal row write | `apps/worker/src/activities/programme.ts` → `finishProgrammeActivity()` |

---

## 2. Route

```
POST /v1/orgs/:orgId/programmes/:programmeId/cancel
Role: MEMBER
Body: none
```

MEMBER is the role `POST /programmes` and `POST /tasks/:id/cancel` already use: cancelling a
programme is undoing the same act those endpoints perform, and the role ladder matches the
write it undoes. **Escalating this to ADMIN is a policy choice nobody has made** — it is
recorded here as available, not implemented. Any future change must update the controller,
`api-contract.md` and the e2e suite together.

### Response

```json
{ "data": { "programmeId": "...", "cancellation": "requested", "recordedBy": "workflow" } }
```

| Status | Body / code | When |
|---|---|---|
| `200` | `{ programmeId, cancellation: "already_cancelled" }` | the row was already `cancelled`. Nothing written, **no orchestrator call**. |
| `202` | `{ programmeId, cancellation: "requested", recordedBy: "workflow" }` | the row has `startedAt`; the cancellation reached `programme-<id>`; the workflow owns the terminal state and will write it. |
| `202` | `{ programmeId, cancellation: "cancelled_before_start", recordedBy: "api" }` | no scheduler ever ran (`startedAt` null); the API wrote `cancelled` in one guarded UPDATE. |
| `404` | `NOT_FOUND` | no programme with that id **in this organisation**. |
| `409` | `PROGRAMME_NOT_CANCELLABLE` | the row is `succeeded`, `failed`, `blocked` or `timed_out`; the message names the status. Nothing written. |
| `409` | `EXECUTION_NOT_FOUND` | the row is `pending`/`running` and Temporal has no execution under `programme-<id>`. Nothing written. |
| `503` | `ORCHESTRATOR_UNAVAILABLE` | Temporal could not take the cancellation. Nothing written. |

`404` and never `403` for another tenant's programme: a `403` would confirm the id exists,
which is the cross-tenant existence oracle every other route in this codebase refuses to be.

`409 EXECUTION_NOT_FOUND` mirrors `task.cancel` exactly: the row claims a live execution and
there is none, so writing `cancelled` would produce a programme that is stopped in the UI and
— if anything ever reattached to that id — dispatching in the background.

---

## 3. Who writes the terminal state

There is exactly one writer per case, decided by `startedAt` — the column only
`loadProgrammeActivity` writes (`apps/worker/src/activities/programme.ts:152-171`):

| `startedAt` | Writer | What is written | Answer |
|---|---|---|---|
| set | the parent workflow's `CancellationScope.nonCancellable` (`run-programme.ts:159-178`) | `status='cancelled'`, `failureCode='CANCELLED'`, `failureReason` prose, `finishedAt` | `202 requested` |
| null | `ProgrammesService.recordPreStartCancellation` — one `UPDATE` guarded by `status='pending' AND startedAt IS NULL` | `status='cancelled'`, `failureCode='CANCELLED'`, `finishedAt`, reason "Cancelled before the scheduler started; no task was dispatched." | `202 cancelled_before_start` |

Why the split:

- **A started programme belongs to its workflow.** Writing `cancelled` in the API as well
  would be a second writer racing `finishProgrammeActivity`, which is guarded to
  `status IN ('pending','running')` (`activities/programme.ts:683-695`). Whichever landed
  second would be silently dropped while the API reported the cancellation as recorded.
- **A programme that never started has no workflow to report anything.** Leaving it
  `pending` would be a row claiming a schedule that is doing nothing. This is the same
  posture `submit()` already takes when it marks a programme `failed` for a start that
  failed (`programmes.service.ts:271-289`).

### The two compare-and-swaps arbitrate

The API's guarded `UPDATE` and `loadProgrammeActivity`'s `pending → running` write are both
conditioned on `status='pending'`. Whichever commits first wins and the loser observes it:

- API first → the workflow's load sees `cancelled`, reports the row's actual status, and
  `drive()` returns without dispatching (a terminal programme schedules nothing). The row is
  `cancelled`; no workflow wrote it.
- Workflow first → the API's `UPDATE` affects zero rows, and the service re-reads, sees
  `startedAt` set, and answers `202 requested` **without forcing the write**.

If the guarded update affects zero rows and the re-read shows `cancelled` or a terminal
status, the service applies the same `200 already_cancelled` / `409
PROGRAMME_NOT_CANCELLABLE` semantics — it never forces the write.

### Audit

`programme.cancel_requested.v1`, written on the paths that actually request a cancellation
(`requested` and `cancelled_before_start`), with:

- `idempotencyKey: programme.cancel_requested:<programmeId>` — deterministic, so a retried
  request that reaches the same arm is one event about one cancellation;
- `payload: { programmeId, actorId, recordedBy, previousStatus }` — **never the objective**.
  The submission event already carries the content; an audit row that echoed it would make
  every cancellation a second copy of programme content for no operational gain.

No event is written on `already_cancelled` (nothing was requested), and none on a refusal.

---

## 4. What cancellation does to children

The parent is cancelled; the children follow through Temporal, with values this codebase
never sets — the SDK defaults:

| Setting | Value in force | Where verified |
|---|---|---|
| `ChildWorkflowOptions.cancellationType` | `WAIT_CANCELLATION_COMPLETED` | `node_modules/.pnpm/@temporalio+workflow@1.25.0_long@5.3.2_protobufjs@8.8.1/node_modules/@temporalio/workflow/lib/interfaces.d.ts:510-512` (`@default` + property), enum default at `:384`, `:425-427` |
| `ChildWorkflowOptions.parentClosePolicy` | `PARENT_CLOSE_POLICY_TERMINATE` (= `TERMINATE`) | same file, `:516-518` |

`grep -rn "parentClosePolicy\|cancellationType" apps packages --include=*.ts` returns
nothing: neither option is set by this repository, so both SDK defaults are what runs.

Consequences of `WAIT_CANCELLATION_COMPLETED`:

- the cancellation request **is propagated** to the child, and the parent waits for the child
  to finish cancelling before its own `handle.result()` rejects;
- the child's own cancellation path runs: `runTaskWorkflow`'s catch calls
  `recordCancellation` in a `CancellationScope.nonCancellable`, which writes the task's
  terminal state (`cancelled`) and closes its `WorkflowRun`;
- an activity that was **already executing** is not aborted. It runs to its own completion
  or timeout, and its completion is discarded by the closed workflow (`Activity not found on
  completion … workflow execution already completed` appears in the worker log in exactly
  that case). `executeAgentActivity` finalises its own `ExecutionAttempt` before returning,
  which is why the attempt does not stay `running`.

The last two child-start properties were re-verified, not assumed:

- the child is started with `workflowId: \`${WORKFLOW_ID_PREFIX}${node.taskId}\`` —
  `run-programme.ts:331` — so `POST /cancel` and the operator's `task-<id>` re-probe both
  reach it;
- with `workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY` —
  `run-programme.ts:345` — a live duplicate is still refused and a closed
  failed/cancelled/terminated child may be replaced.

---

## 5. What cancellation does **not** do

- **It does not spend or revoke approvals.** A HIGH/CRITICAL node is refused by the
  reservation with `approval_required` (`activities/programme.ts:377`) and recorded
  `waiting_for_approval`. Cancelling the programme leaves the `ApprovalRequest` exactly as
  it was: `consumedAt` and `consumedByAttemptId` stay `NULL`, `status` stays `PENDING`.
  Proved by `programme-cancellation.test.ts` → *does not spend an approval grant that was
  waiting for a human*.
- **It does not delete evidence.** Artifacts, evidence, `AgentRun` and checkpoints written
  before the cancellation are untouched. A task that already succeeded stays `succeeded`
  with its attempt and evidence intact. Proved by *does not rewrite a task that completed
  before the cancellation*.
- **It does not abort an in-flight activity instantly.** Cancellation cancels the
  *workflow*; a JS activity already executing cannot be force-killed. It finishes (or hits
  its own `startToCloseTimeout`) and its result is discarded. This is a Temporal property,
  not a gap in this code.
- **It does not write task rows.** The API writes one programme row in one case (§3); every
  task status on the cancellation path is written by the child's own workflow.
- **It does not release reservations.** Nothing releases a reservation on cancel, and
  nothing needs to: the interrupted child settles its own attempt.

---

## 6. Known limitations

### 6.1 `TERMINATE` parent-close

`parentClosePolicy` is not set, so it is `TERMINATE`. **A programme that is _terminated_
rather than _cancelled_ terminates its children without per-child cleanup.** No child catch
block runs, so the children's tasks can stay `queued`/`running` with attempts in flight, and
the programme row stays in whatever state it held.

Reachability: `TerminateWorkflowExecution` (an operator, `temporal workflow terminate`, or a
retention/administrative action), not this route. This route issues `RequestCancel`, which
is the path in §4.

**Recorded, not fixed.** Changing the policy to `REQUEST_CANCEL` would make termination
propagate cancellation to children — a real improvement, and a behaviour change to every
existing parent/child edge in the system, which is why it is not part of this unit.

### 6.2 The interrupted node keeps `ProgrammeTask.status = 'running'`

A node's outcome is written by `recordProgrammeCheckpointActivity`, which runs **after** the
child returns (`activities/programme.ts:646-657`). A cancellation that interrupts the child
closes the programme without a checkpoint for that node, so the node row keeps `running` —
the state whose documented meaning is "reserved and dispatched".

What is nonetheless true, and asserted:

- at most **one** node can be in this state (`maxConcurrent` defaults to 1);
- the node owns no live `Task` and no live `ExecutionAttempt` — both are terminal, which the
  worker suite asserts directly;
- `reserveProgrammeTaskActivity` refuses a terminal programme
  (`activities/programme.ts:269-280`), so nothing can dispatch that node again.

The residue is bookkeeping: `ProgrammeTask.status` is read by the API's programme response,
so a client showing node states would display one node as `running` for a cancelled
programme. Settling it would mean extending `finishProgrammeActivity` to sweep node rows —
an activity-behaviour change outside this unit's scope.

### 6.3 Not covered by a test

- **Cancellation before the workflow's first task executes.** The handler is structured so
  that the first `await` in `drive()` rejects with `CancelledFailure` and the
  `nonCancellable` scope still records the terminal state, but no test produces that exact
  interleaving (it needs a queue with no worker, then a start, then a cancel, then a worker).
  See `PROGRAMME-CANCELLATION-E2E-REPORT.md` §4.
- **Worker restart after a cancellation request** — no restart harness exists here.

---

## 7. Files changed

| File | Change |
|---|---|
| `apps/api/src/orchestrator/orchestrator.service.ts` | body of `cancelTaskWorkflow` extracted to private `cancelWorkflow`; `cancelProgrammeWorkflow(programmeId)` added |
| `apps/api/src/programmes/programmes.controller.ts` | `POST :programmeId/cancel`, `@Roles('MEMBER')` |
| `apps/api/src/programmes/programmes.service.ts` | `cancel()` + private `recordPreStartCancellation()` |
| `apps/api/src/programmes/programmes.response.ts` | `CancelProgrammeResponse` |
| `apps/api/src/common/errors.ts` | `PROGRAMME_NOT_CANCELLABLE` |
| `apps/api/api-contract.md` | route row, codes, who-writes rule, audit event |
| `apps/api/test/programmes.e2e-spec.ts` | 8 cancellation tests |
| `apps/worker/test/programme-cancellation.test.ts` | new: 4 worker-suite tests |

No schema migration: the terminal write reuses `Programme.status`, `failureCode`,
`failureReason` and `finishedAt`, all of which already exist.
