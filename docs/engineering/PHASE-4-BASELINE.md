# INTELLIGENZ — Phase 4 Baseline

> Reconnaissance before any Phase 4 change. Every statement below was produced by a command in this session.
> Phase 4 target: make execution defensible, not broader.

**Branch:** `phase-4/execution-trust`

## 1. Starting commit — discrepancy recorded

The directive names base commit `3b8c1cf`. The actual HEAD is **`c104e64`**.

`c104e64` is the documentation commit created immediately after `3b8c1cf` on the same branch (`phase-3/real-agent-runtime`). It contains no code. Nothing was reset, discarded, or lost.

```
c104e64 docs: phase 3 baseline, runtime guide, security model and lifecycle
3b8c1cf feat: real sandboxed agent runtime with isolated workspaces
43d5c17 docs: phase 2 architecture decisions and engineering record
```

Working tree at branch creation: **clean** (0 entries in `git status --porcelain`).

Phase 4 therefore starts from `c104e64`, which is `3b8c1cf` plus documentation. Recorded rather than silently accepted, per directive §1.2.

## 2. Host capability, measured

| Capability | Result | Consequence for Phase 4 |
|---|---|---|
| `bwrap` | present, `--unshare-net` verified blocking | sandbox layer exists |
| cgroup v2 controllers (root) | `cpuset cpu io memory hugetlb pids rdma misc dmem` | aggregate limits are theoretically available |
| `sudo -n mkdir /sys/fs/cgroup/iz-probe` | **succeeded** | a cgroup can be created |
| root `cgroup.subtree_control` | `cpu memory pids` | cpu/memory/pids are delegated |
| user slice subtree | `cpu memory pids` delegated | user-slice cgroups possible |
| `systemctl --user` | `degraded` | no clean user session bus; prefer root-created cgroups |
| Docker | absent | unchanged |
| PostgreSQL / Redis / Temporal | running | unchanged |

**Consequence:** cgroup enforcement is feasible on this host, but must be validated from the live cgroup filesystem, not from configuration. Whether a worker can create and populate a cgroup without interactive `sudo` is **not yet established** and is a Phase 4 gate question.

## 3. Credential topology, measured

| Fact | Evidence |
|---|---|
| `~/.local/share/opencode/auth.json` | **absent** |
| `~/.local/share/opencode/opencode.db` | **present, 1,082,355,712 bytes** (SQLite) |
| `~/.config/opencode/opencode.jsonc` | contains a custom provider block with `baseURL` and `models` |
| Provider credential storage | therefore inside `opencode.db`, not `auth.json` |

This contradicts the directive's stated assumption that the credential store is `~/.local/share/opencode/auth.json`. On this host the credentials live in the SQLite database that Phase 3 already mounts (narrowed) into the sandbox and that the Phase 3 audit proved readable.

**Consequence:** credential isolation cannot be achieved by simply not mounting `auth.json`. Either the database is removed from the sandbox entirely, or authentication must be moved out of the process — which requires the provider to be reachable through a proxy with a canary key. The second path depends on whether the configured provider honours an overridden `baseURL` plus a dummy key. That is the first research question of Phase 4 and it gates Gate A.

## 4. What Phase 4 inherits and must not regress

| Control | Phase 3 state |
|---|---|
| Host-side git on agent-writable content | **closed** — sandboxed git, hooks/fsmonitor disabled, negative control |
| Network egress | `--unshare-net` + allowlisted 443 proxy |
| Sandbox mounts | narrowed to opencode state; `mcp-auth.json` masked |
| Transcript | redacted at collection, 5 MiB cap, ADMIN-only content |
| Resource limits | rlimits only (nofile/nproc/as) + process-group kill |
| Risk classification | **client-supplied** — D-006 open |
| Approval | single `APPROVED` row, never consumed, self-approval permitted |
| Workspace reaper | absent |
| Artifact→attempt attribution | time-window heuristic, no FK |
| Evaluation harness | absent |
| Dependency audit | red (2 high via next→postcss) |
| CI execution | authored, never run |
| Tests | 412 unit, 60 API e2e, 57 web e2e, 3 migrations |

## 5. Phase 4 gate risk assessment

| Gate | Risk | Reason |
|---|---|---|
| A — credential isolation | **highest** | requires the provider to accept a proxied baseURL and a canary key; unproven |
| B — resource enforcement | medium | cgroups creatable, but root/sudo dependency must be verified |
| C — authorization | medium | self-attestation is a policy design, not a missing capability |
| D — evaluation | low risk, high effort | new package, no external dependency |
| E — lifecycle | medium | reaper is new logic over existing tables |
| F — provenance | low | additive migration |
| G — audit | depends on A | audit will attempt credential extraction first |
| H — engineering | medium | audit gate already red; CI unverified |
| I — documentation | low | must match what is actually built |

Phase 4 will be reported **CONDITIONAL PASS at best** unless Gate A and Gate B are both verified and Gate H's audit is either green or explicitly accepted with evidence.

## 6. Non-negotiable boundaries restated

- All work under `/home/ubuntu/intelligenz` only.
- Ports 3000/4000 belong to another product. INTELLIGENZ uses 3100/4100.
- Never kill processes by broad name matching.
- No cloud provisioning, no production credentials, no remote push without verified credentials.
- A control is not "verified" because its configuration exists.
