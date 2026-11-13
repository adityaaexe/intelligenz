# Phase 3 implementation plan — as executed

**Task:** DOC-301 (engineering record)
**Branch:** `phase-3/real-agent-runtime` (uncommitted working tree; last commit `43d5c17`)
**Date:** 2026-11-13

> **This plan was written after the work, not before it.**
>
> There is no pre-execution Phase 3 plan in this repository. The sequence below is
> reconstructed from the working tree, the migration timestamps, the security report's
> timeline and the row timestamps in the development database. It records **what was
> done and in what order**, including the units that only exist because the audit forced
> them. It is not evidence of foresight, and it must not be read as "the plan was
> followed". Where a unit was added mid-phase, §4 says so.

---

## 0. Gate definitions

Gates are exit conditions, not phases. A gate closes when its check passes on the tree
that exists at that moment; a later unit can reopen an earlier gate, and two did (§4).

| Gate | Name | Question | Exit condition |
|---|---|---|---|
| **G0** | Baseline | What does this host actually provide? | Node, pnpm, Postgres, Temporal, `bwrap`, `opencode` version and a live headless probe are recorded with output; no claim is inherited from Phase 2 |
| **G1** | Schema | Can execution identity and workspace life be stored without ambiguity? | Migration applies to an empty database; `(workflowRunId, attemptNumber)` unique; `ExecutionWorkspace.rootPath` unique; identity tests pass |
| **G2** | Sandbox | Is the isolation measured rather than declared? | `probeSandbox` reports `networkBlocked`, `rootReadOnly`, `canWriteWorkspace` true from inside a real `bwrap`; path and symlink escapes fail; the builder refuses to run without `bwrap` |
| **G3** | Adapter | Does a real agent run, and does it obey the port? | The reusable contract suite passes (minus the declared non-determinism skip); a real task fixes the fixture bug; artifacts re-hash to their reported digests |
| **G4** | Wiring | Does the product record the run, not just the adapter? | A task started through the API produces `ExecutionWorkspace`, `ExecutionAttempt` (#1), `AgentRun`, ≥1 `ToolInvocation`, ≥1 `Artifact`, and a terminal `Task` state |
| **G5** | Surface | Can an operator read the run? | Execution detail route renders attempts, trace, artifacts and integrity from the API at 1440/1024/768/390; every row labelled from `simulated` |
| **G6** | Assurance | Is the claim set honest? | Gate commands run with literal output; the adversarial audit is complete; every Critical is closed or explicitly carried as a condition; the fifteen security cases are mapped or recorded as gaps |

---

## 1. Units, in the order they landed

| # | Unit | Owner role | Files (principal) | Depends on | Gate |
|---|---|---|---|---|---|
| 1 | **P3-000** — baseline recon | `@agent-engineer` | `docs/engineering/PHASE-3-BASELINE.md` | — | G0 |
| 2 | **DB-301** — execution schema | `@database` | `packages/database/prisma/schema.prisma`, `prisma/migrations/20261113124350_execution_workspaces/`, `packages/database/test/execution-identity.test.ts` | G0 | G1 |
| 3 | **AG-301a** — workspace manager | `@agent-engineer` | `packages/workspace-manager/src/{manager,paths,state,sandbox,errors,index}.ts`, `test/workspace-manager.test.ts` | DB-301 | G1, G2 |
| 4 | **AG-301b** — sandbox argv + probe | `@agent-engineer` | `packages/workspace-manager/src/sandbox.ts`, `test/sandbox.test.ts` | AG-301a | G2 |
| 5 | **AG-301c** — real adapter | `@agent-engineer` | `packages/agent-runtime/src/runtimes/opencode-cli.ts`, `opencode-stream.ts`, `sandbox/{egress-proxy,entry-source,state-mounts}.ts`, `process-group.ts`, `redact.ts`, `test/{opencode-cli,egress-proxy,state-mounts,transcript,redact,process-group}.test.ts` | AG-301b | G2, G3 |
| 6 | **AG-301d** — contract suite | `@agent-engineer` | `packages/agent-runtime/test/runtime-contract.ts`, `local-simulated.test.ts`, exported as `@intelligenz/agent-runtime/testing` | AG-301c | G3 |
| 7 | **BE-302a** — worker lifecycle | `@node-developer` | `apps/worker/src/activities/{attempts,workspace,artifacts}.ts`, `execute-agent.ts`, `persist-result.ts`, `ids.ts`, `runtime.ts`, `config.ts`, `test/{execution-persistence,workspace-lifecycle,runtime-selection,approval-bypass}.test.ts` | DB-301, AG-301c | G4 |
| 8 | **BE-302b** — execution reads | `@node-developer` | `apps/api/src/executions/**`, `apps/api/src/artifacts/**`, `apps/api/test/executions.e2e-spec.ts`, `apps/api/api-contract.md` | BE-302a | G4 |
| 9 | **FE-301** — execution UI | `@frontend-react` | `apps/web/src/app/[workspace]/tasks/[taskId]/page.tsx`, `components/executions/**`, `lib/{executions,execution-state}.ts`, `e2e/executions.e2e.ts` | BE-302b | G5 |
| 10 | **OPS-301** — real-run proof | `@agent-engineer` | `infra/scripts/p3-real-run.ts`, `infra/scripts/p3-sandbox-audit.ts`, `infra/fixtures/sample-repo/**` | AG-301c, BE-302a | G3, G4 |
| 11 | **SEC-301** — adversarial audit | `@security-architect` | `docs/engineering/PHASE-3-SECURITY-RESULTS.md` §1–§8 | all of the above | G6 |
| 12 | **SEC-302-F1** — host `git` removal | `@agent-engineer` | `opencode-cli.ts` (`collectWorkspaceEvidence`), `workspace-manager/src/manager.ts` (`readHeadSandboxed`), `infra/scripts/p3-real-run.ts`, `test/workspace-git.test.ts` | SEC-301 | G2, G6 |
| 13 | **SEC-302-F2** — state allowlist + transcript | `@agent-engineer` | `sandbox/state-mounts.ts`, `test/state-mounts.test.ts`, `redact.ts`, `test/redact.test.ts`, `TranscriptBuffer`, `apps/api/src/artifacts/artifacts.service.ts`, `test/executions.e2e-spec.ts` | SEC-301 | G6 |
| 14 | **SEC-302-F3** — resource ceilings | `@agent-engineer` | `sandbox/entry-source.ts` (`prlimit`), `process-group.ts`, `test/process-group.test.ts`, `apps/worker/src/config.ts`, `test/config.test.ts` | SEC-301 | G2, G6 |
| 15 | **SEC-302-F4** — egress pinning | `@agent-engineer` | `sandbox/egress-proxy.ts`, `test/egress-proxy.test.ts`, `packages/agent-runtime/src/types.ts`, `ADR-006` note | SEC-301 | G6 |
| 16 | **SEC-302-F5** — policy record | `@technical-writer` + owner | `docs/decisions/OPEN-DECISIONS.md` D-006, `apps/api/test/tasks.e2e-spec.ts` | SEC-301 | G6 |
| 17 | **DOC-301** — engineering record | `@technical-writer` | `docs/engineering/PHASE-3-*.md`, `docs/engineering/RUNTIME-ADAPTER-GUIDE.md`, `docs/engineering/WORKSPACE-SECURITY-MODEL.md`, `docs/engineering/EXECUTION-LIFECYCLE.md`, `README.md` | all | G6 |

Owner roles are the roles that did the work, not a claim about staffing. One agent held
several roles in this phase; the file boundaries are what prevented collisions, not the
labels.

---

## 2. Sequencing rule that was actually followed

```
G0 baseline
  └─ DB-301 schema
       └─ AG-301a workspace manager ── AG-301b sandbox
                                        └─ AG-301c adapter ── AG-301d contract suite
                                              └─ BE-302a worker ── BE-302b API
                                                    └─ FE-301 UI
                                                          └─ OPS-301 real run
                                                                └─ SEC-301 audit
                                                                      └─ SEC-302 remediation
                                                                            └─ DOC-301
```

Two inversions were deliberate:

1. **The adapter came before the product wiring.** A real run can be proven by a script
   (`p3-real-run.ts`) long before the worker can schedule one. Proving the sandbox and the
   contract first meant the wiring was built against a known-working component instead of
   debugging both at once.
2. **The UI came before the audit.** That was a scheduling choice, not a safety one: the
   audit then reported that it had not reviewed the UI, so the surface carries no
   adversarial sign-off (see §5).

---

## 3. What each unit had to prove (acceptance checks as executed)

| Unit | Acceptance check | Result |
|---|---|---|
| DB-301 | `prisma migrate deploy` on empty DB; `@@unique([workflowRunId, attemptNumber])` present; every new tenant model carries `orgId` | pass — migration applied, identity tests 7/7 |
| AG-301a | A traversal id is refused before `mkdir`; a symlinked candidate is refused after `realpath`; a forged handle cannot delete a sibling; `provision → ready → executing → preserving → completed` only along declared edges | pass — `workspace-manager.test.ts`, 24 tests incl. the id table |
| AG-301b | From inside a real sandbox: TCP to `1.1.1.1:443` fails, `/etc` write fails, `/workspace` write succeeds; no `bwrap` → throw | pass — 10 tests |
| AG-301c | `opencode --version` probed; argv built with no shell; NDJSON parsed into events, usage and tool calls; a cancelled signal kills the process group and its descendants | pass — contract + unit tests, one skipped by declaration |
| AG-301d | Two adapters pass the same eight assertions; a non-deterministic adapter declares it and the determinism assertion is visibly skipped | pass — `local-simulated` 8/8, `opencode-cli` 7 pass + 1 skipped |
| BE-302a | Attempt numbered per workflow run, unique; workspace row follows the manager; provisioning failure recorded with stage/code; artifact bytes re-hashed after copy; `local-simulated` + `simulated:false` refused | pass — `execution-persistence.test.ts` 6, `workspace-lifecycle.test.ts` 4 |
| BE-302b | Attempt list newest-first; foreign attempt `404`; artifact integrity computed; tamper `409`; gone `410`; transcript `403` for `VIEWER`/`MEMBER` | pass — `executions.e2e-spec.ts` 16 |
| FE-301 | Attempt rows labelled from the API's `simulated`; trace count equals API count; integrity stated in words; four viewports | pass — 6 tests × 4 projects |
| OPS-301 | Real run: agent fixes the bug, suite passes in the sandbox, fixture unchanged | pass — §2 of the status document |
| SEC-301 | Two Criticals reproduced with evidence, not asserted | pass — F1 reproduced as host code execution |
| SEC-302 | Each finding either closed with a regression test or re-graded with a stated residual | pass — F1/F4 closed, F2/F3 re-graded, F5 recorded |

---

## 4. Where the audit forced the plan to change

The audit was not a review pass at the end; it invalidated a unit that was already
"done". Four changes were forced, and each added work that no earlier unit had planned.

### 4.1 F1 — the diff was produced by host `git`

**What the plan assumed.** After the sandbox exits, the adapter runs
`git -C <workspace>/repo diff` and `status` on the host. It was treated as a read.

**What the audit found.** The workspace is agent-writable, so `.git/config`
(`core.fsmonitor`) and `.git/hooks/*` are agent-authored programs. Host `git` executes
them. Reproduced end to end: the payload ran as `ubuntu`, wrote the worker's environment
to disk, and `sudo -n` succeeds on this host.

**What changed.**

- New function `collectWorkspaceEvidence()` runs `git` inside a fresh `bwrap` with the
  run's own profile, plus `-c core.fsmonitor=false -c core.hooksPath=/dev/null
  -c diff.external=`, `--no-ext-diff`, `--no-textconv`, `GIT_CONFIG_NOSYSTEM=1`,
  `GIT_CONFIG_GLOBAL=/dev/null`.
- `workspace-manager` gained `readHeadSandboxed()` for the two paths that adopt a
  directory an agent may have written (`provision()`'s idempotency branch and `recover()`).
- `p3-real-run.ts` stopped calling host `git` against the workspace.
- New regression test `workspace-git.test.ts` with a **negative control**: the payload is
  proved live on a host `git` before the adapter path is asserted safe.

**Gate impact.** G2 reopened. The sandbox was correct; the platform around it was not.

### 4.2 F2 — the whole `$HOME` was mounted, and the transcript was served raw

**What the plan assumed.** The adapter needs the provider credential, so it mounts
`$HOME/.local/share`, `$HOME/.local/state` and `$HOME/.cache`. The transcript was treated
as an artifact like any other.

**What the audit found.** Measured from inside: 6 provider credentials, 696 operator
sessions, a 1.07 GB database, `mcp-auth.json`, the agentmemory secret and the NSS
`key4.db`. The transcript — raw model and shell output — was written verbatim and served
to any `VIEWER`.

**What changed.**

- New module `sandbox/state-mounts.ts`: four paths, only if they exist; `$HOME` never
  mounted; `mcp-auth.json` masked with `/dev/null`; six operator directories masked with
  empty tmpfs.
- `TranscriptBuffer.push()` redacts every line before it is retained; capped at 5 MiB with
  an explicit truncation line.
- `redact.ts` extended: bare JWT, URL userinfo, case-insensitive `KEY=value`, `npm_`,
  base64 decode pass.
- `ArtifactsService.content()` refuses a raw transcript below `ADMIN`, before reading a byte.
- New tests: `state-mounts.test.ts` (7), `transcript.test.ts` (5), `redact.test.ts` (15).

**Gate impact.** G6 cannot close; the unit is carried as **CONDITIONAL PASS**. The
database cannot be masked — auth lives in it — so one credential remains readable in the
sandbox. Moving authentication into the egress proxy is the only structural fix and is not
in this phase.

### 4.3 F3 — no CPU, memory, pid or disk limit

**What the plan assumed.** The adapter's timeout bounded a run. It bounds wall time only
while the Node event loop is alive.

**What changed.**

- `prlimit` wrapper in the sandbox entry shim: `nofile=1024`, `nproc=4096`, `AS=6 GiB`.
- `runInProcessGroup()`: `SIGTERM` to `-pgid`, `SIGKILL` after a grace window; four tests,
  including a backgrounded grandchild and a positive control.
- `AGENT_MAX_USD` defaulted to `0.5`; `0` refused at boot for a real runtime.
- `RLIMIT_FSIZE` was implemented, measured, and **removed**: the provider database is
  ~1 GiB and the ephemeral overlay copies it up on first write, so any per-file limit below
  that kills the agent at startup.

**Gate impact.** F3 High → Medium. No cgroup, no disk quota. G6 records the residual.

### 4.4 F4 — `network: false` overstated

**What the plan assumed.** A proxy with a host allowlist was sufficient.

**What the audit found.** `CONNECT` validated the host, not the port;
`CONNECT localhost:18082` reached a second service. Absolute-form HTTP was forwarded with
a spoofed `Host`.

**What changed.**

- `CONNECT` requires an exact allowlist entry **and** port 443.
- Absolute-form HTTP is refused outright.
- Every decision is logged `{host, port, allowed, method}`.
- `RuntimeCapabilities.network` documentation and ADR-006's note were rewritten to the
  precise claim.

**Gate impact.** F4 closed. The tunnel remains opaque and unrated; that is stated, not
fixed.

### 4.5 F5 — the approval gate is self-attested

**What changed.** Nothing in code. The finding is a product decision (who may classify
work as low risk), recorded as **D-006** with four options and a recommendation. A test in
`tasks.e2e-spec.ts` pins today's behaviour so a policy change cannot pass silently.

**Gate impact.** F5 High → Medium (open). G6 records it as an accepted policy risk.

---

## 5. What was planned, then cut

| Item | Why it is not here |
|---|---|
| **Evaluation framework (directive §10)** | No benchmark set, no task corpus, no completion-rate or cost metric across tasks. Six fixtures and one real run are a proof, not an evaluation. Building it needs a repository corpus and a budget, neither of which this phase had. |
| **Workspace reaper** | `cleanup()` runs at the end of an attempt; a hard kill leaves a directory and a non-terminal row. `recover()` can repair the row, but nothing schedules it. A sweeper needs a supervisor this deployment does not have. |
| **Multi-tenant live fixture** | Only one source repository is configured. Tenant isolation is proved at the database and API layers, not with two concurrent real runs in two orgs. |
| **CI execution** | No `gh`, no remote, no push credential. `.github/workflows/ci.yml` is authored and has never run. |
| **Screen-reader session** | Not performed. Accessibility evidence is axe (zero violations), landmark tests and keyboard tests; none of those is a screen-reader session. |

These are recorded in `PHASE-3-KNOWN-LIMITATIONS.md`, not hidden here.

---

## 6. Collision rule

One unit, one file set. The only shared files were:

| File | Units that touched it | How conflict was avoided |
|---|---|---|
| `packages/workspace-manager/src/sandbox.ts` | AG-301b, SEC-302-F3 (rlimit flag probe) | F3 added an option and a probe; it did not change the mount layout |
| `packages/agent-runtime/src/runtimes/opencode-cli.ts` | AG-301c, SEC-302-F1, SEC-302-F2, SEC-302-F3 | sequential; each change confined to one function (`collectWorkspaceEvidence`, `mountsFor`, the entry env) |
| `apps/worker/src/config.ts` | BE-302a, SEC-302-F3 | F3 changed the `AGENT_MAX_USD` default and the boot refusal only |
| `apps/api/test/executions.e2e-spec.ts` | BE-302b, SEC-302-F2 | transcript role tests appended, existing assertions untouched |
| `docs/engineering/PHASE-3-SECURITY-RESULTS.md` | SEC-301, SEC-302 | append-only addendum; the audit text was not edited |

No two units wrote the same file concurrently. That is a statement about this phase's
history, not a guarantee for the next one.

---

## 7. Definition of done for Phase 3, and the verdict

| Condition | Status |
|---|---|
| `pnpm -w typecheck` exits 0 | yes — 8 projects |
| `pnpm lint` exits 0 with zero warnings | yes |
| `pnpm -w test` passes | yes — 38 files, 412 passed, 1 skipped |
| `pnpm --filter @intelligenz/api test:e2e` passes | yes — 60 passed |
| `pnpm --filter @intelligenz/web test:e2e` passes | yes — 57 passed, 3 skipped |
| `pnpm -w build` exits 0 | yes |
| `pnpm audit --audit-level high` | **no — 7 advisories, 2 high (PostCSS via Next.js). Exit 1.** Recorded in `PHASE-3-TEST-RESULTS.md` §1.7 and D-004 |
| A real agent run is recorded end to end | yes — §2 of the status document |
| Two Criticals closed | F1 closed; F2 carried as a condition |
| The fifteen security cases mapped | 13 `VERIFIED`, 1 `PARTIAL`, 1 `NOT IMPLEMENTED`, 4 gaps — `PHASE-3-TEST-RESULTS.md` §4 |
| Every claim carries a status word | yes, in these documents |

The phase is **done enough to hand to an operator for a trusted repository**, and not done
enough to run against a repository whose contents are sensitive. That distinction is the
whole of §5 in `WORKSPACE-SECURITY-MODEL.md`.
