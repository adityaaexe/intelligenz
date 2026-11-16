# Phase 8.7 — governed planner, programme lifecycle and authority review

**Branch:** `phase-6/trust-boundary-closure`
**Baseline:** `3e56ef851777fc7fcc6d455c1b5879520ab3df85`
**Code head at the time of writing:** `0b68b9ba11c9d96e128cd143156f2868b8ba74fa`
**Production:** **NO-GO**
**Overall phase status:** **PARTIAL**

PARTIAL, not PASS, for four stated reasons: the real planner provider was never
exercised (no credentials), approval resumption is blocked on a governance decision,
journey 8 is partial (no programme-level cancel endpoint), and one intermittent E2E
failure was observed and never reproduced. Every other completion criterion is met with
evidence below.

---

## 1. Baseline comparison

Verified from the filesystem, not from the session report.

| Item | Reported | Observed | Verdict |
|---|---|---|---|
| HEAD | `3e56ef8` | `3e56ef851777fc7fcc6d455c1b5879520ab3df85` | exact |
| Branch | `phase-6/trust-boundary-closure` | same | exact |
| Worktree | clean | `git status --porcelain` empty | exact |
| Ancestry | `2321c0d`, `b4408e8`, `3e56ef8` | all ancestors (also `4f10d67`, `1cf3c58`) | exact |
| Models | 18 | 18 | exact |
| Migrations | 9 | 9 at baseline → 10 after Phase 8.7 | exact |
| Activities | 10 | 10 (`apps/worker/src/activities/index.ts`) | exact |
| Temporal / Prisma / zod | — | 1.25.0 / 7.10.1 / 4.6.7 | recorded |
| Node / pnpm | — | 22.23.2 / 10.15.1 | recorded |
| `pnpm programme:check` | VALID | VALID, 14 tasks | exact |
| Suite | 1015 passed / 15 skipped / 92 files | same, measured twice | exact |
| typecheck / lint | exit 0 | exit 0 / exit 0 | exact |
| `PRODUCTION_SPEC.md` | — | absent; the directive's "if present" does not apply | recorded |

No divergence. Nothing was reset, cleaned or overwritten.

## 2. Commits and files

| Commit | Subject | Files | Insertions |
|---|---|---|---|
| `34eaedf` | give a programme child its task's id, and make the reservation answer truthfully | 18 | 1682 |
| `fced403` | define the proposal contract and the Plan row a decision binds to | 8 | 796 |
| `0a222ba` | propose plans that only a human, and only identical bytes, can authorise | 19 | 2754 |
| `0b68b9b` | give a programme's stop reason a code, and cross its continue-as-new boundary | 16 | 1114 |

`3e56ef8..0b68b9b`: **49 files changed, 6343 insertions, 183 deletions.** Nothing pushed
(no remote exists).

## 3. Authority boundary — review and remediation

### 3.1 Method

An independent reviewer was used and instructed to treat the repository's comments as
*claims*, not evidence — this codebase has a history of comments that overstate controls.
The reviewer answered ten specific questions with `file:line` citations and returned a
trust-boundary table plus 11 findings.

The lead then re-verified six load-bearing facts before accepting the review, because a
review is also a claim:

| Fact | Result |
|---|---|
| SDK `startChild` default id is `workflowId ?? uuid4()` | confirmed in `@temporalio/workflow` 1.25.0 |
| `parentClosePolicy` defaults to `TERMINATE`; child cancellation to `WAIT_CANCELLATION_COMPLETED` | confirmed in SDK `interfaces.d.ts` |
| `POST /cancel` targets `task-<taskId>` and wrote `cancelled` even on `not_found` | confirmed `tasks.service.ts` |
| `dispatch_failed` maps to node `failed` | confirmed `shared/programme.ts` |
| Checkpoint upsert omits `taskId` from its update predicate | confirmed `programme.ts` |
| Reservation reads the programme without `status`; the status gate precedes the idempotency check | confirmed `programme.ts` |

### 3.2 Verdicts, after remediation

| Boundary | Verdict at review | Verdict now |
|---|---|---|
| Programme submission | ENFORCED | ENFORCED |
| Task reservation | PARTIAL (authority arm untested) | **ENFORCED** (AUTH-10 test added) |
| Attempt creation | PARTIAL | **ENFORCED** (retry-after-commit fixed) |
| Attempt claim | ENFORCED | ENFORCED |
| Approval binding | ENFORCED | ENFORCED |
| Child execution | PARTIAL (random UUID id) | **ENFORCED** (`task-<taskId>`) |
| Evidence persistence | PARTIAL (checkpoint relabel) | **ENFORCED** (`taskId` in predicate) |
| Cancellation | **UNENFORCED** (advisory) | **ENFORCED** for task-scoped cancellation; programme-level cancel endpoint absent (P87-010) |

### 3.3 The two HIGH defects, and what they meant

1. **A lost activity response wedged a task.** The reservation committed, then the retry
   saw `Task.status='queued'` — a state the reservation itself had written — and answered
   `not_runnable`. The node was recorded `failed`, no child started, and the task sat
   `queued` with an unclaimed attempt that no sweeper reclaims.
2. **Cancellation was advisory.** The child ran under a random UUID, so `POST /cancel`
   never named it; the API still wrote `cancelled`; the child kept working, later emitted
   `task.succeeded.v1`, and `completeTaskActivity` flipped the run back to `succeeded`.
   A user-cancelled task reported success.

Neither was an attacker-driven defect. Both were reachable in normal operation.

### 3.4 What the review does not prove

No adversarial Temporal client was exercised; the namespace is trusted. A compromised
worker can bypass every in-activity check. Concurrency arguments rest on PostgreSQL READ
COMMITTED semantics, not on a measured race. These are recorded, not waved away.

## 4. Planner — proposal-only, and why it cannot authorise

Pipeline, as implemented:

```
POST /plans (objective) ──► provider (HTTP, untrusted JSON) ──► zod strict parse
        ──► validateProposedPlan (reuses validateProgrammeGraph) ──► Plan row: proposed | invalid
POST /plans/:id/approve (ADMIN, not proposer) ──► hash + approver + expiry ──► approved
POST /plans/:id/submit (MEMBER) ──► hash check, expiry check, revalidation
        ──► TasksService.create ──► draft→ready ──► ProgrammesService.submit ──► runProgrammeWorkflow
```

`PlanStatus = proposed | invalid | approved | rejected | submitted` — five values, each
with a writer. `invalid` can never be approved. `rejected` and `submitted` are terminal.
`approved` cannot be rejected.

The four separations that make it governance rather than automation:

1. **Model output is data.** Strict schema; unknown fields refused, so a model cannot
   supply `provider`, `simulated`, `status`, `approvedContentHash` or `programmeId`.
2. **Validation is not the planner's.** Graph rules are delegated to
   `validateProgrammeGraph`; there is no second cycle detector.
3. **Approval is a human, and only identical bytes.** The approver is the JWT subject;
   `approvedContentHash` binds the decision to the exact proposal; submission recomputes
   the hash and refuses a mismatch.
4. **Approval is not execution authority.** `approve()` contains no call to the task
   service, the programme service or the orchestrator. Asserted by row counts: approving
   creates zero `Task`, zero `Programme`, zero `ExecutionAttempt`.

Risk class is passed as a **claim** and the server derives the effective class. A plan
claiming `LOW` for "deploy … production" materialises as `CRITICAL`, stays `ready`, and
opens an `ApprovalRequest` that is `PENDING` — never a grant. The planner does not spend,
mint or consume approvals.

### What is not proven here

- No real model was called. The provider is `http-llm` and is unconfigured in this
  environment; every claim above was exercised against a `127.0.0.1` stub on port 0.
  **Real-LLM planning: NOT RUN.**
- Plan-to-execution was not driven end-to-end for a HIGH task; that assertion belongs to
  the worker suite and was not added.
- Concurrent double-submit was tested as idempotent retry, not as two parallel requests.

## 5. Lifecycle

`PROGRAMME-TRANSITIONS.md` records the seven statuses, the three writers, every legal edge
and the durable timestamps. Reconciliation decisions, with reasons:

- `proposed / validating / awaiting plan approval / ready` are **Plan** states. A programme
  row does not exist until an approved plan is submitted.
- No `cancelling` status: the terminal write is one conditional UPDATE inside a
  non-cancellable scope; a `cancelling` row would have no writer.
- No `partially_completed` status: per-node statuses and checkpoint outcomes already carry
  partial completion; duplicating them would create a second source of truth.

`Programme.failureCode` is now machine-readable (`TASK_FAILED`, `APPROVAL_PENDING`,
`DEPENDENCY_BLOCKED`, `NO_READY_NODE`, `DEADLINE_EXCEEDED`, `ORCHESTRATOR_UNAVAILABLE`,
`START_FAILED`, `GRAPH_INVALID`, `CANCELLED`, `UNSPECIFIED`), written in the same UPDATE as
the status and cleared on success. A NULL column is read as `UNSPECIFIED`, never as
success.

`succeeded` requires every node `succeeded`; the code derives it from node states alone.

## 6. Approval resumption — BLOCKED, deliberately

Three independent blockers, each verified: the workflow closed under
`ALLOW_DUPLICATE_FAILED_ONLY` so its id cannot be reused; nothing observes an approval
decision; and the terminal row is refused by the reservation (a control this phase
hardened). The approval policy itself is fully defined (ADMIN, four-eyes, expiry,
revocation, single use) — what is undefined is whether a *stopped programme* may be
re-opened.

**No endpoint, no schema field, no "ready for later" column was added.**
`APPROVAL-RESUMPTION-DESIGN.md` names five decisions; D1–D3 are blocking. Journeys 6 and 7
are therefore NOT RUN, and are reported as blocked rather than skipped.

## 7. Concurrency and isolation — NOT DONE

`maxConcurrent` remains **1** and no default changed. P83-007 (per-attempt `io.max`) and
P83-008 (per-attempt accounting) remain open. The existing I/O throttle proof
(245 MB/s → 4.3 MB/s on the worker leaf) is **not** per-attempt isolation, and this phase
does not claim it is.

## 8. Continue-As-New — PASS, and it found a real bug

`apps/worker/test/programme-continue-as-new.test.ts`:

- 5-node chain, boundary `2`, `maxConcurrent: 1` → **3 runs, 2 crossings**, programme
  `succeeded`, checkpoints `[1,2,3,4,5]` with no duplicate sequence (a restart at zero
  would have collided on `@@unique([programmeId, sequence])`), each checkpoint naming the
  attempt that claimed it.
- Crossing is established from the execution history: `status.name === 'CONTINUED_AS_NEW'`
  plus `WorkflowExecutionContinuedAsNew.newExecutionRunId`. `describe()` in SDK 1.25.0 does
  **not** expose `continuedExecutionRunId`; the report records the field actually used.
- **Negative control:** the same chain with the boundary above the checkpoint count does
  not cross (`continuedAsNewRunId === ''`, one run). Without it, the positive assertion
  could be always-true.

The test forced a fix: the backstop compared the **cumulative** checkpoint count, so after
the first crossing the predicate was true on the first iteration of the next generation —
an infinite continuation loop that records nothing. The counter is now per execution. This
defect was structurally unreachable before a test crossed the boundary, which is the
argument for crossing it.

## 9. Tests

| Gate | Result |
|---|---|
| Planner contract (pure) | 24 passed |
| Graph validator (existing) | 9 passed |
| Worker activity contract | 6 passed — exactly ten activities |
| Programme execution + reason codes + continuation | 21 passed (all files) |
| Full suite | **96 files, 1064 passed, 15 skipped**, skip budget 15 = baseline |
| API E2E, run 1 | exit 0, 10 files, 159 passed, 21 s |
| API E2E, run 2 | exit 0, 10 files, 159 passed, 21 s |
| API E2E, run 3 | exit 0, 10 files, 159 passed, 21 s |
| typecheck | exit 0 |
| lint (`--max-warnings=0`) | exit 0 |
| `prisma validate` | valid |
| migrations | 10; dev and `_test` both "up to date" |
| `pnpm programme:check` | VALID, 26 tasks |

### The ten required journeys

| # | Journey | Status |
|---|---|---|
| 1 | one objective → valid three-task plan | **PASS** |
| 2 | malformed graph rejected before Programme/Attempt | **PASS** |
| 3 | plan approval cannot execute before it | **PASS** |
| 4 | approved plan submits exactly once | **PASS** |
| 5 | failure isolation intact | **PASS** |
| 6 | approval-gated task resumes after valid approval | **BLOCKED** (D1–D3) |
| 7 | duplicate approval signals → no duplicate claims | **BLOCKED** (D1–D3) |
| 8 | cancellation stops dispatch, durable terminal state | **PARTIAL** (child cancellation proven; no programme cancel endpoint) |
| 9 | planner/provider failure truthful | **PASS** |
| 10 | crosses Continue-As-New, state preserved | **PASS** |

### One unresolved failure

`approval-attempt-binding.e2e-spec.ts` → "reserves exactly one attempt and one grant, and
refuses the loser with 409" failed **once** in eight full-suite runs, then passed seven
consecutive times and passed in isolation. The assertion was not captured, so the mechanism
is unknown. The diff for the commit in question does not touch the `POST /run` path
(verified). Recorded as **P87-011**, open, with the evidence that exists and the evidence
that does not. The final three-run gate passed.

## 10. PostHog — design only, no events

`ingested_event = false`; no event has been observed in 30 days. No projector exists, no
event was sent, and **no adoption, usage or programme-success claim may be made**.
`TELEMETRY-EVENT-CONTRACT.md` defines twelve events against the audit log as the single
source of truth, with typed, content-free properties (no objectives, goals, criteria,
prompts, notes, paths or hashes). Rollout is gated on observing a real event before any
dashboard is built.

## 11. Figma and UI — nothing created

No INTELLIGENZ Figma file key was supplied. No file was created, no credits spent, no UI
code changed. `CONTROL-PLANE-UX-REQUIREMENTS.md` states the one rule — a proposed plan must
never look approved — and the status presentation, accessibility and API mapping a future
surface must follow.

## 12. Ledger and handoff

`EXECUTION-STATE.json`: **VALID**, phase `8.7`, 26 tasks (13 completed, 5 blocked, 8
planned), history appended with the Phase 8.7 entry. P83-003…P83-011 statuses preserved.
`NEXT-SESSION-HANDOFF.md` carries the Phase 8.7 checkpoint and the cold-start command.

## 13. Completion criteria

| # | Criterion | Status |
|---|---|---|
| 1 | Baseline reconciled | **PASS** |
| 2 | Authority review completed and independently challenged | **PASS** |
| 3 | Planner produces a structured proposed graph | **PARTIAL** — pipeline proven; real model NOT RUN |
| 4 | Validation rejects before execution | **PASS** |
| 5 | Plan approval separate from execution approval | **PASS** |
| 6 | Existing programme workflow executes the validated plan | **PASS** |
| 7 | Resumption proven or policy-blocked | **BLOCKED** (recorded, not invented) |
| 8 | Failure isolation intact | **PASS** |
| 9 | Long-running handling proven or explicit limitation | **PASS** |
| 10 | Required tests pass | **PASS** |
| 11 | Three consecutive E2E runs exit zero | **PASS** |
| 12 | Ledger and handoff validate | **PASS** |
| 13 | Worktree clean after commit | **PASS** |
| 14 | Production NO-GO | **PASS** |

## 14. Unresolved human decisions

| ID | Decision | Blocks |
|---|---|---|
| **D1** | May an ADMIN re-open a blocked programme, on the same row? | P87-009 |
| **D2** | May an approval decision cause a dispatch attempt, or must a human call `POST /run`? | P87-009 |
| **D3** | Maximum resumes, and does the original deadline survive? | P87-009 |
| D4, D5 | Confirm expiry-at-claim and `succeeded`-via-external-run | P87-009 (safe defaults proposed) |
| **P83-003/004** | Authorisation to remove `(ALL) NOPASSWD: ALL` | Gate A credential custody |
| P83-005 / P83-006 | CI remote and Temporal in CI; backup target and drill | delivery gates |

## 15. Production verdict and next eligible task

**Production: NO-GO.** No deployment, no production migration, no credential rotation, no
host configuration change was performed.

**Next eligible task: P87-011** — reproduce the intermittent
`approval-attempt-binding` failure and capture its assertion. It is unblocked, it is about
whether the suite's green result can be trusted, and it must be settled before the next
phase treats a green run as evidence. Then **P87-010** (programme cancel endpoint), then
**P87-012** (deadline return value), then **P87-009** once D1–D3 are decided.
