# Phase 4 — Implementation Plan (executed, recorded post-hoc)

**Branch:** `phase-4/execution-trust` · **Base:** `c104e64` · **Written:** 2026-11-14
**Status:** this plan is a **reconstruction**. The work was decomposed and executed first; this
file records the decomposition that was actually run, unit by unit, with the outcome of each.
It is not a forecast, and nothing in it is marked complete because it was intended.

**Phase 4 goal:** make execution defensible. Not broader: not more screens, not more adapters,
not more integrations. Every unit below closes a control that Phase 3 shipped as a claim.

**Vocabulary** (contract §13): `VERIFIED` — reproduced by a test or command, output quoted.
`IMPLEMENTED` — code exists, runtime verification incomplete. `PARTIAL` — some required
behaviour exists. `BLOCKED` — an external dependency prevents progress and is named.
`NOT IMPLEMENTED` — nothing exists.

---

## 1. Why the decomposition looks like this

Phase 3 ended with a working real agent and six controls that did not hold under audit:

| Phase 3 control | What was actually true | Gate |
|---|---|---|
| Sandbox cannot read the provider credential | `opencode.db` (1.08 GB, credential + 696 sessions) was mounted so the agent could authenticate | A |
| Resource limits are enforced | `RLIMIT_AS`/`RLIMIT_NPROC` per process; aggregate unbounded | B |
| Risk is classified by the server | Client-supplied `riskClass`, trusted | C |
| Approval is single-use and bound | One `APPROVED` row, never consumed, self-approval permitted | C |
| Artifacts belong to an attempt | Time-window heuristic, no foreign key | F |
| An evaluation harness exists | It did not | D |

A control that depends on a caller remembering something is not a control (audit F1 is exactly
that failure). So the units are ordered by **blast radius**, and each one is expected to produce
a *measurement*, not a code review: a probe, a test with a negative control, or a command whose
output is quoted in the phase record.

**Gate order and why.**

| Order | Gate | Reason for its position |
|---:|---|---|
| 1 | A — credential isolation | Highest risk, and it determines whether a real run can be trusted at all. Blocks G. |
| 2 | B — resource enforcement | Independent of A. A real run without aggregate limits is an unbounded run with a label. |
| 3 | C — authorization (D-006) | Independent of A/B, but a real run must be authorised before it is measured. |
| 4 | D — evaluation | Needs a real runtime (A+B) to produce a real baseline; the harness itself has no external dependency. |
| 5 | E — workspace lifecycle | Needs leases in the schema; independent of A–D. |
| 6 | F — artifact provenance | Additive migration; depends on E's workspace identity. |
| 7 | G — adversarial audit | Audits A–F. Must run last, and its findings become units. |
| 8 | H — engineering gates | Closes the audit's class-level findings; depends on G. |
| 9 | I — documentation | This file and its siblings. Depends on every measurement above. |

---

## 2. Units

### Gate A — credential isolation

| Unit | What was built | Done when | Outcome |
|---|---|---|---|
| **A1** | `packages/egress-broker`: per-attempt unix-socket listener, capability token, exact path allowlist, header strip, host-side credential injection, decision log | A request with a foreign or absent token is refused `403`; a caller cannot name a destination | **VERIFIED** — `packages/egress-broker/test/broker.test.ts` (20 tests), `sandbox-attempt.test.ts` (8) |
| **A2** | `credential.ts`: read from `opencode.db` (`credential` table) or from an env var; typed, value-free errors; expired OAuth refused rather than sent | A missing or expired credential fails with a message that contains no secret | **VERIFIED** — `credential.test.ts` (12 tests), including the header-injection rejection |
| **A3** | Sandbox state: no host `$HOME` mount. An empty, writable state tree is created inside the sandbox; `opencode.db` is absent, not masked | A probe inside the production sandbox layout reports every host credential path absent | **VERIFIED** — `credential-isolation.test.ts` (11), `state-mounts.test.ts` (4) |
| **A4** | Relay: the sandbox's `127.0.0.1:8899` is bridged to the per-attempt socket; the sandbox sees `izbroker/<key>` as its model | opencode completes a turn through the relay with no credential in its environment | **VERIFIED** — `broker-run.test.ts`; structured proof in §4 |
| **A5** | `infra/scripts/p4-broker-proof.ts`: host facts, sandbox probe, broker refusals from inside the sandbox, one real task end to end, log scan, cost | A real agent fixes a real failing test through the broker, and the log holds no secret | **VERIFIED** — 10.9 s, 5 tool calls, 18,623 in / 151 out tokens, provider-reported `$0.000000` (free tier; the OpenAI-compatible surface reports usage but no cost field) |

**Exit condition for Gate A:** the sandbox holds no credential, and the only authentication path
is a host process the agent cannot address. Both measured, plus a positive control that the probe
can detect a leak when one is planted.

### Gate B — resource enforcement

| Unit | What was built | Done when | Outcome |
|---|---|---|---|
| **B1** | `apps/worker/src/cgroup.ts`: create/limit/place/read/kill/remove, as ten file operations and no privilege | Limits are read back from the files the kernel enforces from | **VERIFIED** — `cgroup.test.ts` (15), full tier under the wrapper |
| **B2** | `infra/scripts/setup-cgroups.sh`: one root step, idempotent, prints the delegated controllers; `worker-with-cgroup.sh`: root writes one pid, drops uid, execs | Runtime needs no privilege; a normal shell honestly reports `unavailable` | **VERIFIED** — the wrapper was exercised in this session (15/15 full-tier tests); the delegation was already present, so `setup-cgroups.sh` itself was not re-run. `CGROUP_MIGRATION_DENIED` reproduced from a login shell |
| **B3** | `resource-profiles.ts`: SMALL/STANDARD/HEAVY, server-selected from risk class, `HEAVY` refused without cgroups | The attempt row records a profile the cgroup actually applied | **VERIFIED** — `resource-profiles.test.ts` (15) |
| **B4** | Capability probe: a plain directory returns `CGROUP_NOT_CGROUP2`; a symlink is refused; a root-owned root returns `CGROUP_ROOT_NOT_WRITABLE`; a non-delegated tree returns `CGROUP_MIGRATION_DENIED` | No configuration-only `enforced` claim | **VERIFIED** — `capabilities.test.ts`; audit probe3 |
| **B5** | Termination: `cgroup.kill` after the grace signal; `terminationReason` derived from `oom_kill` / `pids.events max` / wall clock / spend | A killed run says *why* it was killed | **VERIFIED** — `termination.test.ts` (15) |

### Gate C — authorization (D-006)

| Unit | What was built | Done when | Outcome |
|---|---|---|---|
| **C1** | `apps/api/src/risk/`: versioned policy `2026-11-14.1`, server-derived class, hard floors, security signals, repository text treated as hostile input | A client `LOW` on destructive content is stored `CRITICAL` and the downgrade attempt is recorded | **VERIFIED** — `classify.test.ts` (25), `risk-approval.e2e-spec.ts` cases 1–2 |
| **C2** | `approval-binding.ts`: content hash over title/goal/criteria/risk/profile/source/commit; profile binding | A grant is an authorisation for one exact request | **VERIFIED** — e2e cases 3–5 |
| **C3** | `approval-gate.service.ts`: tenant-scoped, single-use consumption via conditional `updateMany` (`count === 0` → refusal), self-approval `403`, expiry, revocation, `APPROVAL_UNBOUND` for legacy rows | Two concurrent runs with one grant: exactly one proceeds | **VERIFIED** — e2e cases 6–15 |
| **C4** | Worker re-check: reserved **and** unrevoked **and** unexpired **and** hash-bound, refusing with a specific code | A direct Temporal start with a dead grant ends before the agent runs | **VERIFIED** — `approval-grant.test.ts` (13), `approval-direct-start.test.ts` (4 live Temporal refusals) |

### Gate D — evaluation

| Unit | What was built | Done when | Outcome |
|---|---|---|---|
| **D1** | `packages/evaluation`: benchmark model, 8 fixtures with `BENCHMARK.json` | A fixture is a repository, not a mock; a version bump invalidates its simulation | **VERIFIED** — `benchmark.test.ts` |
| **D2** | Judges: `command`, `file-equals`, `file-absent`, `grep`, `diff-files`; no model judge | Every judge is a command, hash, regex or diff count | **VERIFIED** — `judge.test.ts` |
| **D3** | Rubric `2026-11-14.1` with weights 40/25/15/10/10, normalised over applicable dimensions; security event forces 0 and `disqualified` | A run that passes 4/5 judges but leaks `/etc/passwd` scores 0 | **VERIFIED** — `rubric.test.ts`; `path-traversal-attempt` = 0.00 with 4 passing judges |
| **D4** | Aggregation that refuses to mix modes, rubric versions or benchmark versions | A simulated number cannot be averaged with a real one | **VERIFIED** — `aggregate.test.ts` |
| **D5** | CLI + simulated baseline + real baseline attempt | A real baseline exists, or its blocker is named | **PARTIAL** — simulated baseline recorded; **real baseline BLOCKED** by provider `429 RESOURCE_EXHAUSTED` (20 requests/day) |

### Gate E — workspace lifecycle

| Unit | What was built | Done when | Outcome |
|---|---|---|---|
| **E1** | Lease columns: `leaseOwner`, `leaseExpiresAt`, `lastHeartbeatAt`, `cleanupAttempts`; conditional-UPDATE lease acquisition | Two workers cannot both believe they own a directory | **VERIFIED** — schema + `workspace-lifecycle.test.ts` |
| **E2** | Reaper: expired lease beyond 2× interval + no live workflow + non-terminal state; decisions `reaped` / `skipped_live` / `skipped_unknown` / `skipped_fresh` / `quarantined` / `cleanup_failed` | Every "do nothing" case is tested as a first-class outcome | **VERIFIED** — `reaper.test.ts` (13) |
| **E3** | Reclaim + quarantine: path recomputed from ids, every component `lstat`ed, symlinks refused, artifacts copied before removal | `..`, absolute ids and symlinked parents are refused; a sibling tenant is untouched | **VERIFIED** — `reclaim.test.ts`, audit probe12 |

### Gate F — artifact provenance

| Unit | What was built | Done when | Outcome |
|---|---|---|---|
| **F1** | `Artifact.attemptId` / `workspaceId` FKs (`SetNull`), never backfilled; `unattributed: true` for legacy rows | An artifact with no link is reported as unattributed, not attributed to the latest run | **VERIFIED** — `executions.e2e-spec.ts` |
| **F2** | `artifact-locator.ts`: containment after `realpath`, symlink handling, logical URI, checksum verification | Tampered bytes → `409 ARTIFACT_INTEGRITY_FAILED`; missing → `410`; outside root → `404` | **VERIFIED** — 12 artifact e2e cases (containment, checksum, `410`, transcript authorisation) plus the `unattributed` assertion |

### Gate G — adversarial audit and remediation

| Unit | What was built | Done when | Outcome |
|---|---|---|---|
| **G1** | Independent audit (`PHASE-4-SECURITY-RESULTS.md`), verdict CONDITIONAL PASS, six findings | Findings are reproduced, not inferred | **VERIFIED** — audit document, probes 1–19 |
| **G2** | F1 remediation: `env` is a required field of the sandbox command; `execSandboxed` is the only sanctioned spawn; canary test with negative control | The old call shape leaks the canary; the production path does not | **VERIFIED** — `sandbox-env-isolation.test.ts` (5, including control) |
| **G3** | F2 remediation: the worker enforces all five predicates | A dead grant refuses a direct start with a specific code | **VERIFIED** — 4 live refusals |
| **G4** | F3 remediation: `sk_live_`, `glpat-`, AWS secret patterns added, plus bare-value fixtures | The three uncovered families are redacted; bare values tested | **VERIFIED** — `redact.test.ts` + `execSandboxed` regression |

### Gate H — engineering gates

| Unit | What was built | Done when | Outcome |
|---|---|---|---|
| **H1** | `SEC-403` lint rule + `SPAWN_OWNERS` allowlist + `check-spawn-discipline.sh` | A bare `child_process` import fails lint in boundary packages; a sanctioned owner passes | **VERIFIED** — 5 blocked, 1 allowed, exit 0 |
| **H2** | Dependency audit: PostCSS pinned via `pnpm.overrides` to `8.5.32` | `pnpm audit --audit-level high` exits 0 | **VERIFIED** — 3 vulnerabilities, 1 low / 2 moderate, 0 high or critical |
| **H3** | CI workflow authored | It runs | **NOT IMPLEMENTED** — `.github/workflows/ci.yml` exists and has never run (no remote, no `gh`, no push credential). Local equivalent: `infra/scripts/verify.sh` |

### Gate I — documentation

| Unit | Deliverable | Outcome |
|---|---|---|
| **I1** | This plan | **VERIFIED** (as a record, not a forecast) |
| **I2** | Implementation status with evidence | **VERIFIED** |
| **I3** | Test results with literal output and the 28/15 mapping | **VERIFIED** |
| **I4** | Security remediation appended to the audit | **VERIFIED** |
| **I5** | Resource enforcement: effective vs configured, what is not enforced | **VERIFIED** |
| **I6** | Credential isolation: traffic path, mount table, adversarial results | **VERIFIED** |
| **I7** | Evaluation framework: inventory, rubric, baselines, limitations | **VERIFIED** |
| **I8** | Workspace recovery: leases, decision table, crash tests | **VERIFIED** |
| **I9** | README updated to Phase 4 reality | **VERIFIED** |
| **I10** | Drift fixed: `OPENCODE_CLI_SKIP` → `IZ_REAL_PROVIDER` | **VERIFIED** |

---

## 3. Ordering constraints that turned out to matter

1. **A3 had to precede A1's proof.** The broker can only be proven once the sandbox no longer
   mounts the credential database. Building the broker first produced a passing test against a
   sandbox that could still read the key.
2. **B2 (root step) had to precede B5 (kill tests).** Without the wrapper, `cgroup.procs`
   migration returns `EPERM` and every kill test silently downgrades to the `limited` tier. The
   suite now *reports* its tier instead of pretending.
3. **C3 had to precede C4.** The worker's re-check consumes the API's reservation contract
   (`consumedAt` non-null). Writing the worker first produced a second writer and two consuming
   paths.
4. **G1 had to precede G2–G4.** The audit found F1, which no test in the phase had been written
   to catch: the sandbox held no credential, and the *evidence* sandbox leaked the worker
   environment. The remediation is a required-field change, not an extra `env:` line.
5. **H1 had to follow G2.** The lint rule is the class-level fix for F1; writing it before the
   fix would have produced an allowlist that legitimised the leak.

---

## 4. What the plan did not include, and why

| Not planned | Reason |
|---|---|
| A second runtime adapter | Phase 4 hardens one path; a second adapter multiplies the surface before the first is defensible |
| Disk quota and I/O bandwidth | cgroup v2 has `io.max`, but this host's delegation covers `cpu memory pids` only; claiming it would be a configuration claim, not a measurement |
| A real baseline with statistical power | Depends on provider quota; **BLOCKED**, and recorded as such |
| Approval-expiry sweeper | Data hygiene, not a bypass (the gate refuses expired grants). Named as a residual instead |
| A seccomp/LSM profile | Requires a kernel policy and a test harness that this phase did not build. Stated as the top residual, not silently skipped |
| Fixing F4 (header forwarding) | LOW severity; the strip-list remains. Recorded as open, not waived |

---

## 5. Post-hoc honesty note

Three things in this plan were **not** known when it was written:

1. **F1 existed.** The phase's own tests asserted "the sandbox holds no credential" and were
   true. The leak was in a *second* sandbox used for evidence collection. The plan's Gate G was
   scheduled as an audit; it became the most valuable unit in the phase.
2. **Gate B would be opt-in.** The plan assumed enforcement could be default. The kernel
   disagrees: migrating a process into a cgroup requires write access to the source cgroup, so a
   worker started from a login shell cannot place its children. The honest outcome is a wrapper
   and a loud `unavailable`, which is what shipped.
3. **The real baseline would be blocked by quota, not by code.** The harness, broker, credential
   and sandbox all worked in the same attempt. The provider's free tier (20 requests/day) stopped
   it. The plan treated real-mode execution as an engineering risk; it was a supply risk.

Each of those changed the phase's output. None of them changed its verdict vocabulary: the
record uses `BLOCKED` and `PARTIAL` where they apply.
