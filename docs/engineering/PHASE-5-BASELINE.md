# INTELLIGENZ — Phase 5 Baseline

> Stage 0 record. Every claim below was produced by a command in this session.
> Phase 4 is preserved as delivered. Nothing was reset, cleaned, or rebased.

**Branch created:** `phase-5/isolation-readiness`
**Base:** `5bc69cf` (Phase 4 documentation commit)
**Working tree at start:** clean (0 entries), **no git remote configured**

## 1. Git state — verified, not assumed

```
5bc69cf docs: phase 4 baseline, credential isolation, resources, recovery, evaluation
008c32b feat: phase 4 execution trust — credential isolation, cgroups, authorization, evaluation
c104e64 docs: phase 3 baseline, runtime guide, security model and lifecycle
3b8c1cf feat: real sandboxed agent runtime with isolated workspaces
```

This matches the directive's reported Phase 4 identifiers exactly. No discrepancy to reconcile.

## 2. Environment, measured

| Capability | Result | Consequence |
|---|---|---|
| Node / pnpm | v22.23.2 / 10.15.1 | unchanged |
| PostgreSQL | 18.6, `intelligenz_dev` + `intelligenz_test` | unchanged |
| Temporal | dev server, 7233 / UI 8233 | unchanged |
| Redis | 8.0.5 | unchanged |
| Docker | absent | no container-based isolation available |
| **`/dev/kvm`** | **ABSENT** | **hardware virtualisation unavailable** |
| **CPU virt flags** | **0 lines matching `vmx`/`svm`** | **no nested virtualisation exposed** |
| `firecracker` / `jailer` | absent | not installed; cannot run without KVM anyway |
| `runsc` (gVisor) | absent | could be installed; ptrace platform needs no KVM |
| `unprivileged_userns_clone` | 1 (max 27191) | bwrap works |
| Root filesystem | **ext4**, mounted `rw,relatime,discard,errors=remount-ro` | see §3 |
| **`prjquota` mount option** | **NO** | **filesystem project quotas unavailable as mounted** |
| Loop devices | `/dev/loop-control` present, 12 nodes | **bounded disk images are viable** |
| cgroup root controllers | `cpuset cpu io memory hugetlb pids rdma misc dmem` | `io` exists |
| cgroup root subtree | **`cpu memory pids`** | **`io` not delegated** |
| `intelligenz` subtree | `cpu memory pids` | inherits the same three |

## 3. What the storage facts mean for Gate D

Ext4 supports project quotas only when the filesystem is created with the `prjquota` feature **and** mounted with `prjquota`. Measured: neither is true here. Enabling it requires `tune2fs -O project,quota` plus a remount of `/` — a host-wide change with reboot risk, on a filesystem shared with unrelated applications.

Therefore **filesystem project quotas are rejected as the enforcement mechanism**, not because they are wrong, but because this host cannot provide them safely.

The viable mechanism is **a bounded per-attempt ext4 image mounted via a loop device**:
- the size ceiling is a property of the block device, not a periodic check;
- `ENOSPC` occurs at the kernel level, so the agent cannot exceed it by creating files quickly;
- temporary files, build caches and test output all live inside the image and therefore count;
- cleanup is `umount` + unlink of a file the manager owns, so it cannot traverse outside the workspace;
- it requires no host mount option change and no reboot.

Caveat to verify during implementation: loop-backed images are sparse and do not reserve host space up front, so the quota bounds *this attempt's* usage but does not partition total host free space across concurrent attempts.

## 4. What the virtualisation facts mean for Gate B

Firecracker requires KVM. `/dev/kvm` does not exist and the CPU exposes no virtualisation extensions. On this host, Firecracker is **not a design choice — it is unattainable**. Any document claiming a microVM tier here would be false.

Remaining options:
1. **Retain Bubblewrap as an explicitly restricted tier** — shared kernel, namespace + mount + network isolation, cgroup limits. Truthful label: `restricted-shared-kernel`.
2. **gVisor in ptrace mode** — a userspace application kernel that intercepts syscalls; needs no KVM, but adds a large syscall surface to validate, a new runtime dependency, and significant latency. Feasible in principle, not yet evaluated on this host.

Level-3 isolation (VM-grade) is therefore **BLOCKED**, and the platform must refuse any execution profile that requires it rather than silently downgrading.

## 5. Inherited Phase 4 state that Phase 5 must not regress

| Control | Phase 4 state |
|---|---|
| Credential injection | broker, host-side, per attempt |
| Sandbox | bwrap, `--unshare-net`, read-only root, single rw bind |
| Spawn discipline | lint forbids direct `child_process`; `execSandboxed` only |
| cgroups | `memory.max`/`swap.max`/`pids.max`/`cpu.max` verified equal to profile |
| Authorization | server-derived risk, bound single-use approval, worker re-check |
| Artifacts | `attemptId` provenance, checksum verified on read |
| Gates | 655 tests, 11 skipped, audit 0 high/critical |

## 6. Phase 5 gate risk

| Gate | Risk | Reason |
|---|---|---|
| A — Credential custody | **high** | the credential store is owned by the same UID the worker runs as; separating them needs a distinct service identity, which this host has no supervisor for |
| B — Isolation tier | **blocked at level 3** | no KVM; bwrap remains the strongest available tier |
| C — CPU/memory | medium | rate limits exist; lifetime accounting must be added |
| D — Disk/I-O | medium | loop-image quota viable; `io` not delegated, device support unproven |
| E — Output cap | low | `outputCapBytes` declared but unused |
| F — Approval/attempt | medium | additive schema + transactional reservation |
| G — Integrity | medium | git filters can shape diffs; needs a non-git verifier |
| H–N | see report | CI, SBOM, audit, runbook |

Phase 5 will be reported **CONDITIONAL PASS at best**. Gate B cannot be closed on this host, and saying otherwise would be the exact failure this phase exists to prevent.
