# Phase 6 — Claim identity and write authority (AG-604)

The third review of `phase-6/trust-boundary-closure` returned **PASS** for the
approval-to-attempt gate and **FAIL** for the commit: one regression introduced by the N2
fix, one latent hole in the arm that fix added, and one finding (N4) closed for
`Task`-aggregate writes only — for two of the three by-name writers it named, and for none
of the other five aggregate namespaces (`workflow.*`, `agent.*`, `approval.*`, `project.*`,
`run.*`), which remain writable by name (N15). This document is the record of that change.

Base: `a75f121`. No prior commit is rewritten.

---

## 1. N7 — the release pass reaped a live claim

**The classifier was right; the question was wrong.** `describeWorkflowExecution` is keyed
by workflow id **and** run id. The probe asked about `task-<taskId>` plus the holder's run
id. For a claim written by an execution started under any other workflow id — a back-office
workflow, a replay, another workflow type on the queue, this repository's own test harness
(`probe-<uuid>`) — the server answers NOT_FOUND, which the N2 fix correctly classifies as
`absent`, and the pass released a claim whose execution was **RUNNING**.

The released run's next terminal write (`persistResultActivity`, `completeTaskActivity`) is
refused `EXECUTION_CLAIM_REFUSED`, so the run cannot record its result. That is a fail-open
release in the one module that must never fail open, produced by a correct fix to a
fail-closed bug.

### The fix: record the identity, do not derive it

| Piece | Where |
|---|---|
| `ExecutionAttempt.claimedByWorkflowId String?` — additive migration, no back-fill | `packages/database/prisma/migrations/20261115120000_phase6_claim_workflow_id/migration.sql` |
| Written in the **same** conditional `updateMany` as the run id and `claimedAt`, read from `Context.current().info.workflowExecution.workflowId` | `apps/worker/src/activities/claim.ts` (`claimExecution`), `validate-task.ts` (`claimForExecution`) |
| The probe asks about the **recorded pair**, never `task-<taskId>` | `apps/worker/src/reaper.ts` (`createTemporalProbe.execution(workflowId, runId)`), `claim-release.ts` |
| A claim with no recorded workflow id is **skipped** (`skipped_unknown`), not released | `claim-release.ts` (`runClaimReleasePass`) |
| The release predicate requires the pair, and clears all three claim columns | `claim-release.ts` (`releaseClaim`) |
| The new attempt a retry allocates carries the pair too | `activities/attempts.ts` (`startAttempt`), `execute-agent.ts` |

**`classifyProbeError` is untouched.** It was correct: NOT_FOUND for a *given pair* means
"no such execution". The defect was that the pair named an execution that was not the one
holding the claim. Confirmed byte-for-byte against `a75f121` (§6).

### Proof

`apps/worker/test/execution-boundary.test.ts`, `N2 / N7 — the shipped probe against a real
server` (real Temporal, real PostgreSQL, no stubs):

| Test | Asserts |
|---|---|
| live execution under a **non-canonical** workflow id (the reviewer's §G) | `skipped_live`; claim columns intact; attempt still `queued`; zero `execution.claim_released.v1` rows |
| live execution under the canonical id (negative control) | `skipped_live`; pair intact |
| recorded pair the server has never heard of | `released`, audited with `liveness: 'absent'` |
| recorded pair that has **finished** (a real execution, stopped) | `released`, audited with `liveness: 'finished'` and the pair |
| claim recording **no** workflow id (legacy row) | `skipped_unknown`; the probe is never consulted — not even with `task-<taskId>` |

The §G test **fails on `a75f121`**; §6 records the run.

---

## 2. N8 — the pre-dispatch arm permitted `succeeded`

`requireCompletionAuthority`'s pre-dispatch arm checked identity and the absence of a
foreign attempt, and never looked at `status`. A workflow started under `task-<taskId>`
could therefore write `succeeded` for a task with **zero attempts and zero `AgentRun`
rows**. Bounded only because the shipped registry happens to emit `failed` — a bound in the
caller, not in the control.

The arm now requires `status ∈ {failed, cancelled}` (`claim.ts`,
`PRE_DISPATCH_TERMINAL_STATUSES`), and refuses anything else with
`EXECUTION_CLAIM_REFUSED`. The legitimate refused path is unchanged and proved twice: the
by-name test (`allows the pre-dispatch arm for the task's own execution…`, now on a
`queued` fixture where the write actually lands) and the end-to-end refusal in
`approval-bypass.test.ts`, which asserts the task ends `failed` and the audit row exists.

---

## 3. N4 residual — the event writer and the start record

`emitEventActivity` and `recordStartActivity` were registered, dispatched by name, and read
no authority. The reviewer wrote a valid `task.succeeded.v1` and moved a task
`queued → running` from standalone activities. AG-604 makes the audit event the durable
record of a refused run, so forging it is worth more now, not less.

The scope is `aggregateType === 'Task'` (`emit-event.ts:73`): `workflow.*`, `agent.*`,
`approval.*`, `project.*` and `run.*` events remain writable by name. That is N15 and is
recorded as a residual in `TRUST-BOUNDARY-CLOSURE.md`; where this section says N4 is
closed, it means closed for task writes.

Both now call the same two arms as completion (`requireEventAuthority`,
`requireStartAuthority` → `requireExecutionWriteAuthority`), **before their first read**:

| Arm | Condition |
|---|---|
| claim | the named attempt carries a claim held by this execution → the write is authorised |
| pre-dispatch | no attempt carries a claim → the caller must be `task-<taskId>`, **and** may write only what the refusal path writes |

| Intent | Pre-dispatch arm |
|---|---|
| terminal `failed` / `cancelled` | allowed |
| terminal `succeeded` | **refused** (N8) |
| `task.failed.v1`, `task.cancelled.v1` | allowed |
| `task.status_changed.v1`, `task.succeeded.v1` | **refused** |
| a start (`queued → running`) | **refused** — there is no pre-dispatch case; the claim is granted before the start is recorded |
| any write with no execution identity (standalone) | `EXECUTION_IDENTITY_UNAVAILABLE` |

Preserved and verified: the normal path and a retry of the same run (the legitimate-path
tests drive the real `runTaskWorkflow` end to end), the pre-dispatch **failure** path
(`approval-bypass`, `approval-direct-start`, `approval-attempt-binding` all assert
`task.failed.v1` is written by a refused run), and the reaper's own writes (`claim-release`
writes `ExecutionAttempt` and `AuditEvent` through Prisma directly, never through an
activity).

One consequence, stated rather than hidden: a **duplicate** execution refused by the claim
can no longer write `task.failed.v1` for a task another execution owns — both its terminal
write and its event are refused. Its refusal is still durable in
`execution.claim_duplicate.v1` (written best-effort by `claimExecution`) and in its own
workflow result.

Two tests encoded the pre-AG-604 expectation and were changed to assert the boundary
instead of the old behaviour. Both are stronger afterwards; neither is a fixture bent to
make the code pass:

| Test | Before | Now |
|---|---|---|
| `execution-claim.test.ts` — "a direct Temporal start cannot join a claimed execution" | asserted a `task.failed.v1` row for the task | asserts `execution.claim_duplicate.v1` on the **attempt** (with the holder's run id), and **zero** `task.failed.v1` rows for a task this execution does not own |
| `approval-attempt-binding.test.ts` — "a direct Temporal start with no attempt id" | started under `task-<id>-direct` | starts under the canonical `task-<taskId>`, the shape whose refusal path can still record its event; the non-canonical shape now has its own test asserting the refusal (`refuses the refusal event from a workflow that is not this task's execution`) |

---

## 4. Residuals recorded, not redesigned (N9 / N11)

An attempt adopted **before** the Phase 6 claim columns existed is `running` with
`claimedByWorkflowRunId IS NULL`. The exact row shape:

```
ExecutionAttempt {
  status                 = 'running'
  claimedByWorkflowRunId = NULL        -- never back-filled, deliberately
  claimedAt              = NULL
  claimedByWorkflowId    = NULL
  agentRunId             = <set>       -- it did run
}
```

Such a row can be neither claimed (`classifyLostClaim`: `running` requires a claim it does
not have), nor adopted (`adoptReservedAttempt` requires `queued`), nor completed (the
completion arm's `foreign` predicate is `null !== executionRunId` → true for **everyone**,
including its own execution), nor reaped (`claim-release.ts` selects `status: 'queued'`
only). **The workflow cannot advance its task**: completion is refused for everyone, including
its own execution. An operator can still cancel it through `POST /cancel`, which accepts a
`queued` or `running` task and writes `cancelled` (`tasks.service.ts:1037`, `:1064`); what is
true is that the workflow cannot finish it, not that nothing can. The refused completion is
swallowed with a log line while its `task.failed.v1` is still emitted — task and audit trail
disagree. This paragraph used to say the task "never reaches a terminal state", which ignored
the operator path.

**Fail-closed and migration-window-only.** The predicate is deliberately not relaxed:
treating an unclaimed `running` attempt as belonging to whoever asks would hand every
duplicate execution the ability to complete a task somebody else is running, which is the
hole the arm exists to close. Documented in `claim.ts` (the residual block above the
`foreign` predicate) and `claim-release.ts` (module header).

---

## 5. Test-quality fixes from the review

1. **The N4 pre-dispatch fixture used a `ready` task**, where `completeTask`'s guard
   refuses the write, so the test could only ever observe `changed: false` and proved
   nothing about the arm. The rogue-completion test now uses a `queued` task — the state
   `POST /run` leaves behind and the only non-terminal state the write lands on — and the
   N8 test uses the same.
2. **The N3 refusal was duplicated in two guards**, so deleting either alone left the suite
   green. The two refusals are now distinct mistakes with distinct messages and one test
   each: an attempt id that is **omitted** (`an attempt id is required`) and one that is
   **supplied but empty** (`the attempt id is empty`). Deleting either guard fails its own
   test; the in-switch narrowing is now an invariant assertion, not a second refusal.

### Mutation checks (each control removed alone, suite re-run, source restored)

| Control removed | Test that fails | Evidence |
|---|---|---|
| the recorded workflow id (i.e. `a75f121`'s derived probe) | `does not release a claim held by a live execution whose workflow id is not task-<taskId>` | `outcome: 'released'` instead of `skipped_live`, on a real RUNNING execution |
| the N8 status gate (`refuseIntent` admits everything) | `refuses "succeeded" for a task with no attempts and no AgentRun` | `promise resolved "{ changed: true, … }" instead of rejecting` |
| the `requireEventAuthority` call in `emitEventActivity` | all three `task.succeeded.v1` refusal tests | `promise resolved … instead of rejecting` ×3 |
| `drive-run.ts`'s missing-argument guard | `names the missing attempt id and exits 2` | exit `1`, not `2` |
| `drive-run.ts`'s empty-argument guard | `refuses an attempt id that was supplied but is empty` | exit `0`, not `2` (the workflow started) |

---

## 6. Verification

| Gate | Result |
|---|---|
| `pnpm -w typecheck` | clean (10 workspace projects) |
| `pnpm -w lint` | clean (`--max-warnings=0`) |
| `pnpm -w test` | 72 files, **822 passed, 15 skipped, 0 failed** |
| `pnpm --filter @intelligenz/api test:e2e` | 7 files, **97 passed**, 0 failed |
| `apps/worker` package | 22 files, **252 passed, 12 skipped, 0 failed** (baseline `a75f121`: 239 passed, 12 skipped — +13 new) |
| `apps/worker/test/isolation-gate.test.ts` ×5 | 5/5 runs, **4/4 passed each** |

Two structural facts worth recording here:

- `classifyProbeError` — from its doc comment through `isWorkflowNotFound`, marker and
  error-chain helpers included — hashes to the same bytes as `a75f121`:
  `f1ff802830f2383ebd1e04c3e2b3df145ac4beb7315d82103f322bc659845b53`.
- The N7 §G test, run against `a75f121` in a scratch worktree (this test file, that
  commit's source, a schema built from that commit's migrations), fails with
  `outcome: 'released'` where it requires `skipped_live` — the live claim is reaped.
