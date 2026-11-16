# P88-001 — a cancelled programme can leave one node `running`

**Status: root cause located, implementation NOT DONE this cycle.** The preview deliverable
took priority; P88-001 is recorded with the mechanism and the fix design so the next cycle
starts from evidence, not from a symptom.

---

## 1. Symptom, as disclosed by P87-010

A cancelled programme can leave one `ProgrammeTask` with `status = 'running'` while no live
task or attempt remains. The Phase 8.8 cancellation test asserts `stranded <= 1`; the target
is 0.

## 2. Root cause, from the code

Two writers, and a gap between them:

| Step | Code | What it writes |
|---|---|---|
| Reservation commits | `reserveProgrammeTaskActivity`, `apps/worker/src/activities/programme.ts:~434` | `ProgrammeTask.status = 'running'`, `startedAt`, `attemptCount` — **inside the same transaction** that reserves the run and attempt |
| Child finishes | `recordProgrammeCheckpointActivity`, `:~687` | moves the node to a terminal status, guarded `status IN ('pending','running')` |
| Cancellation | `runProgrammeWorkflow` catch, `run-programme.ts:~165-181` | `finishProgrammeActivity` writes the **Programme** row `cancelled` — and nothing touches `ProgrammeTask` |

So the node is set `running` **before** the child is awaited, and the only thing that can
clear it is a checkpoint that never arrives if the workflow is cancelled in between. The
child's own cancellation handler writes the **Task** row, not the `ProgrammeTask` row — two
different records, and only one is being settled.

This is not a race with a rare window: any cancellation that lands after a reservation and
before that child's checkpoint produces it. It is observed as "one" because
`maxConcurrent` is 1, so at most one node is in flight.

## 3. Why the obvious fixes are wrong

- **API writes the node terminal state.** The API does not own programme dispatch; a
  cancellation request is not proof the child has stopped.
- **Delete the residue.** It is the record that a node was dispatched. Deleting it removes
  the evidence that the attempt existed.
- **A new activity.** The contract asserts exactly ten activity names.
- **A background sweeper.** A second writer of programme state, for a property a
  transaction can hold.

## 4. Fix design (for the next cycle)

Extend `finishProgrammeActivity` — already the single terminal writer — with an optional
`settleInFlightNodes: boolean`, set only for `status: 'cancelled'`:

1. In the same transaction as the programme-terminal UPDATE, `updateMany` every
   `ProgrammeTask` with `status = 'running'` to `cancelled`, guarded on `status = 'running'`.
2. For each row that the update matched, append a `ProgrammeCheckpoint` with `outcome =
   'cancelled'` and evidence `{ reason: 'cancelled while in flight', settledBy: 'finish' }`.
   Allocate `sequence` as `max(sequence) + row_number` **inside the transaction**, because
   the workflow's in-memory counter is not reachable from the cancellation path.
3. Idempotency comes from the guard: a retry finds no `running` node and appends nothing.
   `(programmeId, sequence)` unique remains the backstop.
4. The workflow passes `settleInFlightNodes: true` only on the cancellation path.

Open questions to settle during implementation:

- Should the attempt referenced by an in-flight node be mentioned in the evidence? The
  checkpoint's evidence is written by the parent, which does not hold the attempt id after
  the cancellation unwind. Option: read the latest attempt for that task inside the same
  transaction and record its id, without changing its status (the child owns that).
- Does `finishProgrammeActivity`'s current `pending|running` guard still hold? Yes — settle
  only runs when the programme UPDATE matched, so a programme already terminal is untouched.

## 5. Tests required

1. Cancel during an active child → **zero** nodes `running` after the programme is
   `cancelled`; the settled node is `cancelled` with a checkpoint at the next sequence.
2. A node that completed before the cancellation stays `succeeded` (no rewrite).
3. A node never reserved stays `pending` (it was never dispatched; settling it would be a
   lie).
4. Repeated cancellation → no duplicate checkpoint, `finishedAt` unchanged.
5. Resume-after-restart of a cancelled programme is not a path; the terminal guard covers it.

## 6. Why it matters beyond tidiness

The preview dashboard reports programme state. A node that says `running` with no execution
is exactly the "green because a process exists" failure the dashboard is required to avoid;
leaving the data wrong and then filtering it in the UI would move the lie, not remove it.
