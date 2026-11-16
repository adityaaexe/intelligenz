# Phase 8.8 — gate matrix

**As of:** HEAD `d7a817d` plus the documentation commit that carries this file.
**Rule:** a gate is PASS only with evidence produced in this phase. Inherited evidence is
labelled as inherited. A skip is not a pass; a green rerun does not close an unexplained
failure.

---

## 1. The four Phase 8.8 tasks

| Gate | Status | Evidence |
|---|---|---|
| **P87-011** intermittent approval-binding failure | **BLOCKED** | `P87-011-APPROVAL-BINDING-INVESTIGATION.md`. ~95 executions, no reproduction: 8 then 7 full-suite runs, 40 consecutive isolated runs, 50 n-way contention batches. The lock-cycle hypothesis was **disproven** (`run-deadlock-probe.ts`: `DEADLOCK_OBSERVED=false`, because a non-key `UPDATE` takes `FOR NO KEY UPDATE`, compatible with the FK's `FOR KEY SHARE`). The test now attaches statuses, codes and counts to its failure message; assertions and expected values unchanged. Blocked on a captured occurrence. |
| **P87-010** programme cancellation | **PASS** | `PROGRAMME-CANCELLATION-CONTRACT.md`, `PROGRAMME-CANCELLATION-E2E-REPORT.md`. Route, role, codes and the single-writer rule implemented; 4 worker tests + 8 API tests; child cleanup and no-orphan invariants asserted on rows. 9 of the directive's 12 scenarios covered; 3 **NOT RUN** with mechanical reasons. |
| **P87-012** deadline semantics | **PASS** | `DEADLINE-SEMANTICS-AND-PROOF.md`, `programme-deadline.test.ts` (5 tests). Fail-open `NaN` closed; return value now agrees with the row on the deadline and `GRAPH_INVALID` paths. The new tests were run against the **pre-fix** workflow and produced 3 failures / 2 passes, so they are known to detect the defects. |
| **P87-009** approval resumption | **BLOCKED_POLICY** | `APPROVAL-RESUMPTION-DECISIONS.md`. D1–D3 unanswered; D4/D5 have safe defaults. No endpoint, column or event added. |

## 2. Phase 8 host-boundary gates (unchanged, not re-litigated)

| Gate | Status | Why |
|---|---|---|
| P83-003 / P83-004 credential custody | **BLOCKED** | Requires explicit operator authorisation for the sudoers/host change. `sudo -n true` still returns root. Not attempted. |
| P83-005 CI | **BLOCKED** | No remote, no push credential, no Temporal service in CI. Local CI-equivalent validation was run instead. |
| P83-006 backup/restore | **BLOCKED** | No approved backup target and no restore drill environment. No destructive test run. |
| P83-007 / P83-008 per-attempt isolation | **OPEN** | `maxConcurrent` remains **1**; no default changed. The existing I/O throttle proof is leaf-level, not per-attempt. |
| P83-011 missing Phase 7 documents | **BLOCKED** | Two cited documents still do not exist; R-21 remains PARTIAL. |

## 3. Phase 9 gates

| Gate | Status | Why |
|---|---|---|
| Telemetry contract | **PASS (document)** | `PHASE9-TELEMETRY-CONTRACT.md`, taxonomy mapped to audit events, with the missing audit events named. |
| SDK installed | **NO** | No PostHog dependency exists. |
| Project identity verified | **NOT RUN** | No PostHog tool exists in this session (`search("posthog")` → nothing) and no credential is available. |
| Controlled event sent / read back | **NOT RUN** | Same. No synthetic event was sent to fake progress. |
| Observability architecture | **PASS (document)** | `OBSERVABILITY-ARCHITECTURE.md`. OTel is **not** installed; the design states the prerequisites. |
| End-to-end trace observed | **NOT RUN** | No instrumentation. |
| Cost model | **PASS (document)** | `COST-MODEL.md`. CPU-seconds measurable; **money not computable** — no token accounting, no price table. |

## 4. Phase 10 gate

| Gate | Status | Why |
|---|---|---|
| Control-centre Figma | **BLOCKED** | No INTELLIGENZ file key supplied. No file created, no credits spent. The Phase 8.7 control-plane requirements stand as the local specification. |

## 5. Invariants that must not have moved

Each is checked by an existing test that fails if the control is removed; none was edited in
this phase.

| Invariant | Status | Where |
|---|---|---|
| Boot enforcement gate refuses outside its subtree | **preserved** | `execution-enforcement.test.ts` |
| One-shot execution claim (CAS) | **preserved** | `execution-claim.test.ts` |
| Approval bound to the exact attempt | **preserved** | `approval-attempt-binding` + worker suites |
| Launch-site authority / pre-dispatch intent gate | **preserved** | `execution-boundary.test.ts` |
| Evidence provenance | **preserved** | `evidence-*` suites |
| Audit idempotency | **preserved** | audit assertions in every suite |
| cgroup enforcement | **preserved** | `cgroup*`, `io-limits`, `cpu-budget` (tier-gated skips, baseline 15) |
| Ten-activity contract | **preserved** | `contract.test.ts`, exact match |

## 6. Production

**NO-GO.** Mandatory gates still open: credential custody, host privilege closure,
per-attempt isolation, CI, backup/restore, verified telemetry, and the unexplained P87-011.
