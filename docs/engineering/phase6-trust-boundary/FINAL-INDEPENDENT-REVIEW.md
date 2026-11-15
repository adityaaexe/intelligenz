# Final Independent Review — Phase 6 Trust Boundary

**Task:** SEC-601 — independent review of the approval-to-attempt TOCTOU fix
**Commit reviewed:** `3aed33d1ab7f96c3d9f634b4f66137490753f6c1`
**Parent:** `6eda7c896e390dbce5a8be743e5337ed194777fd`
**Branch:** `phase-5/isolation-readiness`
**Reviewer:** Security Architect (independent; did not author this commit)
**Date:** 2026-11-15
**Method:** read the full diff, traced every call path to `runtime.execute`, ran the committed
suites against a real PostgreSQL 18 and a real Temporal 1.25 server, and ran three independent
probes that live outside the repository (`/tmp/opencode/`). One database-level concurrency
experiment proved the `UPDATE … WHERE` semantics directly. No repository file was modified
except this one.

---

## Verdict

**FAIL — narrow claim verified, phase criterion not met.**

The primary claim, read literally, is **true**: two executions that both call
`validateTaskActivity` naming the same attempt id can no longer both acquire execution
authority. The decision is a genuine database compare-and-swap, and I proved the PostgreSQL
semantics rather than accepting the comment's assertion.

The verdict is FAIL because the phase's own acceptance criterion — recorded in
`docs/engineering/phase5-recovery/REMEDIATION-REGISTER.md:18` — is that the claim must be
"written by validation **and honoured by the execution path**". It is not honoured by the
execution path. `executeAgentActivity` never reads `claimedByWorkflowRunId` and never checks
approval, and `adoptReservedAttempt` will adopt an attempt another execution has already
claimed. I demonstrated an unapproved HIGH-risk task executing through that path.

So: **the write is real, the enforcement is conventional.** One caller honours it; the
capability does not.

| Question | Answer |
|---|---|
| Is the TOCTOU closed? | **Partially closed.** Atomic and correct for executions that pass through `validateTaskActivity`; unguarded for executions that reach `executeAgentActivity` without it; not applicable to executions that name no attempt. |
| Is the database decision atomic? | **Yes.** Proven, not inferred (below). |
| Would the tests catch the pre-fix defect? | **Yes** for the covered path. Proven by reading the parent's `validate-task.ts` (no claim, no write) against the new assertion. |
| Is Phase 5 regressed? | **No.** Diff touches no isolation, volume, cgroup, budget or reaper file. |

---

## 1. The atomicity claim — verified

`apps/worker/src/activities/claim.ts:229-258` runs one conditional write inside a transaction:

```ts
const claimed = await transaction.executionAttempt.updateMany({
  where: { id, orgId, taskId, status: 'queued', claimedByWorkflowRunId: null },
  data:  { claimedByWorkflowRunId: identity.workflowRunId, claimedAt },
});
if (claimed.count !== 1) return false;
```

The grant is `count === 1` (`claim.ts:249`). There is no read-then-write on the winning path;
the read-back at `claim.ts:271-283` only classifies a *lost* claim and never grants.

**Can both callers get `count === 1`? No.** Under READ COMMITTED, the loser blocks on the
row lock, then re-evaluates the predicate against the committed row version (EvalPlanQual).
I proved this on the same PostgreSQL instance the suite uses, with two sessions and the exact
predicate shape:

```
A: BEGIN; UPDATE … WHERE claimed IS NULL;  -- holds the lock 3s
B: BEGIN; UPDATE … WHERE claimed IS NULL;  -- blocks
A: COMMIT;
B: UPDATE 0        <-- predicate re-checked, matches nothing
final row: claimed = run-A
```

`B UPDATE 0` is the whole argument. Two `count === 1` results are impossible; the comment at
`claim.ts:35-38` is accurate. The `count === 0` branch is also correctly *not* treated as a
blanket refusal: identity decides retry vs refusal (`classifyLostClaim`, `claim.ts:157-216`),
and permission was already decided by the write.

**Scope predicate is correct.** `orgId` and `taskId` are conjuncts, not alternatives, so the
write cannot cross a tenant or a task boundary. The committed cross-tenant test passes.

## 2. Identity — stable, and unforgeable inside Temporal

`executionIdentity` (`claim.ts:135-148`) prefers `Context.current().info.workflowExecution.runId`
and consults `input.workflowRunId` **only** when the activity context throws.

- **Stable across retries:** an activity retry keeps the workflow run id, so `claimedAt` and the
  holder are unchanged. The write-once test confirms `claimedAt` does not move across three
  calls.
- **Distinct for a duplicate execution:** a second execution has a different run id.
- **Not caller-controlled in production:** the value is set by the Temporal server that
  dispatched the activity. A rogue workflow calling `validateTaskActivity` gets *its own* run id
  in context, so it cannot impersonate another execution.
- **Fallback is forgeable — and correctly scoped as such.** When there is no activity context,
  the caller-supplied id is accepted. I confirmed this: a direct call with
  `workflowRunId: 'probe-forged-run-id'` wrote exactly that value into the column. The code and
  the contract (`shared/contracts.ts:59-71`) both say this is the direct-invocation path only.
  Accurate, but see **T3** — the precedence is untested.

## 3. Ordering — airtight *within the workflow*, not within the system

Inside `runTaskActivity` the ordering claim holds. `claimForExecution` is called at
`validate-task.ts:228-231`, after every Phase 5 gate and immediately before
`return { runnable: true, task }` at `validate-task.ts:234`. Nothing that provisions, leases,
creates a cgroup or brokers a connection runs earlier in that activity. The second activity is
`executeAgentActivity`, invoked at `run-task.ts:164`; there is exactly one `runtime.execute`
call site (`execute-agent.ts:631`) and exactly one workflow call site.

But "the claim is the last step of validation" is only a guarantee if validation is
unavoidable. It is not: `executeAgentActivity` is a registered Temporal activity
(`activities/index.ts:26`) and is dispatched **by name**, so any workflow started on the
worker's task queue can invoke it without ever calling `validateTaskActivity`. That is F1.

The authors already use the right test for a control like this. `execute-agent.ts:211-213`
says the isolation gate is unbypassable because "this is the only path to `runtime.execute` in
the worker, so there is no second launch site that could skip it". The claim fails that same
test: it is enforced one activity upstream of the only launch site.

## 4. Crash-retry — preserved for the paths that exist, with one stranded state

- **Activity retry within one execution:** same run id, attempt `queued` or `running` →
  `classifyLostClaim` returns `retry` (`claim.ts:189-194`). Covered by a committed test. ✓
- **Re-allocation after a finalised or reaped attempt:** `startAttempt` allocates `max + 1`
  (`attempts.ts:113-146`); the new row is unclaimed, so the predicate admits it. The reaper
  fails `running` attempts (`reaper.ts:290-305`), which is the state a dead worker is recovered
  from. ✓
- **Crash between the claim and adoption** (claim committed, `startAttempt` never ran): the
  attempt is left `queued` and claimed by a run that is gone. Nothing clears it — the reaper
  only looks at `running` (`reaper.ts:290`), and no run/task reconciler exists. A fresh
  `POST /run` is refused earlier: `tasks.service.ts:778` requires task status `ready`, and
  `POST /run` leaves the task `queued`, so the retry is a `422` before the `409` active-run
  check at `tasks.service.ts:789`. **F4.**

This state is not reachable today in a harmful way only because adoption ignores the claim
(F2) — the two defects mask each other. Any fix for F2 must ship with a release path, or it
converts a bypass into a wedge.

## 5. Paths to a running agent — enumerated

| # | Path | Reaches `runtime.execute`? | Gated by the claim? |
|---|---|---|---|
| 1 | `POST /run` → `runTaskWorkflow` → validate → execute | yes | **yes** — attempt always named |
| 2 | Direct `runTaskWorkflow` start, genuine attempt id | yes | **yes** — verified end-to-end (committed test) |
| 3 | Direct `runTaskWorkflow` start, **no attempt id** | yes | **no** — `validate-task.ts:228` skips the claim entirely. HIGH risk is still refused (`APPROVAL_NOT_RESERVED`, `validate-task.ts:350-357`); LOW is not. **F3** |
| 4 | Rogue workflow → `executeAgentActivity` by activity name | yes | **no** — the activity reads no claim and no approval. **F1** |
| 5 | In-process direct call to `executeAgentActivity` | yes | **no** — same as 4, no Temporal needed at all. **F1** |

Path 3 was exercised for real: two `runTaskWorkflow` starts on one LOW task with different
workflow ids and no `attemptId` produced **two attempts, both `succeeded`, started 1 ms apart
(05:23:34.736 and .737) and overlapping for ~800 ms**, with `claimedByWorkflowRunId: null` on
both. `AgentRun` rows: **1** — keyed to attempt 2, so the duplicate is invisible in the
execution record. The claim is inert on this path by design; the design gap is the absence of
any replacement control.

## 6. Are the tests real?

**Yes, with three limitations.**

- Real database, no mocks: `useTestDatabase()`, real PostgreSQL, real Temporal connections.
  I ran the file: **15/15 passed**.
- Would fail pre-fix: the parent's `validate-task.ts` contains no claim and no write (verified
  via `git show 6eda7c8:…`), so both calls resolve and `expect(fulfilled).toHaveLength(1)`
  fails. The assertion is meaningful.
- No weakened assertions, retries or sleeps. The `isolation-gate` change is a genuine fixture
  fix, not a silenced assertion: it adds the documented `[simulate:ok]` marker, and I verified
  the marker is honoured *before* the hash bucket (`packages/agent-runtime/src/runtimes/local-simulated.ts:326-333`).
  Without that check the fix would have been inert; it is not.
- **T1 — the concurrency test cannot, by itself, distinguish a database CAS from Prisma
  serialising two awaits on one pooled connection.** Both produce "one fulfilled, one
  `EXECUTION_ALREADY_CLAIMED`". The atomicity evidence is my separate two-session experiment,
  not the test. Recommend asserting the interleaving explicitly (a held transaction that makes
  the second `UPDATE` block) so the property is tested rather than inferred.
- **T2 — the two real-Temporal tests never run in CI.** `.github/workflows/ci.yml` defines
  postgres and redis services but **no Temporal service**, so `describe.skipIf(!enabled)`
  skips the strongest end-to-end proof on every push. They pass locally. The file header also
  states CI is "authored, never observed to run" (O8), so "CI green" is not evidence either way.
- **T3 — identity precedence is untested.** In the end-to-end test the context run id and the
  input `workflowRunId` are the same value, so an implementation that read the forgeable input
  instead of the context would still pass. A negative control is missing: start the workflow
  with a deliberately wrong `workflowRunId` in the input and assert the claim records the
  context id.

---

## Findings

### F1 — High — The claim is not enforced at the execution authority boundary

**Where:** `apps/worker/src/activities/execute-agent.ts:160-175` (entry), `:350` (`startAttempt`),
`:631` (`runtime.execute`); registration at `apps/worker/src/activities/index.ts:26`.

`executeAgentActivity` reads only the task row (`execute-agent.ts:167-174`). It consults no
claim and no approval. Because activities are dispatched by name, any workflow on the worker's
task queue can call it directly and skip `validateTaskActivity` entirely.

**Reproduction (executed, `/tmp/opencode/executor-probe.mts`):** create a HIGH-risk task with
**no approval row**, then call the executor directly.

```
validationVerdict: "APPROVAL_REQUIRED (refused)"      <- the gate works
executorVerdict:   "RAN: status=succeeded runtimeId=local-simulated"
attempt:           { attemptNumber: 1, status: "succeeded", claimedByWorkflowRunId: null }
```

An unapproved HIGH-risk task executed, with no claim ever written.

**Why it matters:** this contradicts the register's own closure criterion ("honoured by the
execution path") and is a stronger attack than O1 described — it needs no attempt id and
bypasses approval as well as the claim. The precondition is Temporal client access to the
worker's task queue, which is exactly the capability O1 already assumes ("with Temporal access
plus the attempt id"). It is **not a regression** — the path predates this commit — but it means
O1 cannot be marked closed.

**Remediation:** make the claim an entry condition, not an upstream courtesy.

```ts
// execute-agent.ts, before any provisioning or startAttempt
const executionRunId = executionIdentity({});           // activity context, not input
if (executionRunId === undefined) {
  throw nonRetryable(EXECUTION_CLAIM_REFUSED,
    'execution has no claimable identity; an execution must hold a claim to run');
}
const held = await db().executionAttempt.findFirst({
  where: { orgId: input.orgId, taskId: input.taskId, claimedByWorkflowRunId: executionRunId },
  select: { id: true, status: true },
});
if (held === null) {
  throw nonRetryable(EXECUTION_CLAIM_REFUSED,
    'no attempt is claimed by this execution; validateTaskActivity must grant the claim first');
}
```

### F2 — High — Adoption ignores the claim, so a claimed attempt can be taken

**Where:** `apps/worker/src/activities/attempts.ts:170-179` (find) and `:188-203` (CAS).

The adoption compare-and-swap predicates on `status: 'queued'` and `agentRunId: null` only.
`claimedByWorkflowRunId` is absent from both. An attempt claimed by execution X can therefore
be adopted and run by a different execution Y that reached the executor without validating.

**Reproduction (executed):** claim attempt 9 via `validateTaskActivity` with
`workflowRunId: 'probe-forged-run-id'`, then call `executeAgentActivity` with no identity.
Result: the same attempt became `succeeded` while still carrying
`claimedByWorkflowRunId: 'probe-forged-run-id'` — a different execution ran on it.

**Remediation:** pass the executing run id into `startAttempt` and add the claim to the CAS.
This alone is **not sufficient** for path 4 (the caller still chooses whether to check), which
is why F1's entry check is the load-bearing fix.

```ts
where: {
  id: reserved.id, orgId: input.orgId,
  status: 'queued', agentRunId: null,
  OR: [{ claimedByWorkflowRunId: null }, { claimedByWorkflowRunId: input.executionRunId }],
}
```

### F3 — Medium — Two direct starts with no attempt id execute concurrently

**Where:** `apps/worker/src/activities/validate-task.ts:228-231`.

The claim is skipped when no attempt is named. `validate-task.ts:141-142` documents that "a
client may start the workflow without going through `POST /run`" — so this is a supported
path, not an abuse of one. Reproduced above: two overlapping executions, two `succeeded`
attempts, one `AgentRun` row.

**Bounded by:** HIGH risk is still refused (`APPROVAL_NOT_RESERVED`,
`validate-task.ts:350-357`), so the exposure is duplicate execution of non-approval-gated
tasks. Precondition is Temporal access. It is outside the claim's documented scope — the commit
and `validate-task.ts:223-226` both say "every execution that names an attempt" — so this is a
**residual without a register entry**, not a false statement in the commit.

**Remediation:** have `recordStartActivity` reserve an attempt for every execution and require
the claim unconditionally, or refuse a direct start with no attempt on a queue that expects
reservations. Duplicate execution is currently also partly *hidden* (one `AgentRun` overwrites
the other); that reporting gap should be closed regardless.

### F4 — Medium (operational, not exploitable) — Claim without adoption strands the reservation

**Where:** `claim.ts:225-258` writes the claim; `attempts.ts:113-146` is the only allocator;
`reaper.ts:290` recovers only `running`.

A crash between the claim and adoption leaves `queued` + claimed. No automated path clears it:
the reaper does not look at `queued`, and no run/task reconciler exists. `POST /run` is refused
at `tasks.service.ts:778` because the task is `queued`, and `POST /cancel` makes it terminal.
Today this is survivable only because adoption ignores the claim (F2). **Fixing F2 without a
release path converts a bypass into a wedge.**

**Remediation:** extend the reaper to fail `queued` attempts whose claim is older than a
grace window and whose Temporal run is not live, and clear `claimedByWorkflowRunId` on that
transition. Ship it in the same change as F1/F2.

---

## Documentation accuracy of existing residuals

| Residual | Documentation | Verdict |
|---|---|---|
| **O1** (approval TOCTOU) | `REMEDIATION-REGISTER.md:18` — required "a one-shot `claimed` state written by validation **and honoured by the execution path**; must not break crash-retry" | **Inaccurate as a claim of closure.** The defect description is exact and this commit fixes it; the closure criterion is only half met (F1, F2). The register was not updated, so it now reads as still-open — which is, accidentally, the more honest state. |
| **O11** (isolation-gate flake) | `REMEDIATION-REGISTER.md:33` — "Volume-pool contention suspected; a flaky test is not evidence" | **Stale and factually wrong.** The commit measured the real cause: a deterministic ~15% hash bucket, not volume contention. I verified the mechanism at `local-simulated.ts:326-333`. The register should be corrected; the commit's own explanation is accurate. |
| **O8** (CI never executed) | `ci.yml:3-5`, register | **Accurate**, and it materially limits the value of the commit's "763 passed" gate. Within the reviewed package I measured 193 passed / 12 skipped, and typecheck clean. |
| **Shared-kernel isolation** | Register, D-007 | **Accurate and correctly out of scope.** Not reported as a finding. |
| **Temporal access as a trusted capability** | Register O1's precondition | **Accurate, but load-bearing.** Every finding above shares that precondition. If Temporal access were treated as untrusted, F1 would be Critical. I have rated it High to avoid inflating severity. |

---

## What still cannot be guaranteed

1. **That an execution ran only because it was authorised.** Authority is checked by one caller,
   not by the capability. A second execution that skips validation runs freely (F1, F2).
2. **That one attempt maps to one execution.** True for validated callers; false for any caller
   that reaches the executor directly (F2).
3. **That a direct start with no attempt is single.** Two can run concurrently (F3).
4. **That the strongest tests run in CI.** They do not; there is no Temporal service (T2).
5. **That a crash between claim and adoption is recoverable automatically.** It is not (F4).
6. **That `claimedAt` is an audit truth for every execution.** It is `NULL` on every path that
   did not validate, including paths that executed (F3).

## What is guaranteed (and verified)

1. **The compare-and-swap is atomic.** Two validated claimants cannot both win; EvalPlanQual
   makes the loser's predicate false after the winner commits (`B UPDATE 0`).
2. **Identity is server-side and stable** inside Temporal, and a validated execution cannot
   impersonate another run id.
3. **The claim is written before any provisioning** on the validated path, and a refusal leaves
   no workspace, cgroup, broker request or `AgentRun` behind — asserted and passed.
4. **A refusal costs nothing.** Every Phase 5 gate runs before the claim, so a stale approval or
   a forged attempt does not spend the reservation.
5. **The audit grant is transactional** with the claim (`claim.ts:253-255`), so a claim cannot
   exist without its record; refusals are written best-effort with the code carried durably by
   `task.failed.v1`.
6. **Phase 5 is not regressed.** The diff touches no isolation, volume, budget, cgroup or reaper
   module; the only Phase 5 change is the `isolation-gate` fixture marker, which I verified is
   implemented and takes precedence over the hash.

---

## Test evidence gathered during this review

| Suite | Command scope | Result |
|---|---|---|
| `test/execution-claim.test.ts` | real Postgres + real Temporal | **15/15 passed** |
| approval + isolation suites (5 files) | real Postgres + Temporal | **38/38 passed** |
| full worker package | `vitest run` in `apps/worker` | **193 passed, 12 skipped, 0 failed** (20 files) |
| workspace-wide | `pnpm -w test` | **762 passed, 15 skipped, 1 failed** — the single failure was `packages/database/test/seed.test.ts` (expected 4 users, found 8), caused by tenant rows my own probes created in the shared test DB; after removing them the file passes **7/7**. Not a commit regression. |
| typecheck | `tsc --noEmit` (src + test projects) | **clean** |
| database CAS semantics | two-session EvalPlanQual probe | **loser `UPDATE 0`** |
| no-attempt double start | `/tmp/opencode/no-attempt-probe.mts` | **2 concurrent executions, 2 attempts succeeded, claim NULL, 1 AgentRun** |
| unapproved HIGH via executor | `/tmp/opencode/executor-probe.mts` | **validation refused, executor ran** |

Verification status of this review: **verified** for every claim above that cites a command or
a file, including the workspace-wide total. Two caveats stated plainly: (a) the workspace run's
one failure was an artifact of my own probe tenants and is not attributable to the commit — it
was reproduced, cleaned up and re-run green; (b) the two real-Temporal tests pass locally but
cannot run in CI, which has no Temporal service.

---

## Recommendation

Do not mark O1 closed. Either narrow O1's wording to "two *validated* executions" and register
F1/F3 as new residuals, or complete the remediation by moving enforcement to the execution
boundary (F1 + F2) and shipping the release path (F4) in the same change. The first option is
honest and cheap; the second is what the register's criterion actually asks for.

Of the two, I would refuse to ship the claim "O1 closed" without F1 and F2 — not because the
compare-and-swap is wrong (it is right), but because a durable claim that the only launch site
never reads is a record of authority rather than a control over it.
