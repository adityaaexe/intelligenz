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

---

# Addendum — SEC-603 re-review of `a75f121`

**Commit reviewed:** `a75f1217b49b1eb1fdae953076ecc8739f7ebf82`
**Parent:** `74207f04257a9b20ba2a50a992aa50ff237f5e21`
**Branch:** `phase-6/trust-boundary-closure`
**Reviewer:** Security Architect (independent; authored none of the three commits)
**Date:** 2026-11-15
**Method:** read the full diff and every changed module; re-ran both N1 reproductions with new
fixtures and four candidate identity field names; dispatched activities against real Temporal
1.32.2 and real PostgreSQL 18.6 through the **production** activity registry; ran the
production workflow bundle to establish what the shipped registry can actually reach; ran the
committed suites (worker 239/251, Phase 5 123/126); reverted five behaviours one at a time in
a scratch copy (`/tmp/scratch/r3`, repository untouched) to check the new tests fail pre-fix.
Every probe lives outside the repository in `/tmp/opencode/`. No repository file was modified
except this one.

---

## Verdict

**PASS for approval-to-attempt (O1) — the gate this phase is about.
FAIL for the commit as a whole — two defects in the boundary this commit owns.**

This is the third pass over the same control and the first where the control holds against
the adversary it was defined against. N1 is closed by construction, not by assertion: the
identity has no input field left, a standalone activity is refused before it reads a row, and
I could not produce a second execution or a single new attempt in either variant of the
reproduction that broke the previous commit. N2, N3 and the two activities N4 named are
closed, and the N2 fix is better than what I asked for — it exercises the shipped probe
against a real server and adds a negative control.

The FAIL is two specific things, neither of which is a "the fix does not work" claim:

1. **N7 — the N2 classifier fix converted a fail-closed case into a fail-open one.** A claim
   whose holder is a *live* execution started under a workflow id other than `task-<taskId>`
   is now classified `absent` and **released while it runs**. Before this commit that case
   answered `unknown` and was skipped; I recorded that skip in SEC-602 as the fail-closed
   protection. It is the one thing `claim-release.ts` says the module must never do.
2. **N8 — the new pre-dispatch completion arm does not constrain the terminal status.** A
   workflow started under `task-<taskId>` can write `status: 'succeeded'` for a task with no
   attempt, no claim and no `AgentRun`. Through the shipped registry only `failed` is
   reachable (I verified that), but the *control* does not enforce that bound — the registry
   does. A one-line narrowing makes the control match its own comment.

| Question | Answer |
|---|---|
| N1 — standalone activity naming a victim's run id | **Closed.** Refused `EXECUTION_IDENTITY_UNAVAILABLE` in both variants, zero new attempts, zero side effects, identity fields deleted from the contract. |
| N2 — `absent` classification, and whether the coverage is real | **Closed.** The shipped probe is now tested against a real server, with a malformed-id negative control; reverting the classifier fails three tests. |
| N3 — `drive-run.ts start` with no attempt id | **Closed.** Exit 2, a message that names what to supply, before any Temporal connection. |
| N4 — `persistResultActivity` / `completeTaskActivity` without a claim | **Closed for the two named activities; the class is not.** `emitEventActivity` and `recordStartActivity` remain unguarded by name, and this commit *increases* the audit event's authority. |
| Is the launch-site identity forgeable any more? | **No.** Not by input, not by a standalone activity, not by a rogue workflow (it gets its own run id). |
| Is the release path fail-closed? | **No longer.** N7. |
| Do the new tests fail pre-fix? | **Yes** — five independent reverts, five failures. |
| Is Phase 5 regressed? | **No.** |
| Can approval-to-attempt be marked PASS? | **Yes**, with the boundary in the last section. |

---

## 1. N1 — closed

I re-ran both variants of my SEC-602 reproduction (`/tmp/opencode/r3-probe.mts`, section A),
with a real standalone activity (`Client.activity`) on a real worker built from the
**production** activity registry. The input carried **four** candidate identity field names at
once — `executionRunId`, `claimedByWorkflowRunId`, `runId`, `temporalRunId` — all set to the
victim's claim holder, because a fix that merely renames the field would pass a test that
supplies only the old name.

Victim not yet adopted (the variant that used to *spend* the reservation):

```
verdict:        EXECUTION_IDENTITY_UNAVAILABLE, nonRetryable=true
attemptsBefore: [{1, queued, claimedBy=execution-victim-3b43…}]
attemptsAfter:  [{1, queued, claimedBy=execution-victim-3b43…}]   newAttempts=0
agentRuns=0     taskStatus=ready
```

Victim already adopted (the variant that used to create attempt 2 and run concurrently):

```
verdict:        EXECUTION_IDENTITY_UNAVAILABLE, nonRetryable=true
attemptsBefore: [{1, running, claimedBy=execution-victim-e73f…}]
attemptsAfter:  [{1, running, claimedBy=execution-victim-e73f…}]  newAttempts=0
agentRuns=0     taskStatus=ready
```

**The identity fields are deleted, not ignored.** `ExecuteAgentActivityInput.executionRunId`
and `ValidateTaskActivityInput.workflowRunId` are gone from `shared/contracts.ts`; the
`ValidateTaskActivityInput` field was also the field that carried a *database* run id into a
*Temporal* run-id parameter, so its removal closes an id-space confusion as well. The refusal
is emitted before the first database read (`claim.ts:444`, `claim.ts:594`), so there is no
window in which a row is touched.

**No test seam supplies an identity.** `executionIdentity()` takes no parameter and reads only
`Context.current()` (`claim.ts:164-176`); `executionWorkflowId()` is the same shape
(`claim.ts:184-195`). The harness starts a real workflow and reads the run id *back* from
`handle.firstExecutionRunId` (`execution-harness.ts:152-158`); the probe workflow takes no
arguments, so nothing a test passes can influence it. `requireExecutionClaim` still takes the
identity as an argument, and that is correct: it is an internal guard whose production callers
derive the value from the context, and the dispatch-level proof is the standalone group, which
I re-ran rather than trusting.

**Residual in the fix, not a defect:** an activity retry inside a workflow keeps the same run
id, so a Temporal retry of `executeAgentActivity` is still admitted — that is the crash-retry
property, and the `retry after adoption` test plus the `attempt 2 under the same claim` test
both pass in my run.

## 2. N2 — closed, and the coverage is the shipped probe

My finding was that `absent` was unreachable because `WorkflowNotFoundError` carries no `code`
and no coded `cause`, so the classifier answered `unknown` and the release could only fire for
*terminal* runs.

- **Classifier:** `classifyProbeError` (`reaper.ts:91-101`) now walks the error chain and
  recognises the error by identity (`instanceof`, `name`, and the SDK's `Symbol.for`
  marker) before falling back to gRPC 5.
- **Reachability:** the two `N2 — the shipped probe against a real server` tests call
  `createTemporalProbe().execution()` — the shipped function — and only *scope* which rows the
  pass may act on, so the classification itself is real. I re-ran them: `released` with
  `liveness: 'absent'` for a never-seen UUID run id, `skipped_unknown` for a malformed one,
  `skipped_live` for a running one.
- **Independent check of the error shape** (`/tmp/opencode/r3-probe2.mts`, section I): a real
  `describe()` of an existing run under a *different* workflow id throws
  `{ name: 'WorkflowNotFoundError', code: null, hasCodedCause: false, marker: true }`. The
  parent's classifier expression answers `unknown` for that object; the current one answers
  `absent`. So N2 is fixed — and see N7 for what that fix broke.
- **Coverage is not a stub.** `reaper.test.ts:252-288` constructs the real error type, a
  coded `cause`, a foreign-realm copy carrying the marker, and the two `unknown` controls.
  Reverting `classifyProbeError` to the parent's `grpcStatus(error) === 5` form fails three
  tests: the end-to-end absent-release and both pure classifier assertions.

## 3. N3 — closed

`drive-run.ts start <taskId> <orgId>` (no attempt id) exits **2** with a message that names
the missing argument, says why it is required, and tells the operator that `POST /run`
returns it — before `TemporalTaskClient.connect()` is called:

```
drive-run.ts start: an attempt id is required.
… Supply the queued attempt id that POST /run returned in its 202 body:
  drive-run.ts start <taskId> <orgId> <attemptId> [correlationId]
```

`start <taskId>` alone still exits 2 with the usage block. `cancel` / `describe` / `wait` are
unchanged. The usage string, the module header and the code agree.

One test-quality note: the pre-flight guard is duplicated by an in-switch guard, so deleting
*either one alone* still leaves the test green (I checked: removing the pre-flight leaves the
switch guard, and the test passes). Removing **both** — the true pre-fix state — fails the
test (`expected 1 to be 2`). The behaviour is safe; the test is one revert less sensitive than
it looks.

## 4. N4 — closed for the two activities it named, not for the class

`persistResultActivity` requires the claim before it delegates (`persist-result.ts:60-68`), and
`completeTaskActivity` requires authority before its first read (`complete-task.ts:42-52`).
Both refusals come before any write, and the inner writers (`persistResult`, `completeTask`)
are not in the activity registry, so they cannot be dispatched by name.

Re-ran, by name, from a real workflow (`/tmp/opencode/r3-probe.mts` sections D and E, plus the
committed N4 group):

| Call | Result |
|---|---|
| `persistResultActivity`, canonical-id workflow, no claim | `EXECUTION_CLAIM_REFUSED`, `agentRuns=0`, run still `queued` |
| `completeTaskActivity`, standalone activity | `EXECUTION_IDENTITY_UNAVAILABLE`, task and run untouched |
| `completeTaskActivity`, foreign claim | `EXECUTION_ALREADY_CLAIMED`, task stays `ready` |
| `completeTaskActivity`, non-canonical workflow id, no claim | `EXECUTION_CLAIM_REFUSED` |
| full legitimate path (validate → execute → persist → complete) | `authority: 'execution-claim'`, task `succeeded`, one `AgentRun`, claim intact |
| retry of the same execution (two executes, one session) | attempt 1 and attempt 2 both `succeeded`, both stamped with the session's run id |
| reaper's own writes | direct database statements, not activities; release + audit + `skipped_live` all observed live in my own pass |

The class is **not** closed. `emitEventActivity` and `recordStartActivity` are registered
activities that read no claim and take no identity. I dispatched both as **standalone
activities** with no workflow context at all:

```
L: emitEventActivity  → created a task.succeeded.v1 AuditEvent for a task that never ran
                        (task still `queued`, zero attempts, zero AgentRuns)
M: recordStartActivity → moved a Task queued → running and a WorkflowRun → running,
                        with no claim, no attempt and no execution
```

Both predate this commit. They matter *more* after it, because `failBeforeExecution` and
`recordUnexpectedFailure` now deliberately let the terminal write be refused and tell the
reader that "the event below is the record" (`run-task.ts:268-283`, `run-task.ts:388-400`).
That makes an unauthenticated event writer the authoritative record of a refused execution.
Register it as **N10**, not as a regression.

## 5. The pre-dispatch arm (request 5) — bounded, but not by the control

`requireCompletionAuthority` (`claim.ts:623-685`) permits a terminal write with no claim when
the activity's workflow id equals `task-<taskId>` and no attempt of the task is running or
claimed. I tested exactly the attack described.

**It works.** A workflow started under `task-<victimTaskId>` that calls `completeTaskActivity`
with no attempt id, no claim, on a task with no attempt at all:

```
B:pre-dispatch-no-attempt-succeeded
  verdict:  [{ changed: true, previousStatus: 'queued', status: 'succeeded',
               authority: 'pre-dispatch' }]
  taskStatus: succeeded     runStatus: succeeded     finishedAt: set
  attempts: []              agentRuns: 0
```

That is the literal N4 sentence — "terminal state for a task that never executed" — still
true for `succeeded`. Now the bounds, measured rather than assumed:

- **The workflow id must be canonical.** A workflow under `rogue-<uuid>` is refused
  `EXECUTION_CLAIM_REFUSED` (section C). The id is `task-` + a task UUID, so it is guessable,
  not secret — but it is the *only* thing standing between a workflow and this write.
- **REJECT_DUPLICATE is real.** With a live execution holding `task-<taskId>`, a second start
  under that id fails with `WorkflowExecutionAlreadyStartedError` (probe 3), so the arm cannot
  be used against a task that has a live run. That is the strongest part of the design and it
  holds.
- **The shipped registry cannot reach `succeeded`.** `main.ts:143` registers exactly one
  workflow module, `workflows/run-task`, and `runTaskWorkflow` never calls
  `completeTaskActivity` with `succeeded` and no attempt: the success path reaches completion
  only after `persistResultActivity`, which requires the claim. I ran the **production**
  workflow bundle with no attempt id and the only reachable outcome is:

```
H:production-registry-no-attempt
  result:     { status: 'failed', summary: 'EXECUTION_CLAIM_REFUSED: …' }
  taskStatus: failed   runStatus: failed   run.error: EXECUTION_CLAIM_REFUSED
  attempts: 0          agentRuns: 0
```

So the reachable residual through the shipped worker is: **any Temporal client can force any
non-terminal task to `failed`, without executing it, whenever no execution is live for it** —
by starting `runTaskWorkflow` under `task-<taskId>` with no attempt id. That is a denial of the
task, plus a fabricated failure reason on `WorkflowRun.error`. It is also *pre-existing in
kind* (before this commit the same caller could write any status), and it is the price of
letting a refused run record its refusal.

**Verdict on the arm: bounded, so a residual rather than a break — but two things should
change.** The comment at `claim.ts:629-634` says "A run that never claimed a reservation may
only record a **refusal** for the task it was started for." The code does not say that; it
says "any terminal status". Narrowing the arm to `failed` and `cancelled` — the only statuses
either legitimate pre-dispatch call site uses — makes the code match the sentence at the cost
of one condition, and closes the `succeeded` case for every future workflow type. **N8.**

Second, the test that covers this arm (`execution-boundary.test.ts:932-960`) uses a task in
`ready`, which `completeTask` refuses to write (`status IN (queued, running, verifying)`), so
the fixture can only ever observe `changed: false`; it asserts the *refusal*, which is right,
but it would not have shown the write. My probe used `queued`, which is the production state
after `POST /run`, and showed the write.

## 6. Regression from removing the fallback (request 6)

Every consumer of a supplied identity was enumerated and checked. What is now unreachable:

| Path | State | Intended? | Documented? |
|---|---|---|---|
| Any standalone / direct activity call naming an attempt | refused `EXECUTION_IDENTITY_UNAVAILABLE` | yes | `claim.ts` header, `contracts.ts`, AG-603 §5 |
| `drive-run.ts start` without an attempt id | refused, exit 2 | yes | script usage + AG-603 §5 |
| Direct function-call tests | replaced by real executions | yes | AG-603 §5, suite headers |
| A hand-started workflow under a **non-canonical** id writing terminal state before a claim | refused | yes | AG-603 §5 "Deliberate consequence" |
| `validateTaskActivity` accepting a database `WorkflowRun.id` as an execution identity | refused (the field is gone) | yes — it was an id-space bug | diff, `contracts.ts` |

**One legitimate path is now unreachable and is not documented.** An `ExecutionAttempt` that
is `running` with `claimedByWorkflowRunId IS NULL` can never be completed by anyone:

- the claim arm cannot apply (no claim exists),
- the pre-dispatch arm treats it as foreign to *everyone*, including the execution that owns
  it: `row.status === 'running' ? row.claimedByWorkflowRunId !== executionRunId` is
  `null !== runId` → `true` (`claim.ts:656-660`),
- the reaper only considers `status: 'queued'` (`claim-release.ts:106`).

Such a row exists for every attempt adopted before the Phase 6 column was added, and the
column is explicitly never back-filled. AG-603 documents the *launch*-site consequence of an
in-flight execution ("refused at the launch site"), not this completion-site wedge: a task that
was mid-run at deploy time keeps its terminal write refused forever, and the refusal is
swallowed with a log line (`run-task.ts:279-284`). Fail-closed, but a stuck task. **N11.**

No other legitimate path is lost: the approval gate's *accepting* case is preserved in a
Temporal-gated block (`approval-grant.test.ts`), the retry case passes, and `cancel` /
`describe` / `wait` are untouched.

## 7. The release predicate (request 7) — uses the run, and it is still not safe

The predicate is the specific run: the candidate is probed as
`probe.execution(taskId, candidate.claimedByWorkflowRunId)` (`claim-release.ts:137`), the probe
passes that run id to `getHandle(workflowId, runId)` (`reaper.ts:158`), and the release write
requires `status: 'queued'` **and** `claimedByWorkflowRunId: input.workflowRunId`
(`claim-release.ts:236-239`). Naming a different dead run cannot release a live one; I ran it:

```
F: live holder + a *dead* sibling run under the same workflow id
   action: { outcome: 'skipped_live' }      row: queued, claim = the live run
```

**But the same test shows the hole in the other direction.** The probe is asked about the
canonical workflow id (`task-<taskId>`) with an arbitrary run id. When the holder's run id
belongs to a workflow with a *different* id, `describe` answers NOT_FOUND — which the N2 fix
now turns into `absent` — and the claim is released **while the holder is running**:

```
G: live holder under `probe-<uuid>` (the harness's own default id)
   liveStatus: RUNNING        canonicalDescribeFound: false
   action: { outcome: 'released',
             reason: 'Temporal reports no execution for run 01a1de39-0288…' }
   row:    failed, claim = NULL, terminationReason 'crashed'
```

Before this commit the same shape produced `unknown` → `skipped_unknown` (SEC-602 §7). The
classification is now *right about the pair it asked about* and *wrong about the claim*: the
question the release path needs answered is "does this run id exist anywhere in the namespace",
not "does it exist under the id I derived from the task". **N7.**

## 8. Do the new tests fail on the pre-fix code? — Yes, five reverts, five failures

Scratch copy at `/tmp/scratch/r3` (`git archive a75f121`), one behaviour reverted at a time:

| Reverted behaviour | Test(s) | Result |
|---|---|---|
| `executionIdentity()` fallback restored in `execute-agent.ts` (input field used when no context) | N1 standalone ×2 + in-workflow identity ×1 | **3 fail** — the standalone executor resolves with `status: 'succeeded'`; the reproduction runs again |
| `classifyProbeError` back to `grpcStatus(error) === 5` | absent-release E2E + 2 pure classifier tests | **3 fail** — `expected 'unknown' to be 'absent'`, E2E `skipped_unknown` |
| `requireExecutionClaim` removed from `persistResultActivity` | N4 "refuses persistence … no claim" | **fails** — promise resolved, `AgentRun` written |
| workflow-id check removed from the pre-dispatch arm | N4 "refuses a pre-dispatch completion from a workflow that is not this task's execution" | **fails** — the rogue completion resolves |
| both `drive-run` guards removed (true pre-fix state) | N3 "names the missing attempt id and exits 2" | **fails** — `expected 1 to be 2` |

No weakened assertions, no sleeps used as synchronisation, no test seam supplying an identity.

## 9. Phase 5 regression — none found

The diff touches no isolation, volume, cgroup, budget, output-cap or resource source file. The
only Phase 5-adjacent change is `isolation-gate.test.ts`, which now reserves and claims an
attempt so the activity can reach the gate under test; `reserveAndClaim` goes through
`claimExecution`, the production writer.

| Suite | Result |
|---|---|
| `apps/worker` full | **239 passed, 12 skipped, 0 failed** (22 files) |
| `packages/workspace-manager` + `isolation-gate` + `cpu-budget` + `isolation` | **123 passed, 3 skipped** |
| volumes: leases, ownership, containment (`..`, symlink, forged lease), reclaim, ENOSPC | **17/17 passed** |
| output cap / io limits | pass; the measured-throughput test skips (see below) |
| CPU budget arithmetic + sampler | **12/12 passed**; the three cgroup *kill* tests skip |
| VM fail-closed (`isolation-gate`) | **4/4 passed** — vm refused, forged env ignored, forged input cannot downgrade, restricted tier proceeds |
| cgroup probe | **6/6 tier-limit tests passed** (superblock magic, delegation, read-back) |

The 12 skips are this host's kernel refusing cgroup delegation and the io throughput
measurement — unchanged from the previous two reviews, and not attributable to the diff.

## 10. New bypasses across the three commits

- **N7** is new in `a75f121` and is a fail-open release (below).
- **N8** is new in `a75f121` (the arm did not exist before) and is bounded by the registry.
- Nothing new from `3aed33d` or `74207f0` beyond what SEC-601/SEC-602 already recorded; the
  F1/F2/F3 paths they opened are now closed at the launch site, and I re-confirmed there is
  still exactly one `runtime.execute` call site and one workflow call site for the executor.
- The `claimExecution` write is unchanged: one conditional `updateMany` inside a transaction,
  `count === 1` is the grant, no read-then-write.

---

## New findings

### N7 — Medium (High impact, conditional reachability) — the release pass reaps a live claim whose workflow id is not `task-<taskId>`

**Where:** `reaper.ts:151-165` (`execution()` probes `task-<taskId>` + run id),
`reaper.ts:91-115` (`classifyProbeError` now maps that NOT_FOUND to `absent`),
`claim-release.ts:137` and `:236-239` (release follows the classification).

A claim's holder is identified by **run id only**. `describe` is keyed by **workflow id and run
id**. When the two ids belong to different executions — i.e. the claim was written by a
workflow started under any id other than `task-<taskId>` — the probe's NOT_FOUND means "no such
run *under that workflow id*", and the classifier reads it as "no such execution". The claim is
then released on a live run:

```
liveStatus: RUNNING → action: released → attempt: failed, claim NULL, terminationReason 'crashed'
```

The execution is not dead; it is now unauthorised. Its next `persistResultActivity` or
`completeTaskActivity` is refused `EXECUTION_CLAIM_REFUSED`, so the run cannot record its
result. `claim-release.ts:29-34` says a release "destroys work" and is the thing the pass must
never do; it does it here.

**Reachability.** Not through the shipped worker: `main.ts:143` registers `runTaskWorkflow`
only, and every client that starts it uses `task-<taskId>` (`client.ts:77`, API
`orchestrator.service.ts:145`). It becomes reachable the moment a claim is written by any other
workflow id — a back-office or replay workflow, a second workflow type on the queue, or the
repository's own test harness (`probe-<uuid>`, `execution-harness.ts:146`), which is exactly
the shape AG-603 contemplates when it says a hand-started suffixed-id workflow "must be
cancelled through `POST /cancel`". A staging environment that runs the suite against the same
Temporal namespace and has the reaper enabled will release live test claims.

**Fix, in order of preference:** record the workflow id with the claim (it is server-set
context, equally unforgeable — `executionWorkflowId()` already exists) and probe that pair;
or treat `absent` as `absent` only when the holder's workflow id is the canonical one and
`unknown` otherwise. The first makes the probe exact; the second restores the fail-closed
behaviour at the cost of the wedge N2 was opened for.

**Regression, not a pre-existing defect:** the parent answered `unknown` for this shape. I
verified the parent's decision for the same error object (`/tmp/opencode/r3-probe2.mts`,
section I: `parentClassifierAnswer: 'unknown'`, `currentClassifierAnswer: 'absent'`), and I
recorded the skip as a fail-closed protection in SEC-602 §7.

### N8 — Medium (latent) — the pre-dispatch completion arm permits `succeeded`, not only a refusal

**Where:** `claim.ts:623-685`. The arm checks identity and the absence of a foreign attempt; it
never checks `input.status`.

Reproduction: start any workflow under `task-<victimTaskId>` and dispatch
`completeTaskActivity({taskId, orgId, status: 'succeeded'})` with no attempt id. On a task with
no attempts and a `queued` workflow run:

```
{ changed: true, status: 'succeeded', authority: 'pre-dispatch' }
task → succeeded, run → succeeded, attempts 0, AgentRuns 0
```

Bounded today by the registry (only `runTaskWorkflow`, which reaches this arm only with
`failed`/`cancelled`) and by `REJECT_DUPLICATE` (no live run). Not bounded by the control: any
additional registered workflow type widens it to `succeeded`, and the comment at
`claim.ts:629-634` already claims the narrower behaviour.

**Fix:** in the pre-dispatch arm, require `status` to be `failed` or `cancelled`. Both
legitimate call sites use only those (`run-task.ts:268`, `:323`, `:388`).

### N9 — Low — the `foreign` predicate treats an unclaimed `running` attempt as foreign to its owner

**Where:** `claim.ts:656-660`. `row.status === 'running' ? row.claimedByWorkflowRunId !==
executionRunId : …` evaluates `null !== runId` → `true` for a running row with no claim, so the
execution that adopted such a row cannot complete its task; and the reaper will not release it
(`claim-release.ts:106` selects `status: 'queued'` only). Same root as N11.

### N11 — Low (upgrade window) — a pre-Phase-6 `running` attempt wedges its task permanently

Every attempt adopted before `claimedByWorkflowRunId` existed has `NULL` there (the column is
deliberately never back-filled). Such a row can be neither claimed (`classifyLostClaim`
refuses), nor adopted (`attempts.ts:233` requires the claim), nor completed (N9), nor reaped.
A task that was mid-run at deploy time therefore never reaches a terminal state; the refused
completion is logged and swallowed (`run-task.ts:279-284`) while `task.failed.v1` is still
emitted, so the task and the audit trail disagree. AG-603 documents the launch-site consequence
of in-flight executions; this is the completion-site one.

### N10 — Low (pre-existing) — two by-name activities still write execution state with no authority, and this commit leans on one of them

`emitEventActivity` and `recordStartActivity` are in the registry (`activities/index.ts`), read
no claim and take no identity (probe sections L and M: a standalone activity wrote a valid
`task.succeeded.v1` for a task that never ran, and moved a task `queued → running`).
`a75f121` makes the audit event the durable record of a refused execution
(`run-task.ts:268-283`, `run-task.ts:388-400`), which raises what forging it is worth. N4's
class is one third closed.

---

## Can approval-to-attempt be marked PASS?

**Yes — for the boundary the register calls O1.** The criterion in
`docs/engineering/phase5-recovery/REMEDIATION-REGISTER.md:18` is that the claim is "written by
validation **and honoured by the execution path**". That is now true, and I could not break it:

- **One reservation, one execution, for every dispatch shape I can produce.** Standalone
  activity: refused before the first read. Rogue workflow with a borrowed attempt id: refused
  with its own run id in context. Rogue workflow with no attempt: refused. Duplicate canonical
  start: blocked by `REJECT_DUPLICATE`. Retry of the same execution: admitted, under the same
  claim, as attempt N+1.
- **Identity is not an input.** No activity input carries a run id; `executionIdentity()` and
  `executionWorkflowId()` read only the server-set context; the test seam that used to supply
  one is gone and its replacement supplies nothing.
- **Approval is enforced at the launch site**, through the same shared function validation
  uses, and re-checked after the claim.
- **The terminal writes are authority-checked** for the two activities that write execution
  results, and adoption is conditional on the claim.

**The exact boundary of what is now guaranteed:**

> A task is executed only by an execution that holds a `queued` `ExecutionAttempt` claimed
> under the run id the Temporal server assigned to it, for a task whose approval gate passes at
> launch, and no second execution can hold that attempt. Nothing reachable through an activity
> input, a borrowed run id, or a rogue workflow can produce that state or bypass it.

**What that boundary does not cover, and therefore what must not be claimed:**

1. **It is not "no caller can alter task state."** Any Temporal caller can force any idle task
   to `failed` (probe H), can pre-empt a task's single execution slot by claiming its attempt
   under its own run id, and can forge the audit event that describes the outcome (N10).
2. **It is not "a task cannot be reported succeeded without executing."** True through the
   shipped registry, not true of the control (N8).
3. **It is not "a stranded claim is released safely."** It is released on a live run when the
   holder's workflow id is not canonical (N7). The register's O1 sentence — "released by the
   reaper only when Temporal reports its run absent or terminal" — is technically true and
   materially misleading until N7 is fixed.

**So: mark O1 PASS, with N7/N8/N9/N11 recorded as open defects, and do not close F4.** The
distinction matters: O1 asks whether the approval-to-attempt boundary holds, and it does. F4
asks whether a stranded claim is released only when it is provably dead, and the answer just
became "almost".

## What still cannot be guaranteed

1. **That a live claim is never released.** N7 — demonstrated, not argued.
2. **That the terminal status written without a claim is only a refusal.** N8.
3. **That the audit trail is authoritative.** N10 — it is the record the refusal path now
   depends on, and it is writable by name without authority.
4. **That every in-flight execution can finish across the upgrade.** N11.
5. **That CI covers the identity boundary.** The Temporal-gated tests (54 of them at the
   previous count) skip without a server; with `TEMPORAL_ADDRESS` closed this package reports
   `197 passed, 54 skipped, 0 failed`. A skipped test is not a failing one, and the property
   that matters most is in the skipped set.
6. **Tenant isolation of the release pass.** `runClaimReleasePass` scans every tenant's
   candidates; the probe is scoped by task and run id, and the write by `orgId`, `taskId` and
   the holder — that part is sound — but a single reaper sweep acts across tenants, which the
   multi-tenant gap (O4) leaves unexercised.

## What I would refuse to ship

1. **A release pass that can reap a live claim** (N7). If the fix cannot land in this change,
   gate the pass on the holder's workflow id being canonical, or leave the pass disabled, and
   correct `claim-release.ts:29-34` and the register's O1 sentence in the meantime.
2. **The sentence "a run that never claimed a reservation may only record a refusal"** while
   the code accepts `succeeded` (N8). Either narrow the arm or fix the comment — the comment is
   what the next reviewer will believe.
3. **"N4 is closed"** as written. Two of the three by-name writers that finding named are
   closed; the event writer is not, and it is now load-bearing (N10).
4. **"F4 is closed."** It was PARTIAL for the `absent` arm and is now PARTIAL for a different
   and worse reason.

## What I tried and could not do

- **Reach `succeeded` through the shipped worker.** I started the production workflow bundle
  (`main.ts:143`'s module) under `task-<taskId>` with no attempt id. Every path ends in
  `failed`. That is the bound that keeps N8 a latent finding rather than a live bypass, and I
  could not widen it without registering a workflow type the worker does not ship.
- **Produce a second execution, or a single new attempt, from a standalone activity.** Both
  variants of the SEC-602 reproduction now refuse before any row is read. I also supplied four
  candidate identity field names at once and added a third shape (`validateTaskActivity`
  standalone); all refused, zero attempts.
- **Release a live canonical claim by naming a dead run.** `skipped_live`; the claim and its
  timestamp are intact.
- **Run the cgroup kill and io-throughput tests.** This host refuses cgroup delegation for the
  full tier; 12 tests skip, as in the previous two reviews. CPU enforcement was therefore not
  re-observed, only confirmed unchanged by the diff — the diff touches no resource file.

---

## Test and probe evidence gathered during this addendum

| Item | Command / artefact | Result |
|---|---|---|
| `apps/worker` full | `npx vitest run apps/worker/test` | **239 passed, 12 skipped, 0 failed** |
| `execution-identity.test.ts` | verbose, real Temporal | **18/18 passed**; N1 standalone ×3 and N3 ×2 executed, not skipped |
| `execution-boundary.test.ts` | verbose, real Temporal + PostgreSQL | **24/24 passed**; N2 real-probe ×3 executed |
| `reaper.test.ts` | — | 17 passed (5 of them `classifyProbeError`: the real error type, a bare gRPC code, a coded `cause`, `unknown` controls, and a foreign-realm copy carrying the marker) |
| Phase 5 (`workspace-manager`, `isolation-gate`, `cpu-budget`, `isolation`) | verbose | **123 passed, 3 skipped** |
| `io-limits` + `cgroup` | verbose | **13 passed, 9 skipped** (host refuses the full cgroup tier) |
| N1 re-run, both variants, four field names | `/tmp/opencode/r3-probe.mts` §A | `EXECUTION_IDENTITY_UNAVAILABLE`, `newAttempts=0`, `agentRuns=0` |
| pre-dispatch arm, `succeeded` and `failed` | §B | **written**, `authority: 'pre-dispatch'`, 0 attempts, 0 AgentRuns |
| non-canonical workflow id | §C | refused `EXECUTION_CLAIM_REFUSED` |
| standalone complete / canonical persist | §D, §E | `EXECUTION_IDENTITY_UNAVAILABLE` / `EXECUTION_CLAIM_REFUSED` |
| release: live holder + dead sibling | §F | `skipped_live`, claim intact |
| release: live non-canonical holder | §G | **`released`** while `liveStatus: RUNNING` |
| production workflow bundle, no attempt | `/tmp/opencode/r3-probe2.mts` §H | task `failed`, 0 attempts, 0 AgentRuns |
| parent vs current classifier on a real error | §I | `parent: unknown`, `current: absent` |
| REJECT_DUPLICATE while live | `/tmp/opencode/r3-probe3.mts` | `WorkflowExecutionAlreadyStartedError` |
| forged audit event / forged run start | `/tmp/opencode/r3-probe4.mts` | both **written** from standalone activities |
| pre-fix sensitivity | `/tmp/scratch/r3` (five reverts) | 5/5 corresponding tests failed |
| `drive-run.ts` | `tsx scripts/drive-run.ts start <task> <org>` | exit **2**, message names the attempt id |

Verification status: **verified** for every command and probe result quoted here. Honest
caveats: (a) the production-registry bound in §H is established by reading `main.ts:143` and
by running that module, not by inspecting a deployed worker; (b) the cgroup kill and
io-throughput suites could not run on this host, so Phase 5 enforcement is confirmed by absence
of change rather than by re-observation.

---

# Addendum — SEC-604 re-review of `23db912`

**Commit reviewed:** `23db912037ee17932f6cd4dc1a801ffe9b8b2337` ("fix: release a claim on
evidence about that execution, not a naming convention").
**Parent:** `a75f1217b49b1eb1fdae953076ecc8739f7ebf82`. **Tree:** clean at review time; no
uncommitted changes.
**Scope:** the two declared trade-offs, the three findings the previous addendum raised
(N7, N8, N4-class), pre-fix sensitivity, Phase 5 regression.

## Verdict

**PASS** — for the commit, and for all three gates it was written to close.

Every blocking finding from the previous three rounds is closed, and I could not reopen any
of them with my own reproductions against real Temporal 1.32 and real PostgreSQL:

- **N7** — fixed by recording the pair. A live execution under a non-canonical workflow id,
  claiming through the *production* path, is `skipped_live`; the claim survives and still
  authorises the run's terminal write.
- **N8** — `succeeded` is refused before the first write; `failed`/`cancelled` still land,
  including end to end through the shipped workflow.
- **N4 (residual class)** — the event writer and the start record refuse standalone dispatch,
  rogue workflow ids and borrowed attempts; the normal path, a retried start, the
  pre-dispatch failure path and the reaper's own writes all still work.

Two new **Medium** findings are recorded (N12, N13), both non-security: an availability
regression in the release pass's candidate ordering, and a test-adequacy gap that leaves the
*writer* half of the N7 fix uncovered. Neither makes a gate statement untrue, and each has a
one-predicate or one-assertion fix. Details, and why I do not fail the commit for them, in
"What I would refuse to ship".

## 1. N7 — closed, and the fix is the right shape

### 1.1 The fix is "record the identity, do not derive it"

`ExecutionAttempt.claimedByWorkflowId` (`schema.prisma`, migration
`20261115120000_phase6_claim_workflow_id`, one nullable `text` column, no back-fill, applied
cleanly — `_prisma_migrations.finished_at` set, `logs` empty). It is written in the **same**
conditional `updateMany` as the run id (`claim.ts:318-321`), from
`executionWorkflowId()` (`claim.ts:194-202`, `Context.current().info.workflowExecution`), and
in the same write path as `startAttempt`'s adoption (`attempts.ts`, called with
`executionWorkflowId()` from both `execute-agent.ts` call sites). The probe asks about the
recorded pair (`reaper.ts:158-176`) and nothing else.

### 1.2 The reproduction I ran — the real shape, not the test's fixture

The shipped test writes the claim with a raw `update`. Mine writes it **through
`validateTaskActivity`, inside a live workflow started under `probe-<uuid>`** — the exact
shape N7 was reported in, with the claim produced by production code:

```
workflowId:            probe-d6c5fcf8-a5ec-449f-b502-9b06b6c923af
runId:                 01a1de9f-954b-7a20-a9bf-c5e7fe5b90e9
liveStatus:            RUNNING
claimAfterValidate:    { status: queued, claimedByWorkflowId: probe-d6c5fcf8…,
                         claimedByWorkflowRunId: 01a1de9f… }      ← recorded from context
action:                { outcome: 'skipped_live', workflowId: probe-d6c5fcf8…,
                         workflowRunId: 01a1de9f… }
row:                   { status: queued, both claim columns intact, claimedAt intact }
releaseAudits:         0
```

Then the assertion that matters more than the row state — the claim still *authorises* the
live run:

```
A2: same execution, completeTaskActivity → { changed: true, status: 'failed',
                                             authority: 'execution-claim' }
    task: failed
```

Before this commit the same shape produced `released` while `RUNNING` (SEC-603 §G). N7 is
closed.

### 1.3 Attacking the new input

| Attack | Result | Evidence |
|---|---|---|
| Choose a workflow id that does not resolve | The **recorded** id is used, not the caller's choice; a claim that records no id is skipped before the probe is called | §C |
| Re-claimed row + stale release attempt | `lost_race`; the row keeps the new pair, zero release audits | §B1: `releasePredicate` requires `status: 'queued'` **and** `claimedByWorkflowId` **and** `claimedByWorkflowRunId` (`claim-release.ts:291-301`) |
| Adopted between the read and the write | `lost_race`; the row stays `running` | §B2 |
| `claimedByWorkflowId IS NULL` | `skipped_unknown`; **the probe is never called**, not even with `task-<taskId>` | §C: `askedTotal: 0`, `askedWithDerivedId: []` |
| Forge the recorded id through activity input | Ignored. Nine candidate identity fields set to the canonical id; the row recorded the real `probe-2db7…` | §F1 |
| Workflow-id reuse / restart / rename | `describe(id, run)` is keyed by the pair; a reused id mints a new run, and the recorded run stays the one that claimed. Old run terminal → release is correct; new run live → `skipped_live` | §A/§B + `reaper.ts:160-168` |
| Make someone else's claim releasable | Not possible from an activity: `claim-release.ts` is imported by the reaper and tests only, never from `src/activities/` | structural test `:1893`, and `grep` confirms |

`classifyProbeError` is unchanged — verified, not taken on trust. The implementer's hash is
reproducible: the region from `classifyProbeError`'s doc comment through `isWorkflowNotFound`
(stopping before `createTemporalProbe`) hashes to
`f1ff802830f2383ebd1e04c3e2b3df145ac4beb7315d82103f322bc659845b53` at **both** commits, byte
for byte. Its helpers (`isWorkflowNotFound`, `errorChain`, `grpcStatus`) hash identically
too, and the file's only changed hunks are the interface comment and `execution()`.

## 2. N8 — closed; the refusal is still recorded end to end

- `succeeded`, canonical id, no claim: **refused** (`EXECUTION_CLAIM_REFUSED`, details
  `status: "succeeded"`); task still `queued`, run still `queued`, zero `AgentRun`s.
- `cancelled`, same shape: **admitted** — `{ changed: true, status: 'cancelled',
  authority: 'pre-dispatch' }`.
- End to end through the **shipped** `runTaskWorkflow`: a HIGH task with no approval, a real
  reservation, started under `task-<taskId>` →
  `result: { status: 'failed', summary: 'APPROVAL_REQUIRED: …' }`, task `failed`, **one**
  `task.failed.v1` with `code: APPROVAL_REQUIRED`. The refusal path that the whole
  `failBeforeExecution` design exists for still records itself.
- `task.status_changed.v1` from the same canonical, claim-less execution: **refused**. The
  arm admits refusals, not successes — including the audit event.

## 3. N4-class — closed for `Task` writes, and the legitimate paths still work

| Shape | Result |
|---|---|
| standalone `emitEventActivity` (`task.succeeded.v1`) | `EXECUTION_IDENTITY_UNAVAILABLE`, 0 rows |
| standalone `recordStartActivity` | `EXECUTION_IDENTITY_UNAVAILABLE`, task stays `queued` |
| rogue workflow id → `task.succeeded.v1` | `EXECUTION_CLAIM_REFUSED`, 0 rows |
| rogue workflow id → `task.failed.v1` (the refusal event) | `EXECUTION_CLAIM_REFUSED`, 0 rows |
| canonical id, no claim → `task.status_changed.v1` | `EXECUTION_CLAIM_REFUSED` |
| canonical id, no claim → `task.failed.v1` | **written** (1 row) — the refusal path |
| claimed execution: validate → start → `task.status_changed.v1` | **all three succeed**; task `running` |
| claimed execution: `recordStartActivity` delivered **twice** (retry) | first `{started: true}`, second `{started: false}`, both admitted, no second run row, claim intact |
| borrowed attempt id (another execution's claim) → complete / emit / start | all three `EXECUTION_ALREADY_CLAIMED`, 0 writes |
| reaper's own writes | `claim-release.ts` writes `ExecutionAttempt` + `AuditEvent` through Prisma directly, no activity; a real release produced its audit row (§G) |

One scoping fact the "closed" label must carry: the gate runs only for `Task` aggregates
(`emit-event.ts:69-79`). A rogue workflow can still write `workflow.*`, `agent.*`,
`approval.*`, `project.*` and `run.*` audit rows by name — §E6 wrote a `workflow.failed.v1`
for an arbitrary aggregate id. Nothing under review depends on those events, so this is not
a gate failure; it is a narrower closure than the phrase "N4 is closed" implies. **N15.**

## 4. The two declared trade-offs

### 4.1 A duplicate can no longer write `task.failed.v1` — correct consequence

A duplicate execution holds no claim and does not own the task. Its `task.failed.v1` said "the
task failed" about a task that is `queued` and owned by another live execution — a false
statement about somebody else's aggregate. Refusing it is the same ownership rule the
terminal write already enforced, applied one layer over. §F3, against a real claimed attempt:

```
duplicate: validate → EXECUTION_ALREADY_CLAIMED
taskStatus: queued
taskAggregateFailedEvents: 0
claimDuplicateEvents: 1        (on the attempt, naming the holder)
```

Nothing user-visible or evidentially load-bearing depended on the old event: no consumer
reads `task.failed.v1` outside the worker (`grep` over `apps/` and `packages/`), the task's
own execution still writes it when *it* fails (the end-to-end refusal in §D3), and the task
audit trail is now *more* accurate, not less.

Two caveats, both recorded as findings rather than objections:

- the surviving record (`execution.claim_duplicate.v1`) is written **best-effort**
  (`claim.ts:954-976`) and a duplicate has no `WorkflowRun` row, so if that audit write fails
  the only record is Temporal history. Before, the workflow's event was the reliable one.
  Informational.
- two comments still assert the old behaviour as the guarantee (`claim.ts:95-97`,
  `:946-952`, `:966` — "the workflow's `task.failed.v1` … is the durable record"). Since
  AG-604 that is false for exactly the duplicate case. **N14.**

### 4.2 The direct-start fixture moved to the canonical id — preserved, not weakened

The test's subject is "a direct Temporal start with **no attempt id** is refused" and it
still proves that: `result.status === 'failed'`, `assertNothingRan` (attempt still `queued`,
zero `AgentRun`s, zero workspaces), exactly one `WorkflowRun`, and the refusal recorded with
`code: APPROVAL_NOT_RESERVED`. Those assertions are untouched. The fixture changed because
the *event* is now authority-checked, and it is the only record that shape can produce.

What the test no longer exercises — "a run that is not this task's execution may not write
the task's refusal" — is asserted directly, with the opposite expectation, in
`execution-boundary.test.ts:1740` (refusal event from `task-<id>-direct`: refused, 0 rows)
and `:935` (pre-dispatch completion from a random `probe-…` id: refused, task stays
`queued`). The coverage moved to where it is the subject; it was not dropped. I also
re-checked that the old fixture could not have caught the regression it looks like it might:
its assertions never depended on the terminal write landing.

The cost is real and worth recording: a run started under a non-canonical id now leaves **no
Postgres trace at all** — its terminal write, its terminal event and its refusal event are all
refused, and it has no attempt. Its only record is Temporal history. Correct ownership rule,
thinner evidence. Informational.

## 5. Pre-fix sensitivity — the claim holds, three for three

Scratch at `/tmp/scratch/r4`: `a75f121` extracted over a tree whose `node_modules` resolves to
this workspace (so the *current* generated Prisma client is used — the class `claimedByWorkflowId`
exists, which is the comparison most favourable to the implementer: no failure can be blamed
on a missing column), plus the new test file and probe fixture from `23db912`.

| Test | On `a75f121` |
|---|---|
| "does not release a claim held by a live execution whose workflow id is not `task-<taskId>`" | **FAIL** — `outcome: 'released'` where `skipped_live` is required |
| "refuses `succeeded` for a task with no attempts and no AgentRun" | **FAIL** — promise resolved `{ changed: true, status: 'succeeded', authority: 'pre-dispatch' }` |
| "refuses a `task.succeeded.v1` written by a standalone activity" | **FAIL** — promise resolved `{ created: true, eventId: … }` |

The implementer's claim about the N7 test is independently reproduced, and its two other
mutation rows I spot-checked behave the same way. No weakened assertion, no seam supplying an
identity, no `.only`.

## 6. Phase 5 regression — none

The diff touches no isolation, volume, cgroup, budget, output-cap or resource source file
(`git diff --name-only` — 22 files, all worker/claim/docs/migration).

| Suite | Result |
|---|---|
| `packages/workspace-manager` + `isolation-gate` + `cpu-budget` + `isolation` + `volumes` + `io-limits` | **129 passed, 4 skipped** |
| volumes: leases, ownership, containment, reclaim, ENOSPC | pass (in the above) |
| CPU budget arithmetic + sampler | pass; cgroup *kill* tests skip (host refuses delegation) |
| VM fail-closed | pass |
| cgroup probe | pass |
| `apps/worker` | **252 passed, 12 skipped** |
| monorepo `pnpm -w test` | **822 passed, 15 skipped, 72 files** |
| `apps/api` e2e | **97 passed** |
| typecheck (10 projects) / eslint (worker) | clean / clean |

The 4/12 skips are the same host-kernel refusals as the previous two reviews.

## New findings

### N12 — Medium (availability, upgrade window) — permanently-skipped rows are never aged out, so enough legacy claims stall the whole release pass

**Where:** `claim-release.ts:135-156` (candidates: `status: 'queued'`, claimed, `claimedAt <
cutoff`, `orderBy: { claimedAt: 'asc' }`, `take: batchSize`) and `:174-186` (a claim with no
recorded workflow id is skipped and **left in place**).

A NULL-id claim can never be released, but it still consumes a slot, and it is the *oldest*, so
it sits at the front of the queue on every pass for ever. With at least `batchSize` such rows,
no other task's claim is ever scanned again — and every pass looks healthy, because the
actions are all `skipped_unknown`.

Reproduction (real `runClaimReleasePass`, real Prisma):

```
10 legacy claims (claimedByWorkflowId NULL), ages 10h → 9h51m
 1 genuine candidate (recorded pair, holder gone), age 1h
batchSize 5

scanned: 5
outcomes: { skipped_unknown: 5 }
genuineCandidateWasScanned: false
genuineRow: { status: queued, claim intact }      ← never released
probeCalled: 0
```

The permanently-skipped *class* is new in this commit (before it, every candidate was probed;
a malformed run id was the only pre-existing instance, and it is rare). The mechanism is
pre-existing, so this is "the commit materially widens an existing weakness", not a new
invention.

**Fix:** exclude them from the candidate query — they can never be released, so selecting
them is pure cost: `where: { …, claimedByWorkflowId: { not: null } }`. Report them with a
separate count/query if operators need to see the legacy backlog. That removes the
per-pass rework and the starvation in one predicate.

### N13 — Medium (test adequacy) — the production claim writer is not covered, and the N7 test cannot see it break

**Where:** `execution-boundary.test.ts:1046-1065` (`strandedAttempt`), `:1301-1315`
(`holdClaim`) — every `claimedByWorkflowId` assertion in the suite follows a row the **test**
wrote with `update`. No test asserts the column on a row produced by `validateTaskActivity`
→ `claimExecution` → `validate-task.ts:259`.

Mutation, on a clean `23db912` tree: delete `workflowId: executionWorkflowId(),` from
`validate-task.ts` (the writer half of the fix), leave everything else intact:

```
execution-boundary.test.ts + execution-claim.test.ts → 51 passed (51)
  including "does not release a claim held by a live execution whose workflow id is not task-<taskId>" ✓
```

Production would then record NULL for every new claim: every stranded claim unreleasable for
ever, and N12's starvation triggered by the ordinary traffic of the fix itself. The suite
would stay green.

**Fix:** one assertion on the legitimate path — after `validateTaskActivity`, the adopted
attempt's `claimedByWorkflowId` equals the session's workflow id. (`execution-harness`
already exposes `runId`; the workflow id is the id the session was started under.) The
probe I ran (§A) shows the behaviour is correct today; only the test is missing.

### N14 — Low (documentation, contradicts the code) — the claim module still promises the duplicate's refusal is recorded by the workflow

`claim.ts:95-97`, `:946-952`, `:966`: "the workflow's `task.failed.v1` carries the same code
durably" / "… carries that code durably". Since AG-604 a duplicate execution's
`task.failed.v1` is **refused** (§F3: 0 rows). The durable record is the best-effort
`execution.claim_duplicate.v1`. This is the audit contract of the module that produces both
events; the next reviewer will read the comment and believe it. Fix: say what is true — the
refusal event is best-effort and the workflow result is not persisted.

### N15 — Low (scoping) — N4 is closed for `Task`-aggregate writes only

`emit-event.ts:69-79` gates on `aggregateType === 'Task'`. `workflow.*`, `agent.*`,
`approval.*`, `project.*` and `run.*` events are still writable by name from any workflow
(§E6: a rogue workflow wrote a `workflow.failed.v1` for an arbitrary aggregate id). Not
load-bearing for any gate under review — but "N4 is closed" needs "for task writes" attached,
and the register should say so.

### N16 — Informational — `CONTINUED_AS_NEW` is `active` for ever

`reaper.ts:170-172` maps `CONTINUED_AS_NEW` to `active`. For the first run of a chain that is
correct; once the chain has ended it is still `active`, so a claim held by that run can never
be released. Unreachable through the shipped registry (`runTaskWorkflow` does not
continue-as-new) and fail-closed, so: recorded, not filed.

### Informational — the duplicate's only durable record is best-effort

`claim.ts:954-976` swallows the audit failure by design, and a duplicate has no `WorkflowRun`
row to carry an error. If that write fails, Postgres has no record of the refusal. The
trade-off is defensible (a refusal must not become a retryable DB error) but the *cost*
changed in this commit and should be written down where the comment is.

### Informational — deployment invariant: the reaper and the worker must share a namespace

The probe now asks about the **recorded** pair, which is exact only if the reaper's
`TEMPORAL_NAMESPACE` is the one the claim was written under. Two processes in different
namespaces turn every live claim into `absent` → fail-open release. Pre-existing (the derived
probe had the same coupling), newly worth stating because the exactness is now the whole
argument. Not asserted anywhere.

### Re-observed residual — the release pass is not tenant-scoped (O4)

My single pass, run for a test tenant, released a stranded claim belonging to a **different**
tenant — a row left behind by the earlier vitest run (`workflowId: probe-b4ac6318…`, logged
at 09:52:17.757 with `liveness: absent`). The write is scoped by `orgId`/`taskId`/holder, so
it is not a cross-tenant *corruption*, but one sweep acts across tenants and no test covers
two real orgs. Unchanged by this commit.

## Final status of every gate this phase touched

| Gate | Status | Basis |
|---|---|---|
| **Approval-to-attempt (O1)** | **PASS** (unchanged) | Re-confirmed in this commit: standalone activity refused before any read; rogue workflow with a borrowed attempt refused; duplicate execution refused with its own run id in context; retry of the same run admitted under the same claim; the launch-site claim and the approval re-check are untouched by the diff |
| **Claim release (F4)** | **PARTIAL — safety PASS, liveness M** | Safety: I could not make it release a live claim in any shape I constructed (§A, §B1, §B2, §C, and the shipped tests). Liveness: N12 (starvation at ≥ `batchSize` legacy claims) and the documented permanent wedge for pre-migration claims (§5 of the closure record). Do not mark F4 closed |
| **Write authority (N4)** | **PASS for `Task` writes; PARTIAL for the class** | The two activities it named now require authority before their first write and refuse every hostile dispatch I could construct; the other five aggregate namespaces are still open (N15) |
| **Isolation flake (O11)** | **PASS** | `isolation-gate` 5 runs × 4 tests, all green; the `[simulate:ok]` lever is present and the file is untouched by this commit; the deterministic-bucket explanation in the register is the correct one |

## What still cannot be guaranteed

1. **That a stranded claim is released.** Safety is proven; liveness is not. N12 can stall the
   pass indefinitely, and pre-migration NULL-id claims are never released by design.
2. **That the writer half of N7 cannot regress silently.** N13 — the suite is green with the
   writer removed.
3. **That the audit trail is authoritative for a refused duplicate.** Best-effort write, no
   run row, and two comments that claim otherwise (N14).
4. **That no audit row is forged for a non-`Task` aggregate.** N15.
5. **That every in-flight execution completes across the upgrade.** N9/N11 unchanged: an
   attempt adopted before the claim columns existed still wedges its task, and its refusal is
   swallowed while `task.failed.v1` is emitted.
6. **That CI exercises any of the identity boundary.** The Temporal-gated tests skip without a
   server; with `TEMPORAL_ADDRESS` closed the worker package reports `197 passed, 54 skipped`
   as before. CI still never runs (O8).
7. **Tenant isolation of the release pass.** O4, re-observed above.

## What I would refuse to ship

1. **Enabling the release pass at fleet scale without N12's predicate.** It is one line
   (`claimedByWorkflowId: { not: null }` in the candidate query) and without it the upgrade
   window can permanently disable the safety net this phase exists to provide — silently,
   with a pass that reports only `skipped_unknown`.
2. **"N4 is closed"** without "for `Task`-aggregate writes" (N15).
3. **"The duplicate's refusal is durable"** while it is a best-effort write and three comments
   say a reliable event covers it (N14).
4. **"F4 is closed."** Safety yes; liveness no.

I would **not** refuse this commit for N12 or N13: neither makes any gate statement untrue,
both are recorded above with a concrete fix, and the security properties the commit was
written to establish hold under every reproduction I could build.

## What I tried and could not do

- **Release a live claim.** §A (production-path claim under a non-canonical id), §B1
  (re-claim between read and write), §B2 (adoption between read and write), §C (NULL id), and
  the shipped real-probe tests: `skipped_live` / `skipped_unknown` / `lost_race` every time,
  zero `execution.claim_released.v1` rows.
- **Influence the recorded workflow id from an activity input.** Nine candidate field names
  at once, all forged to the canonical id; the row recorded the true `probe-…` id.
- **Get a duplicate execution to write anything task-scoped.** Terminal write, refusal event
  and start all refused; the only record is on the attempt.
- **Make the retried start fail.** Two `recordStartActivity` deliveries in one execution: the
  second is admitted and idempotent (`started: false`).
- **Find an out-of-scope change, a disabled control, or a test bent to pass.** None: the diff
  is 22 files, all claim/docs/migration; the two test fixtures that changed are stronger or
  redistributed, and the only deleted assertion (`task.status === 'ready'`) was replaced by a
  `queued` fixture whose assertion is that the write did **not** land.
- **Reproduce the implementer's full mutation table.** I verified its sha256 exactly, the §G
  row exactly, and two of the other four rows; the writer-side mutation it does not have is
  N13.

Honest caveats: (a) the pre-fix comparison used this workspace's generated Prisma client, so
the `claimedByWorkflowId` column existed at `a75f121` in the scratch tree — the failure
cannot be attributed to schema drift, and I checked that the failures are behavioural
(`released`, `changed: true`, `created: true`); (b) cgroup *kill* and io-throughput tests
still skip on this host, so Phase 5 enforcement is confirmed by absence of change, not by
re-observation; (c) the review document for round 3 was committed *inside* this fix commit,
so I cannot attest from git that its text is unaltered — I re-read it, and it matches the
conclusions I reached in round 3.

## Test and probe evidence gathered during this addendum

| Item | Command / artefact | Result |
|---|---|---|
| `apps/worker` full | `npx vitest run apps/worker/test` | **252 passed, 12 skipped, 0 failed** |
| monorepo | `pnpm -w test` | **822 passed, 15 skipped, 72 files** |
| `apps/api` e2e | `pnpm --filter @intelligenz/api test:e2e` | **97 passed** |
| `execution-boundary` verbose | real Temporal + PostgreSQL | **36/36 passed**; every new N7/N8/N4 test executed, none skipped |
| typecheck / lint | `pnpm -w typecheck`, `eslint apps/worker/{src,test,scripts}` | clean / clean |
| Phase 5 suites | `vitest run packages/workspace-manager apps/worker/test/{isolation-gate,cpu-budget,isolation,volumes,io-limits}` | **129 passed, 4 skipped** |
| isolation flake | `isolation-gate` ×5 | 4/4 each, 5/5 runs |
| migration | `_prisma_migrations` + `information_schema` | applied, `claimedByWorkflowId text` nullable, no back-fill |
| §A N7, production claim path | `/tmp/opencode/r4-probe.mts` §A | `skipped_live`, pair recorded from context, claim intact, 0 release audits |
| §A2 authority preserved | §A2 | `{ changed: true, status: 'failed', authority: 'execution-claim' }` |
| §B1 stale release vs re-claim | §B1 | `lost_race`, new pair intact |
| §B2 stale release vs adoption | §B2 | `lost_race`, row `running` |
| §C NULL recorded id | §C | `skipped_unknown`, `askedTotal: 0`, derived id never asked |
| §D1 N8 `succeeded` | §D1 | refused, nothing written |
| §D2 N8 `cancelled` | §D2 | admitted, task `cancelled` |
| §D3 end-to-end refusal (shipped workflow) | §D3 | task `failed`, 1 `task.failed.v1`, `APPROVAL_REQUIRED` |
| §E1–E4 N4 refusals | `/tmp/opencode/r4-probe-b.mts` | standalone/rogue/no-claim: refused, 0 rows; refusal event admitted |
| §E5 claimed path | §E5 | validate, start, `task.status_changed.v1` all succeed |
| §E6 non-`Task` aggregate | §E6 | **written** by a rogue workflow (N15) |
| §F1 forged workflow id | §F1 | ignored; recorded id is the real one |
| §F2 borrowed attempt | §F2 | complete/emit/start all `EXECUTION_ALREADY_CLAIMED` |
| §F3 duplicate | §F3 | 0 task events, 1 `execution.claim_duplicate.v1` |
| §G absent pair | §G | `released` + audit row |
| retried start | `/tmp/opencode/r4-probe-c.mts` | `started: true` then `started: false`, claim intact |
| N12 starvation | `/tmp/opencode/r4-probe-d.mts` | 10 legacy + batchSize 5 → genuine candidate never scanned, probe never called |
| N13 writer mutation | clean `23db912`, `validate-task.ts:259` removed | **51 passed** — the suite cannot see it |
| pre-fix N7 / N8 / N4 | `/tmp/scratch/r4` (`a75f121` + new tests) | **3/3 fail**, with the pre-fix outcomes quoted above |
| classifier hash | region at both commits | `f1ff8028…` identical, byte for byte |
| claim-release reachability | `grep` + `execution-boundary.test.ts:1893` | not imported from `src/activities/` |

Verification status: **verified** for every command and probe result quoted here.

---

# Addendum — SEC-605 Gate G re-review of `9461d27`

**Commit reviewed:** `9461d2773a2902dee91d0f36a22977356548c01e`
**Parent:** `58476b0a105c3fb405d63278d38e1eb965fc28d4`
**Branch:** `phase-5/isolation-readiness`
**Reviewer:** Security Architect (independent; did not author this commit)
**Date:** 2026-11-15
**Method:** read every new module end to end, traced the four call paths named in the claim
(snapshot → manifest → capture → persist), ran the shipped suites, and ran seven adversarial
probes that live outside the repository (`/tmp/opencode/gateg-probes/`, scratch trees under
`/home/ubuntu/.cache/gateg/`). Every probe that asserts "nothing happened" has a positive
control in the same run. Two mutations were applied to a *scratch copy* of
`packages/workspace-manager` to test assertion sensitivity; the repository was not modified
except for this file.

## Verdict

**FAIL — the core mechanism is real and the headline attack is genuinely closed, but two
agent-reachable paths break the boundary this gate exists to establish, and a third deletes
evidence after the fact.**

What is verified, and is the hardest part of this commit: the authority is now a host walk.
Staging, a `clean` filter, a commit, `textconv`, an external diff and a hook all leave
`git diff` empty or lying, and none of them moves the manifest. I measured each of those
against a live git binary with a positive control, not by reading comments. That is a real
improvement over the previous evidence path and it should not be lost in the verdict.

The verdict is FAIL because the walk is not contained and the evidence is not undeletable:

1. **`.git/hooks` as a directory symlink escapes the tree.** `readGitMetadata` calls
   `readdir(join(gitPath, 'hooks'))` (`snapshot.ts:359`) and then `lstat`s and hashes each
   name; `isContained` (`snapshot.ts:368`) is lexical, so `<root>/.git/hooks/<anything>`
   passes. Measured: `.git/hooks -> /etc` produced 98 hook entries with the SHA-256 of
   `/etc/passwd`; `.git/hooks -> <outside dir>` hashed files outside the workspace. The
   agent can create that symlink inside its own checkout. The same swap during a run
   produces **zero change rows** (`changeCount: 0`, `complete: true`) because the
   manifest compares `entries` only and `.git` is excluded from `entries` — the only trace
   is that the two side digests differ.
2. **One `chmod 000` directory deletes the manifest, and the task still succeeds.**
   `captureFinalEvidence` catches the `EACCES` from `readdir` and returns `null`
   (`evidence.ts:256-266`); `attachEvidence` then returns the adapter's result unchanged
   (`execute-agent.ts:497`), `finalStatus` stays `succeeded` (`:968-984`). Measured: initial
   snapshot present, final snapshot file never written, no manifest, no artifact row, one
   warning log. The agent does not have to forge the evidence — it only has to make its own
   report impossible to produce.
3. **The reaper deletes `evidence/` after preserving artifacts.** `reaper.ts:497` calls
   `reclaimWorkspace({ keepArtifacts: !artifactsPreserved })`; with `false`,
   `evidencePresent` is gated off (`reclaim.ts:212`) and the whole directory is removed
   (`reclaim.ts:220`). Measured: `removed: true`, `evidenceKept: false`, directory gone —
   while the `Artifact` row keeps `authoritative: true` and a `uri` that can never be read
   again. This directly contradicts the comment added in this commit at `reclaim.ts:203-214`.

So: **the bytes on disk are now authority; the definition of which bytes are looked at, and
whether a report exists at all, is still the agent's.**

| Question | Answer |
|---|---|
| Is the staging/filter/commit attack closed? | **Yes.** Verified with live git and positive controls. |
| Does the walk stay inside the workspace? | **No.** `.git/hooks` directory symlink; also a race on the final component. |
| Can the agent suppress its own manifest? | **Yes**, with one unreadable directory; the task still reports success. |
| Does evidence survive cleanup? | **Normal cleanup yes; the reaper no.** |
| Is the Git report demoted? | **Yes**, on both create and update (`persist-result.ts:301,314`). |
| Is Phase 5 regressed? | **No.** Diff touches no cgroup/isolation/volume/termination file; targeted suites green. |

## G-01…G-20 acceptance matrix

| # | Question | Verdict | Evidence |
|---|---|---|---|
| **G-01** | Git staging cannot shape authority | **PASS** | Probe §A: modified file, `git add -A`, `git diff` = **0 bytes**, staged diff 152 bytes; manifest = `modified`, `after.sha256` = SHA-256 of the on-disk bytes. Mutation M1 (comparator blind to `sha256`) makes this test fail. |
| **G-02** | Clean/smudge filter cannot execute during snapshotting | **PASS** | Probe §B: control `git diff` ran the filter (marker appeared, 150-byte diff); snapshot pair ran with the same armed config and the marker never appeared; manifest hashed `SECRET=THIRD`, the disk bytes, not the filtered text. |
| **G-03** | Hooks, external diff, textconv cannot execute during snapshotting | **PASS** | Probe §C/§D/p6b: `git commit` fired the hook (control true); `git diff --ext-diff` fired the external diff (control true); `git diff` on a binary-marked file fired textconv (`plainFired: true`, which is the exact command shape the old collector used) — and none of the three fired during a snapshot pair. |
| **G-04** | A symlink or path replacement cannot escape the workspace | **FAIL** | Root symlink → `SNAPSHOT_ROOT_INVALID`; entry symlinks (`..`, absolute, chain, `../../../etc/passwd`) recorded and never followed; `/etc/passwd` digest absent from `entries`. **But** `.git/hooks -> /etc` produced 98 `git.hooks` entries including `/etc/passwd`'s SHA-256 (probe §I/§J). Containment is lexical and a parent component is not checked. |
| **G-05** | A file cannot change during capture without detection | **FAIL** | Probe §Q: 96 MiB file rewritten in place, same size, during the walk → `complete: true`, `stopReason: null`, and the recorded SHA-256 is **neither** the original nor the final content. The size comparison at `snapshot.ts:564` cannot see a same-size rewrite. Design doc line 51-54 claims the mechanism covers "a file can change between `lstat` and `readFile`"; it covers only the size-changing case. Secondary, reasoned: `digestFile` opens by path (`snapshot.ts:213`) after `lstat` (`:504`) with no `O_NOFOLLOW` and no `fstat`/dev-ino comparison, so a file swapped to a symlink in that window is read through; a swap to a FIFO blocks. Not reproduced (race), marked as such. |
| **G-06** | The final snapshot cannot occur while an agent process is active | **PASS** (caveat) | `execute-agent.ts:756` runs after `runtime.execute` resolves; `killCgroup` at `:931` is **after** the snapshot, so the guarantee is not the cgroup. It is `--unshare-pid` in `buildSandboxCommand` (`sandbox.ts:322`, unconditional) plus `--die-with-parent`: when pid 1 (bwrap) exits, the kernel kills the namespace, so the tree really is gone. `opencode-cli` has no unsandboxed fallback (comment `:95`). Caveat: the evidence code *assumes* the runtime is sandboxed; nothing asserts that linkage, so a future non-sandboxed adapter would inherit a false guarantee. |
| **G-07** | Evidence cannot be persisted before the initial snapshot exists | **PASS** | `captureFinalEvidence` returns `null` when `initial === null` (`evidence.ts:219-223`); `attachEvidence` then omits `evidence`; `persistResult` only writes evidence from `result.evidence` (`persist-result.ts:355`). The ordering is structural, not comment-enforced. |
| **G-08** | Cleanup cannot happen before final evidence is durable | **PARTIAL** | Normal path: snapshot files are written before the `finally`, and `cleanup({ keepArtifacts: true })` preserves `evidence/` (`workspace.ts:258`, `manager.ts:633`) — verified by the shipped lifecycle test and by probe §N's initial path. Reaper path: `reaper.ts:497` passes `keepArtifacts: !artifactsPreserved`, so after a successful artifact preservation the evidence is deleted (probe §p7: `removed: true`, `evidenceKept: false`). Authority rows outlive their bytes. |
| **G-09** | A client or the agent cannot mark its own artifact authoritative | **PASS** | Only two writes to `Artifact.authoritative`: `persist-result.ts:301/314` (git report, hard `false`) and `:359/376` (host manifest, `evidence.authoritative && workspaceId !== null`). `candidate` is gone: no occurrence in `persist-result.ts`; the parent's `result.providerMeta['workspaceId']` read is absent (`git show 58476b0:…/persist-result.ts:136,334`). Derivation is `executionWorkspaceIdFor(run.id, attempt.attemptNumber)` scoped by `orgId` + `taskId` (`:508`). `providerMeta.workspaceId` is now written by the worker for display (`execute-agent.ts:832-834`) and never read as authority. `result.artifacts` naming `change-manifest` is refused (`:267`). The adapter cannot set `evidence` at all: `ExecutionResult` is `.strict()` and `attachEvidence` is the only writer. |
| **G-10** | An artifact cannot be replayed across tenants, tasks or attempts | **PARTIAL** | IDs include `taskId` (`ids.ts:75-81`); API reads are `(id, orgId)` (`artifacts.service.ts:133-136`, `:31` comment). Content-addressing is intentional. Two gaps: (a) IDs omit `orgId`, so a `Task.id` collision across tenants would make the `upsert({ where: { id } })` update another org's row — unreachable in practice because `Task.id` is a server-generated UUID (`schema.prisma:252`), but the safety depends on that; (b) the attempt binding is the **newest** attempt of the **newest** run (`persist-result.ts:120-140`), not the execution in context, so a delayed persist can bind a manifest to a later attempt's `workspaceId`/`attemptId`. Requires overlapping attempts/runs; pre-existing shape, inherited by the evidence columns. |
| **G-11** | A malformed or truncated manifest cannot pass verification | **PARTIAL** | Probe §S: truncated body refused (size), one flipped byte refused (hash), bounded manifest → `complete: false` → `authoritative: false` (probe §P; `evidence.ts:242`; `persist-result.ts:359`). But `verifyManifestFile` never parses the body: a body that says `complete: false` with an envelope claiming `authoritative: true` and a correct checksum **passes** (`selfConsistentContradiction: null`). `authoritative` is asserted by the writer, not re-derived at the boundary; the manifest is also never compared against `ExecutionWorkspace.initialManifestDigest`, so it is not bound to the row it claims to describe. Not agent-reachable today (only the worker writes the envelope), so this is hardening, not an exploit. |
| **G-12** | Legacy artifacts cannot be mistaken for authoritative | **PASS** | Migration is additive, `authoritative BOOLEAN NOT NULL DEFAULT false`, no back-fill; `evidenceSource`/`manifestDigest` nullable and reported verbatim (`artifact-summary.ts:63-69`); the legacy test asserts `evidenceSource: null`, `authoritative: false` (`evidence-provenance.test.ts:399-423`), and the summary test covers a row that predates the columns. Nothing infers provenance from `kind`. |
| **G-13** | A failure path cannot silently produce a successful task state | **FAIL** | Probe §N: `chmod 000` on one directory inside the repo → `captureFinalEvidence` returns `null`, no `final-snapshot.json`, no manifest, no artifact; `finalStatus` remains `succeeded` and `workspaceOutcome` is `completed`. The same happens on ENOSPC/IO error during evidence writing. The design intent ("evidence bookkeeping must not fail a run") is defensible, but it means the agent chooses whether evidence exists, and absence is not escalated anywhere. Contrast: an integrity failure at persist *does* fail the task (`persist-result.ts:96-105`), so the two failure modes are asymmetric — a manifest that is absent is fine, a manifest that is present-but-wrong is fatal. |
| **G-14** | The trust boundary is not overstated | **PASS** (with one inaccurate comment) | The design doc is honest: "This is not isolation… the same-UID worker compromise remains open" (`TRUSTED-SNAPSHOT-DESIGN.md:115-116`), and the phase docs already record same-UID. `evidence/` invisibility is a mount-table property, and the isolation test states the tmpfs caveat rather than claiming UID separation. Inaccurate: `snapshot.ts:30-31` says files under `packages/workspace-manager/src` "may not import `child_process` at all", but `manager.ts:1` does and is allowlisted (`eslint.config.mjs:36-40`). The rule is real; the sentence is wrong. |
| **G-15** | Phase 3–6 findings still hold | **PASS** | Diff touches no `cgroup.ts`, `termination.ts`, `sandbox.ts`, volumes, isolation or CPU-budget file (empty `--stat`). The only deletions in `execute-agent.ts` are the three `return` expressions being wrapped in `attachEvidence`; no gate logic removed. Phase 5 targeted suites: 23 passed, 4 skipped (the host-limited cgroup/io tests, unchanged). |
| **G-16** | The staging test fails on the pre-fix behaviour | **PASS** | Measured, not reasoned: in the staging scenario `git diff` is 0 bytes and `git diff --cached` is 152 bytes, i.e. the pre-fix collector's evidence for a fully rewritten tree was "nothing". Mutation M1 on a scratch copy (comparator ignores `sha256`) fails the staging, clean-filter, commit and hostile tests (8 failures). Mutation M2 (`complete: true` unconditionally) fails exactly the two bounded-manifest tests. Mutation M3 (follow symlinks) fails the symlink test and the hostile `/etc/passwd` assertion. |
| **G-17** | The provenance test fails on the pre-fix code | **PASS** (reasoned) | Parent code: `candidate: result.providerMeta?.['workspaceId']` and `findFirst({ id: candidate, orgId, taskId })` (`git show 58476b0:apps/worker/src/activities/persist-result.ts:136,334-337`). The test provisions the sibling as a **real** `ExecutionWorkspace` row in the same org and task (`evidence-provenance.test.ts:191-215`), so the parent predicate would return it and `expect(manifest.workspaceId).toBe(own.workspaceId)` would fail. Not executed against the old code because that requires editing the tree; the parent source and the fixture are quoted so the conclusion does not rest on inference. |
| **G-18** | No assertion weakened, no test skipped-as-passed, no retry added | **PASS** | `git diff --numstat` shows **0 deleted lines** in every test file; `reclaim.test.ts` is additive only. No `.only`, no `it.fails`, no retry config in the diff. One new gated suite (`evidence-capture-points.test.ts:189`, `skipIf(!temporalEnabled)`) **ran and passed** on this host (Temporal available). The 12 worker skips are the pre-existing set. |
| **G-19** | Suites, types and lint are green | **PASS** | `packages/workspace-manager` 131/131; `apps/worker` 266 passed / 12 skipped; `apps/api/src` 29/29; phase-5 targeted 23 passed / 4 skipped; `tsc -p packages/workspace-manager` clean; `eslint` clean on all changed source. |
| **G-20** | The gate's own claim: the agent no longer authors the evidence used to judge it | **FAIL** | True for *content* of a manifest that exists: staging, filters, hooks and commits cannot move it. False for *existence* (G-13) and for *what is read* (G-04). An agent can both leave the change list empty while making the host walk read `/etc`, and remove the manifest entirely while the task reports success. Both are the inversion this gate was written to remove, in a narrower form. |

## New findings

### F-G1 — High — `.git/hooks` can be a symlink to any directory, and the walk reads through it

`packages/workspace-manager/src/snapshot.ts:358-405`.

`readdir(join(gitPath, 'hooks'))` follows a symlinked hooks directory. Each name is then
turned into `<root>/.git/hooks/<name>` and checked with `isContained`, which is lexical
(`:431-433`), so the path is always "inside" the root even when the parent is a link to
`/etc`. `statOrUndefined` (`:375`) then `lstat`s the target and `digestFile` (`:389`) hashes
it.

Reproduction (probe §I/§J, `/tmp/opencode/gateg-probes/p2-paths.mts`):

```
rm -rf .git/hooks && ln -s /etc .git/hooks     # agent, inside its own checkout
takeWorkspaceSnapshot(repo)
→ hooks: 98 entries, first: ['.pwd.lock', '.resolv.conf.systemd-resolved.bak', ...]
→ hooks['passwd'].sha256 === sha256(readFile('/etc/passwd'))   true
```

Impact:

- **Boundary violation and a hash oracle.** The manifest digest covers `git.hooks`
  (`serialiseSnapshot` → `git.hooks[].sha256`), so the artifact `checksum` returned to the
  tenant depends on the SHA-256 of arbitrary readable host files. A tenant that can guess a
  file's exact content can confirm the guess by predicting the checksum. No raw content is
  returned, but "never read outside the tree" is false.
- **Availability.** There is no aggregate byte budget for hooks (`GIT_METADATA_MAX_BYTES`
  is per file, 256 MiB; `MAX_HOOKS` is 1,024). `.git/hooks -> /usr` makes one snapshot hash
  up to 1,024 files of up to 256 MiB each, twice per attempt.
- **Silence.** A mid-run swap produces `changeCount: 0`, `complete: true` (probe §R):
  `.git` is excluded from `entries`, and `buildChangeManifest` compares only `entries`
  (`manifest.ts:181-216`). The only trace is that `initial.digest !== final.digest` with no
  row explaining why.

Fix: `lstat` the hooks directory; if it is a symlink or not a directory, record that fact
and do not enumerate. Equivalently, open it with `O_DIRECTORY | O_NOFOLLOW` and `readdir`
the fd. Add `git` metadata (config/index/hooks digests) to the manifest as an explicit
`git_changed` row so a swap is visible rather than inferred from a digest inequality. Give
git metadata an aggregate byte budget. The regression test should be the probe above: a
`.git/hooks` symlink to a directory containing a known file must either throw or record the
link, and the file's digest must appear nowhere.

### F-G2 — High — one unreadable directory suppresses the manifest, and the task still succeeds

`apps/worker/src/activities/evidence.ts:256-266`, `apps/worker/src/activities/execute-agent.ts:497,755-765,968-993`.

`takeWorkspaceSnapshot` propagates `EACCES` from `readdir` (only `ENOENT` is treated as
`unreadable`), `captureFinalEvidence` catches everything and returns `null`, and the success
path then attaches nothing. Measured (probe §N, `/tmp/opencode/gateg-probes/p4-corrected.mts`):

```
mkdir hidden && chmod 000 hidden
captureInitialEvidence → present
captureFinalEvidence   → null   (warn: "Final workspace snapshot failed…")
evidence/final-snapshot.json    → absent
task status                     → succeeded, workspace outcome completed
```

The same shape is reachable through ENOSPC while writing the snapshot file, or any I/O
error. The agent cannot forge the report, but it can delete it — and "no manifest" is
indistinguishable to a reviewer from "the agent made no changes" unless they know to look
for absence.

Fix: treat an agent-caused capture failure as a first-class outcome. Minimum: record a
`evidence_unavailable` reason on the attempt/workspace row and force `authoritative: false`
with an explicit absence marker, so the API can render "evidence missing" rather than an
empty list. Better: fail the attempt closed when the *final* snapshot cannot be taken for a
reason other than the workspace being absent, because at that point the run cannot be
reviewed. A `chmod 000` inside the repo is not an infrastructure fault; it is the agent
choosing not to be measured.

### F-G3 — Medium — the reaper deletes `evidence/` after preserving artifacts, leaving dangling authority

`apps/worker/src/reaper.ts:497` (and the second pass at `:736`), `packages/workspace-manager/src/reclaim.ts:203-220`.

`preserveArtifacts` copies only `artifacts/` (`reclaim.ts:256-264`). The reaper then calls
`reclaimWorkspace({ keepArtifacts: !artifactsPreserved })`; when preservation succeeded this
is `false`, so `evidencePresent` is forced false and the else branch removes the whole
workspace directory, evidence included. Measured (probe §p7):

```
{ removed: true, artifactsKept: false, evidenceKept: false, directoryAfter: null }
```

The `Artifact` row keeps `authoritative: true`, `evidenceSource: 'host-snapshot'` and a
`uri` under the deleted directory; `summariseArtifact` will report integrity `missing`.
This is exactly the outcome the new comment at `reclaim.ts:203-214` says must not happen
("a digest pointing at bytes nothing can produce again"), contradicted by the only
unattended caller. It also means a worker death mid-run — the case the reaper exists for —
destroys the one artifact that could have explained the run.

Fix: `preserveArtifacts` should copy `evidence/` beside `artifacts/` (or the reaper should
pass `keepArtifacts: true` and remove `repo/` itself), and the reaper should not delete a
workspace whose `finalManifestDigest` is set until the manifest bytes are durable somewhere
else. Add a test that runs the **reaper** path over a workspace with evidence and asserts
`evidenceKept: true`; the current lifecycle test covers `cleanup`, not `reclaim`.

### F-G4 — Medium — a same-size rewrite during capture yields a silently mixed digest

`packages/workspace-manager/src/snapshot.ts:207-234,504-567`; claim in `TRUSTED-SNAPSHOT-DESIGN.md:49-54`.

The only stability signal is `digest.sizeBytes !== stat.size` (`:564`). A writer that
rewrites bytes in place without changing the length produces a digest of a state that never
existed, with `complete: true`. Measured (probe §Q, 96 MiB file, paced writer):

```
complete: true, stopReason: null
recorded sha: e039ca72…   (neither the original e0cc8db8… nor the final cdd1e9d7…)
```

Impact is bounded — it cannot make a changed file look unchanged relative to the baseline,
and a later re-walk detects the mismatch (the shipped test at `hostile-repository.test.ts:269`
shows that). But the manifest then carries an `after` fingerprint that is not true of any
instant, and the design doc's consistency paragraph overstates what the size check covers.

Fix: after opening, `fstat` the fd and compare `dev`, `ino`, `size` and `mtimeNs` with the
`lstat` result; hash from the fd. Re-`lstat` after hashing and compare again. That closes
both the same-size rewrite and the `lstat`→`open` symlink swap, and it is the same change
that fixes F-G5. If that is too strong a guarantee to buy, the doc should say "a size change
is detected; a same-size rewrite is not".

### F-G5 — Medium (race-dependent) — `lstat` then `open` by path: no `O_NOFOLLOW`, no identity check

`packages/workspace-manager/src/snapshot.ts:213` (`createReadStream(absolute)`), `:504` (`lstat`), `:556`.

Between the `lstat` that classifies an entry as a regular file and the `open` that hashes it,
the entry can be replaced by a symlink. `createReadStream` follows it, so the walk reads
outside the tree; if the target's size equals the `lstat` size, `:564` sees no instability
and records the target's digest. A swap to a FIFO blocks the read (the FIFO classification
only helps if the FIFO is there at `lstat` time). I did not win the race in a controlled
probe, so this is a code-level finding, not a demonstrated exploit; it is the same class as
F-G1 and the fix is the same `open`-with-`O_NOFOLLOW` + `fstat` pattern.

### F-G6 — Low — `verifyManifestFile` verifies self-consistency, not meaning or provenance

`apps/worker/src/activities/evidence.ts:109-141`.

It checks `checksum === manifestDigest`, the file's length, and the file's hash. It never
parses the body, so `complete`/`changeCount`/`changes` are not re-derived; and it never
compares `initialManifestDigest` with the `ExecutionWorkspace.initialManifestDigest` the
worker wrote *before* the run, so the manifest is not bound to the row it describes.
Measured (probe §S): a body rewritten to `complete: false`, `changeCount: 0`, `changes: []`,
re-hashed and presented with a matching envelope, returns `null` ("verified").

Not agent-reachable — `result.evidence` is worker-authored and `ExecutionResult` is strict —
so this is a hardening item, not a bypass. Fix: parse with a schema, re-derive
`manifestDigest`, require `body.complete === envelope.authoritative`, require
`body.initial.digest === repositoryRow.initialManifestDigest`, and require
`body.final.digest === envelope.finalManifestDigest`. All four are cheap and turn "the
writer said so" into "the record agrees".

### F-G7 — Low — `.git` metadata changes never appear as a change row

`packages/workspace-manager/src/manifest.ts:181-232`; `TRUSTED-SNAPSHOT-DESIGN.md:23-25`.

`buildChangeManifest` compares `entries` only; `.git` is excluded from `entries` by design
(`snapshot.ts:483`). So a rewritten `.git/config`, a replaced index or a hooks change moves
`initial.digest`/`final.digest` but produces no row. Probe §R measured `changeCount: 0` for a
run in which `.git/hooks` was entirely replaced. The design says the digest "covers it" —
true, but a reader of the change list is told nothing, and no field says "git metadata
changed". Add an explicit `git` comparison to the manifest (before/after config/index/hook
digests, plus a boolean) so this is a row rather than an inference.

### F-G8 — Low — documentation overstates two properties

- `snapshot.ts:29-31`: "files under `packages/workspace-manager/src` may not import
  `child_process` at all". `manager.ts:1` imports `execFile` and is on the allowlist
  (`eslint.config.mjs:36-40`). The rule is scoped to the spawn boundary, not the package.
- `TRUSTED-SNAPSHOT-DESIGN.md:33`: "Lexical containment … on every directory **and** every
  entry; throws `SNAPSHOT_PATH_ESCAPE`". It is checked on every path string, but a parent
  component that is a symlink is not a path string that can fail the check (F-G1). The table
  row should say "lexical containment of every path string; parent symlinks are refused only
  for the root and for the final component".

### F-G9 — Informational — evidence is bound to the newest attempt, not the one that produced it

`apps/worker/src/activities/persist-result.ts:120-140,161-166`. Both the run and the attempt
are resolved as "newest for this task", not from the execution identity in context, and
`EvidenceSummary` carries no attempt id with which to cross-check. With overlapping
attempts/runs a delayed persist can write a manifest that describes attempt *N*'s tree with
attempt *N+1*'s `attemptId`/`workspaceId`. The one-live-workflow invariant makes this hard to
reach; it is listed because the commit's comment ("the attempt row the worker opened") is
stronger than the code.

### F-G10 — Informational — content-addressed IDs omit `orgId`

`apps/worker/src/activities/ids.ts:75-81`. `artifactIdFor(taskId, kind, checksum)` and
`evidenceIdFor(...)` are scoped by task only. The upsert matches on `id`, so a cross-tenant
`Task.id` collision would update another organisation's row. `Task.id` is a server-generated
UUID (`schema.prisma:252`), so this is not reachable; adding `orgId` to the derivation would
remove the dependence on that fact.

## Regression, sensitivity and test integrity

**Phase 3–6 (G-15).** The diff modifies 37 files, all evidence/claim/workspace/docs. `git
diff --stat` for `cgroup.ts`, `termination.ts`, `sandbox.ts`, volumes and isolation is
empty. The only removed lines in `execute-agent.ts` are the three return expressions now
wrapped by `attachEvidence`; no condition, threshold or ordering in the resource path
changed. Phase 5 targeted suites: 23 passed, 4 skipped (host-limited), same as before.

**Sensitivity (G-16/G-17).** Three mutations on a scratch copy of the workspace-manager
package, each run against the shipped tests:

| Mutation | Result |
|---|---|
| `compareEntry` blind to `sha256` | **8 failed**, including staged change, clean filter, committed change, hostile repository |
| `manifest.complete` always `true` | **2 failed**: change cap, bounded snapshot |
| `classify` treats symlinks as files | **3 failed**: symlink recorded-not-followed, hostile repository, post-manifest modification |

The provenance test's pre-fix sensitivity is established from the parent source
(`git show 58476b0:…:136,334-337`) plus the fixture's real sibling row, not by executing the
old code.

**Test integrity (G-18).** `--numstat` shows zero deleted test lines. No `.only`, no
`it.fails`, no retry added. The one new gated suite executed here and passed. Nothing was
bent to pass.

## What Gate G does not establish

1. **Authenticity.** No signing key, no signature, no MAC. A compromised worker (same UID)
   can write any manifest it likes; the digest only proves the bytes did not change after
   the worker wrote them.
2. **Containment of the walk.** `.git/hooks` is a directory symlink away from reading
   arbitrary host paths (F-G1), and the final component is raceable (F-G5).
3. **That evidence exists.** One unreadable directory suppresses it (F-G2).
4. **That evidence survives.** The reaper deletes it (F-G3).
5. **History.** Endpoints only; a change made and reverted within the run is invisible.
6. **Content pre-image.** Hashes, not old bytes; a display patch cannot be derived.
7. **That anything enforces `authoritative`.** No approval path reads the column; the gate
   records provenance but no consumer refuses an approval on a missing or non-authoritative
   manifest. The field is currently descriptive.
8. **Cross-attempt accumulation.** Each attempt's baseline is the tree it inherited, so an
   earlier attempt's changes are "pre-existing" by construction; the approver must read every
   attempt, and nothing tells them to.
9. **That a non-sandboxed adapter would be safe.** G-06 depends on `--unshare-pid`, not on
   the evidence code.
10. **VM isolation.** Unchanged by this commit; the design doc says so.

## What I would refuse to ship

1. **The sentence "the walk cannot leave the tree"** while `.git/hooks` is a symlink hole
   (F-G1). Either fix the enumeration or strike the claim; a boundary statement that is
   false in one reachable case is worse than a narrower true one.
2. **The sentence "the agent cannot control the evidence used to judge it"** while one
   `chmod 000` directory deletes the manifest and the task reports success (F-G2). The
   correct claim today is "the agent cannot *forge* the content of a manifest that exists".
3. **The reaper deleting `evidence/` while the row keeps `authoritative: true` and a dead
   URI** (F-G3). This is a data-loss bug in the one path that runs when nobody is watching.
4. **"The final snapshot is the tree as the agent left it"** while a same-size concurrent
   write can produce a digest of a state that never existed and still say `complete: true`
   (F-G4), and while the doc claims the size check covers mid-read changes.

I would **not** refuse the commit for F-G6…F-G10: none makes a gate statement untrue that
is not already listed above, all are cheap hardening, and they are recorded with concrete
fixes.

## Test and probe evidence gathered during this addendum

| Item | Command / artefact | Result |
|---|---|---|
| workspace-manager suite | `npx vitest run packages/workspace-manager/test` | **131 passed** |
| worker suite | `npx vitest run apps/worker/test` | **266 passed, 12 skipped** |
| api unit | `npx vitest run apps/api/src` | **29 passed** |
| phase-5 targeted | `isolation-gate`, `cpu-budget`, `volumes`, `io-limits` | **23 passed, 4 skipped** |
| typecheck | `tsc --noEmit -p packages/workspace-manager/tsconfig.json` | clean |
| lint | `eslint` on every changed source file | clean |
| §A staging | `/tmp/opencode/gateg-probes/p1-git-cannot-shape.mts` | `git diff` 0 B, staged 152 B, manifest `modified`, on-disk sha |
| §B clean filter | same | control marker **true**, snapshot marker **false**, on-disk sha |
| §C external diff / textconv | same + `p6b-textconv.mts` | controls **true**, snapshot markers **false** |
| §D hooks | same | control (commit) **true**, snapshot **false** |
| §E symlink root | `p2-paths.mts` | `SNAPSHOT_ROOT_INVALID` |
| §F entry symlinks | same | recorded, not followed, `/etc/passwd` digest absent |
| §I `.git/hooks -> outside` | same | **hashed outside file** (`loot.txt` digest matches) |
| §J `.git/hooks -> /etc` | same | **98 entries, `/etc/passwd` digest matches** |
| §K `.git/config -> /etc/passwd` | same | recorded as `symlink:/etc/passwd`, not read |
| §L `.git -> other repo` | same | not followed, kind `file`, `head`/`config` null |
| §M dir -> symlink | same | not descended |
| §N evidence suppression | `p4-corrected.mts` | initial present, **final `null`**, snapshot file absent |
| §O unreadable file | same | `complete: false`, `stopReason: unreadable` (honest) |
| §P bounded manifests | same | `maxChanges` → `complete: false`; bounded initial → `initial-incomplete`, `authoritative: false` |
| §Q same-size rewrite | same | `complete: true`, digest **neither** endpoint |
| §R `.git` swap mid-run | `p5-verify.mts` | **`changeCount: 0`**, `complete: true`, digests differ |
| §S verify | same | truncated/edited refused; **body/envelope contradiction accepted** |
| §p7 reaper | `p7-reaper.mts` | `removed: true`, **`evidenceKept: false`**, directory gone |
| mutation M1/M2/M3 | scratch copy `/home/ubuntu/.cache/gateg/mut` | 8 / 2 / 3 targeted failures |

Verification status: **verified** for every command and probe result quoted here. The one
finding marked race-dependent (F-G5) is explicitly reasoned from `snapshot.ts:213,504,556`
and was not reproduced; F-G9 is reasoned from `persist-result.ts:120-166`.

# Addendum — SEC-606 Gate G re-review of `cfc1f26`

**Commit reviewed:** `cfc1f26cd4600a96fd2aa7722f128e4988a7cecf`
**Parent:** `9461d2773a2902dee91d0f36a22977356548c01e`
**Branch:** `phase-6/trust-boundary-closure`
**Reviewer:** Security Architect (independent; did not author this commit)
**Date:** 2026-11-15
**Method:** re-ran every attack from SEC-605 against the new tree, then attacked the fixes
themselves; ran the full suite, the API e2e suite, typecheck and lint; ran eleven probes
outside the repository (`/home/ubuntu/.cache/sec606/probes/`, scratch trees under
`/home/ubuntu/.cache/sec606/scratch-*`); and ran a seven-mutation study on a scratch copy
of the tree (`/home/ubuntu/.cache/sec606/mut`, built with `git archive HEAD` + copied
`node_modules`) to measure whether the new tests fail when each fix is reverted. The
repository was not modified except for this file; `git status --porcelain` is empty before
and after.

## Verdict

**FAIL — narrower than round 1, and for a different reason.**

Both Highs are genuinely closed, and I could not reopen either. `.git/hooks -> /etc` now
records the link and reads nothing from `/etc` (0 entries, no `/etc` digest anywhere in the
snapshot or the manifest, with a real-hooks positive control producing the exact hook
digest). `chmod 000` now fails the attempt with `EVIDENCE_MISSING`, writes an
`attempt.evidence_failed.v1` bound to the attempt, creates no authoritative artifact, and
the task ends `failed`; a complete run still succeeds, and a runtime with no workspace still
legitimately produces nothing. F-G3's measured failure is fixed: the reaper now keeps
`evidence/` beside the artifact copy and the URI stays readable.

The verdict is still FAIL because:

1. **A High the commit does not touch: `.git` is excluded at every depth, but only the root
   `.git` is described.** `sub/.git/` is walked past — not in `entries`, not in
   `git`, not in the manifest — and I measured an agent write into it producing
   `changeCount: 0`, `complete: true`, `authoritative: true`, with the digest identical to
   the baseline. That is a silent, deterministic, persistent place to put arbitrary content
   that the evidence never describes. It defeats the gate's product for that content
   without a race, a forgery, or a broken assumption. The design doc says the opposite
   (`.git` "at any depth … recorded as metadata instead"), which is true only at the root.
2. **The one residual they chose to document instead of fix has a false bound.** The doc says
   the same-size rewrite "cannot make a changed file look unchanged *relative to the
   baseline*". I measured exactly that: a same-size in-place write into an already-read
   region, with `mtime` restored at nanosecond precision, produced `complete: true`, a final
   digest **equal to the baseline digest**, `changeCount: 0`, and an authoritative manifest
   — while the file on disk differed. `ctime` changes and is available in the same `Stats`;
   it is not compared.
3. **Two more documented statements are false** (parent-swap detection, nested `.git`
   metadata), which is what G-14 exists to catch, and I failed `9461d27` partly on exactly
   this ground. A gate whose deliverable is an honest evidence claim cannot ship a
   guarantee it does not provide.
4. **The agent can still choose whether its evidence is authoritative and still succeed.**
   One `truncate` to 9 GiB (`final-incomplete`) or one file whose name is not valid UTF-8
   (`unreadable`) makes the manifest non-authoritative, records no failure, and leaves the
   task `succeeded`. F-G2 closed *absence*; it did not close *uselessness*. The difference
   from F-G2 is one boolean that no consumer refuses on.

| Question | Answer |
|---|---|
| Is `.git/hooks -> /etc` closed? | **Yes.** 0 hook entries, target recorded, no `/etc` digest in snapshot or manifest; real-hooks control passes. |
| Can any `.git` metadata path still produce a foreign hash? | **No.** `.git` link, `.git` gitfile, `.git` gitfile → `/etc/passwd`, `.git/HEAD`, `config`, `index`, a symlinked hook entry: all recorded as `symlink:`/pointer text, none read through. |
| Is `chmod 000` closed? | **Yes.** attempt `failed`, `EVIDENCE_MISSING`, event bound to the attempt, 0 authoritative artifacts, task `failed`; complete-run and no-workspace controls pass. |
| Is the reaper's evidence deletion closed? | **Yes for the measured path.** Evidence survives, URI readable, row stays authoritative; out-of-band loss is demoted with an event. The guard is not an invariant (F-G16). |
| Can the agent hide a change? | **Yes**, three ways: nested `.git` (silent), non-UTF-8 filename (labelled incomplete), and a live writer during capture (the documented residual). |
| Is the walk contained? | **For persistent structures, yes.** The parent-swap window the doc admits is real and I reproduced it; it is not detected by the identity check, contrary to the doc's sentence. |
| Does `verifyManifestFile` bind the change list? | **No, as the implementer says.** It binds the two snapshot digests to `ExecutionWorkspace`; a forged change list with genuine anchors is accepted. |
| Are the six git attacks still closed? | **Yes**, each re-measured with a firing control. |
| Is the new test suite sensitive? | **Yes**, seven for seven: reverting each fix makes its test fail, and the controls stay green. |
| Is Phase 3–6 regressed? | **No.** 899/15/84, 97 e2e, 72 claim/boundary/identity, 23 phase-5, lint 0, typecheck 0. |

## 1. F-G1 — the escape is closed; the record is not surfaced

Re-run on a scratch repository, `takeWorkspaceSnapshot` + `buildChangeManifest`:

| Probe | Result |
|---|---|
| **A** `.git/hooks -> /etc` | `hooks: []`, `hooksDirectoryLinkTarget: "/etc"`, `complete: true`, `oversize: []`; `/etc/passwd` SHA-256 in snapshot **false**, in manifest **false**; no `root:x:0:0`; manifest body `complete: true` |
| **B** positive control, real hooks dir + `pre-commit` | 15 entries; `pre-commit.sha256` equals the file's SHA-256 exactly; `hooksDirectoryLinkTarget: null` |
| **C** `.git -> <outside git dir>` | `kind: "file"`, `head/config/index: null`, `gitfileSha256 = sha256("symlink:<target>")`, marker content absent |
| **D** `.git` as a gitfile `gitdir: /etc/passwd` | pointer text hashed, target not opened, `/etc/passwd` digest absent |
| **D2** `.git` as a 1 MiB non-pointer | `gitfileSha256: null`, `oversize: [".git"]`, `complete: false`, `stopReason: "unreadable"` |
| **E** `.git -> /etc/passwd` (link to a file) | recorded as `symlink:`, no digest, no `root:` prefix |
| **F** `.git/HEAD`, `config`, `index` each `-> /etc/passwd` | `head: null`; `config`/`index` = `sha256("symlink:/etc/passwd")`; no `/etc` digest, no `root:x:0:0` |
| **G** hook entry `passwd -> /etc/passwd` inside a real hooks dir | `{name:"passwd", kind:"symlink", sha256: sha256("symlink:/etc/passwd")}` — recorded, not read |
| **H** hook entry that is a directory / a FIFO | silently absent from `hooks` (no `special`/`dir` record) — cosmetic |
| **L/M** entry symlink and directory symlink in the content tree | recorded with `symlinkTarget`, never followed, `/etc` digest absent |

**The fix is the right shape.** Every enumeration now goes through `listDirectory`, which
`lstat`s before `readdir`; `.git` itself and `.git/HEAD` are read with `O_NOFOLLOW`; the
gitfile is capped. No `.git` metadata path I tried produced a foreign hash.

**Judgement on "record, don't throw".** The reasoning is sound: a throw would delete the
whole snapshot, and an attacker who can choose between "evidence that mentions me" and "no
evidence" will choose the latter. Recording keeps every other byte described and puts the
anomaly inside the digest, so it is *attributable* to the attempt (`ExecutionWorkspace` is
per attempt and its `initialManifestDigest` covers the field). But "visible" is only true
for someone who opens `evidence/*.json`: `EvidenceSummary` has no field for it, the artifact
summary exposes only `kind/uri/checksum/size/evidenceSource/authoritative/manifestDigest`
(`complete`/`counts` live in the manifest file, not in the row), no audit event is written,
and no log line mentions the link. The row a reviewer reads says `authoritative: true,
changeCount: 0` — indistinguishable from a clean run. That is a surfacing gap, not an escape
(F-G14).

**Residual, not fixed: `.git` metadata is outside the byte ceiling.** A 40 MiB hook left
`snapshot.totalBytes` at 2 and completed. `GIT_METADATA_MAX_BYTES` is per-file; `MAX_HOOKS`
is per-name. The bound on this is Gate D (the volume), not the snapshot; informational.

**F-G7 is unchanged.** A mid-run swap of `.git/hooks` from a real directory to `/etc`
produces `digestsDiffer: true`, `changeCount: 0`, `changes: []`, `complete: true` and
`hooksDirectoryLinkTarget: "/etc"` on the final side. The anomaly is in the digest and the
manifest body, and the change list still explains nothing; a reviewer comparing digests sees
a difference with no row. Now that the link target is canonical, the cheapest fix is a
`git_changed` row (or the `gitAnomalies` field from F-G14) rather than a new comparison.

## 2. F-G2 — absence is closed; usefulness is not

Real PostgreSQL, real Temporal, the production activity registry, the run's terminal write
composed exactly as `run-task.ts` composes it (`outcomeOf(result.status)`):

| Scenario | `result.status` | error | attempt | event bound | authoritative artifacts | task |
|---|---|---|---|---|---|---|
| agent `chmod 000` a directory it wrote | `failed` | `EVIDENCE_MISSING`, `retryable: false` | `failed` | **yes** (`code: SNAPSHOT_CAPTURE_FAILED`, `phase: final`) | **0** | **failed** |
| control: complete run | `succeeded` | — | `succeeded` | no event | **1**, `authoritative: true`, URI readable | `succeeded` |
| control: runtime with no workspace | `succeeded` | — | `succeeded` | no event | 0 (no workspace row) | `succeeded` |
| one `truncate` to 9 GiB (sparse) | `succeeded` | — | `succeeded` | no event | **0**; manifest written, `authoritative: false`, `complete: false`, `stopReason: final-incomplete`, URI readable | `succeeded` |

The first row is the finding closed, measured end to end, and the two controls are the
reason it is a measurement rather than a habit. The fourth row is new: `evidenceGap()`
returns `finalEvidenceFailure`, which is set only when the capture *throws*; a bounded walk
is not a throw, so it succeeds with `authoritative: false`. The doc calls this the correct
failure direction ("a partial answer that is labelled partial is useful"), and it is honest
— but the task still reports plain `succeeded`, and nothing refuses on the label. The
agent's cheapest attack changed from `chmod 000` (which now fails the run) to one
`truncate` (which does not). F-G13.

**"The second hole" — the propagation is fixed, the terminal write is not.** Measured:
the activity now returns `status: "failed"` while the adapter returned `succeeded`, which is
the hole the implementer describes. One layer down, `completeTaskActivity` still accepts
`status: "succeeded"` for an attempt recorded `failed` with `EVIDENCE_MISSING`: I set up
exactly that row, called `complete` with `succeeded`, it was **accepted**, and the task
became `succeeded`. So the only thing preventing a lying terminal state is that the workflow
passes `result.status`; the write itself does not cross-check the attempt it names. Low
today (one caller), but it is the same class as N4/N15 and it is the last line of defence
this finding was about. F-G18.

**The initial capture is still silent.** `captureInitialEvidence` returning `null` writes a
warning log and nothing else: no audit event, no column, no `evidence_failed` record. The
final absence is now durable; the baseline's absence is not. I could not make it
agent-reachable in this deployment (the baseline runs before `runtime.execute`, and a clone
cannot produce a `000` directory), so this is Low. F-G19.

## 3. F-G3 — the measured path is closed; the guard is not an invariant

Six reaper scenarios through the real `runReaperPass` against real rows:

| Scenario | `outcome` | `authorityRevoked` | artifact | bytes |
|---|---|---|---|---|
| artifacts preserved, evidence present | `reaped` | 0 | `authoritative: true` | **readable**; `repo/` gone, `artifacts/` gone, `evidence/` kept |
| evidence removed out of band before the pass | `reaped` | **1** | `authoritative: false` | event `artifact.authority_revoked.v1` written |
| workspace already `cleaned` (any pre-fix pass) | **not selected** | — | **`authoritative: true`** | **unreadable** |
| reclaim refuses (recorded `rootPath` mismatch) | `quarantined` | 0 | **`authoritative: true`** | **unreadable** |
| artifact URI outside the recorded `rootPath` | `reaped` | 0 | **`authoritative: true`** | unreadable (hypothetical: production URIs are built from `rootPath`) |
| evidence present, `final-snapshot.json` deleted | `reaped` | 0 | `authoritative: true` | manifest readable, snapshot gone (the manifest is self-contained) |

So: **yes, I can construct authority rows that survive with unreadable bytes** — three ways.
The honest statement of the mechanism is "on the pass that reclaims a workspace in a
non-terminal state, rows whose URI is under the recorded `rootPath` and is not readable are
demoted". The code comment says "a guard demotes **any** authority row whose bytes are
gone", and the commit says the guard addresses "bytes … removed by a pass that ran before
this fix" — but a workspace reaped before this commit is `cleaned`, which is terminal,
which `runReaperPass` excludes. The one case the comment names is precisely the case the
query cannot reach. F-G16, and a documentation defect.

Two consequences of retaining evidence in place that the commit does not state: the
evidence directory now lives for ever under `<workspaceRoot>` with no retention policy
(Gate Q is OPEN), and its survival depends on a directory nothing owns — which is why the
demotion exists at all.

## 4. F-G4 — documented, and the documented bound is false

Two measurements, both with the window held open by a 2 GiB file (the technique the shipped
F-G5 test uses: hold the window, do not race it):

| Write during the hash | `complete` | `stopReason` | recorded digest |
|---|---|---|---|
| same size, in place, `mtime` moves | false | **`unstable`** | none |
| same size, in place, `mtime` restored through the JS seconds API (δ ≈ 0.47 µs) | false | **`unstable`** | none |
| same size, in place, `mtime` restored exactly (`utimensat`, δ = 0 ns) | **true** | null | the **pre-write** content |

The after-check works, and it is a real improvement: the ordinary same-size rewrite is now
contested instead of silently hashed. The adversarial one is not, and the consequence is
worse than the doc says. Reproduced on a 1 GiB file whose first 4 KiB were rewritten to
`0x42` during the final walk, with `mtime` restored exactly:

```
baselineDigest == finalDigest     9b0a8ffd…  (identical)
complete: true   stopReason: null   changeCount: 0   no row for payload.bin
manifest.complete: true  →  Artifact.authoritative: true
on-disk first 8 bytes: [66,66,66,66,66,66,66,66]
mtime restored exactly, size unchanged, ctime changed (not compared)
```

The doc's bounding sentence — "It cannot make a changed file look unchanged *relative to
the baseline*" — is therefore **false**, and I have to correct my own record too: the SEC-605
addendum repeated that bound under F-G4's Impact. It was wrong then and it is wrong now.

Is it acceptable? Not as written. The mechanism is confined to a live writer during
capture, which the design excludes by assumption (G-06), not by code. But (a) `ctime` is in
the same `Stats` and an attacker cannot set it, so a one-line comparison closes it; (b) the
gate's only stated bound on the residual is the sentence I just falsified. Answer to the
question asked: **it reopens G-08** — not as "the walk may be inconsistent", which is now
admitted, but as "an inconsistency can be steered into a false negative", which is a
different and worse property.

## 5. F-G5 — the final component is closed; the FIFO and the parent are not

| Attempt | Result |
|---|---|
| symlink swap after `lstat` | `UnstableEntryError` (`ELOOP` from `O_NOFOLLOW`) — **closed** |
| hard link to a **different** inode, same size | `UnstableEntryError`: "inode 66305:7599761 is not the 66305:7599760 that was classified" — **closed** |
| same inode, same size, rewritten **before** the open | hashes the new bytes (a truthful digest of the moment) — not a defect |
| **swap to a FIFO** after `lstat` | `open()` **did not settle in 3 s**; POSIX says it blocks until a writer exists — the walk hangs, and with it the activity (F-G17) |
| **swap a parent directory** to a symlink after its `readdir` | measured escape, below |

The parent swap, made deterministic (2 GiB holder file; swap after the descriptor was
observed in `/proc/self/fd`):

```
entries: aaa-evil/aaa-big, aaa-evil/group, aaa-evil/hostname, aaa-evil/hosts,
         aaa-evil/os-release, aaa-evil/passwd
aaa-evil/passwd.sha256 == sha256(/etc/passwd)   true
complete: true   stopReason: null
```

A **complete, authoritative** snapshot carrying `/etc/passwd`'s, `/etc/group`'s and
`/etc/hostname`'s digests. The design doc admits the window exists, so the existence is not
a new finding — but its compensating sentence is wrong: "The identity check makes the swap
*detected* whenever the target is a different inode, which is every case except a
same-inode/same-size substitution." In a parent swap the `lstat` happens **after** the swap,
so it describes whatever the link points at and the identity check agrees by construction.
The only cases the check detects are swaps of the final component. F-G12 (documentation) and
the G-04/G-05 caveat.

## 6. F-G6 — bound to the record, not to the truth of the change list: confirmed

Constructed a real initial/final pair (2 changes), captured a genuine summary, verified it,
then rewrote the manifest body keeping both genuine snapshot digests:

| Presentation | `verifyManifestFile` |
|---|---|
| genuine summary + genuine body, correct `expected` | `null` (verified) |
| body: `changes: []`, `changeCount: 0`, **both genuine digests kept**, envelope made consistent (digest, checksum, size, count) | **`null` (accepted)** |
| body: one **fabricated** change row added, genuine digests kept, envelope consistent | **`null` (accepted)** |
| envelope `complete: false` against a body `complete: true` | refused — "body is complete=true but the summary says complete=false" |
| `expected.initialManifestDigest` wrong | refused — "the workspace recorded initial aaaa…, not 27c4…" |
| `expected: null` | accepted (no anchor) |

So the fix does what it claims: the body is parsed, the digest is re-derived with the same
canonical writer, `complete`/`authoritative` cannot contradict, and both digests are bound
to the row written before the agent existed. The change list is not re-derived from the
snapshots — nothing holds the snapshots at persist time — so a writer who controls the
manifest file can still assert any change list with genuine anchors.

**Does it matter?** Only for a writer who can write `evidence/`. The sandbox binds
`repoPath` to `/workspace` and nothing else (`sandbox.ts:312`), so `evidence/` is a sibling
the agent's mount table does not contain; the reviewer's original conclusion stands — this is
hardening against a same-UID/worker compromise (Gate A, OPEN), not an agent path. Keep it as
Informational, with one addition: `workspaceEvidenceBinding` returns `null` when the row is
missing, so a result whose workspace row was deleted is verified with no anchor at all — the
caller treats "cannot contradict" as "verified". Not reachable today (the reaper keeps rows),
worth a comment.

### F-G7…F-G10 — carried forward, none fixed and none claimed fixed

| ID | Status | Note |
|---|---|---|
| **F-G7** | **Open, Low** | `.git` changes still produce no change row (measured, case K above). Now that the link target is inside the digest this is a reporting gap, not a detection gap. |
| **F-G8** | **Superseded by F-G12** | The `child_process` sentence was corrected and is now accurate ("an allowlist over the spawn boundary, not a package-wide ban"). The containment table row still reads "lexical containment … on every directory **and** every entry", which is true of path strings and silent about parent components; the prose below the table now says the opposite, honestly. |
| **F-G9** | **Open, Informational** | `persistResult` and `workspaceEvidenceBinding` still resolve the newest run → newest attempt → derived workspace, not the execution in context; `workspaceEvidenceBinding` uses the same rule, so the check and the write agree with each other but can both describe the wrong attempt under overlapping runs. |
| **F-G10** | **Open, Informational** | `artifactIdFor`/`evidenceIdFor` still omit `orgId`; the upsert matches on `id`. Unreachable while `Task.id` is a server UUID. |

## 7. The six git attacks — re-measured, still closed

Each attack is run twice: once through the command the old collector used (the control) and
once through the snapshot pair (the measurement).

| Attack | Control | Manifest |
|---|---|---|
| staging (`git add -A`) | `git diff` **0 bytes** | `modified`, `after.sha256` = on-disk bytes, `changeCount: 1` |
| clean filter | `git diff` 0 bytes, **filter ran** (marker) | `modified`, on-disk bytes |
| commit | `git status` empty, `git diff` 0 bytes | `modified`, `changeCount: 1` |
| textconv | `git diff` 115 bytes, **textconv ran** | `modified`, on-disk bytes |
| external diff (`GIT_EXTERNAL_DIFF`) | **ran** (marker) | `modified` |
| hooks (`pre-commit`) | **ran** on `git commit` | `modified`, `changeCount: 1` |

No regression. The commit's only change in this area is `hashRegularFile` and the git
metadata reader, and neither is on the git-command path.

## 8. Phase 3–6 regression — none found

`git diff 9461d27 cfc1f26` touches six source files, all evidence/claim/workspace/docs:
`execute-agent.ts`'s changes are `let finalStatus/finalError`, the `gap` correction and the
status propagation; no condition, threshold or ordering in the cgroup, budget, volume,
isolation or termination path changed. `persist-result.ts` adds one read
(`workspaceEvidenceBinding`) before the existing verification. `reaper.ts` adds
`keepEvidence: true` and the demotion; `reclaim.ts` splits one flag into two. No
`cgroup.ts`, `termination.ts`, `sandbox.ts` or volume file is touched.

Measured: `execution-{boundary,claim,identity}` **72 passed**; `isolation-gate` **4/4
passed** including "refuses a vm profile, ends the attempt failed, and launches nothing",
"ignores forged environment claims" and "cannot be downgraded by a forged activity input
field"; `cpu-budget`/`volumes`/`io-limits` **19 passed, 4 skipped** (the pre-existing
host-limited set). The claim at the launch site, context-only identity, release semantics,
write authority, isolation, volume ownership, output cap, CPU budget and VM fail-closed all
still hold.

## 9. Test integrity — no weakening, and the new tests are sensitive

`git diff --numstat` over the test files: 477/0, 150/**1**, 157/**1**, 65/**1**, 225/0,
92/0. The three deleted lines are import rewrites (`createWorkspaceManager, evidencePath`,
`workspacePath, WorkspaceState`, `mkdir, mkdtemp, readdir, symlink, writeFile`). No `.only`,
no `it.fails`, no retry, no sleep, and the only `skipIf` is on the new F-G2 suite (no
existing assertion was made conditional). My SEC-605 addendum recorded "0 deleted lines"
for `9461d27`; this commit's diff deletes three, all import rewrites.

A test that cannot fail is not evidence, so each fix was reverted on a scratch copy of
`HEAD` and its test re-run:

| Mutation | Test file | Result |
|---|---|---|
| M1 enumerate `.git/hooks` by path again (`readdir` follows the link) | `snapshot-escape` | **1 failed / 7 passed** — the F-G1 negative |
| M2 drop `O_NOFOLLOW` + all identity checks | `snapshot-race` | **2 failed / 1 passed** — inode swap and size change |
| M3 `evidenceGap()` always `null` (pre-F-G2 behaviour) | `evidence-capture-failure` | **1 failed / 2 passed** — the failed-run test |
| M4 keep the gap, return the adapter's status unchanged | `evidence-capture-failure` | **1 failed / 2 passed** — `result.status` was `succeeded` |
| M5 `keepEvidence: !artifactsPreserved` (pre-F-G3) | `reaper` | **1 failed / 18 passed** — evidence-kept test |
| M6 stop `verifyManifestFile` after the hash check | `evidence-provenance` | **2 failed / 9 passed** — anchor and completeness refusals |
| M7 remove `revokeUnbackedAuthority` | `reaper` | **1 failed / 18 passed** — the demotion test |

Seven for seven, and in each mutant the controls stayed green, which is what makes the
failure the finding rather than a broken fixture.

One adequacy gap: `evidence-capture-failure.test.ts` is `skipIf(!temporalEnabled)`, so on a
host without Temporal all three F-G2 tests skip and nothing asserts `EVIDENCE_MISSING`.
Also, its final `complete` step composes `result.status === 'succeeded' ? 'succeeded' :
'failed'` in the test rather than calling the real workflow, so the production mapping
(`outcomeOf`) is still not exercised end to end — mild, and the same shape as N13.

## 10. The nine residuals

The only enumerated residual list in the artifacts is `TRUSTED-SNAPSHOT-DESIGN.md`'s eight
numbered limitations plus the parent-swap paragraph, which is nine. I evaluate that list;
if the implementer's list differs, the per-item reasoning below still applies to the same
properties.

| # | Residual | Accurate? | Acceptable for a gate claiming evidence authority? |
|---|---|---|---|
| 1 | Endpoints, not history | **Yes** — two snapshots, no interval | **Yes.** Stated; a reverted change is invisible by construction. |
| 2 | No content pre-image | **Yes** | **Yes.** Hashes identify, they do not reconstruct. |
| 3 | Hard links hashed twice | **Yes** — measured: a hard link to a different inode is refused by dev/ino; two names to one inode are both described | **Yes.** Paths, not inodes, is the right model here. |
| 4 | Mount crossings walked | **Yes.** The agent cannot create a mount (no `CAP_SYS_ADMIN`, no `--dev-bind` of a host path), so it is a host-configuration risk, not an agent one | **Yes**, with Gate D as the bound. |
| 5 | No rename detection | **Yes** | **Yes.** Add+delete is the honest answer. |
| 6 | Non-UTF-8 names "represented lossily rather than rejected" | **No.** Measured: one such name makes the snapshot `complete: false`, `stopReason: "unreadable"`, and the entry is absent entirely — the walk stops | **No.** The file is hidden and the whole manifest is downgraded by one `writeFile`. F-G15. |
| 7 | Same-size rewrite with `mtime` restored | Mechanism **yes**; the bound ("cannot make a changed file look unchanged relative to the baseline") **no** — measured `changeCount: 0` with the file changed | **No, as written.** Fix is one line (`ctime`), or the bound must be struck. F-G12. |
| 8 | This is not isolation / same-UID open | **Yes** | **Yes.** Stated plainly, and Gate A is OPEN in the matrix. |
| 9 | A parent directory swapped between `readdir` and `open` is not closed | Existence **yes**; the compensating claim ("detected whenever the target is a different inode") **no** — the `lstat` follows the swap, so identity agrees | **Yes as a residual**, **no as stated.** The window is only reachable with a live writer, which G-06 excludes by assumption; say so. F-G12. |

## New findings

### F-G11 — High — `.git` at any depth is excluded from the walk and described nowhere, so an agent can write arbitrary content the manifest never sees

`packages/workspace-manager/src/snapshot.ts:732` (`name === GIT_DIRECTORY` skipped at every
depth), `readGitMetadata` (`:487`) which only reads `<root>/.git`,
`TRUSTED-SNAPSHOT-DESIGN.md:41` ("`.git` excluded at any depth | skipped in the walk,
recorded as metadata instead").

Measured with a pre-existing `sub/.git` (the shape a nested repo or submodule has, and one
an agent can create on its first line of work):

```
baseline: a.txt, sub/.git/seed.txt        (sub/.git invisible)
agent writes sub/.git/payload.bin
final:  entries [a.txt, sub]              (payload invisible)
        changeCount 0, changes [], complete true, stopReason null
        before.digest === after.digest    (true)
        git metadata mentions "sub"       (false)
→ manifest complete:true → Artifact.authoritative:true
```

And from a clean baseline where the agent creates the directory itself, the change list is
`[sub added]` and nothing about what `sub` contains; `.git` inside it is not even listed as
a directory.

Impact: the workspace tree is the evidence; a directory the agent fully controls, at any
depth, is not described by `entries`, not covered by `git`, and produces no change row. The
agent can put arbitrary bytes there (bounded only by Gate D) and an authoritative manifest
will report no change. No race, no forgery, no assumption violated, and the API shows
`authoritative: true, complete: true`.

The exclusion itself is defensible (walking every nested `.git` object store is expensive
and usually noise). The defect is that the exclusion is **invisible and undocumented**. Fix
one of: skip `.git` only at the root and walk nested ones like any directory; or emit a
`dir` entry for every nested `.git` plus a metadata record (count, total bytes, and a digest
of its files) so "content exists here and was not described" is a fact in the snapshot; or,
at minimum, add the nested paths to `git.oversize`/a new `excluded` list so
`complete: false`. Add the test: a write under `sub/.git` must change the digest or the
manifest.

### F-G12 — Medium — three statements the gate relies on are false

1. `TRUSTED-SNAPSHOT-DESIGN.md:80` (Limitations 7): "It cannot make a changed file look
   unchanged *relative to the baseline*." Measured false (§4 above: identical digests,
   `changeCount: 0`, file changed, `complete: true`).
2. §"What 'never descend through a link' covers": "The identity check makes the swap
   *detected* whenever the target is a different inode". False for a parent swap — the
   `lstat` follows the swapped parent, so identity agrees by construction (§5 above).
3. `snapshot.ts:732` / design table (`:41`): nested `.git` is "recorded as metadata instead". It is
   recorded nowhere (F-G11).

Remediation: (1) compare `ctimeMs`/`ctimeNs` in the after-check — an attacker cannot set
`ctime`, and my attack is detected by it for free; (2)/(3) reword to what the code does, or
make the code do what the words say.

### F-G13 — Medium — the agent can deterministically make its own evidence non-authoritative and still succeed

`execute-agent.ts:1092-1110`; `evidence.ts:391-441`. `evidenceGap()` is non-null only when
the final capture *throws*. A bounded walk is not a throw:

- one `truncate` to 9 GiB (sparse, one syscall) → `complete: false`,
  `stopReason: final-incomplete`, `authoritative: false`, **task `succeeded`**;
- one file with a non-UTF-8 name → `complete: false`, `stopReason: unreadable`, the file
  absent from `entries`, **task `succeeded`** (F-G15);
- 50 001 files → `max-entries`, same shape.

F-G2's invariant is now "if a baseline exists, a *missing* final manifest fails the
attempt". The agent's cheapest way to make the evidence unusable is no longer to remove it
(the run fails) but to bound it (the run succeeds). Nothing consumes `authoritative`, so the
practical difference from F-G2 for a reviewer who reads task status is nil. Either fail the
attempt when a *leased* workspace's final manifest is non-authoritative for a
content-reachable reason, or have `completeTaskActivity` refuse `succeeded` when the newest
attempt has a baseline and no authoritative manifest. Decide it explicitly; today it is an
undocumented product decision that reads as a hole.

### F-G14 — Medium — the F-G1 anomaly is in the digest and nowhere a reviewer looks

`evidence.ts:426` (the summary is built from the manifest), `apps/api/src/artifacts/artifact-summary.ts:16-37`. The link target is
in the canonical body (good), but `EvidenceSummary` has no field for it, no audit event is
written, no log mentions it, and the artifact summary exposes only `authoritative`,
`evidenceSource`, `manifestDigest`, checksum and size. An authoritative manifest with `hooksDirectoryLinkTarget:
"/etc"` is rendered as `authoritative: true, changeCount: 0`. Add a `gitAnomalies`/`excluded`
field to `EvidenceSummary` and surface it; do not downgrade completeness (that would hand
back the switch).

### F-G15 — Medium — a single non-UTF-8 filename stops the walk and hides the file

`snapshot.ts` uses `readdir` with the default string encoding, then `statOrUndefined` on the
joined string. Measured: one file named `<0xff><0xfe>.txt` → `complete: false`,
`stopReason: "unreadable"`, entry absent. Two consequences: the file is invisible to the
manifest, and one `writeFile` downgrades every subsequent manifest of that workspace. The
doc says "represented lossily rather than rejected", which is neither what happens nor the
right behaviour. `readdir(..., { encoding: 'buffer' })` and carrying the name as bytes (or
recording it as `undecodable` with its digest) is the honest fix; until then, the doc must
say the entry stops the walk.

### F-G16 — Medium — the demotion guard is not an invariant; terminal rows are never revisited

`reaper.ts:266,286-288` (the candidate query excludes `TERMINAL_STATES`), `:533` (the guard
runs only after a successful reclaim), `:595-613` (the comment claims "any authority row").

Constructed: a `cleaned` workspace whose evidence was removed out of band keeps
`authoritative: true` and an unreadable URI forever; a `quarantined` workspace (reclaim
refused, or `rm` failed after removing `evidence/`) is likewise never revisited. The commit
names "a pass that ran before this fix" as the case it repairs; those rows are exactly the
ones the query cannot select. Either add a repair sweep over `Artifact.authoritative = true`
whose URI is unreadable (scoped by org, batched), or state the invariant as "at reclaim
time".

### F-G17 — Low (DoS, race-dependent) — a swapped-to-FIFO entry blocks the walk

`snapshot.ts:301-310`. `O_NOFOLLOW` refuses a symlink but not a FIFO; `open(O_RDONLY)` on a
FIFO blocks until a writer appears. Measured: `hashRegularFile(fifo, staleRegularStat)` did
not settle within 3 s. A live writer can hang a snapshot (and the activity) indefinitely.
`O_NONBLOCK` plus the existing `fstat` (which already rejects non-regular files via the size
and identity checks) closes it; the FIFO classification already exists for the non-race
case.

### F-G18 — Low — `completeTaskActivity` accepts `succeeded` for a failed attempt

`apps/worker/src/activities/complete-task.ts:42-84`. Measured: an attempt recorded `failed`
with `EVIDENCE_MISSING`, then `complete` with `succeeded` → accepted, task `succeeded`. The
workflow's propagation fix is the only thing standing between the two. A cheap guard: when
`attemptId` is named and the attempt is terminal, refuse a status that disagrees with
`RUN_STATUS[attempt.status]`.

### F-G19 — Low — a failed baseline is still silent

`execute-agent.ts:701-710`; `evidence.ts:331-357`. A `null` baseline is a warning log: no
audit event, no column, no record. The final absence now has `attempt.evidence_failed.v1`;
the initial one has nothing. Not agent-reachable in this deployment (the baseline precedes
the process, and a clone cannot produce a `000` directory), so the severity is about
honesty, not exploitability.

### F-G20 — Low (documentation) — stale records and one orphaned comment

- `PHASE6-GATE-MATRIX.md`, `TEST-RESULTS.md`, `EVIDENCE-INDEX.md`, `REMEDIATION-REGISTER.md`
  all still say "Commit: 9461d27" and the register still says "IN FIX" for F-G1…F-G6; the
  tree they describe is `cfc1f26`. Honest as a record of the reviewed commit, but they were
  added/edited *in this commit*, so the artifact set now contradicts itself.
- `TRUSTED-SNAPSHOT-DESIGN.md:3` says "full suite 875/15 skipped"; it is 899/15/84.
- `EVIDENCE-INDEX.md` says "15 models"; the gate matrix says 16.
- `persist-result.ts:494-501`: the `resolveWorkspaceId` doc comment is now stacked above
  `workspaceEvidenceBinding`'s own comment, so it documents the wrong function.

## G-01…G-20 matrix (old → new; unchanged rows carry their prior verdict)

(Only the rows whose verdict changed are argued; the rest are re-stated so the matrix is
read as a whole.)

| # | Question | Round 1 | **Now** | Evidence |
|---|---|---|---|---|
| **G-01** | Git staging cannot shape authority | PASS | **PASS** | re-measured: `git diff` 0 B, manifest `modified`, on-disk sha (§7) |
| **G-02** | Clean/smudge filter cannot execute during snapshotting | PASS | **PASS** | re-measured: filter ran for the control, not for the snapshot; disk bytes hashed |
| **G-03** | Hooks, external diff, textconv cannot execute during snapshotting | PASS | **PASS** | re-measured: all three fired for the controls, none for the pair |
| **G-04** | A symlink or path replacement cannot escape the workspace | **FAIL** | **PARTIAL** | Persistent escapes closed (hooks dir, `.git`, HEAD, config, index, hook entry) — nothing from `/etc` in any field. Parent swap measured: `complete: true` with `/etc/passwd`'s digest. Nested `.git` is a coverage hole, not an escape (F-G11). |
| **G-05** | A file cannot change during capture without detection | **FAIL** | **PARTIAL** | Ordinary same-size rewrite now `unstable`; `mtime`-restored rewrite undetected and measured to hide a change (F-G12). |
| **G-06** | The final snapshot cannot occur while an agent process is active | PASS (caveat) | **PASS** (caveat, now load-bearing) | `:844` after `runtime.execute` (`:1149` on the thrown path); the guarantee is `--unshare-pid`/`--die-with-parent`, not the evidence code. G-04/G-05's residuals are exactly the cases a live writer enables. |
| **G-07** | Evidence cannot be persisted before the initial snapshot exists | PASS | **PASS** | unchanged: `initial === null` ⇒ no summary ⇒ no artifact |
| **G-08** | Cleanup cannot happen before final evidence is durable | **PARTIAL** | **PASS** | Reaper keeps `evidence/` beside the artifact copy; URI readable after `reaped`; `repo/` and `artifacts/` gone. Guard scope: F-G16. |
| **G-09** | A client or the agent cannot mark its own artifact authoritative | PASS | **PASS** | unchanged: only `persist-result.ts:382` writes the column; adapter cannot set `evidence` |
| **G-10** | An artifact cannot be replayed across tenants, tasks or attempts | PARTIAL | **PARTIAL** | unchanged (IDs omit `orgId`; replay binding is newest attempt/run) |
| **G-11** | A malformed or truncated manifest cannot pass verification | **PARTIAL** | **PASS** | body parsed, digest re-derived, complete/authoritative consistency enforced, both digests bound to `ExecutionWorkspace`; wrong anchor refused. The change list is still unbound (F-G6, informational). |
| **G-12** | Legacy artifacts cannot be mistaken for authoritative | PASS | **PASS** | unchanged |
| **G-13** | A failure path cannot silently produce a successful task state | **FAIL** | **PASS** | `chmod 000` ⇒ `failed` + `EVIDENCE_MISSING` + event + 0 authority + task `failed`; two controls. The downgrade path is F-G13, a different row's question. |
| **G-14** | The trust boundary is not overstated | PASS (one comment) | **FAIL** | three false statements (F-G12) and a fourth in `snapshot.ts` (nested `.git`) |
| **G-15** | Phase 3–6 findings still hold | PASS | **PASS** | 72 + 23 phase-5 + 4/4 isolation-gate; diff touches no resource/isolation file |
| **G-16** | The staging test fails on the pre-fix behaviour | PASS | **PASS** | §7 controls; §9 M1 |
| **G-17** | The provenance test fails on the pre-fix code | PASS (reasoned) | **PASS (measured)** | M6: reverting the body/anchor binding fails 2 tests |
| **G-18** | No assertion weakened, no test skipped-as-passed, no retry added | PASS | **PASS** | 3 deleted lines, all imports; M1–M7 (§9); no `.only`/`fails`/sleep |
| **G-19** | Suites, types and lint are green | PASS | **PASS** | 899/15/84; 97 e2e; lint 0; typecheck 0 |
| **G-20** | The gate's own claim: the agent no longer authors the evidence used to judge it | **FAIL** | **FAIL** | Content: unshaped for git, unreadable outside the tree, undeletable without failure. But the agent chooses *coverage* (nested `.git`, silently) and *authority* (bounded walk, labelled) and the task still succeeds. |

**Gate G is not PASS (its own status stays PARTIAL); this review's verdict is FAIL.**
F-G1/F-G2/F-G3 closed; F-G11 High open; G-14 FAIL.

## What the gate still does not establish

1. **Completeness.** `.git` at any depth is undescribed (F-G11), a non-UTF-8 name hides its
   file and truncates the walk (F-G15), and a bounded walk is a success (F-G13).
2. **Authenticity.** Still no signature; same-UID compromise open (Gate A).
3. **Containment under a live writer.** Parent swap and `mtime`-restored rewrite are real
   (§4, §5) and the identity check does not see either.
4. **That evidence survives indefinitely.** It is retained in place with no retention
   policy; the demotion guard only runs at reclaim time (F-G16).
5. **That `authoritative` means anything to a consumer.** Nothing refuses on it; it is
   descriptive.
6. **That a failed attempt cannot be written as a succeeded task.** The workflow's
   propagation prevents it; the terminal write does not (F-G18).
7. **History, pre-image, mounted filesystems, renames** — unchanged and labelled.
8. **That a non-sandboxed adapter would be safe.** G-06 is the load-bearing assumption for
   §4 and §5, and it lives outside the evidence code.

## What I would refuse to ship

1. **The nested-`.git` exclusion as it stands** (F-G11). An authoritative manifest that says
   "no changes" while the agent writes arbitrary content into `sub/.git/` is the exact
   inversion this gate exists to remove, and it needs no adversary beyond the agent.
2. **The sentence "It cannot make a changed file look unchanged relative to the baseline"**
   (F-G12 #1) while it is false. Either compare `ctime` (one line) or strike the bound and
   say "a live writer during capture can hide its own change".
3. **"The identity check makes the swap detected whenever the target is a different inode"**
   (F-G12 #2) while the parent swap is measured and undetected.
4. **A task status of `succeeded` with `authoritative: false` and no failure event**
   (F-G13), unless the product decision is written down where the next reviewer will read it.
5. **A reaper guard described as "any authority row"** when it runs on one pass and never
   returns (F-G16).

I would **not** refuse the commit for F-G14…F-G20: none of them makes a gate statement
untrue that is not already in (1)–(5), and each has a cheap fix.

## What I tried and could not do

- Get any foreign hash through `.git` metadata: link, gitfile, gitfile pointing at
  `/etc/passwd`, HEAD, config, index, a symlinked hook entry. All refused or recorded as a
  target string.
- Reopen the `chmod 000` hole: the attempt fails, the event is bound, the artifact count is
  zero, the task is `failed`. The two controls pass, so this is not "everything fails".
- Make the reaper drop evidence on its measured path, or keep an authority row alive after
  the reaper removed its bytes on that path.
- Defeat the identity check with a hard link to a different inode or a symlink swap.
- Forge a manifest that contradicts `ExecutionWorkspace` and have it persisted.
- Find a persistent (race-free) path out of the tree.
- Weaken an assertion, delete a test, add `.only`/`fails`/a retry, or make a new test pass
  on reverted behaviour (seven mutations, seven failures).
- Regress Phase 3–6: 72 claim/boundary/identity, 4/4 isolation-gate including VM
  fail-closed, 23 phase-5 targeted, 899 full, 97 e2e, lint 0, typecheck 0.

What I could do is in F-G11…F-G20. **F-G11** (High) and **F-G12** (which makes G-14 FAIL) are
the reason the verdict is FAIL; **F-G13** is why G-20 stays failing.

## Test and probe evidence gathered during this addendum

| Item | Command / artefact | Result |
|---|---|---|
| full suite | `npx vitest run` | **899 passed, 15 skipped, 84 files** |
| API e2e | `apps/api`: `npx vitest run --dir test` | **97 passed, 7 files** |
| workspace-manager | `npx vitest run packages/workspace-manager/test` | **144 passed, 13 files** |
| worker | `npx vitest run apps/worker/test` | **274 passed, 12 skipped, 26 files** |
| boundary/claim/identity | `execution-{boundary,claim,identity}.test.ts` | **72 passed** |
| isolation-gate | verbose | **4/4 passed**, including VM refusal and forged-input refusal |
| phase-5 targeted | `isolation-gate`, `cpu-budget`, `volumes`, `io-limits` | **23 passed, 4 skipped** |
| typecheck | `tsc -p packages/workspace-manager`, `tsc -p apps/worker` | **0** / **0** |
| lint | `eslint` on all 12 changed source/test files | **0** |
| P1 F-G1 matrix | `.cache/sec606/probes/p1-fg1.mts` | 14 cases; §1 table |
| P2 parent swap | `p2-parent-swap.mts` | `complete: true`, `/etc/passwd` digest recorded |
| P3 F-G2 + controls | `p3-fg2.mts` (real DB + Temporal) | 4 scenarios; §2 table |
| P4 F-G3 | `p4-fg3.mts` (real `runReaperPass`) | 6 scenarios; §3 table |
| P5 F-G6 | `p5-fg6.mts` | forged change list accepted; anchors refused when wrong |
| P6 six git attacks | `p6-git.mts` | 6/6 controls fired, 6/6 manifests correct |
| P7/P8 F-G4 | `p7-fg4.mts`, `p8-fg4-manifest.mts` | identical digests, `changeCount: 0`, file changed |
| P9 F-G5 | `p9-fg5.mts` | hard link refused, symlink refused, FIFO hung |
| P11 nested `.git` | `p11-nested-git.mts` | `changeCount: 0`, digest unchanged, payload invisible |
| mutations M1–M7 | `/home/ubuntu/.cache/sec606/mutate.sh` | 7/7 fixes fail when reverted |

Verification status: **verified** for every command and probe result quoted above. F-G11,
F-G13, F-G15, F-G16 and the F-G4 consequence are **measured**, not reasoned. The only
reasoned items are the reachability qualifiers on G-04/G-05 (they need a live writer during
capture, which G-06 excludes by assumption, not by code) and F-G19 (not agent-reachable in
this deployment).

---

# Round 3 — Gate G probe verification at `c6eb96f`

**Measured at:** `c6eb96f42265260b736066df2192ca6a219681e5` (code `39063b9a24c64a1b9004fd69725afa340270148f`, docs `c6eb96f`), parent `cfc1f26cd4600a96fd2aa7722f128e4988a7cecf`. Clean tree (`git status --short` empty).
**Reviewer:** independent subagent. I did not write any change in these two commits.
**Method:** five standalone `tsx` scripts under `/var/tmp/probe-gate-g/`, importing the **source** modules directly (`packages/workspace-manager/src/{snapshot,manifest}.ts`). No test framework, no PostgreSQL, no `vitest`, no `pnpm` script. Scratch trees under `/var/tmp/probe-gate-g/*`. Total probe wall time **183 ms**; the pre-fix replay **~60 ms**. No probe came near the 2-minute abandonment bound; none was abandoned.

Reproduce: `node_modules/.bin/tsx /var/tmp/probe-gate-g/probe.mts` (all five), `.../probe2.mts` (F-G20 withdrawal detail), `.../probe3-prefix.mts` (parent-commit replay). Raw output in `/var/tmp/probe-gate-g/results.json`.

**Concurrency note.** The tree was clean when this review started and was **not** clean when it
ended: another process wrote `apps/worker/test/helpers/database.ts`, `apps/worker/test/isolation-gate.test.ts`,
`packages/database/prisma/seed.ts`, `vitest.config.mts` and an untracked `apps/worker/h602-measure-harness.mts`
while I was reading. I made none of those edits — this section is the only file I touched. Every
probe imports `packages/workspace-manager/src/*`, which is unmodified in the working tree, so the
results are pinned to `c6eb96f` content and not to a half-finished edit. The `hookTimeout` reading
below is `git show HEAD:vitest.config.mts`, not the working copy.

## Verdict

**Gate G is FAIL.** The five probed defects are not the reason. Two rows decide it and neither is touched by these commits: **G-16** (the reaper deletes `evidence/` while leaving `authoritative: true` rows — measured in round 2) and **G-20** (F-G20 is a detection with an explicit, documented unprevented window). **G-13** also remains PARTIAL — carried from the matrix, not re-probed here: `verifyManifestFile` does not parse the body, so `complete:false` under an `authoritative:true` envelope still verifies.

What changed is narrower and real: **F-G11, F-G4, F-G1, F-G17 are closed at this SHA and F-G20 is a working, tested detection.** All five behaved as the code claims when I attacked them, and every negative control held.

| Probe | Claim | Result |
|---|---|---|
| **F-G11** | nested `.git` is content, named as an anomaly, inside the entry bound | **PASS** |
| **F-G4** | same-size rewrite with `mtime` restored at ns precision is contested via `ctime` | **PASS** (in-capture window; see scope note) |
| **F-G20** | parent swapped for a link ⇒ `complete:false`, subtree withdrawn, off-tree hash absent | **PASS** (detection; prevention not claimed and not present) |
| **F-G1** | `.git/hooks -> /etc` ⇒ zero `/etc` content, target recorded, no traversal | **PASS** |
| **F-G17** | file swapped to FIFO after `lstat` ⇒ refusal, not a hang | **PASS** |

## The five probes, with the output I produced

### F-G11 — `changeCount` is no longer 0 for a nested `.git`

```
mkdir repo/sub/.git/objects/ab; write repo/sub/.git/objects/ab/cdef "ORIGINAL"
snapshot A; rewrite that file "REWRITTEN"; add sub/.git/HEAD; snapshot B; buildChangeManifest
→ changeCount: 2
→ ["added:sub/.git/HEAD", "modified:sub/.git/objects/ab/cdef"]
→ digestA b5bf67f5a6260ec2 ≠ digestB dc5dd534d1cd48db
→ nestedFileDescribed: true, nestedFileShaChanged: true
→ anomalies: ["nested-git:sub/.git"]
→ entries: sub/.git, sub/.git/HEAD, sub/.git/objects, sub/.git/objects/ab, sub/.git/objects/ab/cdef
```

Entry bound, the half that matters for "it cannot explode the walk": a 40-file nested `.git` walked with `maxEntries: 5` gives `entryCount: 5, complete: false, stopReason: "max-entries"`. The nested tree is bounded by the same counter as everything else — `snapshot.ts:949` excludes `.git` only when `relativeDirectory === ''`, and `:968` records it as an anomaly at any other depth. Test coverage incl. both controls: `snapshot-nested-git.test.ts:48,81,100,117`.

### F-G4 — `ctime` is the discriminator, and the negative control is clean

```
4096-byte file; mtime taken from a reference file; in-place 16-byte write; touch -r restores it
→ sizeUnchanged: true
→ mtimeIdenticalNs: true      (before and after both 2026-11-16T04:45:15.077Z)
→ ctimeMoved: true
→ hashRegularFile(path, staleLstat) → UnstableEntryError:
   "ctime moved from 1794804315106.895 to 1794804315141.895 before the read"
→ two-snapshot: changeCount 1, digests differ  (detected by content hash, complete: true)
→ negative control: complete true / true, digests equal, changeCount 0
```

**Scope note, because the matrix's own sentence is looser than the code.** `ctime` is compared between the walk's `lstat` and the descriptor (`snapshot.ts:399-406`, `:415-424`), so it detects a rewrite **inside the capture window**. A rewrite that finishes *before* the walk's `lstat` is not — and cannot be — detected by `ctime`; it is detected because the bytes hashed are different, which is what my two-snapshot run shows. That is the correct behaviour, but it means "the change is detected via `ctime`" is only true of the in-window case.

I replayed the parent commit to check the docstring's stronger claim. At `cfc1f26`, `hashRegularFile` has no `ctimeMs` comparison at all (`grep ctimeMs` → 0 hits); given the same stale `lstat` it **accepted** the rewrite and returned `sha256(new bytes)`, not the baseline digest:

```
preFixResult: { accepted: true, sha: "59247dc5…93e" }
preFixShaIsBaselineSha: false
preFixShaIsNewContentSha: true
```

So the defect the test describes is real and the fix is load-bearing, but `snapshot-race.test.ts:137`'s "a final digest equal to the baseline" holds only under the interleaving where the write lands after the read and before the post-read `fstat` — it is not what a single-file replay produces. Documentation precision, not a code defect: at HEAD both interleavings are refused because `ctimeMs` is compared before *and* after the read. The suite has no end-to-end two-snapshot test for F-G4 (the matrix says so); my probe supplies one but it lives outside the suite.

### F-G20 — the subtree is read through the link, then withdrawn

Swap performed in the `afterDirectoryListed` seam: between `readdir(parent)` and the child's `lstat`, `parent` is renamed to `parent-real` and replaced by a symlink to an outside tree containing `OUTSIDE-SECRET`.

```
→ complete: false, stopReason: "parent-replaced"
→ entries: ["root.txt:file:5"]   ← the `parent` entry and every child withdrawn
→ totalBytes: 5                  ← recomputed; the 15 outside bytes were counted and removed
→ outsideHashInSerialisedBody: false, inFullSnapshot: false
→ "outside-only" path: absent, link target: absent
→ negative control (same tree, same seam, no swap): complete true, stopReason null, 3 entries
```

Variant B — parent replaced by a *real directory* of the same shape (different `dev`/`ino`, no link) — also gives `parent-replaced` with the subtree withdrawn. `totalBytes` re-derived as 5 is the proof the children were read and then withdrawn rather than never read: `snapshot.ts:1055` (`directoryIdentityVerdict`), `:1061-1082` (filter + splice + `totalBytes` recompute). Tests: `snapshot-race.test.ts:264,291,308`.

This is detection after the fact. `open` is path-based everywhere (no `openat2(RESOLVE_BENEATH)`), so the swap inside `listDirectory`'s own `lstat`→`readdir` window remains undetected by either check, exactly as `TRUSTED-SNAPSHOT-DESIGN.md` limitation 9 states. I did not reproduce that window and am not claiming it is closed.

### F-G1 — `.git/hooks -> /etc`

```
→ hooksDirectoryLinkTarget: "/etc"
→ hooksEnumerated: []
→ anomaly: ["hooks-directory-link:/etc"]
→ entries under .git/: 0
→ sha256(/etc/passwd) in serialised body: false
→ "/etc/passwd" string in snapshot: false
→ complete: true        ← anomaly does not downgrade, by design
→ positive control: hooks ["pre-commit:file:299001868fb8"], sha256 of the fixture "299001868fb8", complete true
```

`listDirectory` is the only descent path and it `lstat`s first (`snapshot.ts:500-520`, used at `:756`). Tests `snapshot-escape.test.ts:63,97`. The positive control matters: the negative result is not "hooks are never enumerated".

### F-G17 — FIFO after `lstat` returns; hard timeout not hit

```
hashRegularFile(fifo, staleLstat) raced against 5 000 ms
→ { outcome: "refused", name: "UnstableEntryError",
    message: "… changed during capture: is no longer a regular file (opened a special file or directory)" }
→ walk over a tree containing a pre-existing FIFO: complete true,
   entry { path: "pre-existing.fifo", kind: "special", sizeBytes: 0, sha256: null }
```

`O_NONBLOCK` (`snapshot.ts:380`) plus the `isFile()` refusal before any read (`:392-398`) is what returns instead of blocking.

**What I did not do:** race the walk's internal `lstat`→`open` window from a second process. I exercised `hashRegularFile` — the exact function the walk calls at `snapshot.ts:1027` — with a stale `lstat`, which is the same state the walk holds when the swap lands. The refusal is therefore the same code path, but the *timing* of the walk-level race was not reproduced.

## Read-only checks (no execution)

### F-G13 / F-G18 / F-G19 — the code is right, the assertions are properties

| Property | Code | Test | Asserts the property? |
|---|---|---|---|
| incomplete manifest ⇒ `EVIDENCE_INCOMPLETE` | `evidence.ts:459-472` builds the failure only when `manifest.complete` is false; `execute-agent.ts:1197-1210` records each gap, downgrades `succeeded → failed`, and sets `EVIDENCE_ERROR_CODES[code]` (`shared/evidence.ts:88-92`) | `evidence-capture-failure.test.ts:555` — 9 GiB sparse `truncate` through the real adapter | **Yes.** Asserts `status: failed`, `code: EVIDENCE_INCOMPLETE`, `code !== EVIDENCE_MISSING`, `retryable: false`, `evidence.authoritative: false`, `stopReason: final-incomplete`, **and** the event's counts reached. The `!==` assertion is the one that stops "one code for two facts" from creeping back. |
| `completeTask` refuses `succeeded` on a terminal non-success attempt | `complete-task.ts:33-72`; called at `:113`, i.e. after authority and before the write | `:763` | **Yes, and better than most.** It asserts the task is still `queued`, not merely "not succeeded" — that rules out the `status IN (queued,running,verifying)` predicate doing the work by accident. Reached-at-all is proven separately by N8: `PRE_DISPATCH_TERMINAL_STATUSES = {failed, cancelled}` (`claim.ts:591`) means a `succeeded` with no claim is refused by authority before this guard runs. |
| failed baseline ⇒ `EVIDENCE_BASELINE_FAILED` | `evidence.ts:369-385` returns the failure instead of silence; `execute-agent.ts:786-788` stores it; the same `gaps` branch fails the attempt | `:663` | **Yes.** `chmod 000` before the lease, so the baseline genuinely precedes the agent; asserts `failed`, the code, `phase: 'initial'`, `initialManifestDigest: null` (no invented anchor), the attempt row, and zero authoritative artifacts. |

**The caveat that matters:** all three are inside `describe.skipIf(!temporalEnabled)` (`:251, :555, :663, :763, :908`), as are 37 `it`s across the suite. On a host without Temporal these tests skip and assert nothing while the summary still reads green. That is the same class of failure the `hookTimeout` change was made to remove — a silent skip standing in for a proof — and it has not been removed, only moved. Whether they ran here is the subject of the last section.

### F-G14 — yes, I can construct an anomaly with no `attempt.evidence_anomaly.v1`

Three paths, in descending severity:

1. **Baseline failed + anomaly present.** `captureFinalEvidenceOutcome` writes the final snapshot to disk and *then* returns `{summary: null, failure: null}` when `initial === null` (`evidence.ts:437-444`). `recordEvidenceAnomalies` is only reached in the success path's `else` branch, i.e. when `finalEvidence !== null` (`execute-agent.ts:971`), and on the thrown path only inside `if (lease !== undefined && finalEvidence === null)` (`:1254-1272`). So `chmod 000` on one directory (F-G19's own arrangement) **plus** `.git/hooks -> /etc` fails the attempt with `EVIDENCE_BASELINE_FAILED` and the anomaly exists only in `final-snapshot.json` on disk — never as an event. Construction is trivial and agent-reachable, though the attempt is already failing, so nothing false is reported as success. **Low.**
2. **Audit write failure.** `recordEvidenceAnomalies` catches every error except `P2002` and logs (`:664-668`). Any anomaly can therefore leave no event if the insert fails. Documented ("Never throws: an audit write is not allowed to replace the run's outcome"); the trade is explicit. **Informational.**
3. **Throw between capture and record.** `recordFinalSnapshot` (`:942-946`) sits between the capture and `recordEvidenceAnomalies` (`:971`). If it throws, the catch block sees `finalEvidence !== null`, so it does not re-enter the recording branch. Anomaly in the digest, on disk, and never in an event. Infrastructure-shaped, not agent-shaped. **Low.**

None of these produces a false success. The three tests at `:908` cover the success path (authority + `changeCount: 0` + event), the nested-`.git` case, and a clean-run control that asserts **zero** anomaly events — a good control, because without it the other two would only prove "every run writes one".

### `hookTimeout` 10 s → 60 s, and what the 15 skips actually are

`vitest.config.mts:15` is `hookTimeout: 60_000`, with the reason in the comment above it (the first Temporal suite compiles the workflow bundle with webpack, ~5 s, and the 10 s default turned that into a `Hook timed out` that skipped every test in the file). `apps/api/vitest.config.mts:24` already used 60 s for the same class. A real-Temporal suite does its start-up in `beforeAll` and gates its tests on `temporalEnabled` (`evidence-capture-points.test.ts:180-190`) — e.g. `evidence-capture-failure.test.ts:61` computes `temporalEnabled = enabled && await temporalReachable()`.

Two things I will not certify:

1. **"No file can now be skipped by a hook timeout without a visible signal" is not established.** The raise removes one *known* cause. A hook that exceeds 60 s still leaves the file's tests reported as skipped; vitest reports the file as failed (the hook error is an unhandled error at suite level), so the skip is accompanied by a failure — but a summary that counts only failed *tests* shows `0 failed` beside the skips. The mechanism is mitigated, not eliminated. I did not execute a hook timeout to confirm how this version reports it.
2. **"The 15 skips are live-Temporal only" cannot be true of a full-suite run.** 37 `it`s sit behind `describe.skipIf(!temporalEnabled)` — counted by brace-matching each block and printing its title, not estimated: `evidence-capture-failure` 10 (`:251,555,663,763,908`), `execution-boundary` 14 (`:707,867,912,1467,1743`), `execution-persistence` 5, `isolation-gate` 4, `approval-attempt-binding` 2, `evidence-capture-points` 1, `execution-identity` 1. **With Temporal unreachable, at least 37 tests skip.** 15 skipped therefore means Temporal *was* reachable and the Temporal-gated suites ran; the 15 are one of the other gates — `TIER !== 'full'` (`cgroup.test.ts:139` 8 its, `cpu-budget.test.ts:587,626` 3), `SET === null` (`io-limits.test.ts:152,200` 3), `P4_REAL_MODEL !== '1'` (`broker-run.test.ts:264` 1), `!bwrapAvailable` (`sandbox-env-isolation.test.ts:65` 5). Which subset sums to 15 depends on this host; I did not measure it.

   This also makes `TEST-RESULTS.md:42-45` false on its face — "15 tests skip, all for one reason: they need a live Temporal server", followed by a list (isolation-gate ×4, execution-persistence ×5, approval-grant ×2, approval-attempt-binding ×1, boundary ×3) that is a subset of the 37 blocks. Those five groups *are* Temporal-gated, so if they skipped, the other ~22 Temporal-gated tests in the same run would have skipped too. The sentence is inherited, not measured. The useful half of the contract's premise holds regardless: the 917-passed figure is evidence the Temporal suites ran, and nothing in these two commits adds a skip.

   One consequence worth flagging to whoever owns the skip budget: a baseline of `15`, set from a run whose skips were attributed to Temporal, is a ceiling derived from the wrong set. With Temporal live the true count is lower, so a *new* skip hides under it — the same "15 is green" hazard the reporter exists to remove.

## Findings

No new **Critical** or **High**. Three **Low**, two **Informational**.

| ID | Sev | Finding |
|---|---|---|
| R3-01 | Low | An anomaly in a final snapshot is never recorded as an event when the baseline failed (`execute-agent.ts:971` + `evidence.ts:437-444`). Attempt still fails, so no false success; the anomaly is on disk only. |
| R3-02 | Low | Anomaly recording is ordered after `recordFinalSnapshot` (`:942` vs `:971`); a throw there loses the event on the success path, while the catch path skips recording because `finalEvidence !== null`. |
| R3-03 | Low | G-17's three properties are proven only where Temporal is reachable. 37 `it`s — including F-G13/F-G18/F-G19/F-G14 — skip silently without it, and a green summary cannot distinguish "asserted" from "never ran". `TEST-RESULTS.md:42-45` compounds this by attributing all 15 skips to Temporal when 15 is below the 37 that gate would produce. |
| R3-04 | Info | `snapshot-race.test.ts:137`'s "a final digest equal to the baseline" describes one interleaving; a single-file replay at `cfc1f26` accepted the rewrite and returned the *new* bytes' digest. Measured, and the defect is the same either way. |
| R3-05 | Info | `hookTimeout` removes the known 5 s trigger, not the class. A >60 s hook still skips a file's tests; the visible signal is the failed suite, not a failed test count. |

## What Gate G still does not establish

- **Prevention of the parent swap.** Detection only. Path-based `open` throughout; the `listDirectory` `lstat`→`readdir` window is unaddressed and admitted.
- **The reaper.** G-16 unchanged by these commits: evidence bytes deleted, authority row kept. This is the row that decides the gate.
- **`verifyManifestFile`.** Still does not parse the body (G-13); `complete:false` inside an `authoritative:true` envelope verifies. Not agent-reachable, still false as a claim about the verifier.
- **`ctime` on coarse filesystems.** The code says a 1-second-granularity filesystem can hide a change inside one tick (`snapshot.ts:861-863`); no test measures that.
- **The walk-level F-G17 race.** I proved the refusal at the function the walk calls, not by racing the walk.
- **A signature.** The manifest digest is content identity. No key, no non-repudiation.

## What I would refuse to ship

1. **`Gate G = PASS`.** On this evidence it would be a statement about five probes, not about the gate. G-16 and G-20 are open and neither is touched here.
2. **Any sentence saying the parent swap is "prevented".** It is detected, the subtree is withdrawn, the attempt fails — that is a good outcome, and it is not prevention. The design says so; the matrix should not drift.
3. **`TEST-RESULTS.md`'s "15 skips, all Temporal" sentence, and any skip budget derived from it.** The inventory says 37 `it`s sit behind that gate; the sentence and the baseline are both off by the same mis-attribution. Fix the attribution before the number becomes a threshold.

**Verified by execution:** F-G11 (`changeCount`, anomaly, bound), F-G4 (both directions, negative control, and the `cfc1f26` replay), F-G20 (two swap variants, withdrawal via `totalBytes`, negative control), F-G1 (link target, absence of `/etc` content, positive control), F-G17 (stale-stat refusal under a 5 s timeout, pre-existing FIFO in a full walk).
**Verified by reading only:** F-G13, F-G18, F-G19 (code + the tests that assert them), F-G14's three gaps, the skip composition, and the `hookTimeout` effect. Nothing in this section is presented as executed.

---

## Follow-up — two FAIL grounds checked against `c6eb96f`, both withdrawn

Read only: no probe re-run, no test run, no PostgreSQL. Both grounds were taken from the
`PHASE6-GATE-MATRIX.md` rows, which are measured at `cfc1f26`. `39063b9` changed the code under
two of those rows and I did not re-read them before using them as grounds. That is the error in
both cases: a row measured at the parent does not carry to the child any more than an
uncommitted fix does.

### Ground 1 — "G-16: the reaper deletes `evidence/` while leaving `authoritative: true`" — **WITHDRAWN**

The measured path is closed at this SHA, and it was closed in `cfc1f26`, which is why `39063b9`
does not touch it.

- `apps/worker/src/reaper.ts:514` and `:924` both pass `keepEvidence: true`.
- `packages/workspace-manager/src/reclaim.ts:224` makes `keepEvidence` independent of
  `keepArtifacts`; `:235-237` derive `evidencePresent = keepEvidence && evidenceExist` and
  `evidenceRemoved = evidenceExist && !keepEvidence`.
- `:239-252`: the preserve branch is taken on **evidence alone** (`preserved = artifactsPresent ||
  evidencePresent`), and `evidence/` is skipped by the `rm` loop whenever `evidencePresent`.
- `:253-257`: the recursive `rm` of the whole workspace runs only when `preserved` is false.

So `evidenceRemoved: true` is reachable only from a caller that explicitly passes
`keepEvidence: false`, and the reaper never does. `removed: true, evidenceKept: false` — the
round-2 measurement — is not reproducible on the reaper path at `c6eb96f`. Tests:
`apps/worker/test/reaper.test.ts:412` (evidence kept beside a preserved artifact, URI stays
readable) and `:476` (the removal path, where the caller asked for removal).

What the G-16 row still contains is narrower and is a **decision, not the defect I named**, and
`reaper.ts:531-556` states it in its own words:

1. `cleaned`, `quarantined` and `cleanup_failed` rows are excluded from the candidate query
   (`:891` selects `completed`/`failed` with `cleanedAt: null`), so a row that already reached
   `cleaned` is never revisited; its bytes can disappear afterwards and it keeps
   `authoritative: true`.
2. `revokeUnbackedAuthority` skips any URI that does not start with the recorded `rootPath`
   (`:545-549`), because a `stat` from the wrong base would demote rows whose bytes are fine.

The compensating control is the read path, not the column: `410 ARTIFACT_GONE`, and
`integrity: 'unknown'` computed from bytes on every request (`reaper.ts:551-556`). That is
`EVIDENCE-INDEX.md` §"Artifact authority after the bytes are gone" (F-G16, Option B). Withdrawn as
a FAIL ground; the G-16 **row** should be re-scored at `c6eb96f` to "residual by decision", not
FAIL. I did not execute the reaper to confirm this — it is read-only, as instructed — so the
evidence is the three call sites and the two tests, not a fresh `reclaimWorkspace` run.

### Ground 2 — "G-13: the verifier still doesn't parse the manifest body" — **WITHDRAWN**

False at this SHA. `verifyManifestFile` parses the body and compares it to the record:

- `apps/worker/src/activities/evidence.ts:129-176` `parseManifestBody`; called at `:228`.
- `:231-233` re-derives `manifestDigest(parsed.body)` and refuses a body that derives a different
  digest — so a rewritten body with a matching envelope is refused.
- `:239` body `complete` vs summary `complete`; `:246` `complete` vs `stopReason`; `:252`
  `authoritative && !complete` refused.
- `:258-264` both snapshot digests vs the summary.
- `:272-290` both snapshot digests vs `ExecutionWorkspace` (`expected.initialManifestDigest`,
  `expected.finalManifestDigest`), which is the row the worker wrote before the agent existed.
- Live path, not dead: `apps/worker/src/activities/persist-result.ts:103`, outside the
  transaction, throwing `EVIDENCE_INTEGRITY_FAILED` (`:105-110`).

The comment at `evidence.ts:181-191` says in as many words that an earlier version checked only
self-consistency and that "the body is now parsed" — the +117 lines `39063b9` added to this file
are that change. `complete: false` inside an envelope claiming `authoritative: true` now returns
`'an authoritative manifest cannot describe an incomplete walk'` (`:252`).

**The one residual I can still defend, and it is not this claim:** `workspaceEvidenceBinding`
(`persist-result.ts:513-527`) resolves the binding by `orderBy: { createdAt: 'desc' }` /
`attemptNumber: 'desc'` — the *newest* run and attempt, not the execution in context. So the
digests are compared against the newest `ExecutionWorkspace`, not necessarily this attempt's. That
is F-G10 / matrix row **G-15** (already PARTIAL: "Replay binding uses the newest attempt/run
rather than the execution in context"), not a body-parsing gap. G-13's row should move to Verified
with that qualifier; the sentence "`verifyManifestFile` never parses the body" is a `cfc1f26`
statement and cannot be cited at `c6eb96f`.

### Confirmations requested

**F-G14 — all three still hold at `c6eb96f`.** Line numbers corrected: the early return is
`evidence.ts:433-438` (`summary: null, failure: null` when `initial === null`); the success-path
anomaly call is `execute-agent.ts:971` (inside `finalEvidence !== null`); `recordFinalSnapshot` is
`:950`, i.e. before `:971`; the thrown path enters only when `finalEvidence === null` (`:1253`) and
records at `:1272`. So #1 (baseline failed + anomaly ⇒ no event) and #3 (throw between `:950` and
`:971` ⇒ no event) are unchanged, and #2 (audit insert failure is logged, `:664-668`) is unchanged.
Fixing #1 and #3 as intended is sufficient; nothing else in that list needs a code change.

**`hookTimeout` — yes, class statement, not "60 s is too short".** The claim is that the *mechanism*
persists: a hook exceeding whatever the timeout is still leaves the file's tests reported as
skipped, so the skip count is the signal that has to be read. 60 s is ample for the measured ~5 s
bundle compile. No objection to the value.

### What the verdict becomes

With both grounds withdrawn, **Gate G's FAIL rests on G-20 alone**: F-G20 is a High that is
detected, not prevented, and the window admitted in `TRUSTED-SNAPSHOT-DESIGN.md` limitation 9 is
real. Stated precisely so the record is usable: an attacker can still cause a digest of an off-tree
file to be computed mid-walk; the snapshot comes back `complete: false` with `stopReason:
parent-replaced`, the subtree is withdrawn, and the attempt fails — so the off-tree digest never
becomes persisted authority. The ground is therefore "an unprevented TOCTOU exists", not "false
evidence is accepted". Whether that is High is the whole call: on the stricter reading F-G20 stays
open and the gate is **FAIL on G-20**; on the "no accepted false authority" reading F-G20 closes by
detection and I have no remaining *code* ground to offer. The documentation row **G-21** is the
other open row in the matrix and I have **not** re-audited it at `c6eb96f`, so I am not substituting
it for a verdict here.

Two corrections to my own round-3 section, for the record: `F-G3`/G-16 is **not** untouched-and-broken
(it is fixed, and its residual is the documented decision), and G-13's verifier **does** parse the
body. My `c6eb96f` verdict should have rested on G-20 from the start; the other two sentences were
inherited from `cfc1f26` and should not have been cited at this SHA.
