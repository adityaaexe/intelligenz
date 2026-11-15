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

---

# Addendum — SEC-602 re-review of `74207f0`

**Commit reviewed:** `74207f04257a9b20ba2a50a992aa50ff237f5e21`
**Parent:** `3aed33d1ab7f96c3d9f634b4f66137490753f6c1`
**Branch:** `phase-6/trust-boundary-closure`
**Reviewer:** Security Architect (independent; same reviewer as SEC-601, authored neither commit)
**Date:** 2026-11-15
**Method:** read the full diff and the new modules; re-ran the SEC-601 reproductions with fresh
fixtures and my own probes; exercised the shipped Temporal liveness probe against a real
Temporal 1.32.2 server; ran four negative controls by reverting one behaviour at a time in a
scratch copy (`/tmp/scratch/intelligenz`, repository untouched); ran the committed suites
against real PostgreSQL 18.6. Every probe lives outside the repository in `/tmp/opencode/`.
No repository file was modified except this one.

---

## Verdict

**FAIL — the four findings are closed as specified, but the control that closes them is
still satisfiable by assertion.**

F1, F2 and F3 behave exactly as the closure record says. F4 works for the case it was
opened for and is fail-closed elsewhere. The tests are real and fail on the pre-fix
behaviour. The FAIL is narrow and points at one thing: **the holder identity the launch site
checks is read from the activity context with a caller-supplied fallback, and that fallback is
reachable in production through standalone Temporal activities.** With Temporal access — the
register's own O1 precondition — a caller can read the attempt id and the holder run id out of
workflow history and present them, and the launch site accepts the assertion. I demonstrated
two executions of one reservation through that path (N1). A "one-shot claim" whose holder can
be named by the caller is one-shot against accidents, not against the adversary O1 names.

| Question | Answer |
|---|---|
| F1 — unapproved HIGH through the executor | **Closed.** Refused at the claim, before any side effect. |
| F2 — adoption by a non-owner | **Closed.** CAS includes the claim; the owner still adopts; allocation stamps it. |
| F3 — two direct starts, no attempt id | **Closed.** Both executions refused; no attempt, no `AgentRun`, no success. |
| F4 — release a stranded claim | **Partially closed.** Terminal runs release correctly with an audit row; the `absent` arm is not produced for a missing execution. |
| Is the launch-site control forgeable? | **Yes, on non-workflow dispatch.** N1, High. |
| Is the authorisation logic shared? | **Yes** — one function, two call sites, one deliberate altitude difference. |
| Do the tests fail pre-fix? | **Yes** — four independent reverts, four failures. |
| Is Phase 5 regressed? | **No.** |
| Can approval-to-attempt be marked PASS? | **No — it must stay PARTIAL.** See the last section. |

---

## Re-run of the four findings

### F1 — closed

Reproduction `/tmp/opencode/sec602-claim-probe.mts`, case A — the exact SEC-601 fixture: HIGH
risk, a `queued` workflow run and a `queued` attempt, **no approval row**, executor called
directly with the attempt id and a run id.

```
validation: refused:APPROVAL_REQUIRED:nonRetryable=true
executor:   refused:EXECUTION_CLAIM_REFUSED:nonRetryable=true
effects:    agentRuns=0 executionWorkspaces=0 toolInvocations=0
            cgroupDirPresent=false claimAudits=0
attempt:    status=queued claimedByWorkflowRunId=null
```

The claim is the first act (`execute-agent.ts:181`), before `getWorkerConfig()`, the runtime
adapter, the task read, `startAttempt`, the cgroup probe, the lease, the broker and
`runtime.execute` (`:685`). Case B — attempt claimed by execution A, executor called as
execution B — refuses with `EXECUTION_ALREADY_CLAIMED`, zero side effects, and the row still
names A. The approval gate that F1 also named is re-run at `execute-agent.ts:223` through the
same shared function; the committed test at `execution-boundary.test.ts:318` (revocation after
the claim) is the right negative control and it passes.

### F2 — closed

Case D of the same probe: claim as X, `startAttempt` as Y → `EXECUTION_ATTEMPT_TAKEN`,
`status='queued'`, holder still X, exactly one attempt row. X then adopts the same row
(`running`, holder X). A retry of X allocates attempt 2 and it is **stamped with X's claim**
(`attempts.ts:156`), which closes the audit-truth gap the SEC-601 review listed as item 6.

The adoption CAS now carries the claim conjunct (`attempts.ts:233`) while the read
deliberately does not, so a non-owner finds the row and is refused instead of falling through
to allocation — the right shape, and the comment explaining it is accurate. The claim
conjunct is genuinely load-bearing: reverting only that line makes the intruder adopt the row
(spot-check below).

Qualification: the *property* "one reservation, one execution" is not fully restored, because
N1 reaches the same outcome by allocating a second attempt under a forged holder name rather
than by adopting the first. F2 as a defect is closed; the invariant it protected is not.

### F3 — closed

Two independent angles:

1. Committed database-level test (`execution-boundary.test.ts:496`), re-run here and proved to
   fail pre-fix by spot-check 3: two concurrent `validateTaskActivity` calls naming no attempt →
   both `EXECUTION_CLAIM_REFUSED`, one `queued` attempt, claim `NULL`, no side effects.
2. My own end-to-end reproduction (`/tmp/opencode/sec602-probe3.mts`): two concurrent
   `runTaskWorkflow` starts on one LOW task with different workflow ids and no attempt id, on a
   real worker and Temporal — both workflow results are `failed` with
   `EXECUTION_CLAIM_REFUSED`, one attempt exists and is `queued`/unclaimed, `agentRuns=0`, task
   stays `ready`.

The refusal moved to `validate-task.ts:174` and is repeated independently at the launch site.
Removing only the validate-site refusal makes the committed F3 test fail (spot-check 3).

### F4 — partially closed

The release path is safe where it fires. With the **real** probe
(`createTemporalProbe().execution`, `reaper.ts:108`) and real Temporal:

| Scenario | Probe | Release | Audit |
|---|---|---|---|
| run terminated | `finished` | **released** — attempt `failed`/`crashed`, claim columns `NULL` | `execution.claim_released.v1`, `actorType=system`, `liveness=finished`, `heldForMs` |
| run still running | `active` | **skipped_live** | none |
| probe cannot answer | `unknown` | **skipped_unknown** | none |
| claim younger than 2 intervals | not a candidate | untouched | none |

The negative control is real: a live claim is not released, including when a second, dead run
exists for the same task. The release predicate requires the specific holder run id
(`claim-release.ts:238`), not just the workflow id, so a live run's claim cannot be released
by naming a different dead run — the candidate's holder *is* the run that is probed.

Two qualifications:

1. **The documented `absent` arm is unreachable for a missing execution in this SDK.**
   `describe()` for a workflow execution Temporal does not know throws `WorkflowNotFoundError`,
   which carries **no `code` and no `cause`** — not gRPC 5. I tested both absent shapes
   (unknown workflow id + unknown run id; known workflow id + unknown run id) and both produced
   that error. `grpcStatus()` (`reaper.ts:136`) therefore returns `undefined` and `execution()`
   answers `'unknown'`, so the pass skips. The table in `claim-release.ts:29-34` and
   `api-contract.md` §6.1 say "not found → release"; in practice only "terminal" releases.
   This fails closed (never a false release) but leaves a permanent wedge for a run deleted or
   aged out of Temporal retention, and the documentation overstates what the code does. **N2.**
2. **The shipped probe has no test.** All five F4 tests inject a fake probe that answers from a
   map; none exercises `createTemporalProbe().execution()`. A stub cannot reveal N2. **N6.**

`release` remains unreachable from the launch path: `claim-release.ts` is imported only by
`reaper.ts`; it is absent from the activity registry (`activities/index.ts`); the structural
test at `execution-boundary.test.ts:913` passes. I confirmed all three independently.

---

## Attacking the fix

### 5. Can the launch-site check be satisfied by forged input? — Yes, on non-workflow dispatch

`executionIdentity` (`claim.ts:134`) prefers `Context.current().info.workflowExecution.runId`
and falls back to the caller's value when there is no workflow execution. Two dispatch shapes
were tested:

- **Workflow-dispatched activity (the normal path): not forgeable.** A purpose-built rogue
  workflow (`/tmp/opencode/rogue-workflow.ts`) called `executeAgentActivity` with
  `executionRunId` set to a victim's claim holder; the activity context won, the call was
  refused `EXECUTION_ALREADY_CLAIMED`, the victim's claim was unchanged and nothing ran.
- **Standalone activity (no workflow execution): forgeable.** SDK 1.25 exposes
  `Client.activity`; server 1.32.2 executes it; I ran it on a worker created with the same
  `Worker.create({ activities, taskQueue })` shape the production entrypoint uses
  (`main.ts:137`) — inferred, not verified against `main.ts` itself, but there is no option
  in that call that would refuse a standalone activity task. A standalone
  `executeAgentActivity` with the victim's run id and attempt id **ran**:

```
standalone: RAN status=succeeded
attempt 1:  running    claimedByWorkflowRunId=execution-victim-...
attempt 2:  succeeded  claimedByWorkflowRunId=execution-victim-...
```

  In the variant where the victim had not yet adopted, the standalone call spends the
  reservation and the legitimate execution is refused afterwards. Both are two executions of
  one reservation, attributed to one claim. See **N1**.

  The two values needed are not secrets: the attempt id is in the workflow input, so it is in
  the `WorkflowExecutionStarted` history event — verified by fetching history with a plain
  client and decoding the payload (the attempt id appears verbatim) — and the run id is the
  execution's own run id, readable with the same access.

The contract comment at `shared/contracts.ts:154` says a direct call "cannot impersonate a
different execution, because the claim it must satisfy was written under that same id". That
is the wrong way round: satisfying a claim written under that id *is* impersonating that
execution. The sentence should be corrected whether or not the fallback is removed.

### 6. Is authorisation genuinely shared? — Yes, with one deliberate divergence

Both activities import `assertTaskAuthorised` from `approvals/authorisation.ts`
(`validate-task.ts:148`, `execute-agent.ts:223`). No second copy exists: the pure decisions
and `refusalFailure` are defined once, and `validate-task.ts` no longer contains them.

The only behavioural difference is the altitude-gated `status === 'queued'` clause
(`authorisation.ts:392`). Dropping it at launch is correct for the stated reason: a Temporal
retry of the same execution legitimately re-enters with the attempt `running` or terminal, and
the claim — not the status — is the exact control there. I verified the retry case passes and
the "grant names another attempt" case still refuses at launch.

A second, undocumented difference exists at the *activity* level rather than inside the shared
function: validation checks task status (terminal, `ready`/`queued`) before calling the gate;
the launch site does not re-check it, so a task cancelled between claim and launch still
executes. This is pre-existing, not introduced here, and outside F1–F4 — but the launch site is
now the place where "authority" is decided, so it is worth registering. **N5.**

### 7. Does the release use the run id, and can a dead run release a live claim? — Yes it uses the run id; no it cannot

Predicate: `where { id, orgId, taskId, status: 'queued', claimedByWorkflowRunId: <holder> }`
inside a transaction, with the probe asked about the same `<holder>`. The only run the pass can
release is the run it just probed. Verified live: a live claim stayed `queued`/claimed while a
dead run id existed for the same task; and a live run started under a **non-canonical workflow
id** is classified `unknown` (the run id exists but not under the derived
`task-<taskId>` id), so it is skipped — fail closed, not a false release.

### 8. Do the 17 tests fail on the pre-fix behaviour? — Yes; four spot-checks

Scratch copy at `/tmp/scratch/intelligenz`; one behaviour reverted at a time; the matching test
re-run:

| Reverted behaviour | Test | Result |
|---|---|---|
| `requireExecutionClaim` call removed from `execute-agent.ts` | "refuses the review's reproduction" | **fails** — executor throws `APPROVAL_REQUIRED`, not the claim refusal |
| `claimedByWorkflowRunId` conjunct removed from the adoption CAS | "refuses adoption by a non-owner" | **fails** — intruder's `startAttempt` resolves |
| no-attempt refusal removed from `validate-task.ts` | "refuses two concurrent validates…" | **fails** — both promises fulfil |
| release pass made a no-op | "releases a claim whose workflow run is provably absent" | **fails** — no action, no audit |

No weakened assertions, no sleeps, no retries. The Temporal-gated tests in this package
executed in my run because a real server was reachable; in CI they still skip for want of a
Temporal service (T2 of SEC-601 remains open, as the closure record says).

### 9. Phase 5 regression — none found

The commit touches no isolation, volume, cgroup, budget, resource or output-cap source file;
the only Phase 5-adjacent change is the `isolation-gate` fixture, which now reserves and claims
an attempt so the activity can reach the gate under test. `reserveAndClaim` writes the claim
through `claimExecution`, the production writer — it does not bypass the check.

| Suite | Result |
|---|---|
| `apps/worker` full | **210 passed, 12 skipped, 0 failed** (21 files) |
| `packages/workspace-manager` (volumes ownership, output cap, reclaim, sandbox) | **93/93 passed** |
| `isolation-gate` (VM refusal, forged env, forged input, restricted tier) | **4/4 passed** |
| `cpu-budget` | 1 passed, **3 skipped** — cgroup migration refused by this host; enforcement not re-observed here (unchanged by the diff) |
| `pnpm -w typecheck` | clean (7 projects) |
| `pnpm -w lint` | clean (`--max-warnings=0`) |

`pnpm -w test` workspace-wide: **779 passed, 15 skipped, 1 failed**. The failure was
`packages/database/test/seed.test.ts` (expected 4 users, found 5) caused by one `User` row my
own crashed probe left behind; after deleting `sec602-%@example.test` the file passes **7/7**.
Not a commit regression — the same artefact the SEC-601 review recorded, from the same cause.

### 10. Is there a new bypass from removing the no-attempt-id direct start? — No

There is still exactly one call site of `runtime.execute` (`execute-agent.ts:685`) and one
workflow call site for the executor (`run-task.ts:162`). The removal narrows, it does not
move, an entry point. Two operational consequences, neither a bypass:

- `apps/worker/scripts/drive-run.ts:58` still starts `runTaskWorkflow` without an attempt id,
  so its `start` command is now guaranteed to be refused. **N3.**
- An execution started before the upgrade and still in flight replays with `attemptId`
  undefined and is refused at the launch site. This is documented in the closure record; it is
  an upgrade-window availability decision, not a security one.

---

## New findings

### N1 — High — The launch-site claim is satisfied by a caller-supplied identity on standalone activities

**Where:** `claim.ts:134-148` (`executionIdentity` fallback), used at `execute-agent.ts:181`;
contract comment at `shared/contracts.ts:154`.

An activity dispatched as a **standalone activity** has an activity context but no workflow
execution, so `executionIdentity` returns the caller's `executionRunId`. The launch site then
accepts whatever claim that id names. Two executions of one reservation were produced:

- victim had not adopted → the standalone call adopted and spent attempt 1, so the legitimate
  execution that arrives later finds no queued reservation and allocates attempt 2 — one
  reservation, two runs, both stamped with the victim's claim;
- victim had adopted (`running`) → the standalone call allocated attempt 2 under the victim's
  claim and ran it concurrently with attempt 1.

Both attempts finish naming the victim's run id, so the audit trail asserts the victim ran
both. Precondition is Temporal client access plus the attempt id — the attempt id and run id
are both readable from workflow history with that access, so there is no additional secret.
This is the O1 adversary, and it restores the outcome O1 was opened to prevent.

It does **not** bypass approval: the launch-site approval gate still refuses an unapproved
task, and the standalone path cannot mint a grant. It is duplicate execution and false
attribution, not privilege escalation.

**Remediation:** remove the fallback at the launch site. `executionIdentity` returning
`undefined` is the correct refusal for a launch:

```ts
const executionRunId = executionIdentity({});
if (executionRunId === undefined) {
  throw nonRetryable(EXECUTION_CLAIM_REFUSED,
    'an activity invoked outside a workflow has no execution identity and cannot hold a claim');
}
```

Tests and scripts can wrap the call in a workflow, or the worker can expose a test-only seam
that does not exist in production. If the fallback must stay, it cannot be the same field a
workflow passes through; an unforgeable capability minted by validation and stored server-side
(not in the activity input, which history exposes) would be required.

### N2 — Medium — The `absent` liveness answer is unreachable, so the documented release never fires for a missing execution

**Where:** `reaper.ts:108-124` and `:136-143`; documentation at `claim-release.ts:29-34` and
`api-contract.md` §6.1.

`WorkflowNotFoundError` from this SDK carries neither `code` nor a coded `cause`, so
`grpcStatus()` returns `undefined` and a genuinely missing execution is classified `unknown`.
Only a non-UUID run id produces gRPC 3 (invalid argument) — also `unknown`. Net effect: the
pass releases on **terminal** runs only. For a claim whose run was deleted or aged out of
retention, the attempt is stranded forever, which is the state F4 exists to prevent. Fail-closed
(no false release), so this is availability and documentation accuracy, not a bypass.

**Remediation:** treat `WorkflowNotFoundError` as `absent` by type (or by the SDK's error name)
before falling back to `unknown`; add a classifier test that constructs the real error.

### N3 — Low — The operational start script is now always refused

`apps/worker/scripts/drive-run.ts:58` calls `startRunTask` with no `attemptId`. Every `start`
now fails with `EXECUTION_CLAIM_REFUSED`. Either accept an attempt id argument or delete the
command, so the tool does not silently stop working.

### N4 — Informational (pre-existing, outside this commit) — Result persistence is still reachable by name without authority

`persistResultActivity`, `completeTaskActivity` and `emitEventActivity` are registered
activities (`activities/index.ts`) and read no claim. A Temporal caller can therefore write an
`AgentRun` and terminal state for a task that never executed. Inspection only — I did not
execute this. It predates the commit and is not one of F1–F4, but it is the same class of
"dispatched by name" reasoning that produced F1, and the phase record does not enumerate it.
Register it before claiming the execution record is authoritative.

### N5 — Informational — The launch site does not re-check task lifecycle

`assertTaskAuthorised` reads the task but never uses `status`, so a task cancelled between
claim and launch still executes and can be persisted as succeeded. Pre-existing; noted because
the launch site is now the authority boundary.

### N6 — Low — The F4 suite cannot detect N2

All five F4 tests inject a fake probe. The shipped `execution()` classifier had no test, and
the stubs answer whatever the test needs, including `absent`. Add one test against the real
error type (no server needed) so the dead arm is covered.

---

## Can approval-to-attempt be marked PASS?

**No. It must stay PARTIAL, and the register's "Closed" wording is currently an overclaim.**

What is now true, and was not before: every path to `runtime.execute` passes
`requireExecutionClaim`; the approval gate is re-run at that same site through the same
function; adoption is conditional on the claim; an execution that names no reservation is
refused; a terminal reservation is released with audit evidence and a live one is not. That is
the criterion the register wrote down ("written by validation **and honoured by the execution
path**"), and it is met.

What is not true: "one attempt authorises one execution". The claim's holder identity is
supplied by the caller whenever the activity is not workflow-dispatched, and a production
worker accepts standalone activities. Both ids needed to forge it are readable from Temporal
history. So the claim is one-shot against concurrent *validated* executions and against
accidents, but not against a caller who can name the holder — which is the adversary the
register names. The correct wording is closer to: *closed for executions that hold no claim
and for executions that hold a different claim; partial for an execution that can name
another's claim.*

Mark O1 **PARTIAL** until N1 is closed. N2 is a separate, fail-closed defect that should be
fixed in the same change because the release path's documentation currently describes
behaviour the code does not have.

---

## What this review would still refuse to ship

1. **"The claim cannot be impersonated."** It can, on any non-workflow dispatch, with ids that
   Temporal history hands to the caller. Do not ship N1's fallback at the launch site.
2. **"A claim whose run is absent is released."** It is not; only terminal runs release. Either
   fix the classifier or correct the record and `api-contract.md` §6.1.
3. **"O1 is closed."** It is closed for the reproductions in SEC-601 and partial for the
   register's stated adversary. Mark it PARTIAL with the two conditions above.

Everything else in the commit — the shared authorisation module, the adoption CAS, the
no-attempt refusal, the release write, the audit rows — is correct, and the tests that cover
them are honest. This is a narrow, cheap fix away from a clean pass.

---

## Test and probe evidence gathered during this addendum

| Item | Command / artefact | Result |
|---|---|---|
| `test/execution-boundary.test.ts` | real PostgreSQL + real Temporal | **17/17 passed**, 5.54 s (Temporal tests executed) |
| `apps/worker` full | `vitest run` | **210 passed, 12 skipped, 0 failed** |
| `packages/workspace-manager` | `vitest run` | **93/93 passed** |
| `isolation-gate` | `vitest run` | **4/4 passed** |
| typecheck / lint | `pnpm -w typecheck`, `pnpm -w lint` | **clean** |
| workspace-wide | `pnpm -w test` | 779 passed, 15 skipped, 1 failed (my probe's leftover user); seed file **7/7** after cleanup |
| F1/F2 reproductions | `/tmp/opencode/sec602-claim-probe.mts` | A/B/C/D as quoted above |
| real liveness probe | `/tmp/opencode/sec602-probe2.mts`, `sec602-probe5.mts` | live→skip, terminated→release+audit, non-canonical→unknown |
| rogue workflow + F3 | `/tmp/opencode/sec602-probe3.mts` | forged context refused; F3 refused end to end |
| standalone-activity forgery | `/tmp/opencode/sec602-probe4.mts` | **ran**; duplicate attempt under the victim's claim |
| absent-run classification | `/tmp/opencode/absent-probe3.mts` | `WorkflowNotFoundError` with no `code` → `unknown` |
| history exposure | `/tmp/opencode/history-probe.mts` | attempt id readable verbatim from `WorkflowExecutionStarted` |
| pre-fix spot-checks | `/tmp/scratch/intelligenz` (four single-line reverts) | 4/4 corresponding tests failed |

Verification status: **verified** for every command and probe result quoted here. Two honest
caveats: (a) the single workspace-wide failure was my own probe residue, reproduced, cleaned
and re-run green — not attributable to the commit; (b) `cpu-budget`'s three enforcement tests
skip on this host because the kernel refuses cgroup migration, so CPU enforcement was not
re-observed in this review, only confirmed unchanged by the diff.
