# Programme deadline — semantics and proof

**Status: implemented and proved.** P87-012 (the deadline return value contradicted the row)
and the two defects found beside it (a deadline that failed open, and a deadline the database
cannot report) are closed. What is *not* proved is listed as NOT RUN with the reason, not
softened.

Scope: `runProgrammeWorkflow` (`apps/worker/src/workflows/run-programme.ts`), the input type
in `apps/worker/src/shared/programme.ts`, and the API's `PROGRAMME_DEADLINE_MS` in
`apps/api/src/programmes/programmes.service.ts`. No migration, no new column, no change to
the cancellation path, the claim, approval binding, or any activity.

---

## 1. What the deadline means

A **soft ceiling on new dispatch**, not a hard kill of work already running.

| | |
|---|---|
| **It stops** | a node that has not been dispatched yet. No reservation is minted, no child is started. |
| **It does not stop** | a child that is already in flight. A running child is awaited to its own verdict; the deadline is not a cancellation. |
| **It is not** | a Temporal `workflowRunTimeout`. That is a hard server-side bound that closes an execution; this is a scheduling rule the workflow applies to itself. |

A programme that hits the deadline is finished `timed_out` **with whatever it had**. The
checkpoints written before it are the record of what ran; nothing is rewritten to pretend it
did not.

### Evaluation point

Once per loop iteration, at the top of the loop, before the ready set is computed:

```ts
// run-programme.ts:264
if (workflowInfo().unsafe.now() >= deadline) { … }
```

Time comes from `workflowInfo().unsafe.now()` and never from `Date.now()`. `Date.now()` in
workflow code is a determinism error: a replay would compute a different answer and the
server would fail the execution with a nondeterminism error. The SDK's clock is the server's
recorded time for this workflow task, so a replay reads the same value.

Because the check is at the *top* of the loop, a child that finishes after the deadline still
finishes normally and its checkpoint is still written. The deadline therefore cannot change
the verdict of work that already started — only whether the *next* node starts.

### The boundary is `>=`

The comparison is `now >= deadline`. **The deadline instant itself counts as exceeded.** A
`deadlineAt` equal to "now" set before the start is already in the past by the time the
workflow evaluates it, which is the same direction as an expired deadline; no test races the
nanosecond boundary.

### Invalid input fails closed

`Date.parse` answers `NaN` for anything it cannot read, and every comparison with `NaN` is
`false`. Before this unit, an unparseable `deadlineAt` therefore disabled the deadline
entirely and said nothing — the programme ran to completion with no bound.

`deadlineAt` is **required** in `RunProgrammeWorkflowInput`, so there is no legitimate "no
deadline" state to preserve. The workflow now checks `Number.isFinite(deadline)` immediately
after the load and the interrupted-node reconciliation (which records what an earlier
execution already did; it dispatches nothing). If the value did not parse:

- the programme is finished `timed_out` with code `DEADLINE_EXCEEDED`;
- the reason names the invalid input as a **quoted, truncated excerpt** (40 characters, then
  `…`), JSON-escaped so a value containing a newline cannot forge a second log line. The
  caller's value is not echoed unbounded;
- no node is dispatched, no checkpoint is written, no attempt is reserved.

---

## 2. The terminal paths

The workflow returns `RunProgrammeWorkflowResult`, and `status` must agree with the status it
committed. Two paths decide the status themselves rather than deriving it from node states;
on both, every node may still be `pending`, so a derived status would report `blocked` while
the row says otherwise. `summarise(state, committed?)` takes that override, and only those
two paths pass it. The deadline has two shapes — parseable and passed, and unparseable — and
both commit the same verdict.

| Path | Committed row (after) | Returned status **before** | Returned status **after** |
|---|---|---|---|
| Deadline — parseable and passed (`run-programme.ts:264`) | `timed_out`, `DEADLINE_EXCEEDED` | `blocked` (every node `pending`) | `timed_out` |
| Deadline — unparseable (`run-programme.ts:242`) | `timed_out`, `DEADLINE_EXCEEDED` | **no deadline path at all**: `NaN` disabled the check, so the programme ran and returned what its nodes did — observed `succeeded` | `timed_out` |
| `GRAPH_INVALID` (`run-programme.ts:229`) | `failed`, `GRAPH_INVALID` | `blocked` (every node `pending`) | `failed` |
| `NO_READY_NODE` (`run-programme.ts:298`) | `blocked`, `NO_READY_NODE` | `blocked` | `blocked` — unchanged, the derived value already agreed |
| Normal end of the loop | `succeeded` / `failed` / `blocked`, with `null` / `TASK_FAILED` / `APPROVAL_PENDING` / `DEPENDENCY_BLOCKED` | derived from node states | derived from node states — unchanged |

`ProgrammeRunStatus` and the database statuses are unchanged. `Programme.status` is written
by `finishProgrammeActivity` from the same value the override carries, so the row and the
return value are one decision written twice, not two derivations that can drift.

The counts (`succeeded`, `failed`, `blocked`, `checkpoints`) are always derived from the
nodes: they describe what happened, and a verdict that contradicts the row would be a lie
about the same facts. On the two overridden paths those counts are honest about the state at
exit — e.g. the deadline path with two untouched nodes returns `blocked: 2`.

---

## 3. Where the deadline lives, and what that costs

**Durable location: the workflow input.** `RunProgrammeWorkflowInput.deadlineAt`
(`apps/worker/src/shared/programme.ts:54`), passed by the API at
`apps/api/src/programmes/programmes.service.ts:266` as
`new Date(Date.now() + PROGRAMME_DEADLINE_MS).toISOString()`, six hours.

`continueAsNew(input)` re-starts the workflow with the same argument object, so the deadline
is carried across every Continue-As-New boundary unchanged. That is a property of the input,
proved from the second run's `WorkflowExecutionStartedEventAttributes.input` (§4, test 5) —
not inferred from "the programme completed".

### Limitation L1 — the deadline is not a column

`Programme` has no `deadlineAt` column, and `PROGRAMME_SELECT` in the API does not project
one. Two consequences, both real:

1. **An operator cannot read the deadline from the database or the API.** It exists only in
   the workflow input, and reading it requires the Temporal history — not the row a dashboard
   has.
2. **A re-start recomputes the budget.** Any future path that starts a new execution for an
   existing programme and lets the API compute `now + 6h` grants a **fresh** six-hour budget,
   silently. Nothing in this build re-starts a programme (there is no resume path — P87-009 is
   BLOCKED on decisions D1–D3), so this is a constraint on the resume design, not a live
   behaviour. A resume must carry the original `deadlineAt`, which is exactly what §4 test 5
   shows the Continue-As-New mechanism already does for its own boundary.

No column was added. A `deadlineAt` column would imply the API enforces or reports a deadline
it does not: the API computes a value once and forgets it, and no query would ever answer
"when will this programme stop dispatching" for a row whose workflow has crossed a boundary
under a different value. Recording the gap is more honest than a column that looks
authoritative and is not.

`PROGRAMME_DEADLINE_MS` is unchanged (six hours) and remains a constant, not configuration.

---

## 4. Proof

`apps/worker/test/programme-deadline.test.ts` — a real Temporal worker, the production
activity registry, a real Postgres, and assertions read from rows and from history.

| # | Test | What it proves |
|---|---|---|
| 1 | Deadline already past | Row `timed_out` + `DEADLINE_EXCEEDED` + `finishedAt` set; **zero** checkpoints; **zero** `ExecutionAttempt` rows; every `ProgrammeTask` still `pending` and every `Task` still `ready`; and the workflow **returned** `timed_out`. Row and return asserted together — defect 2 on the deadline path. The deadline is stamped before the start, so this also exercises the `>=` direction. |
| 2 | `deadlineAt: 'not-a-date'` | Row `timed_out` + `DEADLINE_EXCEEDED`, `finishedAt` set, reason names `"not-a-date"` as a quoted excerpt, zero attempts, returned `timed_out`. This is the fail-closed proof. |
| 3 | Far-future deadline (negative control) | `succeeded`, `failureCode` null, both tasks `succeeded`. Without it, "the deadline fired" and "the assertion is always true" would be indistinguishable. |
| 4 | Cycle in `ProgrammeTask.dependsOn` | Row `failed` + `GRAPH_INVALID`, zero attempts, both nodes `pending`, and the workflow **returned** `failed`. Pre-fix it returned `blocked`. |
| 5 | Continue-As-New, four chained nodes, `continueAfterCheckpoints: 1` | First run `CONTINUED_AS_NEW` with a `newExecutionRunId`; the **second run's** `WorkflowExecutionStartedEventAttributes.input`, read from its own history, equals the input the test passed — `deadlineAt` string-identical, nothing recomputed. |

### The tests detect the defects — measured, not asserted

Running the same file against the pre-fix `run-programme.ts` (`git checkout` of that one file,
then restored):

| Test | Result on the unfixed workflow |
|---|---|
| 1 — deadline past | **FAIL** — `expected 'blocked' to be 'timed_out'` |
| 2 — unparseable | **FAIL** — `expected 'succeeded' to be 'timed_out'`: the programme *ran to completion* with no deadline, which is the fail-open |
| 3 — negative control | PASS (it must: the control does not depend on the fix) |
| 4 — invalid graph | **FAIL** — `expected 'blocked' to be 'failed'` |
| 5 — Continue-As-New | PASS (it must: the deadline was always carried, the return value was the defect) |

`programme-execution.test.ts`'s existing deadline case now also asserts `result.status ===
'timed_out'` where its comment previously recorded `blocked` as the known-wrong value. No
existing expectation was changed or removed.

---

## 5. Scenario matrix

"Directive scenarios" = the deadline behaviours this unit was asked to account for. RUN means
proved by a test in `programme-deadline.test.ts` unless another file is named.

| Scenario | Status | Evidence / reason it is not run |
|---|---|---|
| Deadline already in the past | **RUN** | test 1 |
| `deadlineAt` present but unparseable | **RUN** | test 2 |
| Deadline in the future does not fire (control) | **RUN** | test 3 |
| Invalid graph: committed `failed` == returned | **RUN** | test 4 |
| Deadline preserved across Continue-As-New | **RUN** | test 5, read from the second run's started event |
| Deadline passes while an approval-gated programme waits | **NOT RUN** | There is no resumable approval path: `P87-009` is BLOCKED_POLICY on decisions D1–D3 (`APPROVAL-RESUMPTION-DECISIONS.md`). A programme that records `waiting_for_approval` finishes `blocked` and its workflow **closes**; no execution survives to observe a deadline, and a resume would have to decide D3 ("does the original deadline survive?"). The matrix row needs that decision, not a test. |
| Deadline passes while a child is in flight (soft ceiling, no kill) | **NOT RUN** | Would require the deadline to pass between two loop iterations, i.e. racing wall-clock time on this host, and the workflow sandbox has no injectable clock. Stated instead as a code property: the check is only at the top of the loop (`run-programme.ts:264`), a child is awaited to its own verdict, and the loop breaks on `open.length === 0` **before** the check when the last child finished. |
| Deadline expires *across* a Continue-As-New boundary | **NOT RUN** | Same wall-clock race, one step later: the deadline would have to pass during the crossing. What matters for it — that the next generation receives the same deadline — is test 5. The check itself is the same line in every generation. |
| Duplicate execution after the deadline (re-start / resume) | **NOT RUN** | No resume path exists: `POST /programmes` creates a new row (or replays an idempotent submission) and never re-starts an existing programme, and a direct start under `programme-<id>` is refused by `ALLOW_DUPLICATE_FAILED_ONLY` because the previous execution closed `COMPLETED`. Were an execution started anyway, `loadProgrammeActivity` + `isTerminalProgrammeStatus` would return without dispatching. Neither refusal is the deadline's doing. When P87-009 lands, the resume must carry the original deadline (limitation L1) and this test belongs with it. |
| Operator reads the deadline from the database or API | **NOT RUN — not implemented** | Limitation L1: it lives in the workflow input only. Reading it costs a history fetch. |
| Deadline reached between two nodes of a batch with `maxConcurrent > 1` | **NOT RUN** | The API never sends `maxConcurrent`, so the default 1 is the only production shape. The check is per iteration, before the batch is chosen: a batch dispatched when the check passed is not re-checked per child, and no per-child re-check exists to exercise. That is the documented soft-ceiling behaviour. |

---

## 6. What did not change

- `ProgrammeRunStatus`, `ProgrammeStatus`, `ProgrammeTaskStatus`: untouched.
- Database: no migration, no column, no index.
- `PROGRAMME_DEADLINE_MS`: still six hours, still a constant.
- Cancellation (`runProgrammeWorkflow`'s catch block), the execution claim, approval binding,
  and the ten activities: untouched.
- The `NO_READY_NODE` and normal-end paths: same code, same derived status.
