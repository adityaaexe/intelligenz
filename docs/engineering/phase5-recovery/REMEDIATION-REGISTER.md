# Phase 5 — Remediation Register

Every defect found during this phase, what fixed it, and what remains.

## Fixed this cycle

| # | Defect | Impact | Fix | Regression |
|---|---|---|---|---|
| R1 | `volumes.release()` deleted the volume's bytes **before** checking ownership (`volumes.ts:831`) | A stale or forged lease could wipe another attempt's `/repo` and evict the real holder's in-process lease — cross-attempt data destruction | Ownership decided from the lock **and** the in-process entry before any deletion; non-owner release is a no-op | 2 tests, both failed on the live checkout first |
| R2 | VM-required profiles were never refused; D-007's fail-closed rule was documented and unenforced | A task asking for a virtual machine would silently run on the shared-kernel tier — false assurance of the strongest claim in the product | Gate before provisioning; typed `ISOLATION_TIER_UNAVAILABLE`, non-retryable, one failed attempt, zero AgentRun/workspace/tool invocations | 4 gate tests + 13 unit + 6 API |
| R3 | `apps/api` `typecheck` excluded test files; `typecheck:test` was invoked by nothing | Four fixture type errors survived at HEAD, invisible to the main gate — a gate that did not cover what it claimed | `typecheck` now chains both tsconfigs, matching the worker | 4 errors → 0 |
| R4 | cgroup capability probe reported `enforced` on a plain directory (found earlier in Phase 5) | A control that overstated isolation is worse than none — it converts "unverified" to "falsely verified" | Verify cgroup2 superblock magic, controller delegation, and read-back before reporting | plain directory → `CGROUP_NOT_CGROUP2` |

## Open — security-relevant

| # | Item | Why it matters | What closes it |
|---|---|---|---|
| O1 | **Approval TOCTOU** — two executions holding the genuine attempt id can both validate while the attempt is `queued` | With Temporal access plus the attempt id, a second agent can run | A one-shot `claimed` state written by validation and honoured by the execution path; must not break crash-retry |
| O2 | **Credential custody** — the store is owned by the worker's UID | Worker-level compromise reads every provider credential | Distinct service identity + supervisor; on this host, a privilege-drop wrapper with a dedicated user |
| O3 | **Diff integrity** — a repo-defined git filter can shape `diff.patch` | The agent controls the evidence of its own change | Snapshot the tree and compute changes without invoking repository-controlled helpers |
| O4 | **Multi-tenant untested** | One org seeded; cross-tenant claims are assertions | Two real orgs and 40+ adversarial scenarios |

## Open — operational

| # | Item | State |
|---|---|---|
| O5 | Disk quota is per attempt, not host-wide | 8 × 1 GiB sparse images; concurrent attempts can exceed host free space |
| O6 | I/O enforcement | `io.max` writable, migration denied outside the privileged wrapper → PARTIAL |
| O7 | `outputCapBytes` now enforced, but `io` and disk have no aggregate budget | A single attempt is bounded; the host is not |
| O8 | CI never executed | No `gh`, no remote, no push credential |
| O9 | No SBOM; 1 low + 2 moderate advisories unclassified in writing | — |
| O10 | No backup, no retention policy, no encryption at rest | — |
| O11 | One flaky test (`isolation-gate`, 1 failure in 4 runs) | Volume-pool contention suspected; a flaky test is not evidence |

## Deliberately not done

- **Firecracker / gVisor installation.** No KVM; installing a privileged runtime to prove it cannot run would be theatre. D-007 records the evaluation and the trigger to revisit.
- **Host cgroup reconfiguration** to force `io` enforcement. The directive forbids host-wide changes; `io` is already delegated, but migration is the blocker, not the controller.
- **Rewriting Phase 4 history** to imply a control existed earlier than it did.
