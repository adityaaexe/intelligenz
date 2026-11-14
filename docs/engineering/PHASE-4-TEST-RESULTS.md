# Phase 4 — Test Results

**Branch:** `phase-4/execution-trust` · **Date:** 2026-11-14 · **Tree:** uncommitted
**Status vocabulary:** contract §13. `VERIFIED` means a command ran and its output is here.

---

## 1. Gate summary

| Gate | Command | Result | Status |
|---|---|---|---|
| Typecheck | `pnpm typecheck` | 0 errors | **VERIFIED** |
| Lint | `pnpm lint` (`--max-warnings=0`) | 0 errors, 0 warnings | **VERIFIED** |
| Build | `pnpm build` | 0 failures | **VERIFIED** |
| Dependency audit | `pnpm audit --audit-level high` | exit 0; 3 vulnerabilities: 1 low, 2 moderate; **0 high, 0 critical** | **VERIFIED** |
| Spawn discipline | `bash infra/scripts/check-spawn-discipline.sh` | 5 blocked, 1 allowed, exit 0 | **VERIFIED** |
| Unit / integration | `npx vitest run` | **62 files, 655 passed, 11 skipped**, 42.83 s | **VERIFIED** |
| API e2e | `pnpm --filter @intelligenz/api test:e2e` | 79 passed | **VERIFIED** (phase gate run) |
| Web e2e | `pnpm --filter @intelligenz/web test:e2e` | 57 passed, 3 skipped | **VERIFIED** (phase gate run) |
| CI | `.github/workflows/ci.yml` | never executed | **NOT IMPLEMENTED** |

The two e2e suites require the live stack (Postgres, Temporal, API on 4100, web on 3100). They
were run in the phase gate and their counts are recorded above. They were **not** re-executed
while writing this document, so no literal log is quoted for them; the unit-suite block below is
a re-run in this session.

---

## 2. Literal output

### 2.1 Unit and integration

```
 RUN  v5.1.0 /home/ubuntu/intelligenz

[cgroup tier] limited — self=/user.slice/user-1000.slice/user@1000.service/tmux-spawn-….scope
this process is in cgroup /user.slice/…, outside /sys/fs/cgroup/intelligenz;
the kernel refuses migration. Run via: sudo bash infra/scripts/worker-with-cgroup.sh

skipped: IZ_REAL_PROVIDER not set — contract cases 7 and 8 need a live provider

 Test Files  62 passed (62)
      Tests  655 passed | 11 skipped (666)
   Start at  10:02:42
   Duration  42.83s (tests 81%, import 15%, transform 3%, worker 1%)
```

The `[cgroup tier] limited` line is part of the result, not noise: it says this run exercised the
limit/read-back tier and **skipped the eight full-tier kill tests**. The same file passes 15/15
under the wrapper (§2.3).

### 2.2 Spawn discipline (SEC-403)

```
SEC-403 spawn discipline — rule behaviour
ok    bare import in packages/agent-runtime/src — blocked (eslint exit 1)
ok    bare import in apps/worker/src — blocked (eslint exit 1)
ok    bare import in infra/scripts — blocked (eslint exit 1)
ok    dynamic import bypass — blocked (eslint exit 1)
ok    require() bypass — blocked (eslint exit 1)
ok    sanctioned owner stays allowed — allowed (eslint exit 0)
EXIT:0
```

### 2.3 cgroup full tier, under the wrapper

```
 ✓ apps/worker/test/cgroup.test.ts (15 tests) 2634ms
   ✓ cgroup v2 enforcement (tier: full) (8)
     ✓ kills the whole tree with cgroup.kill and leaves nothing behind 605ms
     ✓ records a refused fork when pids.max is reached 517ms
     ✓ counts CPU time for the tree, which is what cpuTimeMs records 471ms
     ✓ writes usage to no shared state: two cgroups are independent 766ms

 Test Files  1 passed (1)
      Tests  15 passed (15)
```

Command: `sudo -n bash infra/scripts/worker-with-cgroup.sh npx vitest run apps/worker/test/cgroup.test.ts`.
This is the only way to reach the full tier; from a login shell the kernel refuses migration and
eight tests skip, which is what §2.1 shows.

### 2.4 Dependency audit

```
3 vulnerabilities found
Severity: 1 low | 2 moderate
EXIT:0
```

`--audit-level high` exits 0 because there is no high or critical advisory. The two moderate and
one low remain and are not waived; they are visible in every run.

---

## 3. Test inventory

| Package | Files | Tests | Skipped |
|---|---:|---:|---:|
| `apps/api` | 7 | 84 | 0 |
| `apps/web` | 4 | 80 | 0 |
| `apps/worker` | 14 | 133 | 8 |
| `packages/agent-runtime` | 13 | 112 | 3 |
| `packages/contracts` | 3 | 47 | 0 |
| `packages/database` | 4 | 19 | 0 |
| `packages/design-system` | 4 | 49 | 0 |
| `packages/egress-broker` | 3 | 40 | 0 |
| `packages/evaluation` | 6 | 49 | 0 |
| `packages/workspace-manager` | 4 | 53 | 0 |
| **Total** | **62** | **666** | **11** |

Eleven skips, enumerated:

| Suite | Count | Reason | Is the skip honest? |
|---|---:|---|---|
| `apps/worker/test/cgroup.test.ts` (tier: full) | 8 | Process is outside the delegated cgroup; the kernel refuses migration | Yes — the tier is printed, and the tests pass under the wrapper |
| `apps/worker/test/broker-run.test.ts` | 1 | Needs a live provider run | Yes — a real task through the broker, gated on credentials |
| `packages/agent-runtime/test/opencode-cli.test.ts` (contract cases 7, 8) | 2 | `IZ_REAL_PROVIDER` not set | Yes — cases 7 and 8 are the two that need a live provider |

No test is skipped to make a red suite green. Each skip prints its reason.

---

## 4. The 28 attack scenarios

### 4.1 Provenance of this table — read this first

The directive document that numbered the 28 scenarios is **not in this repository**, and it was
not recoverable from this session's readable storage. What is verifiable is the set of attacks
the phase actually executed, which is what this table enumerates: one row per attack, the control
it targets, the test or probe that covers it, and the status.

If a reader holds the directive and its numbering differs, the row-level evidence below still
stands; the numbering does not. This is stated rather than papered over because a coverage table
whose provenance is invented is worse than no table.

### 4.2 The matrix

| # | Attack | Control that must hold | Coverage | Status |
|---:|---|---|---|---|
| A1 | Read the provider credential store, any host credential path, or another process's environment from inside the sandbox | Every host credential path absent (not masked); `/proc/*/environ` unreadable or secret-free | `credential-isolation.test.ts` — "has no opencode data directory at all", "cannot read another process's environment, and cannot see host processes"; `state-mounts.test.ts` — "mounts nothing from the host", "cannot read any host credential path" | **VERIFIED** |
| A2 | Make the worker's own environment reachable through the **evidence** sandbox (audit F1) | `bwrap` is spawned with an allowlisted env at every call site; `/proc/1/environ` holds only `PATH`/`LANG` | `sandbox-env-isolation.test.ts` — 5 tests, including a negative control that reproduces the old call shape and **requires** the canary to leak; `sandbox.test.ts` — "gives the bwrap process an allowlisted environment" | **VERIFIED** |
| A3 | Find a credential-shaped variable or a second high-entropy value in the sandbox env | No key-matching name; exactly one high-entropy value (the canary) | `credential-isolation.test.ts` — "has no environment key that looks like a credential", "carries only one high-entropy value"; positive control asserts the probe can detect a leak | **VERIFIED** |
| A4 | Present no token, a forged token, or another attempt's token to the broker | `403 BROKER_TOKEN` for all three | `broker.test.ts` — absent and foreign cases; `sandbox-attempt.test.ts` — attempted **from inside** the sandbox | **VERIFIED** |
| A5 | Smuggle an inbound `authorization`/`x-api-key`/`cookie` and have it forwarded | All stripped; the only `Authorization` is the broker's | `broker.test.ts` — "injects the real credential and strips every inbound auth header" | **VERIFIED** |
| A6 | Name an endpoint or method outside the model surface | Exact path allowlist; `403` with a log line | `broker.test.ts` — "refuses a destination that is not an approved path", "refuses a path traversal dressed as an approved endpoint", "refuses a method the broker does not serve" | **VERIFIED** |
| A7 | Redirect the broker to another host (`CONNECT`, absolute-form, `//evil.test/…`, `Host`) | Destination is broker-chosen; caller cannot name it | `broker.test.ts` — "never leaves the configured origin"; audit probe9/10 (stub upstream observed every request) | **VERIFIED** |
| A8 | Recover the credential or token from the broker log | Log shape cannot hold a header, body or token | `broker.test.ts` — "records every decision without a token, a header or a body"; `sandbox-attempt.test.ts` — log scan | **VERIFIED** |
| A9 | Send client-controlled `x-forwarded-host` / `x-forwarded-proto` / `openai-organization` upstream | Stripped or dropped | None — the broker still builds outbound headers from a **strip list**, so unknown headers pass | **NOT IMPLEMENTED** (audit F4, LOW) |
| B1 | Allocate past the memory ceiling | `memory.max` kills the largest process; `oom_kill` recorded | `cgroup.test.ts` (tier: full) — "records an OOM kill when memory.max is exceeded" | **VERIFIED** |
| B2 | Exceed memory into swap and keep running | `memory.swap.max = 0` makes `memory.max` a hard ceiling | `cgroup.test.ts` — limit read-back; audit probe16/18 | **PARTIAL** — verified on this kernel; a kernel without swap accounting has no `memory.swap.max`, the write is skipped, and `readEffectiveLimits` reports `unavailable` |
| B3 | Fork-bomb the host | `pids.max` refuses the fork; `pids.events max` recorded | `cgroup.test.ts` (tier: full) — "records a refused fork when pids.max is reached" | **VERIFIED** |
| B4 | Burn CPU indefinitely | `cpu.max` throttles; `nr_throttled`/`throttled_usec` recorded | `cgroup.test.ts` (tier: full) — "counts CPU time for the tree" | **VERIFIED** |
| B5 | Outlive the run in a descendant process | `cgroup.kill` kills the tree atomically; zero pids remain | `cgroup.test.ts` (tier: full) — "kills the whole tree with cgroup.kill and leaves nothing behind" | **VERIFIED** |
| B6 | Leave the attempt cgroup | `/sys` absent from the mount namespace; membership inherited at `fork()` | `cgroup.test.ts` (tier: full) — "places the sandbox before its first exec, and the child cannot escape"; mount list in `sandbox.ts` | **VERIFIED** |
| B7 | Make the platform claim enforcement it does not have | Probe migrates a real process before reporting `enforced` | `capabilities.test.ts` — "refuses a plain directory", "reports CGROUP_ROOT_NOT_WRITABLE", "refuses a cgroup2 filesystem that does not delegate the controllers" | **VERIFIED** |
| B8 | Fill the disk | Disk quota | None | **NOT IMPLEMENTED** — no filesystem quota; `outputCapBytes` is declared but never enforced, and would not bound the filesystem anyway |
| B9 | Saturate I/O bandwidth | `io.max` | None | **NOT IMPLEMENTED** — this host delegates `cpu memory pids` only |
| C1 | Assert `LOW` on destructive content to skip approval | Server derives the class; client value is evidence; downgrade recorded | `classify.test.ts` (25); `risk-approval.e2e-spec.ts` case 1 | **VERIFIED** |
| C2 | Set `riskSource` / `derivedRiskClass` / `riskPolicyVersion` in the request | `.strict()` rejects unknown keys; server-owned fields stripped | `risk-approval.e2e-spec.ts` case 14 | **VERIFIED** |
| C3 | Reuse one approval, or race two runs through it | Conditional `updateMany`; `count===0` refuses; exactly one of two concurrent runs proceeds | `risk-approval.e2e-spec.ts` cases 6, 7, 13 | **VERIFIED** |
| C4 | Approve your own request, or use an expired/revoked grant | `403 SELF_APPROVAL_FORBIDDEN`; expiry flips the row and refuses; revocation wins | `risk-approval.e2e-spec.ts` cases 8, 9, 10 | **VERIFIED** |
| C5 | Start the Temporal workflow directly with a dead grant | Worker re-checks reserved + unrevoked + unexpired + hash-bound | `approval-direct-start.test.ts` — 4 live refusals: expired, never reserved, revoked, unbound | **VERIFIED** |
| E1 | Reap a workspace whose workflow is still running | `skipped_live` + lease extension | `reaper.test.ts` — 13 tests | **VERIFIED** |
| E2 | Reap a sibling tenant, or a path containing `..` / a cross-tenant `rootPath` | Path recomputed from ids; recorded path only checked for agreement; sibling untouched | `reclaim.test.ts` — "refuses a recorded path that disagrees with the ids", "refuses an id that is not a single path segment"; `reaper.test.ts`; audit probe12 | **VERIFIED** |
| E3 | Reach another tenant through a symlinked ancestor inside the root | Every component `lstat`ed; symlink refused even when it resolves inside the root | `reclaim.test.ts` — "refuses a symlinked ancestor even when the link points inside the root" | **VERIFIED** |
| F1 | Read a file outside the artifact root, or a sibling tenant's artifact | Containment after `realpath`; traversal, absolute and symlink forms refused | `executions.e2e-spec.ts` — "never serves a path outside the configured roots", "refuses a row outside every root with 404"; audit probe13 | **VERIFIED** |
| F2 | Substitute artifact bytes, or serve a vanished file | SHA-256 compared before streaming; `409 ARTIFACT_INTEGRITY_FAILED`; `410 ARTIFACT_GONE` | `executions.e2e-spec.ts` — "refuses tampered bytes", "answers 410", "streams the bytes with their checksum when they match" | **VERIFIED** |

### 4.3 Coverage summary

| Status | Count | Rows |
|---|---:|---|
| **VERIFIED** | **24** | A1–A8, B1, B3–B7, C1–C5, E1–E3, F1–F2 |
| **PARTIAL** | **1** | B2 (swap ceiling is conditional on kernel swap accounting) |
| **NOT IMPLEMENTED** | **3** | A9 (forwarding headers), B8 (disk quota), B9 (I/O bandwidth) |
| **BLOCKED** | **0** | — |

The three gaps are not oversights discovered while writing: they are the same three recorded in
`PHASE-4-RESOURCE-ENFORCEMENT.md` §6 and `PHASE-4-SECURITY-RESULTS.md` §7 as open.

---

## 5. The 15 authorization cases (D-006)

Every case is adversarial: a `MEMBER` trying to get work done without a second pair of eyes. The
suite runs against the real application and a real database, with Temporal pointed at a closed
port so a refused gate is distinguishable from a queued run (`503` = passed the gate, `409` =
refused).

| # | Case | Expected | Status |
|---:|---|---|---|
| 1 | Client asserts `LOW` on critical content | Stored `CRITICAL`; `clientAttemptedDowngrade` recorded; request still succeeds | **VERIFIED** |
| 2 | Client omits `riskClass` | Derived server-side | **VERIFIED** |
| 3 | Task content changed after approval | `409 APPROVAL_STALE`, grant not spent | **VERIFIED** |
| 4 | Source repository / branch changed after approval | `409 APPROVAL_STALE` | **VERIFIED** |
| 5 | Execution profile changed after approval | Heavier profile refused, field named; same profile accepted | **VERIFIED** |
| 6 | One approval used for a second run | `409 APPROVAL_CONSUMED` | **VERIFIED** |
| 7 | Two concurrent runs, one approval | Exactly one proceeds; the other `409` | **VERIFIED** |
| 8 | Self-approval | `403 SELF_APPROVAL_FORBIDDEN` | **VERIFIED** |
| 9 | Expired approval | Row flipped to `EXPIRED`; `409 APPROVAL_EXPIRED`; audited | **VERIFIED** |
| 10 | Revoked approval | `409 APPROVAL_REVOKED`; revoke is idempotent; revoke-after-use recorded without pretending the run was undone | **VERIFIED** |
| 11 | Approval id used under a different organisation | `404` for decision and revoke | **VERIFIED** |
| 12 | Approval with no content binding (Phase 3 legacy row) | `409 APPROVAL_UNBOUND`, not a guess | **VERIFIED** |
| 13 | Retry after consumption | Every retry refused; no replacement approval minted | **VERIFIED** |
| 14 | Server-owned fields in the request body | Accepted then stripped; server values stored | **VERIFIED** |
| 15 | `HIGH` task with no approval via `PATCH → queued` | `409 APPROVAL_REQUIRED`; task stays `ready` | **VERIFIED** |

**15 / 15 VERIFIED.** Source: `apps/api/test/risk-approval.e2e-spec.ts`.

The worker's own copy of the gate adds 18 more cases across two files
(`approval-grant.test.ts` 13, `approval-direct-start.test.ts` 4, `approval-bypass.test.ts` 1), all
passing. Four of those start a real Temporal workflow and are refused before the agent runs.

---

## 6. What the tests do not prove

1. **That a killed run is killed on every host.** The eight full-tier cgroup tests skip without
   the wrapper. A CI machine with a different cgroup layout would report `unavailable` and skip
   them; the suite says so, but a reader who only looks at "62 files passed" will not see it.
2. **That the 28 scenarios are the directive's 28.** See §4.1. The rows are evidence; the
   numbering is a reconstruction.
3. **That the broker cannot be abused by a header it does not know.** A9 is open. The boundary is
   destination and credential, not content.
4. **That the agent cannot write a git filter.** It can; the filter runs inside the evidence
   sandbox. The confidentiality leak is closed; the integrity question is not.
5. **That approvals are bound to a specific workflow.** `consumedAt` proves a reservation
   happened, not that this run made it.
6. **That the evaluation baseline means anything about a model.** The only baseline is simulated;
   the real one is `BLOCKED`.
7. **That CI is green.** It has never run.
8. **That a screen reader can use the UI.** Axe, landmarks and keyboard tests only.

---

## 7. Reproduce

```bash
# Gates
pnpm typecheck
pnpm lint
pnpm build
pnpm audit --audit-level high          # exits 0; 1 low + 2 moderate remain
bash infra/scripts/check-spawn-discipline.sh

# Unit and integration (needs TEST_DATABASE_URL for the DB-backed suites)
npx vitest run

# The cgroup kill matrix, which only runs at full tier
sudo bash infra/scripts/worker-with-cgroup.sh npx vitest run apps/worker/test/cgroup.test.ts

# E2E, with the stack up (Temporal 7233, API 4100, web 3100)
pnpm --filter @intelligenz/api test:e2e
pnpm --filter @intelligenz/web test:e2e

# The live-provider contract cases, paid and explicit
IZ_REAL_PROVIDER=1 AGENT_MODEL=gemini-3.5-flash-lite \
  npx vitest run packages/agent-runtime/test/opencode-cli.test.ts
```
