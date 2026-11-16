# Phase 7 — acceptance matrix

**HEAD measured at:** `af835c7` · **Branch:** `phase-6/trust-boundary-closure`
**Supersedes nothing.** Phase 6's `PHASE6-GATE-MATRIX.md` remains the record of Gates A–R for that phase; this file answers R-01…R-22 for Phase 7.

## Vocabulary

`PASS` · `FAIL` · `PARTIAL` · `BLOCKED` (external prerequisite) · `NOT TESTED` · `NOT RE-RUN`

`BLOCKED` is never aggregated into `PASS`.

## Matrix

| ID | Condition | Status | Evidence |
|---|---|---|---|
| **R-01** | Repository and worktree recovery | **PASS** | `af835c7`, clean tree, single worktree, no remote. All historical refs (`23db912`, `58476b0`, `9461d27`…`afef7bd`) resolve. Gate G was already closed in-session — recovery was reconciliation, not restart. |
| **R-02** | Prior authorization fixes still valid | **PASS** | Claim at the launch site, identity context-only, release on the recorded pair, write authority — 146 targeted tests green across boundary/claim/identity/reaper. Included in the final SHA. |
| **R-03** | Gate G snapshot integrity | **PASS (scoped)** | `39063b9`. Scope: the agent cannot cause false evidence to be **accepted as authoritative**. F-G20 residual named. |
| **R-04** | Host filesystem attack suite | **PASS** | 5 filesystem probes with negative controls: staging, clean filter, commit, `.git/hooks -> /etc`, FIFO swap, parent swap, nested `.git`, `ctime` rewrite. Probe wall time 183 ms. |
| **R-05** | Process identity separation | **BLOCKED** | uid 1000 holds `(ALL) NOPASSWD: ALL`; `sudo -n true` → root. Any uid split is theatre until removed. |
| **R-06** | Worker cannot read credentials | **BLOCKED** | Same reason. Store `0600` but parents `0775` owned by the same uid. |
| **R-07** | Worker cannot regain root | **BLOCKED** | `sudo -n true` exits 0. This is the gate, and it is one sudoers line. |
| **R-08** | Broker peer authentication | **BLOCKED** | Broker's real client is the **sandbox** (`brokerDir` bind-mounted), so `SO_PEERCRED` cannot discriminate until the sandbox has its own uid. |
| **R-09** | Capability isolation | **BLOCKED** | Depends on R-05/R-08. |
| **R-10** | Credential use bounded | **BLOCKED** | Disclosure can be removed; use cannot. `maxRequests` bounds it; the socket is legitimate. |
| **R-11** | CPU and memory enforcement | **PARTIAL** | `TIER=full`: 53 passed / 3 skipped. The 3 are the cgroup **kill** tests — the kernel refuses migration from a tmux scope outside `/sys/fs/cgroup/intelligenz`; they need `infra/scripts/worker-with-cgroup.sh`. Rate + lifetime budget + peak read-back pass. |
| **R-12** | Disk enforcement | **PASS** | Re-run at `TIER=full`: `volumes.test.ts` green, including the deliberate `ENOSPC` proof. |
| **R-13** | I/O enforcement | **BLOCKED** | `io.max` is **not writable** at `/sys/fs/cgroup/io.max`; available only inside a delegated subtree. Corrects the Phase 5/6 justification. |
| **R-14** | Output enforcement | **PASS** | `output-cap.test.ts` green at `TIER=full` — UTF-8 boundaries, truncation marker + sidecar. |
| **R-15** | Approval and claim regressions | **PASS** | Claim/N12/N13 suites green; 4 independent review rounds with no reopened finding. |
| **R-16** | Cross-tenant adversarial tests | **PASS** | 43 tests / 7 attacks / 4 mutation proofs. No hole found. Three fragilities recorded. |
| **R-17** | CI execution | **BLOCKED** | No git remote, no push credential, no Temporal service in `ci.yml`. Config authored, never executed. |
| **R-18** | Dependency classification | **PASS** | 3 advisories: 1 low, 2 moderate (`glob >=9.0.0 <=14.0.1`, `minimatch >=7.0.0 <11.0.1`, both patched). **0 critical, 0 high.** Both are glob-matching libraries used by tooling, not request-path code. |
| **R-19** | Backup / restore | **BLOCKED** | No backup target, no restore drill. A backup never restored is not a recovery process. |
| **R-20** | Independent final-SHA review | **PARTIAL** | Gate G reviewed at `39063b9`/`c6eb96f` with 7 rounds. Phase 7's own work (Gate M, host assessment) has **not** had an independent review of this SHA. |
| **R-21** | Documentation and evidence index | **PARTIAL** | Phase 6: 14/14 verified present. Phase 7: `PHASE7-GATE-MATRIX.md` and `HOST-PRIVILEGE-ASSESSMENT.md` exist and were verified. **`GATE-M-SUMMARY.md` and `EVIDENCE-INDEX-PHASE7.md` do not exist** — this row previously claimed four documents and measured two, which is a false citation of exactly the class G-21 exists to catch. Corrected in Phase 8 rather than deleted, so the error stays visible. |
| **R-22** | Production-readiness recommendation | **NO-GO** | See below. |

## Why R-22 is NO-GO, stated once

Not for lack of application-layer controls. Gate G holds within its stated scope; Gate M is adversarially proven; the claim has survived four review rounds.

It is NO-GO because **the worker can become root**, and the credential store is `0600` inside `0775` parents owned by that same uid. A single worker-level compromise is root plus every provider key plus operator session history plus a second credential, and un-disclosing data is not possible.

Five gates (R-05…R-10) collapse into one authorisation: remove `(ALL) NOPASSWD: ALL`, keep password sudo. Step 0 — inventory what depends on passwordless escalation — has not been done and must precede the change.

## What moved this phase

| Was | Now |
|---|---|
| Gate M: "absence of proof" | adversarially proven, 43 tests, 4 mutation proofs |
| Gate G: unknown in the directive's premise | closed in-session, PASS (scoped), residual named |
| R-11/12/14: "PASS in Phase 6, not re-run" | re-run at `TIER=full`: 53 passed / 3 host-limited skips |
| R-18: unclassified | 3 advisories classified, 0 high/critical |
| "io.max writable" | **not writable** — correction |
| "lxd is an escalation path" | no socket found — correction, must be re-verified |
| "remove uid 1000 from sudo" | remove **NOPASSWD only** — minimal, reversible, preserves recovery |
| Swap policy | **97% of 4 GiB consumed** — no agent swap policy exists; likely latency cause |
