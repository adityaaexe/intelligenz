# Phase 4 — Implementation Status

**Branch:** `phase-4/execution-trust` · **Base commit:** `c104e64` · **Date:** 2026-11-14
**Working tree:** uncommitted. Nothing in Phase 4 has been committed, pushed, or run in CI.

This document answers one question: **what does this build actually do when you run it?**
Every claim carries a status (contract §13) and a piece of evidence. A claim with no evidence is
not in this file.

---

## 1. Verdict, per gate

| Gate | Claim | Status |
|---|---|---|
| **A** — credential isolation | The sandbox holds no provider credential. Authentication is terminated host-side by a per-attempt broker. | **VERIFIED** |
| **B** — resource enforcement | Per-attempt cgroup v2 with aggregate memory, pid and CPU limits; effective limits read back from the kernel. | **VERIFIED** under `worker-with-cgroup.sh`; **PARTIAL** by default (rlimits only, honestly labelled) |
| **C** — authorization (D-006) | Server-derived risk under policy `2026-11-14.1`; approval bound to content + risk + profile + repo/commit, single-use, tenant-scoped, re-checked at the worker. | **VERIFIED** |
| **D** — evaluation | Benchmark harness, 8 fixtures, versioned rubric, security disqualification, aggregation refusals. | **VERIFIED** for the harness and simulated baseline; real baseline **BLOCKED** |
| **E** — workspace lifecycle | Leases, heartbeat, reaper with honest skips, validated reclaim, quarantine. | **VERIFIED** |
| **F** — artifact provenance | Direct `attemptId`/`workspaceId` links, `unattributed` for legacy rows, contained reads, checksum integrity. | **VERIFIED** |
| **G** — adversarial audit | Independent audit, F1–F6 recorded, F1–F3 remediated, F4–F6 open. | **VERIFIED** (audit and remediation) |
| **H** — engineering gates | typecheck, lint, build, audit, spawn discipline, 655 unit tests, 79 API e2e, 57 web e2e. | **VERIFIED** locally; CI **NOT IMPLEMENTED** |
| **I** — documentation | This file and its siblings. | **VERIFIED** |

**Overall: CONDITIONAL PASS.** Not production-ready. §7 says why in plain terms.

---

## 2. The executed chain, end to end

```
POST /v1/orgs/:orgId/tasks/:taskId/run
  │
  ├─ API: risk gate (D-006) ─────────────────────────────────────────────┐
  │    server-derived risk, approval lookup, content hash,               │
  │    single-use CAS (updateMany … consumedAt null → count===0)         │
  │                                                                      │
  ├─ API: Temporal client start ──► runTaskWorkflow (task-<taskId>)      │
  │                                                                      │
  └─ 409 / 403 on refusal, before any workflow exists ◄──────────────────┘

runTaskWorkflow
  │
  ├─ validateTaskActivity   re-derives risk, re-checks all five approval predicates,
  │                         returns runnable | already_terminal | not_runnable
  │
  ├─ recordStartActivity    WorkflowRun adopted by Temporal run id; ExecutionAttempt row
  │
  ├─ emitEventActivity      task.status_changed.v1  (idempotency key per run)
  │
  ├─ executeAgentActivity
  │    ├─ workspace lease   leaseOwner / leaseExpiresAt / heartbeat (conditional UPDATE)
  │    ├─ provision         clone or empty dir, base commit pinned
  │    ├─ cgroup            create per-attempt cgroup, write + read back limits
  │    │                    (skipped and labelled `rlimit-only` when unavailable)
  │    ├─ broker            unix socket in 0700 dir / 0600 sock, per-attempt token
  │    ├─ sandbox           bwrap: --unshare-net, --unshare-pid, --die-with-parent,
  │    │                    cleared env, empty state tree, rw /workspace only
  │    ├─ agent             opencode → 127.0.0.1:8899 → relay → broker → provider
  │    ├─ evidence          git status/diff inside a second sandbox with an explicit env
  │    ├─ artifacts         transcript (redacted), diff, report; SHA-256 each
  │    └─ usage             memory.peak, pids.peak, cpu.stat, oom_kill, pids.events max
  │
  ├─ persistResultActivity  ExecutionAttempt outcome; Artifact rows with attemptId/workspaceId
  │
  ├─ emitEventActivity      terminal event
  └─ completeTaskActivity   task status

Reaper (separate loop, every interval)
  expired lease + no live workflow + non-terminal state → cgroup.kill → copy artifacts →
  reclaim validated path → row state reaped | quarantined | cleanup_failed
```

The chain is real in both modes. The difference is which adapter fills `executeAgentActivity`:
`LocalSimulatedRuntime` (default, no shell, no network, no model) or `OpencodeCliRuntime`
(opt-in, real model, real spend).

---

## 3. Unit status with evidence

### A — Credential isolation

| Item | Status | Evidence |
|---|---|---|
| Broker listens on a per-attempt unix socket, `0700` directory, `0600` socket | **VERIFIED** | `broker.test.ts` — "creates a 0600 socket in a 0700 directory" |
| Capability token validated per attempt; foreign or absent → `403 BROKER_TOKEN` | **VERIFIED** | `broker.test.ts` — absent, foreign, and this-attempt cases; `sandbox-attempt.test.ts` from inside the sandbox |
| Inbound `authorization`, `x-api-key`, `cookie`, `proxy-authorization`, `host` stripped | **VERIFIED** | `broker.test.ts` — "injects the real credential and strips every inbound auth header" |
| Real credential injected host-side, read at request time | **VERIFIED** | `credential.test.ts` (12); value never in an error message |
| Caller cannot choose a destination | **VERIFIED** | exact path allowlist; absolute-form and `//evil.test/…` normalise onto the configured upstream (audit probe9/10) |
| Sandbox has no `$HOME`, no `opencode.db`, no `auth.json` | **VERIFIED** | `credential-isolation.test.ts` (11), `state-mounts.test.ts` (4) |
| Sandbox env has no key-shaped variable; one high-entropy value only (the canary) | **VERIFIED** | `credential-isolation.test.ts` |
| The probe can detect a leak when one is planted | **VERIFIED** | positive control in `credential-isolation.test.ts`; negative control in `sandbox-env-isolation.test.ts` |
| A real agent fixed a real failing test through the broker | **VERIFIED** | 10.9 s, 5 tool calls, 18,623 in / 151 out tokens, provider-reported `$0.000000` (free tier) |

Full detail: [`PHASE-4-CREDENTIAL-ISOLATION.md`](PHASE-4-CREDENTIAL-ISOLATION.md).

### B — Resource enforcement

| Item | Status | Evidence |
|---|---|---|
| Profiles SMALL / STANDARD / HEAVY exist with the directive's numbers | **VERIFIED** | `resource-profiles.ts`; `resource-profiles.test.ts` (15) |
| Effective limits equal configured limits | **VERIFIED** | `cgroup.test.ts` under the wrapper: `memory.max` 512M/1G/2G, `memory.swap.max` 0, `pids.max` 64/128/256, `cpu.max` `50000 100000` / `100000 100000` / `200000 100000` |
| OOM kill is recorded, not inferred | **VERIFIED** | `memory.max=32M` → `oom_kill 1`, peak pinned at 33,554,432 → `terminationReason='oom'` |
| Fork flood is refused at the kernel | **VERIFIED** | `pids.max=4` → `pids.events max 9` → `terminationReason='pids'` |
| `cgroup.kill` leaves zero processes | **VERIFIED** | full-tier test, 605 ms, `cgroup.procs` empty after |
| A plain directory never reports `enforced` | **VERIFIED** | `CGROUP_NOT_CGROUP2`; audit probe3 |
| A normal shell honestly reports `unavailable` | **VERIFIED** | `CGROUP_MIGRATION_DENIED` in this session's unit run (`tier: limited`) |
| Enforcement is on by default | **NOT IMPLEMENTED** | requires `worker-with-cgroup.sh`; see §5 |

Full detail: [`PHASE-4-RESOURCE-ENFORCEMENT.md`](PHASE-4-RESOURCE-ENFORCEMENT.md).

### C — Authorization (D-006)

| Item | Status | Evidence |
|---|---|---|
| Risk derived server-side; client value is evidence only | **VERIFIED** | `classify.ts`; `classify.test.ts` (25); e2e case 1 stores `CRITICAL` and records `clientAttemptedDowngrade` |
| Client cannot set server-owned fields | **VERIFIED** | `.strict()` + strip; e2e case 14 |
| Approval bound to content hash, risk, profile, repo/commit | **VERIFIED** | `approval-binding.ts`; e2e cases 3–5 |
| Single use via conditional `updateMany`; `count===0` → refusal | **VERIFIED** | e2e case 6 (`APPROVAL_CONSUMED`), case 7 (two concurrent runs, exactly one proceeds), case 13 (retries) |
| Self-approval refused | **VERIFIED** | e2e case 8 → `403 SELF_APPROVAL_FORBIDDEN` |
| Expiry and revocation enforced | **VERIFIED** | e2e cases 9–10 |
| Legacy row with no binding refused | **VERIFIED** | e2e case 12 → `409 APPROVAL_UNBOUND` |
| `PATCH → queued` cannot spend or bypass a grant | **VERIFIED** | e2e case 15 → `409 APPROVAL_REQUIRED` |
| Worker re-checks all five predicates | **VERIFIED** | `approval-grant.test.ts` (13) |
| Direct Temporal start is refused for a dead grant | **VERIFIED** | `approval-direct-start.test.ts` — 4 live refusals (expired, never reserved, revoked, unbound) |

### D — Evaluation

| Item | Status | Evidence |
|---|---|---|
| 8 fixtures, versioned, each a real repository | **VERIFIED** | `infra/benchmarks/fixtures/*/BENCHMARK.json` |
| Judges are commands/hashes/regex/diffs, no model judge | **VERIFIED** | `judge.ts`; `judge.test.ts` |
| Rubric `2026-11-14.1`, weights 40/25/15/10/10 | **VERIFIED** | `rubric.ts`; `rubric.test.ts` |
| Security event forces 0 and `disqualified` | **VERIFIED** | `path-traversal-attempt` scored 0.00 while 4/5 judges passed |
| Aggregation refuses to mix modes / rubric / benchmark versions | **VERIFIED** | `aggregate.test.ts` |
| Simulated baseline | **VERIFIED** | 7 pass, 1 disqualified, completion 87.5%, mean 87.50 — `infra/benchmarks/BASELINE-simulated.md` |
| Real baseline | **BLOCKED** | provider `429 RESOURCE_EXHAUSTED`, 20 requests/day |

Full detail: [`PHASE-4-EVALUATION-FRAMEWORK.md`](PHASE-4-EVALUATION-FRAMEWORK.md).

### E — Workspace lifecycle

| Item | Status | Evidence |
|---|---|---|
| Lease columns and conditional acquisition | **VERIFIED** | `schema.prisma`; `workspace-lifecycle.test.ts` |
| Reaper skips an active workflow and extends the lease | **VERIFIED** | `reaper.test.ts` — `skipped_live` |
| Reaper skips when Temporal is unreachable | **VERIFIED** | `skipped_unknown` |
| Sibling org untouched | **VERIFIED** | `reaper.test.ts`, `reclaim.test.ts` |
| `..` and symlinked parents quarantined, not deleted | **VERIFIED** | `reclaim.ts`; audit probe12 |
| Idempotent cleanup (`cleanupAttempts` increments) | **VERIFIED** | `reaper.test.ts` |
| Three failures → `cleanup_failed` | **VERIFIED** | `reaper.test.ts` |
| Artifacts copied before removal; quarantine if the copy fails | **VERIFIED** | `reaper.ts` §preserve → quarantine |
| 13 reaper tests | **VERIFIED** | `apps/worker/test/reaper.test.ts` — 13 |

Full detail: [`PHASE-4-WORKSPACE-RECOVERY.md`](PHASE-4-WORKSPACE-RECOVERY.md).

### F — Artifact provenance

| Item | Status | Evidence |
|---|---|---|
| `Artifact.attemptId` / `workspaceId` foreign keys (`SetNull`) | **VERIFIED** | `schema.prisma` |
| Legacy rows labelled `unattributed: true` | **VERIFIED** | `artifact-summary.ts`; `executions.e2e-spec.ts` |
| Tampered bytes → `409 ARTIFACT_INTEGRITY_FAILED` | **VERIFIED** | `executions.e2e-spec.ts` — 12 artifact cases |
| Missing file → `410 ARTIFACT_GONE`; outside root → `404` (no oracle) | **VERIFIED** | e2e |
| Traversal and symlink-to-sibling-tenant refused | **VERIFIED** | `artifact-locator.ts`; audit probe13 |
| Raw transcript is ADMIN-only; diff is member-readable | **VERIFIED** | e2e — VIEWER/MEMBER 403, ADMIN 200 |

### G — Audit and remediation

| Item | Status | Evidence |
|---|---|---|
| Independent audit produced | **VERIFIED** | `PHASE-4-SECURITY-RESULTS.md`, verdict CONDITIONAL PASS |
| F1 (worker env → evidence sandbox → diff artifact) closed | **VERIFIED** | `env` required; canary absent on production path, present on the old call shape |
| F2 (worker gate enforced only `status`) closed | **VERIFIED** | 5 predicates; 4 live direct-start refusals |
| F3 (three secret families unredacted) closed | **VERIFIED** | `redact.ts` patterns + bare fixtures |
| F4 (client `x-forwarded-*` forwarded) | **NOT IMPLEMENTED** | strip-list unchanged; LOW, recorded as open |
| F5 (`/proc/self/cgroup` disclosure) | **NOT IMPLEMENTED** | no `--unshare-cgroup` |
| F6 (socket unlink, inflight decrement, silent git failure) | **NOT IMPLEMENTED** | LOW/INFO, recorded |

Full detail: [`PHASE-4-SECURITY-RESULTS.md`](PHASE-4-SECURITY-RESULTS.md) §7.

### H — Engineering gates

| Gate | Result | Status |
|---|---|---|
| `typecheck` | 0 errors | **VERIFIED** |
| `lint` (`--max-warnings=0`) | 0 | **VERIFIED** |
| `build` | 0 | **VERIFIED** |
| `pnpm audit --audit-level high` | exit 0; 3 vulnerabilities (1 low, 2 moderate); 0 high/critical | **VERIFIED** — re-run in this session |
| Spawn discipline | 5 blocked cases, 1 allowed | **VERIFIED** — re-run, exit 0 |
| Unit/integration | 62 files, 655 passed, 11 skipped | **VERIFIED** — re-run in this session, 42.83 s |
| API e2e | 79 passed | **VERIFIED** (phase gate run) |
| Web e2e | 57 passed, 3 skipped | **VERIFIED** (phase gate run) |
| CI | authored, never executed | **NOT IMPLEMENTED** |

### I — Documentation

All nine Phase 4 documents exist. Line counts are in the delivery note. The drift fix
(`OPENCODE_CLI_SKIP` → `IZ_REAL_PROVIDER`) is applied to the two Phase 3 files that carried it.

---

## 4. How to run a real execution

Real execution is **off by default**. Nothing below happens unless `AGENT_RUNTIME=opencode-cli`.

### 4.1 Prerequisites, measured on this host

| Requirement | Check | Value here |
|---|---|---|
| `bwrap` | `bwrap --version` | 0.11.1 |
| Provider credential | `opencode --standalone auth list` | present for `google` |
| Repository | `WORKSPACE_SOURCE_REPO` | `infra/fixtures/sample-repo` |
| Temporal | `pnpm temporal:start` | `127.0.0.1:7233` |
| cgroup delegation (optional) | `cat /sys/fs/cgroup/intelligenz/cgroup.controllers` | `cpu memory pids` after setup |

### 4.2 Environment

| Variable | Meaning | Required |
|---|---|---|
| `AGENT_RUNTIME` | `opencode-cli` enables the real adapter | yes |
| `AGENT_MODEL` | **Upstream** model id; the sandbox sees `izbroker/<key>` | yes |
| `AGENT_BROKER_UPSTREAM_URL` | Provider base URL the broker forwards to | yes |
| `AGENT_BROKER_CREDENTIAL` | opencode integration id read from the host SQLite store | one of the two |
| `AGENT_BROKER_CREDENTIAL_ENV` | Name of an env var holding the key | one of the two |
| `AGENT_BROKER_CREDENTIAL_DB` | Path to `opencode.db` | default `~/.local/share/opencode/opencode.db` |
| `AGENT_MAX_USD` | Per-run cap, checked against provider-reported cost; `0` refused | yes (default `0.5`) |
| `WORKSPACE_SOURCE_REPO` | Repository cloned per attempt | yes for a real task |
| `AGENT_BWRAP_PATH` | Sandbox binary; missing `bwrap` fails closed | no |
| `WORKER_RESOURCE_PROFILE` | Operator override of the risk-derived profile | no |

The worker **refuses to boot** `opencode-cli` without `AGENT_MODEL`,
`AGENT_BROKER_UPSTREAM_URL`, a credential source, and a positive `AGENT_MAX_USD`
(`apps/worker/src/config.ts`). That is deliberate: a real runtime with no model id or no cap is
a charge waiting to happen, and there is no unproxied fallback to discover at run time.

### 4.3 Two ways to prove it

```bash
# A. Fastest: no API, no Temporal. One real task, prints the diff, re-runs the suite.
npx tsx infra/scripts/p3-real-run.ts

# B. The product path: API → Temporal → worker → agent.
pnpm temporal:start          # terminal A
AGENT_RUNTIME=opencode-cli \
WORKSPACE_SOURCE_REPO=infra/fixtures/sample-repo \
AGENT_MODEL=gemini-3.5-flash \
AGENT_BROKER_UPSTREAM_URL=https://generativelanguage.googleapis.com/v1beta/openai \
AGENT_BROKER_CREDENTIAL=google \
AGENT_MAX_USD=0.5 \
pnpm dev                     # terminal B
```

The structured Gate A proof — sandbox probe, broker refusals from inside the sandbox, one real
run, log scan, cost — is:

```bash
npx tsx infra/scripts/p4-broker-proof.ts
```

### 4.4 Enabling cgroup enforcement (opt-in)

```bash
# Once, as root. Idempotent. Runtime never needs root.
sudo bash infra/scripts/setup-cgroups.sh

# Then start the worker inside its delegated leaf:
sudo bash infra/scripts/worker-with-cgroup.sh pnpm dev
```

Without the wrapper the worker records `executionProfile = "rlimit-only"` and refuses `HEAVY`.
That is honest degradation, not silent success.

### 4.5 Live provider tests

The real adapter's contract cases 7 and 8 are **skipped by default**. To run them:

```bash
IZ_REAL_PROVIDER=1 AGENT_MODEL=gemini-3.5-flash-lite \
  npx vitest run packages/agent-runtime/test/opencode-cli.test.ts
```

Two conditions, both required: `IZ_REAL_PROVIDER` must be exactly `1`, and `AGENT_MODEL` must be
a non-empty model id. Anything else skips, with the reason printed. There is no other switch, and
`OPENCODE_CLI_SKIP` no longer exists.

---

## 5. Where the chain stops being real

| Stop | Detail |
|---|---|
| **Default runtime is simulated** | `AGENT_RUNTIME=local-simulated`. No shell, no network, no model, no cost. A run is labelled `simulated` on every surface. |
| **cgroups are opt-in** | A worker started normally runs `rlimit-only`. Nothing at boot fails closed; it degrades and says so. |
| **The real baseline does not exist** | `BLOCKED` by provider quota, not by code. The simulated baseline is a harness test. |
| **No CI** | `.github/workflows/ci.yml` exists and has never run. Every green result here is a local run. |
| **No remote** | Nothing is pushed. The work is an uncommitted working tree. |
| **One repository** | Real runs are proven on `infra/fixtures/sample-repo`. Not on a real codebase. |
| **One adapter** | `opencode-cli` only. The port exists; a second adapter does not. |
| **No commit, branch, or PR** | The agent's output is a diff and a transcript. Nothing is published. |

---

## 6. Numbers this phase produced

| Measurement | Value | Source |
|---|---|---|
| Real agent run through the broker | 10.9 s, 5 tool calls, 18,623 in / 151 out tokens, `$0.000000` (free tier, provider reports usage but no cost field) | Gate A proof |
| `memory.peak` on a real attempt cgroup | 26,148,864 B | Gate B measurement |
| `pids.peak` on the same attempt | 7 | Gate B measurement |
| `cpu.stat` | `nr_throttled 5`, `throttled_usec 425287` | Gate B measurement |
| OOM kill | `oom_kill 1`, peak pinned at 33,554,432 B, `terminationReason='oom'` | Gate B measurement |
| Fork refusal | `pids.max=4` → `pids.events max 9`, `terminationReason='pids'` | Gate B measurement |
| Simulated baseline | 8 runs, 7 pass, 1 disqualified, completion 87.5%, mean 87.50 | `BASELINE-simulated.md` |
| Real baseline | none | `BLOCKED` |
| Unit/integration tests | 62 files, 655 passed, 11 skipped | this session |
| API e2e | 79 passed | phase gate run |
| Web e2e | 57 passed, 3 skipped | phase gate run |

---

## 7. Residuals, stated plainly

1. **Repository-defined git filters still execute inside the sandbox.** The `env` fix removed the
   confidentiality leak (the worker environment). It did not remove the capability: an agent can
   still define a filter that runs `sh` during evidence collection. That is an integrity question
   (the diff says what the filter emitted), not a disclosure of the worker's secrets. See
   `PHASE-4-SECURITY-RESULTS.md` §7.4.
2. **`consumedAt` proves a reservation happened, not that this run made it.** The worker asserts
   the grant was reserved; it cannot prove the reservation belongs to this workflow. Closing that
   requires passing the reserved `approvalId` through the workflow input and asserting equality —
   not implemented.
3. **`apps/worker` imports one file from `apps/api`.** The risk policy and its version live in
   `apps/api/src/risk`; the worker imports the classification types. A package boundary would be
   cleaner. It is a layering smell, not a security hole, and it is recorded rather than hidden.
4. **Disk quota and I/O bandwidth are not enforced.** `io.max` exists in cgroup v2; this host's
   delegation covers `cpu memory pids` only. A run can fill the disk.
5. **CI never executed.** Authored, unrun.
6. **No remote push.** No credentials, no remote.
7. **F4–F6 remain open.** LOW/INFO, listed in the audit and in `PHASE-4-SECURITY-RESULTS.md` §7.
8. **The sandbox shares the host kernel and the worker's uid.** No seccomp, no LSM, no
   `--unshare-user`. Namespace isolation is a strong fence, not a security boundary.
9. **Risk classification is lexical.** `MEDIUM` needs no approval, and `MEDIUM` is the floor for
   any task whose repository is not allowlisted — which is every task by default. A task phrased
   to avoid the vocabulary needs no human. D-006 §9.5 accepts this.

**Not production-ready.** The controls in this phase are real and measured. The deployment
around them is not: single host, shared kernel, unauthenticated Temporal on loopback, one
database role, no CI, no remote, no baseline.
