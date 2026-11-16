# Phase 8.8 — execution report

**Branch:** `phase-6/trust-boundary-closure`
**Code head measured:** `d7a817d61a06` (documentation commit follows)
**Worktree:** clean apart from the documents this report is part of, committed with it
**Production:** **NO-GO**
**Phase status:** **PARTIAL** — three of the four tasks advanced, one blocked on evidence

---

## 1. Checkpoints, in the required format

| Field | P87-011 | P87-010 | P87-012 |
|---|---|---|---|
| Task | intermittent approval-binding failure | programme cancellation | deadline semantics |
| Files changed | `apps/api/test/approval-attempt-binding.e2e-spec.ts`, two manual tools, `eslint.config.mjs` (scoped `test/manual/**` override) | `programmes.controller.ts`, `programmes.service.ts`, `orchestrator.service.ts`, `api-contract.md`, worker/API tests, 2 docs | `run-programme.ts`, `programme-deadline.test.ts`, `execution-harness.ts`, one assertion strengthened in `programme-execution.test.ts`, 1 doc |
| Behaviour changed | none in production; a failure now carries its evidence | a MEMBER can stop a programme; the writer of the terminal state is decided by `startedAt` | an unparseable deadline fails closed; the deadline and `GRAPH_INVALID` paths return the status the row holds |
| Tests executed | 40 isolated + 50 batches + full suite | 4 worker + 8 API + full suite | 5 new + full suite |
| Pass/skip | see §3 | see §3 | see §3 |
| Verifier | controller | controller | controller |
| Reviewer verdict | controller reviewed the diff: assertions unchanged, override scoped, prettier red is pre-existing | controller reviewed the branch logic, role, and single-writer rule | controller reviewed the fix and the strengthened assertion |
| Commit | `7fa4dd9` | `78c7ff2`, `ad1e54d` | `701d134`, `d7a817d` |
| Blocker | **not reproduced** — blocked on a captured occurrence | none | deadline visibility (L1), deferred |
| Next eligible | P88-003 | P88-001 | P88-002 |
| Continued without a prompt | yes — P87-010 began on acceptance of P87-011 | yes — P87-012 began on acceptance | yes |

## 2. What each task established

### P87-011 — BLOCKED, with the mechanism ruled out

~95 executions produced no reproduction: 8 then 7 full-suite runs, **40 consecutive runs of
the failing spec**, and 50 batches of an n-way reproducer at 2 and 4 contenders. The leading
explanation — a foreign-key share lock forming a cycle with the task update — was **tested and
disproven**: `UPDATE task SET status` takes `FOR NO KEY UPDATE`, which is compatible with
`FOR KEY SHARE`, so the cycle never forms (`run-deadlock-probe.ts` printed
`DEADLOCK_OBSERVED=false` twice, in two independent runs).

The test now attaches both statuses, both error codes, the ids and the four row counts to its
assertions. **No expected value, assertion or tolerance changed.** The message was proved
inert on success (159 e2e runs print nothing) and useful on failure (a temporarily-broken
expectation printed the full evidence object, then the file was restored byte-identically).

### P87-010 — PASS

`POST /v1/orgs/:orgId/programmes/:programmeId/cancel`, `@Roles('MEMBER')`. The single-writer
rule is the part that matters:

| `startedAt` | Writer | Response |
|---|---|---|
| set | the workflow's non-cancellable scope | `202 requested` |
| null | the API, under `status='pending' AND startedAt IS NULL` | `202 cancelled_before_start` |

Without the null branch, a programme cancelled before its scheduler started would sit
`pending` for ever: no workflow exists to record anything. The API answers 404 for another
tenant (never 403), 409 for a terminal programme or an unreachable execution, 503 for an
outage — and writes nothing on any refusal.

### P87-012 — PASS

Two truthfulness defects and one fail-open:

| Path | Row | Returned before | Returned now |
|---|---|---|---|
| deadline passed | `timed_out` | `blocked` | `timed_out` |
| deadline unparseable | — | **ran to completion** | `timed_out` |
| `GRAPH_INVALID` | `failed` | `blocked` | `failed` |

The tests were run against the **pre-fix** workflow and produced exactly three failures
(`blocked` vs `timed_out`, `succeeded` vs `timed_out`, `blocked` vs `failed`) and two passes —
the negative control and the Continue-As-New proof, which must pass either way. That is the
evidence that the tests detect the defects rather than describing them.

`deadlineAt` surviving the boundary is proved from the **second run's own
`WorkflowExecutionStartedEventAttributes.input`**, not inferred from "it completed".

## 3. Verification, measured on the code head

| Gate | Result |
|---|---|
| `pnpm -w typecheck` | exit 0 |
| `pnpm -w lint` (`--max-warnings=0`) | exit 0 |
| `prisma validate` | valid |
| `pnpm -w test` | **98 files, 1073 passed, 15 skipped**; skip budget 15 = baseline |
| API E2E run 1 | exit 0, **167 passed**, 23 s |
| API E2E run 2 | exit 0, **167 passed**, 22 s |
| API E2E run 3 | exit 0, **167 passed**, 22 s |
| `pnpm programme:check` | **VALID**, 32 tasks (15 completed, 6 blocked, 11 planned) |
| Migrations | **11**, unchanged in Phase 8.8 — the 11th (`failureCode`) came from `0b68b9b`; dev and `_test` up to date |
| `git status` | clean after the documentation commit |

## 4. Deliverables

| File | Status |
|---|---|
| `BASELINE-RECONCILIATION.md` | written from measurement |
| `P87-011-APPROVAL-BINDING-INVESTIGATION.md` | NOT REPRODUCED, mechanism disproven |
| `PROGRAMME-CANCELLATION-CONTRACT.md` | implemented |
| `PROGRAMME-CANCELLATION-E2E-REPORT.md` | 9 covered, 3 NOT RUN with reasons |
| `DEADLINE-SEMANTICS-AND-PROOF.md` | implemented, limitations listed |
| `APPROVAL-RESUMPTION-DECISIONS.md` | decision package, **no code** |
| `PHASE88-GATE-MATRIX.md` | gate-by-gate |
| `PHASE88-EXECUTION-REPORT.md` | this file |
| `PHASE9-TELEMETRY-CONTRACT.md` | contract; ingestion **NOT RUN** |
| `OBSERVABILITY-ARCHITECTURE.md` | design; OTel not installed |
| `COST-MODEL.md` | model; money **not computable** |

## 5. What is not done, with the blocker named

| Item | Status | Blocker |
|---|---|---|
| P87-011 root cause | **BLOCKED** | no captured occurrence |
| P87-009 approval resumption | **BLOCKED_POLICY** | D1–D3 |
| One node can stay `running` after cancellation | **OPEN** (P88-001) | needs the cancellation handler to know the in-flight node |
| Deadline not visible to operators | **OPEN** (P88-002) | needs a decision, not a column |
| P2034/P2028 unmapped | **OPEN** (P88-003) | not this phase's failure cause |
| Telemetry ingestion | **NOT RUN** | no SDK, no tool, no verified project identity |
| Tracing | **NOT RUN** | OTel not installed |
| Money cost | **NOT COMPUTABLE** | no token accounting, no price table |
| Figma control centre | **BLOCKED** | no file key supplied |
| P83-003/004, P83-005, P83-006, P83-007/008, P83-011 | **BLOCKED/OPEN** | unchanged from Phase 8.7 |

## 6. Corrections made to earlier documents

Phase 8.8 found and fixed three factual errors in documents written during Phase 8.7 — all
the same mistake, and all around the migration count:

| Document | Said | Correct |
|---|---|---|
| `PHASE87-REPORT.md` (baseline row and verification row) | 10 migrations after Phase 8.7 | **11** — the count was measured at `0a222ba`, and `0b68b9b` then added the `failureCode` migration |
| `BASELINE-RECONCILIATION.md` (this phase's) | 10 | **11** |
| `NEXT-SESSION-HANDOFF.md` (8.7 checkpoint) | 19 models / 10 migrations | 19 / **11** |

The code was never wrong; the documents were stale by one commit. They are corrected in place
with the reason, not silently overwritten, because a report that quietly changes its numbers is
indistinguishable from one that was never checked.

## 7. Verdict and next task

**Production: NO-GO.** No deployment, migration, credential rotation, host change, push or
pull request. Ports 3000/4000 were not touched.

**Next eligible task: P87-011 remains the highest-value open item** and it cannot be advanced
by more green runs. The next *executable* task is **P88-001** (settle the interrupted node on
cancellation), then **P88-003** (map transaction conflicts), then **P88-002** (deadline
visibility, which needs a decision). P87-009 waits on D1–D3, and Phase 9's ingestion waits on
a tool and a credential that this environment does not have.

The programme continued from one accepted task to the next without a new operator prompt
(P87-011 → P87-010 → P87-012 → ledger/docs). It stopped only where a human decision or a
missing external capability genuinely blocks the task, not the whole programme.
