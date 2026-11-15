# AG-603 — Identity and terminal-write authority

**Defect source:** `FINAL-INDEPENDENT-REVIEW.md`, addendum to `74207f0` — verdict FAIL.
**Branch:** `phase-6/trust-boundary-closure`, base `74207f0`.
**Scope:** N1 (High), N2 (Medium), N3 (Low), N4 (defence in depth). F1–F4 were already closed
and were not touched.

---

## 1. N1 — the holder identity could be forged

### The defect

`executionIdentity` read `Context.current().info.workflowExecution.runId` and, when there was
no workflow execution, returned a `workflowRunId` field **from the activity's input**.

An activity dispatched as a **standalone activity** (`Client.activity`) has an activity
context but no workflow execution. It therefore took the fallback, and the launch-site claim
was satisfied by an input field. The reviewer ran it on a worker created the way production
creates one, and produced two executions of one reservation:

- victim not yet adopted → the standalone call spent attempt 1, and the legitimate execution
  arriving later found no queued reservation and allocated attempt 2;
- victim adopted (`running`) → the standalone call allocated **attempt 2 under the victim's
  claim** and ran it concurrently with attempt 1.

Both attempts finished naming the victim's run id. The two values needed — attempt id and run
id — are readable from workflow history by anyone with Temporal access, which is the
register's own O1 precondition. It is duplicate execution and false attribution, not privilege
escalation: the approval gate still refused unapproved tasks and a standalone caller cannot
mint a grant.

### The fix

| What | Where |
|---|---|
| `executionIdentity()` takes **no argument** and reads the activity context only, returning `undefined` when there is none | `apps/worker/src/activities/claim.ts:164` |
| `EXECUTION_IDENTITY_UNAVAILABLE` — a distinct, non-retryable code, so "there is no execution here" is never conflated with "an execution that holds no claim" | `claim.ts:120` |
| `requireExecutionClaim` refuses with that code before its first read | `claim.ts:449` |
| `validateTaskActivity` refuses with that code before writing the claim | `apps/worker/src/activities/validate-task.ts:228` |
| the identity fields are **deleted** from the activity inputs — `ExecuteAgentActivityInput.executionRunId` and `ValidateTaskActivityInput.workflowRunId` | `apps/worker/src/shared/contracts.ts` |
| the workflow no longer forwards an identity to validation | `apps/worker/src/workflows/run-task.ts` |

`ExecuteAgentActivityInput.workflowRunId` survives and is a different thing: the database
`WorkflowRun.id`, cross-checked against the attempt's foreign key. It buys nothing on its own
— the claim still has to be held by the context's run id.

### No activity input can supply an identity

1. No activity input supplies an execution identity, and `executionIdentity()` has no
   parameter to pass — a structural test fails if that signature comes back. This section used
   to open with "nothing in `src/` reads an identity from a parameter", which was false:
   `claimExecution(identity: ClaimIdentity)` reads `identity.workflowRunId`
   (`claim.ts:303-320`). The accurate statement is narrower and is the one that matters.
2. Every writer that needs an execution identity calls `executionIdentity()`; none receives one
   from an activity input. The call sites are `execute-agent.ts:197`, `validate-task.ts:229`,
   `persist-result.ts:71`, `complete-task.ts:102`, `emit-event.ts:78` and
   `record-start.ts:38`, each passing it into the guard that authorises the write.
3. The value comes from `Context.current()`, which the Temporal SDK populates from the
   server's activity task. A standalone activity has no `workflowExecution` and therefore no
   identity; a workflow-dispatched activity cannot override it.
4. Tests obtain every identity from a real workflow execution
   (`test/helpers/execution-harness.ts` → `handle.firstExecutionRunId`). There is no test
   seam that supplies one. The one place a test passes an identity is
   `claimExecution(...)`'s own argument — an internal writer that is *given* an identity by
   its caller, with a single production caller that derives it from the context.
5. Nothing in the **activity-input** surface carries an identity:
   `execution-identity.test.ts:614` asserts no identity field on the inputs.

### Proof

`apps/worker/test/execution-identity.test.ts`

| Test | What it fails on |
|---|---|
| `N1 — an activity with no execution context has no identity` (×4) | direct calls to all four guarded activities: `EXECUTION_IDENTITY_UNAVAILABLE`, zero writes (no claim, no `AgentRun`, no status change) |
| `N1 — a standalone activity cannot impersonate an execution` (×3) | a **real standalone activity** on a **real worker**, carrying the victim's run id: refused, one attempt row, reservation intact |
| `N1 — inside a workflow the identity is the run id` | the claim a running activity writes equals the run id the server minted |
| `N1 — the claim gate decides the same way without a server` (×4) | the gate's decisions, for CI where no server exists |
| `N1 — the shape of the code leaves no way to supply an identity` (×4) | zero-argument `executionIdentity`; no identity field on an activity input; the guard's position in `execute-agent.ts`; both terminal writes guard-then-delegate |

The reviewer's exact reproduction is the second group. Before AG-603 it produced
`attempt 2: succeeded`; it now produces `EXECUTION_IDENTITY_UNAVAILABLE` and **no second
attempt**.

---

## 2. N2 — a missing workflow run was never classified `absent`

### The defect

`describe()` does not surface the raw gRPC error. `WorkflowClient._describeWorkflowHandler`
converts `NOT_FOUND` into `WorkflowNotFoundError`, which carries `workflowId`/`runId` and
**neither `code` nor a coded `cause`**. The probe classified only by `code === 5`, so a
genuinely missing execution became `unknown`, and the release pass could only ever fire for
*terminal* runs. A claim whose run was deleted or aged out of retention was stranded for ever
— the state F4 exists to prevent. Fail-closed, so availability and documentation accuracy,
not a bypass.

### The fix

`apps/worker/src/reaper.ts:91` — `classifyProbeError()`, used by both probe methods.
Classification is by the error's **identity** first (`instanceof WorkflowNotFoundError`,
which the SDK makes copy-safe through `Symbol.hasInstance`; the error's `name`; and the
`Symbol.for('__temporal_isWorkflowNotFoundError')` marker the SDK's decorator writes), then by
the gRPC code, walking the `cause` chain. Everything else stays `unknown`, and `unknown` still
means **skip**.

### Proof

`reaper.test.ts — classifyProbeError (pure)` (×4, no server, no database):

- a real `WorkflowNotFoundError` from the SDK → `absent`, with an explicit assertion that it
  carries no `code` and no `cause` — the exact shape that made the old classifier return
  `unknown`;
- a bare gRPC 5, and a gRPC 5 hidden behind a `cause` → `absent`;
- a plain error, a deadline (4), **an invalid argument (3)**, `undefined`, a string →
  `unknown`. gRPC 3 is a malformed run id: the claim is wrong, not the execution absent;
- the SDK's marker symbol on a foreign error → `absent`.

`execution-boundary.test.ts — N2 — the shipped probe against a real server` (×3). These run
`createTemporalProbe`, not a stub, against the real server:

| Case | Result |
|---|---|
| claim holder is a UUID the server has never seen | probe → `absent` → **released**, audited `liveness: 'absent'` |
| claim holder is not a valid run id (gRPC 3) | probe → `unknown` → `skipped_unknown`, row untouched |
| the claim's run is a live workflow started under `task-<taskId>` | probe → `active` → `skipped_live`, row untouched |

The `absent` arm was unreachable before this change; the first of those three fails on the
old classifier. The five original F4 tests still stub the probe and still pass unchanged —
they test the release decision, which is a different question from the classification.

---

## 3. N3 — `drive-run.ts start` passed no attempt id

`apps/worker/scripts/drive-run.ts:40,70-85`. `start` now **requires** an attempt id
(`start <taskId> <orgId> <attemptId> [correlationId]`) and refuses before it even connects,
with a message that names the missing argument, says what the attempt id is, where `POST /run`
returns it, and why there is no flag that can stand in for it. Exit code 2.

Proof: `execution-identity.test.ts — N3` (×2) spawns the script through `tsx` and asserts
exit 2, the message, and that nothing was written to stdout.

---

## 4. N4 — terminal writes now check authority

`persistResultActivity` and `completeTaskActivity` are registered activities, dispatched **by
name** and reachable by any workflow on the task queue. Neither read a claim: a Temporal
caller could write an `AgentRun`, the attempt link and the terminal state for a task that
never executed.

### `persistResultActivity` — unconditional

`apps/worker/src/activities/persist-result.ts:57` requires `requireExecutionClaim` before the
first write. It is only ever reached *after* a run, so a claim necessarily exists.

The activity is a thin wrapper around `persistResult`, which is the ~350-line persistence body
and is tested directly as persistence. The split is deliberate: the guard is one line and is
tested as authority; the write is tested as what it records. Neither test pretends to be the
other.

### `completeTaskActivity` — two arms, and why

`apps/worker/src/activities/complete-task.ts:31` calls `requireCompletionAuthority`
(`claim.ts:585`) before its first read.

| Case | Control |
|---|---|
| the named attempt carries a claim | `requireExecutionClaim` — the holder, and only the holder |
| no attempt carries a claim | the caller must be **this task's own execution** (`WorkflowRun`/workflow id `task-<taskId>`, read from the activity context) **and** no attempt of this task may be running or claimed by anybody else. The identity half is tested (`execution-boundary.test.ts:984`, `:1018`); the foreign-attempt conjunct (`claim.ts:765-777`) is **code-only** — no test seeds a running foreign attempt against an otherwise-authorised pre-dispatch call. That test is the trigger to state the conjunct as enforced |

The second arm is not a relaxed claim check — there is nothing for it to relax. A claim does
not exist on that path *by construction*: the claim is deliberately the last thing validation
writes, so a refusal never spends a reservation. Requiring one unconditionally would convert
"the approval gate refused this" into "the task is stuck `queued` for ever", and the
pre-dispatch refusal is a real, tested path (`approval-direct-start.test.ts`,
`risk-approval.e2e-spec.ts`). Before AG-603 that path had **no** check at all; now it has two,
both read from server-set context and neither expressible as an activity input. The arm that
authorised a write is returned as `authority: 'execution-claim' | 'pre-dispatch'`, so
"authorised by the holder" and "refused before any reservation existed" are distinguishable
in the record.

### Proof

`execution-boundary.test.ts — N4` (×4) and `execution-identity.test.ts — N1` (×3), all through
real dispatch:

| Case | Result |
|---|---|
| persistence from an execution holding no claim | `EXECUTION_CLAIM_REFUSED`, zero `AgentRun`, attempt still `queued` |
| completion for an attempt another execution holds | `EXECUTION_ALREADY_CLAIMED`, task unchanged |
| pre-dispatch completion from a workflow that is not `task-<taskId>` | `EXECUTION_CLAIM_REFUSED`, task unchanged |
| pre-dispatch completion from the task's own execution | succeeds, `authority: 'pre-dispatch'`, attempt **not** spent |
| legitimate path (`validate → execute → persist → complete` in one run) | succeeds, `authority: 'execution-claim'` |
| retry of the same run (two executes, one identity) | both proceed; attempts 1 and 2 both carry that claim |

The three cases the contract required not to break were checked explicitly and none of them
does: a retry of the same workflow run proceeds, a legitimate completion after adoption
succeeds, and the reaper's own writes are direct database statements that never pass through
an activity (`reaper.ts`, `claim-release.ts`) — the F4 tests and the two real-probe tests
above still pass.

---

## 5. What was removed or changed, and where it is documented

| Removed / changed | Consequence | Documented at |
|---|---|---|
| `executionIdentity`'s input fallback | A direct or standalone call to any guarded activity is refused. There is no "call the activity from a script" path any more. | `claim.ts` module header; `contracts.ts` field comments |
| `ExecuteAgentActivityInput.executionRunId` | Deleted. Callers that passed it now fail to compile, not silently at runtime. | `contracts.ts`; this document |
| `ValidateTaskActivityInput.workflowRunId` | Deleted. | `contracts.ts`; this document |
| `drive-run.ts start <taskId> <orgId>` | Now requires `<attemptId>`; old invocations exit 2 with a message naming it. | `scripts/drive-run.ts` usage block |
| Unit and integration tests that supplied an identity | Replaced by real executions (`test/helpers/execution-harness.ts` + `test/fixtures/probe.workflow.ts`), or by `claimExecution`/`requireExecutionClaim`'s own decisions, or by an explicit refusal assertion. | file headers of the five suites |
| `persistResultActivity` / `completeTaskActivity` | Guarded. `persistResult` and `completeTask` are the inner writers. | activity headers |
| `runTaskWorkflow`'s failure paths | A refused terminal write no longer suppresses the audit event: the completion is attempted, a failure is logged, and `task.failed.v1` is emitted regardless. | `workflows/run-task.ts` |

### Deliberate consequence: the workflow id in the pre-dispatch arm

A run started under a workflow id other than `task-<taskId>` can no longer write a task's
terminal state before a claim exists. The API starts `task-<taskId>` on both start paths
(`tasks.service.ts:792`, `orchestrator/orchestrator.service.ts:145`); **that is code
inspection — no test asserts the workflow id the API starts**, so "always" is not available
here. A hand-started workflow under a suffixed id now leaves the task non-terminal and must be
cancelled through `POST /cancel`. This is the control doing its job, not a regression, and the
F3 "two direct starts of one task" test still passes because it asserts the workflows end
`failed` with nothing executed, not that they wrote the status.

### CI coverage that moved behind a real server

The identity cannot be fabricated, so the tests whose subject is *dispatch* need a Temporal
server and **skip visibly** without one:

| Suite | Tests gated on a reachable server |
|---|---|
| `execution-boundary.test.ts` | F1 ×4, F2 ×1, F3 ×2, N4 ×4, N2 real-probe ×3 |
| `execution-identity.test.ts` | standalone ×3, in-workflow identity ×1 |
| `isolation-gate.test.ts` | ×4 (was DB-only) |
| `execution-persistence.test.ts` | ×5 (was DB-only) |
| `approval-grant.test.ts` | accepting side ×2 (was DB-only) |
| `approval-attempt-binding.test.ts` | accepting case ×1 (was DB-only) |

`execution-claim.test.ts` and `approval-direct-start.test.ts` were already gated this way.

Measured, with `TEMPORAL_ADDRESS` pointed at a closed port: **197 passed, 54 skipped, 0
failed** (19 of 22 files fully green). With the server up: **239 passed, 12 skipped**.

To keep CI from losing the decisions themselves, the gate's *decision* tests are DB-only and
ungated (`requireExecutionClaim` ×4, `requireCompletionAuthority` exercised through its two
arms, `classifyProbeError` ×4, the structural tests ×4). What CI cannot see is the dispatch
shape — which is precisely the property that requires a server. Adding a Temporal service to
`ci.yml` would close it; that is not in this change and is listed as a residual.

---

## 6. Verification

| Gate | Result |
|---|---|
| `pnpm -w typecheck` | clean (7 workspace projects) |
| `pnpm -w lint` | clean (`--max-warnings=0`) |
| `pnpm -w test` | 72 files, **809 passed, 15 skipped, 0 failed** |
| `pnpm --filter @intelligenz/api test:e2e` | 7 files, **97 passed** |
| `pnpm --filter @intelligenz/worker test` | 22 files, **239 passed, 12 skipped** |
| `apps/worker/test/isolation-gate.test.ts` ×5 | 4 passed, five times |
| worker suite with no Temporal reachable | 197 passed, 54 skipped, **0 failed** |

---

## 7. Residuals that remain

1. **Temporal access is still a trusted capability** (unchanged from F1–F4, and now with one
   less hole in it). Everything here assumes an attacker can start workflows and dispatch
   activities by name. A caller with direct database access can claim an attempt and hold it.
2. **`emitEventActivity` is still unchecked.** N4 named it; the contract narrowed the scope to
   `persistResultActivity` and `completeTaskActivity`. A workflow on this task queue can still
   append an audit event that attributes nothing real — it cannot execute, persist a run or
   move a task's state, but the trail is not fully authenticated. Registering it needs a
   decision about which identity an event *should* carry, which is why it was not folded in
   here.
3. **The pre-dispatch arm trusts the derived workflow id.** `task-<taskId>` is not secret, so
   a caller that can start a workflow with that exact id — possible when no live run holds it,
   because `REJECT_DUPLICATE` only refuses while one exists — could mark an idle `queued` task
   failed. The capability is comparable to `POST /cancel` and it cannot touch a task any
   execution is running, but it is not the same strength as a claim.
4. **CI has no Temporal service**, so the dispatch-level suites skip there (§5). The decision
   tests are the CI-visible floor.
5. **`packages/database`'s seed test counts users globally.** It fails if any concurrent suite
   holds a tenant, which is how an aborted run of the new suite once turned it red. The harness
   now makes `close()` non-throwing so cleanup cannot be skipped, but the seed test's global
   count remains order-dependent by construction.
6. **A task refused under a non-standard workflow id is left non-terminal** (§5), by design.
