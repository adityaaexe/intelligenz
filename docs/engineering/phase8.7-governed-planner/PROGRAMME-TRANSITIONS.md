# Programme status transitions — Phase 8.7

**Status:** describes the implementation in this repository. The line references are to the
files as they stand with this document; if a reference has drifted, the file is authoritative
and this page is stale.

`ProgrammeStatus` has exactly seven values:

```
pending  running  succeeded  failed  blocked  cancelled  timed_out
```

The enum is declared at `packages/database/prisma/schema.prisma:139` and has not changed
since the programme layer landed. Everything below is the set of moves the code can actually
make — not a state machine anyone would like to have.

---

## 1. The seven statuses, their writers, and their timestamps

There are exactly three writers of `Programme.status`. A fourth would be a second truth.

| Status | Written by | Edge in | Durable timestamp written with it |
|---|---|---|---|
| `pending` | **API submit** — the insert, column default (`apps/api/src/programmes/programmes.service.ts:171`) | `∅ → pending` | `createdAt` (`@default(now())`) |
| `running` | **`loadProgrammeActivity`** (`apps/worker/src/activities/programme.ts:152`) | `pending → running` | `startedAt` |
| `succeeded` | **`finishProgrammeActivity`** (`apps/worker/src/activities/programme.ts:683`) | `running → succeeded` | `finishedAt`; clears `failureReason` and `failureCode` |
| `failed` | **`finishProgrammeActivity`**, or **API submit** when the start is refused (`programmes.service.ts:251`) | `running → failed`; `pending → failed` | `finishedAt` |
| `blocked` | **`finishProgrammeActivity`** | `running → blocked` | `finishedAt` |
| `cancelled` | **`finishProgrammeActivity`**, from the non-cancellable cancellation scope | `pending → cancelled`; `running → cancelled` | `finishedAt` |
| `timed_out` | **`finishProgrammeActivity`** | `running → timed_out` | `finishedAt` |

`finishProgrammeActivity` is the only writer of `succeeded`, `blocked`, `cancelled` and
`timed_out`, and the only writer of a terminal `failed` that happens after a start. The API's
`failed` covers the one case no workflow exists to report: the row was committed and Temporal
refused to start the execution.

### Durable timestamps

| Column | Written by | When | Rewritten? |
|---|---|---|---|
| `createdAt` | the insert's `@default(now())` | the submission transaction commits | never |
| `startedAt` | `loadProgrammeActivity` (`programme.ts:152-156`) | `pending → running`, conditional on `status = 'pending'` | never — the guard means a second load finds `running` and does not touch it |
| `finishedAt` | `finishProgrammeActivity` (`programme.ts:683-694`) | any move to a terminal status, conditional on `status IN ('pending','running')` | never — a second finish changes nothing |

`startedAt` is deliberately **not** written by the API. "The scheduler is running" is a fact
only the scheduler can report, and a submission that failed to start must not carry a start
time. `finishedAt` is written in the same UPDATE as the status, so a terminal row with no
`finishedAt` is not a state this code produces.

---

## 2. Every legal edge

`∅` means "no row yet".

| From → To | Writer | Reachable in practice |
|---|---|---|
| `∅ → pending` | API submit | **yes** — every successful submission |
| `pending → running` | `loadProgrammeActivity` | **yes** — the parent's first activity call |
| `pending → failed` | API submit (`ORCHESTRATOR_UNAVAILABLE` / `START_FAILED`) | **yes** — Temporal refuses the start |
| `pending → cancelled` | `finishProgrammeActivity` | **only out of band** — an operator cancels the workflow before its first load lands |
| `pending → succeeded` | `finishProgrammeActivity` | **no** — `load` always runs before `finish` and moves the row to `running`; if its CAS loses, `drive` returns early and writes no finish |
| `pending → blocked` | `finishProgrammeActivity` | **no** — same reason |
| `pending → timed_out` | `finishProgrammeActivity` | **no** — same reason |
| `running → succeeded` | `finishProgrammeActivity` | **yes** |
| `running → failed` | `finishProgrammeActivity` | **yes** — a node's task failed, or the graph was refused inside the workflow (`GRAPH_INVALID`) |
| `running → blocked` | `finishProgrammeActivity` | **yes** — an approval is pending, a dependency is blocked, or nothing was schedulable (`NO_READY_NODE`) |
| `running → timed_out` | `finishProgrammeActivity` | **yes** — `deadlineAt` passed |
| `running → cancelled` | `finishProgrammeActivity`, inside `CancellationScope.nonCancellable` | **only out of band** — an operator cancelling `programme-<id>` in Temporal. No API endpoint does it: `POST /cancel` names `task-<taskId>`, and no test exercises this edge |
| `running → running` | — | **no writer.** Nothing re-writes `running`; a reload reads it and leaves it alone |
| `terminal → anything` | — | **refused by the guard**: `where: { status: { in: ['pending','running'] } }`. A late checkpoint or a retried finish cannot reopen or re-close a terminal row; `FinishProgrammeResult.changed` is `false` and the row keeps its status |

The three unreachable `pending → terminal` edges are listed rather than omitted because the
guard permits them. That is deliberate: the guard is about **write ordering**, not about
modelling the lifecycle, and narrowing it to `running` would turn a lost CAS into a thrown
workflow instead of a no-op. The edge is legal for the writer and unreachable from the
scheduler.

---

## 3. Why there is no `cancelling`

Because it would be a status with no writer.

Cancellation is handled in one place: the `catch (isCancellation(error))` arm in
`runProgrammeWorkflow` (`apps/worker/src/workflows/run-programme.ts:156-183`). It opens
`CancellationScope.nonCancellable`, calls `finishProgrammeActivity` with `status: 'cancelled'`
and `code: 'CANCELLED'`, and rethrows so Temporal records the execution as cancelled rather
than as a workflow that stopped early.

That write is **one conditional UPDATE** from `pending`/`running` to `cancelled`. Nothing in
the API cancels a programme today — `POST /cancel` cancels `task-<taskId>` — so the arm runs
only when an operator cancels `programme-<id>` in Temporal; the row it leaves is correct
either way, which is the property this document is about. A `cancelling` status would require
a second write before it and a third after it:

- the first write would have to come from the same non-cancellable arm that is already
  holding the terminal write — nothing else observes "a cancellation was requested" for a
  programme;
- the second write would be the terminal one, so `cancelling` would exist only for the
  duration of one activity call;
- and if the process died between them, the row would sit in `cancelling` for ever: there is
  no sweeper for programmes, and Temporal's own cancel RPC is idempotent on the *execution*,
  so a retry would not rewrite a row left half-way.

A state that only one writer can enter and the same writer immediately leaves is not a
lifecycle stage; it is a lock, and the conditional UPDATE already is one. The honest
read of `running` is "the scheduler owns this row and has not finished with it", which
includes "a cancellation is in flight".

---

## 4. Why there is no `partially_completed`

Because the partial result is already recorded twice, at the granularity where it is true.

- `ProgrammeTask.status` is per node: `pending | running | succeeded | failed | blocked |
  waiting_for_approval | cancelled` (`schema.prisma:149-163`). "Three of five succeeded" is
  three rows saying `succeeded` and two saying something else.
- `ProgrammeCheckpoint` is the ordered record of what the scheduler observed, with the
  attempt and the child execution that produced it. The partial outcome is the checkpoint
  list, not a summary of it.

A `partially_completed` programme status would be a **second source of truth** for the same
fact, computed at a different time from the same rows. The two would disagree the first time
a checkpoint was written after the status, and the disagreement would be silent: a client
reading `partially_completed` cannot tell which nodes it means without reading the nodes
anyway.

It would also have to be defined against the terminal vocabulary. `blocked` already means
"work remains that could not run"; `failed` already means "a node's work failed"; `succeeded`
already means "all of it ran". `partially_completed` would sit between them without saying
which of those three facts is true, and the answer would still have to come from the nodes.

---

## 5. Why `proposed`, `validating`, `awaiting_plan_approval` and `ready` are not programme statuses

Because a programme row does not exist until an approved plan is submitted.

The plan lifecycle is its own enum — `PlanStatus` is `proposed | invalid | approved |
rejected | submitted` (`packages/database/prisma/schema.prisma:174-180`). The four words the
directive lists map onto it, not onto `Programme`:

| Word | Where it actually lives |
|---|---|
| `proposed` | `PlanStatus.proposed` — the planner returned a proposal and nothing has been approved |
| `validating` | a moment inside `PlansService.propose`/`submit`, not a stored state; the outcome is `invalid` or a recomputed hash match |
| `awaiting_plan_approval` | `PlanStatus.approved` with a live `approvalExpiresAt`, or `proposed` before a decision — a plan, not a programme |
| `ready` | a **task** status (`TaskStatus.ready`), and a task must be `ready` before a reservation can name it. There is no `ready` in `ProgrammeTaskStatus` either: a node is `pending` until it is dispatched |

The ordering is enforced by construction, not by convention: `PlansService.submit` creates
the tasks, then calls `ProgrammesService.submit` (`apps/api/src/plans/plans.service.ts:583`),
and only then writes `Plan.status = 'submitted'` and `Plan.programmeId` in a conditional
update (`:605`). A programme therefore has no pre-submission phase to name: before the
approval there is no programme id, no graph and no row.

Adding those values to `ProgrammeStatus` would create four values that **no programme row can
hold** — a vocabulary that licenses queries no writer can satisfy. Worse, `proposed` on a
programme would make "a plan exists" and "a schedule is running" the same column, and the two
have different owners: a plan belongs to the person deciding, a programme to the scheduler.

---

## 6. When `succeeded` is permitted

The exact statement:

> A programme is `succeeded` when **every node is `succeeded`**, **no node is waiting for an
> approval**, and **no node's evidence is missing**.

The first two are the same condition observed twice: `waiting_for_approval` is a node status
that is not `succeeded`, so a programme with an outstanding approval is `blocked`, never
`succeeded`. The third is implied by how the nodes get there: the child writes evidence
(`persistResultActivity`) before it returns a terminal verdict, and the parent records the
node's checkpoint — with the attempt and child run that produced it — only after that verdict
arrives (`apps/worker/src/workflows/run-programme.ts:484-519`). A `succeeded` node therefore
always has a checkpoint naming a real attempt.

**What the implementation actually checks** is narrower, and it is worth being exact about it:
`succeeded` is derived from node states **alone** — `programmeStatus` at
`apps/worker/src/workflows/run-programme.ts:675-683` returns `succeeded` when no node is
`failed`/`cancelled` and every node is `succeeded`. It does not re-read the evidence rows, and
it does not ask the child whether the artifacts exist.

That is a deliberate division of authority rather than an omission. Evidence is the child's
record and Phase 7's document validator's subject; the parent's only claim is "every node
reported success", and the checkpoint list is what makes that claim checkable after the fact.
A parent that re-validated evidence would be a second judge of a verdict it did not observe —
and the first place the two judges would disagree is a task the child marked succeeded for a
reason the parent does not model.

---

## 7. Where the reason lives

Status answers *what* the programme is; `failureReason` and `failureCode` answer *why* it
stopped. Both are written in the same conditional UPDATE that closes the row
(`apps/worker/src/activities/programme.ts:683`), and both are cleared on success:

- `failureReason` is prose for a person and embeds task ids. It is not a filter.
- `failureCode` is one of `PROGRAMME_REASON_CODES` (`packages/contracts/src/programme-reason.ts`):
  `TASK_FAILED`, `APPROVAL_PENDING`, `DEPENDENCY_BLOCKED`, `NO_READY_NODE`,
  `DEADLINE_EXCEEDED`, `ORCHESTRATOR_UNAVAILABLE`, `START_FAILED`, `GRAPH_INVALID`,
  `CANCELLED`, `UNSPECIFIED`.
- A `succeeded` row holds `NULL` in both, and the API answers `failureCode: null` — a success
  has no failure code. `UNSPECIFIED` is reserved for a **terminal non-success** whose code
  this build cannot name (a row that predates the column, or one closed by an older worker),
  and it never reads as success.

The mapping from the workflow's own paths: a node failed or was cancelled → `TASK_FAILED`; a
node waits for an approval → `APPROVAL_PENDING`; a node is blocked → `DEPENDENCY_BLOCKED`;
nothing was schedulable → `NO_READY_NODE`; the deadline passed → `DEADLINE_EXCEEDED`; the
graph was refused → `GRAPH_INVALID`; the execution was cancelled → `CANCELLED`. A programme
that never started is coded by the API (`ORCHESTRATOR_UNAVAILABLE` / `START_FAILED`), and a
success is coded by neither.
