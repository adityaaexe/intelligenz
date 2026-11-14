# Phase 4 — Resource Enforcement

**Branch:** `phase-4/execution-trust` · **Date:** 2026-11-14
**Scope:** per-attempt CPU, memory and pid limits on this host, measured from the cgroup files the
kernel enforces from.

**Verdict:** **VERIFIED under `infra/scripts/worker-with-cgroup.sh`; PARTIAL by default.** A worker
started normally runs with rlimits only and says so. Nothing fails closed.

---

## 1. The problem rlimits do not solve

`RLIMIT_AS` bounds **one process's** address space. `RLIMIT_NPROC` bounds one uid's process count.
A run that forks three children has three address spaces; a run that forks a thousand has a
thousand. The aggregate is unbounded, which is precisely the fork-bomb case a limit exists for.

cgroup v2 gives aggregate statements:

| File | Statement |
|---|---|
| `memory.max` | sum of resident memory for every process in the cgroup |
| `memory.swap.max` | how much of that may be swapped (0 = none) |
| `pids.max` | every thread and process in the tree counts as one |
| `cpu.max` | `quota period` in microseconds — a **rate**, not a total |
| `cgroup.kill` | SIGKILL to every process and descendant cgroup, in one pass |

Phase 3 shipped rlimits and called them resource limits. Phase 4 ships the aggregate and refuses
to call rlimits an aggregate.

---

## 2. Delegation: one root step, no privilege at runtime

```
sudo bash infra/scripts/setup-cgroups.sh        # once, root, idempotent
  ├─ mkdir /sys/fs/cgroup/intelligenz
  ├─ enable +cpu +memory +pids on the parent's subtree_control
  ├─ enable +cpu +memory +pids on intelligenz/cgroup.subtree_control
  ├─ chown the subtree to the worker user
  │    (subtree_control stays root-owned: a worker bug can mis-set a limit,
  │     it cannot grant itself a controller)
  └─ print cgroup.controllers as proof

sudo bash infra/scripts/worker-with-cgroup.sh pnpm dev
  ├─ root writes one pid into intelligenz/worker/cgroup.procs
  ├─ setpriv --reuid --regid --init-groups
  └─ exec the worker                              # no fork, no window outside the cgroup
```

**Why the wrapper is required — a kernel property, not a design choice.** A `cgroup.procs` write is
authorised against **both** the source and the destination cgroup. A process started from a login
session lives under `/user.slice/...`, which the worker user does not own, so migrating its child
into an attempt cgroup fails with `EPERM` even when the destination is owned and writable.
Measured:

```
echo $$ > /sys/fs/cgroup/intelligenz/self-probe/cgroup.procs   → EPERM
launcher(owned) → attempt(owned)                               → OK
```

The worker itself never calls `sudo`, never uses a setuid helper, and makes no privileged syscall.
`apps/worker/src/cgroup.ts` is ten file operations: `mkdir`, `writeFile`, `readFile`, `rmdir`.

---

## 3. Profiles — configured

Server-selected from the task's risk class; the client has no profile field and the adapter never
sees one.

| Profile | `memory.max` | `memory.swap.max` | `pids.max` | `cpu.max` (quota period) | Wall clock | Spend cap |
|---|---:|---:|---:|---|---:|---:|
| `SMALL` | 512 MiB | 0 | 64 | `50000 100000` (½ CPU) | 120 s | $0.10 |
| `STANDARD` | 1024 MiB | 0 | 128 | `100000 100000` (1 CPU) | 300 s | $0.50 |
| `HEAVY` | 2048 MiB | 0 | 256 | `200000 100000` (2 CPU) | 600 s | $2.00 |

Selection policy (`selectResourceProfile`):

| Input | Choice |
|---|---|
| `WORKER_RESOURCE_PROFILE` set | that profile — operator override wins |
| risk `CRITICAL` | `HEAVY` (refused when cgroups are unavailable) |
| risk `HIGH` / `MEDIUM` | `STANDARD` |
| risk `LOW` | `SMALL`, raised to `STANDARD` for a real runtime (policy floor, not a measurement) |

`HEAVY` is refused outright in `rlimit-only` mode. A 2 GiB aggregate promise applied per process
to an unbounded number of processes is not a limit with a label; it is a label.

---

## 4. Effective = configured

`applyLimits` writes four files, then **reads them back** from the same files the kernel enforces
from. A limit that was written but not accepted (a controller not delegated, a value the kernel
clamps) is indistinguishable from an enforced one unless it is read back.

| Profile | `memory.max` read | `memory.swap.max` read | `pids.max` read | `cpu.max` read |
|---|---|---|---|---|
| `SMALL` | `536870912` | `0` | `64` | `50000 100000` |
| `STANDARD` | `1073741824` | `0` | `128` | `100000 100000` |
| `HEAVY` | `2147483648` | `0` | `256` | `200000 100000` |

**Status: VERIFIED** — `apps/worker/test/cgroup.test.ts`, "writes the profile limits and reads
back exactly what the kernel accepted" (tier: limits, and again at tier: full under the wrapper).

`memory.swap.max = 0` is not an optimisation. Measured on this host: with `memory.max=32M` and
swap enabled, a process allocated 200 MB, exited 0, `oom_kill=0`, peak pinned at the limit and the
rest in swap. With `memory.swap.max=0` the same process was OOM-killed in 94 ms with `oom_kill=1`.
Without the swap file, `memory.max` is a soft ceiling.

---

## 5. Measured kill behaviour

All numbers below were measured from a real attempt cgroup, not from a mock, during the phase gate
run. The eight full-tier tests that assert this behaviour pass 15/15 under the wrapper when re-run
for this document; the values themselves are from the gate run.

| Measurement | Value | Meaning |
|---|---:|---|
| `memory.peak` | 26,148,864 B (≈ 24.9 MiB) | peak aggregate RSS for the run |
| `pids.peak` | 7 | processes + threads at peak |
| `cpu.stat` `nr_throttled` | 5 | the quota was actually binding |
| `cpu.stat` `throttled_usec` | 425,287 µs | ~0.43 s of throttled time |
| OOM test | `memory.max=32M` → `oom_kill 1`, `memory.peak` 33,554,432 | the kernel killed it at the ceiling |
| OOM verdict | `terminationReason='oom'` | the attempt records *why*, not just "failed" |
| Fork test | `pids.max=4` → `pids.events max 9` | nine forks refused by the kernel |
| Fork verdict | `terminationReason='pids'` | distinct from OOM and from an agent failure |
| Kill test | `cgroup.kill` → 0 processes remain | descendants included |

The verdict vocabulary (`termination.ts`) separates the process fact from the agent's opinion:

| Reason | When |
|---|---|
| `completed` | tree exited on its own |
| `timeout` | wall clock expired, platform killed it |
| `cancelled` | API/human cancelled, platform killed it |
| `oom` | `memory.events oom_kill > 0` |
| `pids` | `pids.events max > 0` |
| `cpu` | consumed more CPU than the quota permits → **the quota was not in force** |
| `crashed` | died without a verdict |
| `workspace_error` | nothing ran: provisioning, placement or lease failed |

`cpu` is an enforcement-failure signal, not a "busy run" signal. That distinction is the point:
if a run reports more CPU than `quota/period × wallClock`, the platform must not claim the quota
held.

---

## 6. Why a process cannot leave its cgroup

1. **Membership is inherited at `fork()`.** A process cannot leave a cgroup it did not join.
2. **Changing membership requires writing `cgroup.procs` in the destination** — a file under
   `/sys/fs/cgroup`, which is **not in the sandbox's mount namespace**. `bwrap` builds the
   namespace from an explicit bind list; `/sys` is not on it. Measured.
3. **`--unshare-pid` + `--die-with-parent`** prevent reparenting outside the sandbox and leave no
   orphan when `bwrap` dies.
4. **`cgroup.kill` is the backstop**: it kills every process and descendant cgroup atomically,
   including one stuck in uninterruptible sleep.

Verified by `cgroup.test.ts` (tier: full): "places the sandbox before its first exec, and the child
cannot escape".

> Source comment drift: `cgroup.ts` cites `test/cgroup-escape.test.ts`, which does not exist. The
> escape assertions live inside `cgroup.test.ts` (tier: full). The comment, not the coverage, is
> stale.

---

## 7. The honesty machine: the capability probe

`detectCgroupCapability()` refuses to report `enforced` unless it can **migrate a real process**
into a real cgroup. Every failure mode has a distinct code and evidence:

| Host state | Code | What the probe says |
|---|---|---|
| Delegation root missing | `CGROUP_ROOT_MISSING` | path named |
| Root exists, not owned by this user | `CGROUP_ROOT_NOT_WRITABLE` | path and owner named |
| A plain directory | `CGROUP_NOT_CGROUP2` | reports the actual filesystem magic |
| Symlink to a plain directory | `CGROUP_NOT_CGROUP2` | link refused, target reported |
| cgroup2, controllers not delegated | `CGROUP_MIGRATION_DENIED` | full explanation, including that migration needs write access to the source |
| Enforced | `enforced` | only after a real process was placed and `cgroup.procs` read back |

This matters because the Phase 3 audit's sibling check found a probe that reported `enforced` for a
plain directory. A capability probe that lies is worse than no probe: it turns a deployment
decision into a false statement in the attempt row.

**Status: VERIFIED** — `apps/worker/test/capabilities.test.ts` (7 tests), audit probe3.

---

## 8. What is **not** enforced

| Not enforced | Detail | Consequence |
|---|---|---|
| **Disk quota** | No filesystem quota. `io`/`rdma`/`hugetlb` are not delegated to the subtree. | A run can fill the host disk. `outputCapBytes` is declared in the profile and **never read** — see below. |
| **I/O bandwidth** | `io.max` exists in cgroup v2, but `io` is not in `cgroup.controllers` for this delegation (`cpu memory pids` only). | A run can saturate disk I/O. |
| **Post-hoc CPU ceiling** | `cpuCeilingFor(profile)` is a **check**, not a second limit: exceeding it proves the quota was not applied. | Correct as designed; it does not bound anything. |
| **`outputCapBytes`** | Declared per profile (5/5/10 MiB, "sum of bytes the attempt may leave behind"). `grep` across `apps/` and `packages/` finds it only in `resource-profiles.ts`. | **A configuration claim with no enforcement.** The only byte cap actually in force is the transcript buffer's 5 MiB (`TRANSCRIPT_MAX_BYTES`), which is separate and hard-coded. |
| **Wall clock** | Enforced by the adapter's timeout, capped by the activity deadline — not by cgroups. | A stuck `D`-state process is handled by `cgroup.kill`, not by the clock. |
| **Spend** | Enforced against provider-reported cost; a provider that reports no cost leaves the cap unmeasured. | The Gate A run reported `$0.000000` on free tier; it also reports *no cost field at all*. |
| **Aggregate limits when cgroups are unavailable** | Falls back to rlimits and records `executionProfile = "rlimit-only"`. | The attempt row says what it got. `HEAVY` is refused. |
| **A seccomp/LSM boundary** | Not a resource control, but the reason a resource escape is not the only escape. | Out of scope for this unit; recorded as the top residual. |

`outputCapBytes` is the one item on this list that looks like a control and is not one. It is called
out because a reader of the profile table would reasonably assume a 10 MiB cap on HEAVY evidence.
There is no such cap.

---

## 9. Default behaviour, and what a deployment must do

```
cgroup available + wrapper   → enforced, limits read back, kills tested
cgroup available + no wrapper→ limits writable, migration denied → rlimit-only, HEAVY refused
no delegation root           → unavailable → rlimit-only, HEAVY refused
```

**There is no boot failure in any of these paths.** That is deliberate — a worker that refuses to
start because cgroups are missing is unavailable for all work, including simulated work that needs
no cgroup — but it means a deployment that forgets the wrapper degrades quietly and correctly.

A production deployment must:

1. Run `setup-cgroups.sh` once and assert `cgroup.controllers` contains `cpu memory pids`.
2. Start the worker through `worker-with-cgroup.sh` (or an equivalent that places the supervisor in
   an owned leaf) and alert when `executionProfile = "rlimit-only"` appears in attempt rows.
3. Add a filesystem quota for the workspace root, because no cgroup here bounds bytes on disk.
4. Treat `cpu` termination reasons as an enforcement incident, not as a busy run.

---

## 10. Residuals

1. **Opt-in.** Stated three times in this document because it is the single most important
   operational fact: enforcement exists and is tested, and it is not on by default.
2. **`outputCapBytes` is dead config.** Either wire it to a real check or remove it from the
   table; today it is misleading.
3. **No disk or I/O bound.** A run can exhaust either.
4. **`memory.peak` needs kernel ≥ 5.19.** Older kernels have no `memory.peak`; the reader returns
   `null`, never `0`, because a fabricated zero is indistinguishable from a measured one.
5. **A kernel without swap accounting** has no `memory.swap.max`. The write is skipped,
   `readEffectiveLimits` reports `unavailable`, and on that kernel `memory.max` is only a soft
   ceiling. This is why the 28-scenario matrix marks the swap scenario **PARTIAL**.
6. **The wrapper runs as root once.** It writes one pid and drops privilege. It is a small,
   reviewed script, not a privileged service — but it is still a root step in the deployment path.
