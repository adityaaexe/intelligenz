# Phase 3 test results — literal output and security-case mapping

**Task:** DOC-301
**Date:** 2026-11-13
**Tree:** `phase-3/real-agent-runtime`, working tree at `43d5c17` + Phase 3 changes
**Host:** Node v22.23.2 · pnpm 10.15.1 · PostgreSQL 18.6 · Temporal 1.10.0 · bubblewrap 0.11.1 · opencode v2.2.7

Every command below was run in this session against this tree. Output is pasted as it
printed, trimmed only where a line repeats. Exit codes are the shell's, not a summary.

---

## 1. Gate results

### 1.1 `pnpm -w typecheck`

```
> intelligenz@0.0.0 typecheck /home/ubuntu/intelligenz
> pnpm -r --workspace-concurrency=4 run typecheck

Scope: 8 of 9 workspace projects
packages/contracts typecheck$ tsc --noEmit -p tsconfig.json
packages/database typecheck$ prisma generate && tsc --noEmit -p tsconfig.json
packages/design-system typecheck$ tsc --noEmit -p tsconfig.json
packages/workspace-manager typecheck$ tsc --noEmit -p tsconfig.json
packages/database typecheck: ✔ Generated Prisma Client (7.10.1) to ./generated/prisma in 866ms
packages/workspace-manager typecheck: Done
packages/contracts typecheck: Done
packages/design-system typecheck: Done
packages/database typecheck: Done
apps/api typecheck$ tsc --noEmit -p tsconfig.json
apps/web typecheck$ tsc --noEmit -p tsconfig.json
packages/agent-runtime typecheck$ tsc --noEmit -p tsconfig.json
packages/agent-runtime typecheck: Done
apps/web typecheck: Done
apps/api typecheck: Done
apps/worker typecheck$ tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.test.json
apps/worker typecheck: Done
EXIT=0
```

Eight projects, including the two new Phase 3 packages (`workspace-manager`,
`agent-runtime`).

### 1.2 `pnpm lint`

```
> intelligenz@0.0.0 lint /home/ubuntu/intelligenz
> eslint . --max-warnings=0

EXIT=0
```

### 1.3 `pnpm test`

```
 Test Files  38 passed (38)
      Tests  412 passed | 1 skipped (413)
   Start at  17:40:56
   Duration  88.14s (tests 95%, import 4%)

EXIT=0
```

**This gate does not spend money by default.** `packages/agent-runtime/test/opencode-cli.test.ts`
runs the adapter against a fixture; the two contract cases that need a live provider are skipped
unless **both** `IZ_REAL_PROVIDER=1` and a non-empty `AGENT_MODEL` are set. (Phase 4 replaced the
old `OPENCODE_CLI_SKIP` opt-out with this opt-in; the polarity is inverted, and only cases 7 and 8
are gated, not the whole describe.) See §3 for what a green suite does and does not prove.

### 1.4 `pnpm --filter @intelligenz/api test:e2e`

```
> @intelligenz/api@0.0.0 test:e2e /home/ubuntu/intelligenz/apps/api
> vitest run --passWithNoTests --dir test

 RUN  v5.1.0 /home/ubuntu/intelligenz/apps/api

 Test Files  4 passed (4)
      Tests  60 passed (60)
   Start at  17:43:43
   Duration  11.40s (tests 75%, import 22%, transform 3%)

EXIT=0
```

Real PostgreSQL, real Temporal where reachable, Supertest. The 4 files are
`auth-tenancy`, `executions`, `health`, `tasks`.

### 1.5 `pnpm --filter @intelligenz/web test:e2e`

```
  3 skipped
  57 passed (34.7s)
EXIT=0
```

Playwright, Chromium, four viewport projects (1440 / 1024 / 768 / 390), against the live
API on 4100 and the built web app on 3100. The three skips are the reflow test, which is
asserted only under the 390 project because repeating a 390px assertion at 1440 proves
nothing (`apps/web/e2e/responsive.e2e.ts:12`).

### 1.6 `pnpm -w build`

```
apps/api build$ tsc --noEmit -p tsconfig.json
apps/web build$ next build
apps/web build:    ▲ Next.js 15.5.29
apps/web build:  ✓ Compiled successfully in 3.6s
apps/web build:    Checking validity of types ...
apps/web build:  ✓ Generating static pages (5/5)
apps/web build: Route (app)                                 Size  First Load JS
apps/web build: ┌ ○ /                                    1.09 kB         104 kB
apps/web build: ├ ○ /_not-found                            123 B         103 kB
apps/web build: ├ ƒ /[workspace]/[module]                  175 B         109 kB
apps/web build: ├ ƒ /[workspace]/overview                11.4 kB         125 kB
apps/web build: ├ ƒ /[workspace]/tasks/[taskId]          13.1 kB         126 kB
apps/web build: └ ƒ /login                               2.91 kB         113 kB
apps/api build: Done
apps/web build: Done
apps/worker build$ tsc --noEmit -p tsconfig.json
apps/worker build: Done
EXIT=0
```

### 1.7 `pnpm audit --audit-level high` — **FAILS**

```
7 vulnerabilities found
Severity: 1 low | 4 moderate | 2 high
EXIT=1
```

The two `high` advisories, enumerated with `pnpm audit --json`:

| Severity | Package | Vulnerable | Patched | Path |
|---|---|---|---|---|
| high | postcss | `<=8.5.11` | `>=8.5.12` | `apps__web>next>postcss` |
| high | postcss | `<=8.5.17` | `>=8.5.18` | `apps__web>next>postcss` |
| moderate | postcss | `<=8.5.22` | `>=8.5.23` | `apps__web>next>postcss` |
| moderate | postcss | `<8.5.10` | `>=8.5.10` | `apps__web>next>postcss` |
| moderate | glob | `>=9.0.0 <=14.0.1` | `>=14.0.2` | `apps__api>@nestjs/cli>glob` |
| moderate | minimatch | `>=7.0.0 <11.0.1` | `>=11.0.1` | `.>typescript-eslint>…>minimatch` |
| low | deepmerge | `>=4.2.0 <=4.3.1` | none | `apps__api>@nestjs/cli>fork-ts-checker-webpack-plugin>deepmerge` |

This is a **failing gate**, not a footnote. D-004 classifies these as "Low–Medium
(build-time)"; two are now rated `high` by the advisory database, so the classification in
that decision no longer matches the data. The advisories are build-time transitive
dependencies of Next.js/ESLint, not request-path code — which reduces exposure, not the
severity label. Fixing them means moving Next.js/ESLint, which is a separate change with
its own regression surface. D-004 remains open; this document records the measured state.

### 1.8 Security test files, isolated run

The eight files that carry the security assertions, run together to get a per-case count:

```
 Test Files  8 passed (8)
      Tests  76 passed (76)
   Duration  10.27s

EXIT=0
```

---

## 2. Test inventory added by Phase 3

| File | Tests | What it is for |
|---|---:|---|
| `packages/workspace-manager/test/workspace-manager.test.ts` | 24 | id allowlist, provisioning, containment, cleanup, recovery |
| `packages/workspace-manager/test/sandbox.test.ts` | 10 | argv shape, fail-closed, measured network/root/workspace behaviour, env rejection, rlimit flags |
| `packages/agent-runtime/test/runtime-contract.ts` | 8 assertions | reusable conformance suite, exported for any future adapter |
| `packages/agent-runtime/test/opencode-cli.test.ts` | 16 | 4 unit (parsing, redaction) + 4 escape/refusal + 8 contract assertions (1 skipped) |
| `packages/agent-runtime/test/egress-proxy.test.ts` | 7 | host allowlist, port pinning, absolute-form refusal, authority parsing |
| `packages/agent-runtime/test/state-mounts.test.ts` | 7 | what the sandbox can and cannot see under `$HOME` |
| `packages/agent-runtime/test/workspace-git.test.ts` | 4 | F1 regression, with a live negative control |
| `packages/agent-runtime/test/process-group.test.ts` | 4 | descendant reaping, positive control, kill reason |
| `packages/agent-runtime/test/redact.test.ts` | 15 | 13 credential shapes + prose safety + idempotence |
| `packages/agent-runtime/test/transcript.test.ts` | 5 | redaction before retention, 5 MiB cap, chunk boundaries |
| `apps/worker/test/execution-persistence.test.ts` | 6 | attempt numbering, simulated flag, artifact/evidence linkage, trace cap |
| `apps/worker/test/workspace-lifecycle.test.ts` | 4 | state rows across provision → complete / fail / cancel |
| `apps/worker/test/approval-bypass.test.ts` | 1 | a HIGH task with no approval never reaches the runtime |
| `apps/worker/test/runtime-selection.test.ts` | 14 | `AGENT_RUNTIME` selection, scratch-root budget, config refusal |
| `apps/worker/test/config.test.ts` | 11 | boot refusal for a real runtime with no spend cap |
| `apps/api/test/executions.e2e-spec.ts` | 16 | execution reads, tenant 404, traversal 404, tamper 409, gone 410, transcript roles |
| `apps/web/e2e/executions.e2e.ts` | 6 × 4 viewports | attempt rows, timeline, integrity, empty state, download, read-at |
| `apps/web/src/lib/execution-state.test.ts` | 40 | pure state/label logic, including the `simulated` label |
| `packages/database/test/execution-identity.test.ts` | 7 | schema constraints on attempt/workspace identity |

---

## 3. Fifteen required security cases → the test that covers each

> **Provenance, stated first.** The Phase 3 directive's §12 was **not available to this
> unit**: it is not in the repository (searching the tree returns only Phase 2's §12, which
> is the ten quality-gate cases), and it is not elsewhere on this host that this session
> could read. The fifteen properties below are reconstructed from what the Phase 3 work
> actually claims to enforce — the baseline's risk register (§7) and the audit's
> claim-by-claim table (`PHASE-3-SECURITY-RESULTS.md` §4). The **mapping to tests** is the
> evidence; the **enumeration** is not authoritative and must be checked against the
> directive before anyone files this as compliance evidence.

| # | Required property | Test that covers it (file › test name) | Verdict |
|---:|---|---|---|
| 1 | The platform refuses to execute unsandboxed when `bwrap` is absent | `packages/workspace-manager/test/sandbox.test.ts` › `sandbox > fails closed when bwrap is absent` | **VERIFIED** |
| 2 | Root is read-only and exactly one host-backed path is writable | `sandbox.test.ts` › `mounts the root filesystem read-only: /etc/pwned cannot be created`; `leaves the workspace writable`; `builds an argv array with no shell and the expected mounts` | **VERIFIED** |
| 3 | No IP egress (TCP/DNS) from inside the sandbox | `sandbox.test.ts` › `blocks network egress — measured, not declared` | **VERIFIED** |
| 4 | Egress is refused for any host not on the exact allowlist, including suffix look-alikes | `packages/agent-runtime/test/egress-proxy.test.ts` › `refuses CONNECT to a host that is not on the list, even on 443`; `refuses a suffix look-alike of an allowlisted host`; `egress policy primitives > matches hosts exactly` | **VERIFIED** |
| 5 | Egress is pinned to port 443 | `egress-proxy.test.ts` › `refuses CONNECT to an allowlisted host on a non-443 port, and logs it` | **VERIFIED** |
| 6 | No second, TLS-less egress path (absolute-form HTTP) | `egress-proxy.test.ts` › `refuses absolute-form HTTP, so there is no second egress path` | **VERIFIED** |
| 7 | A route-supplied id cannot traverse out of the workspace root | `packages/workspace-manager/test/workspace-manager.test.ts` › `safeSegment — route-supplied ids are hostile input` (14 assertions incl. `..`, `/`, `\`, NUL, `C:`, 65 chars, unicode); `refuses a traversal id before creating anything outside the root` | **VERIFIED** |
| 8 | A symlink inside the workspace cannot escape containment | `workspace-manager.test.ts` › `a symlink pointing at /etc/passwd is refused once resolved` | **VERIFIED** |
| 9 | `cleanup` cannot delete a sibling workspace with a forged handle | `workspace-manager.test.ts` › `cleanup cannot delete a sibling workspace, even with a forged handle` | **VERIFIED** |
| 10 | Post-run `git` cannot execute agent-authored `.git` config or hooks on the host (F1) | `packages/agent-runtime/test/workspace-git.test.ts` › `is executable by a host git — the negative control…`; `collects correct evidence with no host marker…`; `contains the hook even without the -c overrides…`; `leaves no diff artifact behind when the workspace is not a checkout` | **VERIFIED** |
| 11 | The sandbox sees only opencode's own state: no `$HOME`, no sibling app credential, no agentmemory secret, no NSS keys | `packages/agent-runtime/test/state-mounts.test.ts` › all 7 tests (`mounts only opencode paths…`, `cannot read mcp-auth.json…`, `cannot reach a sibling application's credential store or the agentmemory secret`, …) | **VERIFIED** |
| 12 | The provider credential is not readable inside the sandbox | No test can assert this today. `state-mounts.test.ts` › `can read the credential database a run needs to authenticate` asserts the **opposite**, deliberately: `opencode.db` (1.07 GB, credential + 696 session rows) is mounted because auth lives in it. | **NOT IMPLEMENTED** |
| 13 | A credential-shaped environment variable is rejected by the sandbox builder | `sandbox.test.ts` › `rejects an env var that looks like a credential` | **VERIFIED** |
| 14 | The persisted transcript is redacted before retention and bounded | `packages/agent-runtime/test/transcript.test.ts` › 5 tests (redacts before retaining, chunk-split lines, 5 MiB cap, stops growing, unterminated line) + `redact.test.ts` › 13 shapes | **PARTIAL** — three shapes still leak (measured: `sk_live_…` Stripe, an AWS secret access key, `glpat-…`); see §3.1 |
| 15 | Artifact reads are contained, integrity is re-verified, and raw transcripts are role-gated | `apps/api/test/executions.e2e-spec.ts` › `never serves a path outside the configured roots`; `refuses tampered bytes with 409 ARTIFACT_INTEGRITY_FAILED`; `answers 410 ARTIFACT_GONE…`; `refuses the raw transcript to a VIEWER with 403 and no bytes`; `refuses the raw transcript to a MEMBER with 403`; `serves the raw transcript to an ADMIN…` | **VERIFIED** |

**Summary: 13 `VERIFIED`, 1 `PARTIAL`, 1 `NOT IMPLEMENTED`.**

Case 11's seven tests, in full, because the mount policy is the one that changed most
during remediation: `mounts only opencode paths, never $HOME or a sibling application` ·
`can read the credential database a run needs to authenticate` · `cannot read
mcp-auth.json, which a run does not need` · `cannot see previous sessions' shell output or
snapshots` · `cannot reach a sibling application's credential store or the agentmemory
secret` · `sees only opencode under /xdg-data` · `reads the legacy auth file but not the
rest of the global config directory`.

### 3.1 Why case 14 is `PARTIAL` and not `VERIFIED`

The test suite asserts 13 shapes, and all 13 pass. Measured directly against
`redact()` with three shapes the suite does not contain:

```
stripe sk_live   -> key sk_live_​sample00000000000000000000      (leak)
aws secret       -> wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY    (leak)
glpat            -> glpat-00EXAMPLE000000000000000                  (leak)
```

The first is the shape F9 named and was not added: the provider-key pattern is
`sk-` (hyphen), and Stripe's key is `sk_live_` (underscore). The other two are new
observations, not regressions. Redaction is a denylist by construction — `redact.ts` says
so — and the primary controls are the mount allowlist and the `ADMIN` gate on raw
transcripts. But "the transcript is safe" is not true for every credential shape, so the
case is `PARTIAL`.

### 3.2 Gaps — properties with no covering test

These are not cases 1–15 with a weak test; they are security-relevant properties the
system claims or implies and **no test asserts**. They are listed so nobody assumes the
suite covers them.

| Gap | Why it matters | What would cover it |
|---|---|---|
| **Resource ceilings** (`nofile`, `nproc`, `AS`) are enforced by `prlimit` | `infra/scripts/p3-sandbox-audit.ts` measures them, but a script is not a test and is not in the gate. A regression that drops the `prlimit` call would not fail anything. | A test that runs the entry shim and asserts `Max processes` / `Max open files` / `Max address space` from inside |
| **No CPU/memory-RSS/disk quota** | Ten concurrent activities can each allocate 6 GiB of address space and fill `/workspace`; nothing caps them. `RLIMIT_AS` bounds virtual memory, not RSS. | cgroup v2 per run (`MemoryMax`, `CPUQuota`, `TasksMax`, `io.max`) — a deployment change, then a test |
| **Cancelled workspaces are never cleaned** (F13) | `cleanup()` returns early for `cancelled`, and `cleanedAt` is deliberately left null. Every cancelled run leaves a full clone. No test asserts removal because the code does not remove. | A test that asserts the checkout is gone after `cancelled → cleanup` |
| **Workspace reuse ignores the requested source and base commit** (F14) | `provision()` adopts any existing `<root>/repo/.git`, including an empty one, and reports the old HEAD. Latent today because attempt ids never repeat. | A test that provisions the same id from a second source and asserts refusal |
| **Approval is consumed per run** (F5/D-006) | An `APPROVED` row authorises every future run of the task. `tasks.e2e-spec.ts` pins the *bypass* (a MEMBER runs a LOW task with zero approvals); nothing asserts per-run consumption because it does not exist. | `ApprovalRequest.consumedByRunId` + a test that a second run is refused |
| **Provider-mediated exfiltration** | The agent can read its own credential and send it to the provider inside a prompt. No local control detects this. | Network content inspection (TLS interception) or removing credentials from the sandbox entirely |
| **Tenant isolation with two live runs** | Tenant scoping is tested at the database and API layers with fixtures, not with two real agent runs in two organisations. | A two-tenant live fixture with two configured repositories |

---

## 4. Adjacent security tests, not counted in the fifteen

Real, relevant, and deliberately outside the fifteen because they test lifecycle or
honesty rather than isolation:

| Property | Test |
|---|---|
| A cancelled/timed-out run kills the whole process group, including a `setsid` grandchild | `process-group.test.ts` › 4 tests, incl. the positive control |
| A `local-simulated` result claiming `simulated: false` is refused before and during persistence | `execution-persistence.test.ts` › `refuses a local-simulated result that claims to be real`; `execute-agent.ts:266` |
| A HIGH task with no approval never reaches the runtime | `approval-bypass.test.ts` › `refuses a HIGH task with no approval and never invokes the agent` |
| A foreign tenant's attempt is `404`, not `403` | `executions.e2e-spec.ts` › `answers 404 for an attempt belonging to a different tenant` |
| A real runtime with no positive spend cap refuses to boot | `config.test.ts` › spend-cap tests; `runtime-selection.test.ts` › `rejects a negative spend cap…` |
| The adapter refuses a request with no `workspaceRoot`, and a root outside `WORKSPACE_ROOT` | `opencode-cli.test.ts` › `refuses a request with no workspaceRoot…`; `refuses a workspaceRoot outside WORKSPACE_ROOT` |
| The adapter exits `timeout` below the spawn floor rather than spawning anyway | `opencode-cli.test.ts` › `treats an unusable budget as exhausted…` |
| A tool summary never exceeds the `VarChar(500)` column | `opencode-cli.test.ts` › `never returns a tool summary longer than the ToolInvocation column` |

---

## 5. What this suite does not prove

Stated plainly, because a green run invites over-reading:

1. **No load testing.** Nothing was run concurrently beyond the worker's default limit.
   Ten simultaneous real runs, each with a ~1.1 GB overlay copy-up, have never been
   attempted. Throughput and memory behaviour under concurrency are unknown.
2. **No multi-tenant live fixture.** Two organisations with two real repositories and two
   concurrent agent runs do not exist. Tenant isolation is proved at the query layer.
3. **No screen-reader session.** Accessibility evidence is axe (zero violations on
   Overview and the execution screen), landmark assertions and keyboard tests. None of
   those is a screen-reader session with a real assistive technology.
4. **No CI execution.** `.github/workflows/ci.yml` exists and has never run: no `gh`, no
   remote, no push credential. Everything here is a local run.
5. **One skipped determinism test, by declaration.** The contract suite's assertion 8
   ("the same taskId twice yields the same summary and checksums") is skipped for
   `opencode-cli` because an LLM is not a function. The skip is declared
   (`deterministic: false`), it appears in the report as skipped, and the reason is in
   `runtime-contract.ts`. It is not a flaky test being suppressed; it is a property the
   adapter cannot have. §4 of `RUNTIME-ADAPTER-GUIDE.md` explains what that costs.
6. **The live-provider cases skip silently without credentials.** Two contract cases in
   `opencode-cli.test.ts` need a real provider. They run only when `IZ_REAL_PROVIDER=1`
   **and** `AGENT_MODEL` is non-empty; otherwise they skip and print the reason. A CI
   environment without provider credentials therefore shows them as skipped, not failed — the
   green/red signal is weaker than it looks. (Phase 4 replaced `OPENCODE_CLI_SKIP` with this
   opt-in; the flag no longer exists.)
7. **The UI was verified against seeded data.** `executions.e2e.ts` reads attempts the
   seed created (`local-simulated`). The real run's rows come from the same endpoints and
   were not opened in a browser.
8. **The negative control is the only proof the escape tests can fail.** `workspace-git`
   and `process-group` both include one. If a future refactor removes the control, the
   remaining tests could pass for the wrong reason; nothing enforces that the control stays.
9. **No test asserts the audit trail is complete.** Artifact writes, checksum
   verification and tool calls produce no `AuditEvent`; the trail covers task and workflow
   transitions only.

---

## 6. Reproduce

```bash
# Everything except the two e2e suites and the audit
pnpm -w typecheck
pnpm lint
pnpm test                      # spends a fraction of a cent on the real adapter
pnpm -w build

# E2E, with the stack up (Temporal 7233, API 4100, web 3100)
pnpm --filter @intelligenz/api test:e2e
pnpm --filter @intelligenz/web test:e2e

# Dependency audit — currently exits 1
pnpm audit --audit-level high

# The security files alone, with per-test output
npx vitest run \
  packages/agent-runtime/test/{redact,transcript,state-mounts,egress-proxy,workspace-git,process-group}.test.ts \
  packages/workspace-manager/test/{sandbox,workspace-manager}.test.ts \
  --reporter=verbose
```

To run the two cases that need a live provider (paid, opt-in):

```bash
IZ_REAL_PROVIDER=1 AGENT_MODEL=gemini-3.5-flash-lite pnpm test
```

Without both variables they skip, and the suite reports them as skipped. `OPENCODE_CLI_SKIP`
no longer exists; Phase 4 inverted the switch from opt-out to opt-in.
