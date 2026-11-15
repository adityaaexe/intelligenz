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
