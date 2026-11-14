# ADR D-007 — Execution Isolation Backend

**Status:** Accepted
**Date:** 2026-11-14
**Deciders:** IT Leader (architecture), informed by measured host capability
**Supersedes:** the implicit assumption in ADR-003 and Phase 3/4 documents that the bwrap sandbox is "the" isolation boundary

---

## Context

Phase 4 executes an untrusted coding agent inside `bwrap`: read-only root, one writable bind, `--unshare-net`, `--unshare-pid`, cleared environment, cgroup limits. The Phase 4 audit confirmed that containment holds against path, symlink, network, and env attacks — and confirmed that the sandbox **shares the host kernel**, runs as the same UID as the worker, and therefore is not a defence against a kernel or `bwrap` vulnerability.

Phase 5 asks whether a stronger backend should replace or supplement it, and requires the answer to be evidence-based rather than fashionable.

## Measured host capability

| Requirement | Measurement | Verdict |
|---|---|---|
| `/dev/kvm` | **absent** | Firecracker cannot start |
| CPU virtualisation flags (`vmx`/`svm`) | **0 matching lines** in `/proc/cpuinfo` | no nested virtualisation exposed |
| `firecracker`, `jailer` | absent | not installed; moot without KVM |
| `runsc` (gVisor) | absent | installable; ptrace platform needs no KVM |
| Unprivileged user namespaces | enabled (`max_user_namespaces=27191`) | bwrap viable |
| Docker / container runtime | absent | no container-based fallback |
| cgroup v2 | `cpu memory pids` delegated; `io` present at root, **not delegated** | rate/memory/pid limits viable |

## Options considered

### A. Firecracker microVM

**Rejected — unattainable, not merely costly.** It requires KVM. `/dev/kvm` does not exist and the CPU reports no virtualisation extensions, so no amount of privilege escalation produces a VM boundary here. Its documented host model (jailer, dedicated non-privileged UID, seccomp, cgroups, namespaces) is the right shape for a future production host, and is recorded as the target for a host that exposes KVM.

**Cost if the host supported it:** a guest kernel image, a rootfs build pipeline, vsock/network plumbing, jailer configuration, and a second artifact path for extraction. Not justified to design now for a host that cannot run it.

### B. gVisor (`runsc`, ptrace platform)

**Deferred, with a concrete trigger.** gVisor interposes a userspace kernel between the application and the host, which materially shrinks the exposed syscall surface without KVM. It is therefore the only candidate that could raise isolation on *this* host.

Why it is not adopted in this phase:
- It is a new runtime dependency that must be installed and pinned, with its own upgrade and CVE surface.
- The ptrace platform is substantially slower for syscall-heavy work (compilation, test runs), and the benchmark impact on eight existing benchmarks is unknown.
- Compatibility with the `opencode` CLI's process and file behaviour is unverified; discovering that during a security phase converts the phase into a porting exercise.
- Its security properties must be validated, not accepted from marketing — which is a workstream of its own.

**Trigger to revisit:** a measured need for a tier stronger than shared-kernel, or a production host without KVM. The evaluation is bounded and specified in the runbook: latency delta on the benchmark suite, compatibility with the agent runtime, and an adversarial pass against the same 40-scenario suite.

### C. Retain Bubblewrap as an explicitly restricted tier

**Selected for this phase.** It is the only tier this host can actually launch today, and its properties are measured rather than asserted.

## Decision

1. **Bubblewrap is retained as the only operational execution tier**, labelled `restricted-shared-kernel`. It is never described as VM-isolated, container-isolated, or kernel-isolated.
2. **Level-3 (VM-grade) isolation is recorded as BLOCKED** on this host, with `/dev/kvm` absence as the evidence. Any execution profile declaring `requires: 'vm'` **fails closed before the agent is launched** — it does not silently downgrade.
3. **gVisor is a deferred candidate**, with the trigger and evaluation plan above. It is not installed in this phase.
4. **A backend abstraction is introduced** so the control plane never depends on bwrap specifically: capability discovery, provisioning, launch, cancellation, termination, artifact export, cleanup, and a **truthful effective-profile report**.
5. **Tier reporting is a first-class output.** Every execution records its tier, the measurements that justify it, and the controls that are *not* enforced. A UI or API that displays "isolated" without a tier is wrong.

## Consequences

**Positive**
- No false claim of isolation. The strongest honest statement is "shared kernel, namespace + mount + network + cgroup containment, verified against 40+ attacks".
- Cost is zero on a host that cannot virtualise.
- The backend interface makes adding gVisor or Firecracker a new adapter rather than a rewrite.

**Negative / costs**
- A kernel vulnerability or a `bwrap` bug remains host compromise. This is a real, accepted risk and must be stated in deployment readiness.
- Multi-tenant hosting on one shared-kernel host is **not** appropriate for mutually hostile tenants; tenant isolation would depend on the kernel boundary this tier does not provide.
- The abstraction adds indirection for a single implementation — justified only because the tier must be swappable, and because truthfulness about the tier needs a place to live.

## Revisit trigger

Re-open this ADR when any of the following becomes true:
- a host with `/dev/kvm` is provisioned (Firecracker becomes viable);
- a tenant requires isolation from another tenant on the same host (gVisor or separate hosts become mandatory);
- gVisor's benchmark and compatibility evaluation completes and the cost is acceptable.

## Compliance note

Phase 4 documents that describe the sandbox as "isolated" without qualification are amended to say **restricted shared-kernel sandbox**. History is not rewritten to imply a stronger control existed earlier than it did.
