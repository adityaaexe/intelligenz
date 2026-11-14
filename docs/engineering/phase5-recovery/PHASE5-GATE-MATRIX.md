# Phase 5 — Gate Matrix

Authoritative status. Each row names the evidence, not an intention. `PASS` requires a test or a measurement that could fail.

| Gate | Status | Evidence | What is *not* proven |
|---|---|---|---|
| **A — Credential custody** | **NOT STARTED** | — | The credential store is owned by the worker's UID. Phase 4 kept the broker boundary; custody separation needs a distinct service identity and a supervisor this host lacks. |
| **B — Isolation tier** | **PASS (truthful tier) + BLOCKED (level 3)** | D-007; `/dev/kvm` ENOENT and no `vmx`/`svm`; refusal test creates 1 failed attempt, 0 AgentRun, 0 workspace, 0 tool invocation | A VM tier cannot exist here. bwrap is `restricted-shared-kernel` and is never described otherwise. |
| **C — CPU / memory** | **PASS** | `cpu-budget.test.ts` 16 (13 + 3 tier-gated); `cgroup.test.ts` under the privileged wrapper; effective limits read back equal profile | The real `cgroup.kill` on budget breach is exercised only under `worker-with-cgroup.sh`. |
| **D — Disk** | **PASS (per attempt)** | 1100 MiB into a 974 MiB volume → `ENOSPC`; host unaffected; `volumes.test.ts` 16 | Host-wide storage partitioning does not exist. Loop images are sparse: 8 concurrent attempts can exceed host free space. |
| **D — I/O** | **PARTIAL** | `io.max` accepted (`7:6 rbps=8388608 wbps=8388608`); controller delegated (`cpu io memory pids`) | **Migration denied** from an ordinary session; raw device is root-only. Enforcement is only demonstrable inside the privileged wrapper. |
| **E — Output cap** | **PASS** | `output-cap.test.ts` 24; retained bytes never exceed the cap, including 64×64 KiB post-truncation writes | — |
| **F — Approval → attempt** | **PASS, with a known TOCTOU** | Attempt created inside the consumption transaction; live row shows `consumedByAttemptId`; 12 API + 17 worker tests | Two executions holding the genuine attempt id can both validate while `queued`; closing it needs a claim token the execution path honours. |
| **G — Integrity** | **NOT STARTED** | — | A repo-defined git filter can still shape `diff.patch`. Needs a snapshot-based verifier that does not invoke repository-controlled helpers. |
| **H — Recovery** | **INHERITED** | Phase 4: 13 reaper tests | Re-verification after Phase 5 schema changes not repeated. |
| **I — Multi-tenancy** | **NOT STARTED** | — | One org seeded; no hostile-tenant exercise. |
| **J — Evaluation** | **INHERITED** | 8 benchmarks, mode/version refusal, security violation forces 0 | Real baseline still BLOCKED by provider quota. |
| **K — CI** | **BLOCKED** | No `gh`, no remote, no push credential | Workflows authored; never executed. Local gates are not CI. |
| **L — Supply chain** | **PARTIAL** | `pnpm audit --audit-level high` exit 0 (0 high/critical; 1 low, 2 moderate) | No SBOM generated; 3 advisories unclassified in writing. |
| **M — Audit** | **NOT STARTED** | — | Phase 4's audit covered Phase 4. Nothing has independently attacked the Phase 5 controls. |
| **N — Operations** | **NOT STARTED** | — | No runbook, no retention policy, no backup. |

## What changed in this cycle

- **B** moved from *documented but unenforced* to *enforced and tested*. Before this cycle, a VM-required profile would have silently run on the shared-kernel tier — the exact failure D-007 exists to prevent.
- **D-disk** moved from *configured* to *kernel-enforced*, proven by `ENOSPC`.
- **E** moved from *declared* to *enforced*.
- **C-lifetime** moved from *implemented* to *tested*, with the rate-throttle vs lifetime-kill distinction asserted.
- **F** moved from *presumed* to *structurally bound*.

## One observed flake, recorded

`apps/worker/test/isolation-gate.test.ts > proceeds under restricted-shared-kernel` failed **once** in four runs, then passed 3/3 consecutively. Suspected cause: volume-pool contention when the suite runs immediately after the full suite. Not reproduced in isolation. It is a flake until proven otherwise, and a flaky test is not evidence — it is a pending defect.

## Verdict

**CONDITIONAL PASS** at the phase level. The resource and isolation controls are real. Six gates remain unimplemented, and two (A, G) are security-relevant rather than cosmetic.
