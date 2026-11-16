# P87-011 — intermittent `approval-attempt-binding` failure: investigation

**Status: NOT REPRODUCED. P87-011 remains open.**
No root cause is claimed. One plausible mechanism was tested and **ruled out by
measurement**. The defect is not declared fixed.

---

## 1. The original evidence, stated exactly

| Fact | Value |
|---|---|
| File | `apps/api/test/approval-attempt-binding.e2e-spec.ts` |
| Test | `1. two simultaneous POST /run — one attempt, one consumption` → `reserves exactly one attempt and one grant, and refuses the loser with 409` |
| Observed | 1 failure in 8 full-suite runs of the API E2E suite |
| Then | 7 consecutive full-suite passes; isolated run 12/12 |
| Failing run duration | 33.41 s (passing runs ~21 s) |
| **Assertion that failed** | **Not captured.** Only the test name survived. |

The absent assertion is the whole problem. Without it, every later run is compatible with
"fixed", "still broken", and "broken somewhere else", and no amount of green settles it.

## 2. What the test asserts

One HIGH task, ready, one approved grant, two simultaneous `POST /run` against an
unreachable orchestrator:

```
expect(statuses).toEqual([409, 503])
expect(['CONFLICT','APPROVAL_CONSUMED']).toContain(code of the 409)
expect(executionAttempt.count).toBe(1)
expect(workflowRun.count).toBe(1)
expect(approval.consumedAt).not.toBeNull()
expect(approval.consumedByAttemptId).not.toBeNull()
expect(auditEvent count for approval.consumed.v1).toBe(1)
```

Any of those seven assertions failing produces the same test-name-only line. The failure
could have been in the race, in a count, or in the setup.

## 3. Reproduction attempts — all clean

| Attempt | Executions | Violations |
|---|---|---|
| Full API E2E suite (Phase 8.7, before this session) | 8 | 1 |
| Full API E2E suite (Phase 8.7, after) | 7 | 0 |
| Real spec under vitest, repeated (`vitest run test/approval-attempt-binding.e2e-spec.ts`) | **40** | **0** |
| Purpose-built reproducer, 2 contenders × 30 batches | 30 batches | 0 |
| Purpose-built reproducer, 4 contenders × 20 batches | 20 batches | 0 |
| **Total since the failure** | **~95 executions** | **0** |

Reproducers: `apps/api/test/manual/approval-binding-stress.ts`. Not collected by
`pnpm test:e2e` (which includes only `**/*.e2e-spec.ts`), so a slow host cannot turn the
gate red by accident.

At an assumed 1-in-8 rate, 95 clean executions is very unlikely (p ≈ 3×10⁻⁶). The
conclusion is not "it is rare"; it is **"the reproducer does not recreate the condition"**,
and the condition was not identified.

## 4. Hypotheses, and their disposition

| # | Hypothesis | Disposition |
|---|---|---|
| A | Parallel test files share an approval/task fixture | **Ruled out.** `apps/api/vitest.config.mts` sets `fileParallelism: false`, and `startSuite` holds a Postgres advisory lock for the suite's lifetime. No two suites share the database. |
| B | Reused idempotency key creates a stale replay | **Ruled out for this test.** The failing test sends no `Idempotency-Key` on `/run`; its task key is unique per file. |
| C | Concurrent transactions race to spend a one-shot approval | **Tested directly.** 50 batches at 2 and 4 contenders: every batch had exactly one 503, the rest 409, one attempt, one run, one consumption, one audit row. The CAS holds. |
| D | Temporal activity completes after the test timeout | **Not applicable.** The app is offline (`127.0.0.1:1`, `rpcMaxAttempts: 1`); no worker is involved in this suite. |
| E | Teardown races a running workflow | **Not applicable** for the same reason. |
| F | A prior attempt leaves a claimed/consumed approval | **Ruled out.** Each test creates a fresh task and approval; the suite truncates at start. |
| G | Stale test DB or tenant leaks between cases | **Ruled out.** `startSuite` truncates and reseeds; the advisory lock serialises suites. |
| H | Assertion observes an intermediate state before commit | **Contradicted by design.** `POST /run` commits the reservation before contacting the orchestrator, and the 503 is only produced after that commit. The counts are read after both responses settle. |
| I | Workflow/run ids improperly reused | **Ruled out for this path.** The failing test passes no idempotency key; `workflowId` is derived, and the run row is created inside the transaction. |
| J | A test-level retry hides a real race | **Ruled out.** No `retry` is configured for the API suite. |
| K | Resource pressure produces a timing-only failure | **Not evidenced, not excluded.** The failing run was the slowest observed (33.41 s vs ~21 s), which is consistent with host contention, but no failure has been caught under load. This is the leading *remaining* hypothesis and it is unproven. |
| L | Failure depends on test ordering | **Not evidenced.** The failing test is the first test in its file, and 40 isolated runs were clean. |

## 5. A plausible mechanism that was disproven

The transaction order in `TasksService.run()` is:

```
workflowRun.create      → FK share lock on the task row
executionAttempt.create → FK share lock on the task row
approval CAS            → exclusive lock on the approval row
task CAS                → lock on the task row
```

Two concurrent reservations look like a textbook lock cycle: both hold the FK share lock,
one holds the approval row, and the other blocks the winner's task update. That would
produce a PostgreSQL deadlock (`40P01`), which Prisma reports as `P2034`, which **this API
does not map** — and the loser would answer **500**, failing `[409, 503]`.

`apps/api/test/manual/run-deadlock-probe.ts` reproduces that exact statement order with two
interactive transactions and a barrier. Result:

```
T1: committed
T2: committed
DEADLOCK_OBSERVED=false
```

**Ruled out.** The reason is concrete: `UPDATE task SET status = ...` touches no key column,
so PostgreSQL takes `FOR NO KEY UPDATE`, which is *compatible* with `FOR KEY SHARE`. The
cycle never forms. The loser loses the approval CAS cleanly and rolls back.

This is recorded because it is the kind of explanation that is easy to assert and wrong; it
would have produced a confident, incorrect "fix".

## 6. Secondary finding, not claimed as the cause

`apps/api/src/common/prisma-errors.ts` maps only unique-constraint errors (P2002). Nothing
maps `P2034` (write conflict/deadlock) or `P2028` (transaction timeout/closed). If either
occurs, the global filter answers **500**. That is a real robustness gap in its own right,
but the deadlock that would trigger it has been ruled out for this path, and a 500 from
P2028 needs a 5 s transaction, which does not match a 17–42 ms request. It is recorded as
an observation (P88-P2034), **not** as P87-011's root cause.

## 7. What was changed as a result

Nothing in production code. The only change is diagnostic:

- `apps/api/test/manual/approval-binding-stress.ts` — the n-way reproducer, runnable by hand.
- `apps/api/test/manual/run-deadlock-probe.ts` — the lock-order probe.
- The failing test now attaches the observed statuses, error codes and row counts to its
  **failure message**. The assertions, their order and their expected values are unchanged:
  a passing run passes for the same reasons, and a failing run now leaves the evidence that
  was missing the first time.

## 8. What would settle it

One occurrence with the captured assertion. Until then:

- **P87-011 is BLOCKED**, with the blocker being "no captured occurrence", not "unknown
  cause" and not "probably flaky".
- It must not be marked complete because the suite is green. A green suite is compatible
  with a defect that occurs once in ninety-five runs.
- If it recurs, the failure message now contains the statuses, codes and counts, and the
  investigation resumes from evidence instead of from a test name.
