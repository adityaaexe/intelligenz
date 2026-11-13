# Phase 3 implementation status — real execution

**Task:** DOC-301 (engineering record)
**Branch:** `phase-3/real-agent-runtime` (uncommitted working tree; last commit `43d5c17`)
**Date:** 2026-11-13
**Scope:** Units DB-301, AG-301, BE-302, FE-301, SEC-301, SEC-302.

> Vocabulary: `VERIFIED` = reproduced by a command in this session, output quoted;
> `IMPLEMENTED` = code exists, runtime verification incomplete; `PARTIAL` = some required
> behaviour exists; `BLOCKED` = an external dependency prevents progress; `NOT IMPLEMENTED`
> = nothing exists.

Phase 3 makes one claim: a task can be executed by a **real** coding agent, inside a
sandbox, against a **disposable clone**, and the platform records what happened in a form
that can be audited. That claim is now true on this host for a small fixture repository.
It is narrower than it sounds: one adapter, one model, one repository shape, no CI, no
remote push, no evaluation set. Section 3 says exactly where the chain stops being real.

---

## 1. Unit status

| Unit | What it was supposed to deliver | Status | Evidence |
|---|---|---|---|
| **DB-301** — schema | Execution identity, workspace lifecycle, tool trace | `VERIFIED` | Migration `20261113124350_execution_workspaces`; models `ExecutionWorkspace`, `ExecutionAttempt`, `ToolInvocation`; `AgentRun.attemptNumber/workspaceId/simulated/runtimeVersion/providerMeta`; `@@unique([workflowRunId, attemptNumber])` read from `schema.prisma`; `packages/database/test/execution-identity.test.ts` |
| **AG-301** — workspace, sandbox, adapter | A filesystem lease, a `bwrap` argv builder, a real `AgentRuntime` | `VERIFIED` | `packages/workspace-manager/**` (new package); `packages/agent-runtime/src/runtimes/opencode-cli.ts`; `test/sandbox.test.ts` 10 tests; `test/workspace-git.test.ts` 4 tests; `test/process-group.test.ts` 4 tests; real run in §2 |
| **BE-302** — product wiring | API and worker: attempts, workspace lease, artifacts, execution reads | `VERIFIED` | `apps/worker/src/activities/{attempts,workspace,artifacts}.ts`; `ExecutionAttempt` + `ExecutionWorkspace` rows from the real run; `executions.e2e-spec.ts` 16 tests; `execution-persistence.test.ts` 6 tests |
| **FE-301** — execution UI | A screen that shows attempts, tool trace, artifacts, integrity | `VERIFIED` (seeded data) | `apps/web/src/components/executions/**`; route `/[workspace]/tasks/[taskId]`; `apps/web/e2e/executions.e2e.ts` 6 tests × 4 viewports; not exercised against the real run's rows — see §3, hop 12 |
| **SEC-301** — adversarial audit | Find what the sandbox claim gets wrong | `VERIFIED` | `PHASE-3-SECURITY-RESULTS.md` §1–§8: 2 Critical, 3 High, 13 lower findings, each reproduced |
| **SEC-302** — remediation | Close the Criticals and the Highs | `PARTIAL` | F1 closed, F4 closed, F3 High→Medium, F2 Critical→High (open residual), F5 recorded as D-006. `PHASE-3-SECURITY-RESULTS.md` §A.7 |

The unit verdict on the security work is **CONDITIONAL PASS**, not pass. The condition is
F2: the sandbox still holds a live provider credential because the agent must authenticate
to think. See `WORKSPACE-SECURITY-MODEL.md` §5.

---

## 2. The run that proves it

Three real runs exist in the development database. Two failed at 13:55 and 13:59 with
`OPENCODE_EXIT_NONZERO`, zero tokens, zero tool calls and no egress entries — neither
reached the provider; the recorded error carries no further cause. The third succeeded at
14:02 and is the run below. It went through the product — API, Temporal, worker, adapter —
not through a test harness. Every figure was read from the database or recomputed from the
files after the run.

| Field | Value | Source |
|---|---|---|
| Task | `37b46377-9584-4615-9cce-e03cba6dc219` — "Fix the failing sum test (real runtime proof)", `riskClass: LOW` | `Task` row |
| Workflow run | `81f4baff-1a6d-45ac-888d-3ff142f451fc` | `WorkflowRun` row |
| Attempt | **#1**, id `8309444b-a60d-5562-9c13-f66358c5e4fd` | `ExecutionAttempt` row |
| Adapter | `opencode-cli` | `ExecutionAttempt.runtimeId` |
| Runtime version | **`opencode v2.2.7`** | `AgentRun.runtimeVersion`; `opencode --version` |
| Status | `succeeded` | `AgentRun.status`, `Task.status` |
| Duration | **16.4 s adapter-reported**; 16.445 s attempt; 16.758 s `WorkflowRun` (`AgentRun.startedAt` copies the workflow's start, so its 16.758 s is the workflow span, not the model's) | adapter `summary`; `ExecutionAttempt` / `WorkflowRun` timestamps |
| Tokens | **1,206 in / 424 out** | `AgentRun.tokensIn/tokensOut`; recomputed by summing the six `step_finish` events |
| Cost | **$0.0006** stored; the six `step_finish` events in the transcript sum to **$0.00056**, and `Decimal(12,4)` rounds to 0.0006 | `AgentRun.costUsd`; recomputed from `transcript.ndjson` |
| Tool invocations | **6** — `read`, `read`, `glob`, `read`, `edit`, `shell` | `ToolInvocation` rows, sequences 1–6 |
| Egress | 7 `CONNECT` entries, all `allow` (2 × `opencode.ai`, 5 × `api.commandcode.ai`) | `AgentRun.providerMeta.egress` |
| Workspace | `29d98080-ae79-5e77-ae1d-a20269be23a9`, state `completed`, `cleanedAt` set | `ExecutionWorkspace` row |
| Base commit | `371d5f42a0c1828628c59d3a90f2825045efcf67`, branch `main`, source `clone` | `ExecutionWorkspace` row |
| Approval rows | **0** — the task is `LOW`, so no approval was required | `ApprovalRequest` count |
| Artifacts | `transcript` 13,545 B `3874cc46…`; `diff` 284 B `584e34c9…` | `Artifact` rows |
| Integrity | **`verified`** for both, recomputed from the bytes | `verifyArtifact()` run against the files |
| Fixture | `HEAD 371d5f42…`, `git status --porcelain` empty — **unchanged** | `git -C infra/fixtures/sample-repo` |

The diff the agent produced, in full:

```diff
diff --git a/src/sum.js b/src/sum.js
index 8e21017..481e728 100644
--- a/src/sum.js
+++ b/src/sum.js
@@ -6,5 +6,5 @@
  * @returns {number} the sum of `a` and `b`
  */
 export function sum(a, b) {
-  return a - b;
+  return a + b;
 }
```

The six tool calls, in order: read `/workspace` (5 entries), read `src/sum.js`, glob
`test/sum.test.js`, read `test/sum.test.js`, edit `src/sum.js` (one replacement), shell
`node --test` (TAP output, 3 passing). The test file was not modified.

---

## 3. The executed chain, hop by hop

This is the honest version: each hop says what is real and what is not. The chain is drawn
in the order the system runs it.

```
Task → approval gate → workspace provision → clone → sandboxed agent
     → tool calls → diff → artifact → checksum → audit → API → UI
```

| # | Hop | What is real | What is not |
|---|---|---|---|
| 1 | **Task** | A `Task` row with a goal, a risk class, a project and an owner. Created through `POST /v1/orgs/:orgId/projects/:projectId/tasks`, idempotent by header; promoted `draft → ready` by `PATCH`. | Nothing. This hop is the Phase 2 product. |
| 2 | **Approval gate** | Two checks with the same rule: `POST /run` requires an `APPROVED` row when `requiresApproval(riskClass)`; `validateTaskActivity` re-checks it inside the workflow, and throws `APPROVAL_REQUIRED` for a HIGH task even if the API is bypassed. | For a `LOW` task the gate is **vacuous**. The caller chooses the risk class (D-006), so a MEMBER can run real work with no approval. The real run in §2 took this path: `LOW`, zero approval rows. |
| 3 | **Workspace provision** | `leaseWorkspace` writes `ExecutionWorkspace` `requested → provisioning`, calls `manager.provision()`, then writes `ready` with the canonical path and the resolved base commit. A provisioning failure is recorded `failed` with the manager's stage and code. | Nothing at this hop. The directory is created `0700`, the row and the disk agree on the path. |
| 4 | **Clone** | `git clone --no-hardlinks <WORKSPACE_SOURCE_REPO> repo` into the lease; an optional `checkout --detach <baseCommit>`; `HEAD` is read back and recorded. The source repository is never written. | The clone is a **local path** in every run so far. `WORKSPACE_SOURCE_REPO` may be an HTTPS URL, but no remote clone has been executed here (no remote is configured on this host). A credential in that URL becomes readable by the agent (F10). |
| 5 | **Sandboxed agent** | `bwrap` with a read-only root, one host-backed `rw` bind at `/workspace`, `--unshare-net`, `--clearenv`, `--die-with-parent`, plus `rlimits` through `prlimit` in the entry shim. `opencode v2.2.7` runs with `--standalone run --auto --model … --format json`. Measured inside: `uid=1000`, `CapEff=0`, `NoNewPrivs=1`, `Seccomp=0`. | The kernel is shared, there is no cgroup, and the process runs as the worker's uid — which on this host has passwordless `sudo`. `network: false` means "no general egress", not "no bytes leave" (§4). |
| 6 | **Tool calls** | The adapter parses the NDJSON stream, normalises each call to `{sequence, tool, summary, occurredAt}` with a redacted summary capped at 500 characters, and the worker persists them as `ToolInvocation`. 6 rows exist for this run. | The trace is **derived from stdout**, not from the agent's own audit log. A tool call whose output the stream does not include is invisible. The trace is capped at 200 rows per run; a truncation is recorded in `providerMeta`. |
| 7 | **Diff** | Produced by `collectWorkspaceEvidence()`, which runs `git status --porcelain` and `git diff --no-ext-diff --no-textconv` **inside a second `bwrap` invocation** using the same profile. `core.fsmonitor`, `core.hooksPath` and `diff.external` are neutralised as well. | It is a diff of the working tree, not a commit. There is no branch, no commit author, no signed patch. A binary file appears as "Binary files differ" with no content. |
| 8 | **Artifact** | `materializeArtifacts` copies each referenced file into `<workspace>/artifacts`, recomputing SHA-256 from the bytes it writes. `transcript.ndjson` and `diff.patch` exist there. Cleanup keeps that directory and deletes the checkout. | Attribution is by **time window** `(taskId, runtimeId, createdAt)`: `Artifact` has no `attemptId`. With one open workflow per task the window is unambiguous; with a repair script or a second concurrent run it would not be. |
| 9 | **Checksum** | Recomputed on every read by `verifyArtifact()`; never trusted from the column. Both artifacts return `integrity: "verified"` now. A same-length replacement returns `failed` and the API answers `409 ARTIFACT_INTEGRITY_FAILED`; a missing file is `410 ARTIFACT_GONE`. | The database is the trust root. A worker-level compromise can rewrite the checksum and the bytes together. There is no signature, no append-only store, no external timestamp. |
| 10 | **Audit** | `AuditEvent` rows for `task.created`, three `task.status_changed`, `workflow.started`, `task.succeeded`, each with `correlationId` and `idempotencyKey`. | **No audit event is written for the artifact, the checksum, the workspace, or a tool call.** The trail records workflow transitions, not execution detail. `AuditEvent` is append-only by convention, not by grant (D-003). |
| 11 | **API** | `GET /v1/orgs/:orgId/tasks/:taskId/executions` and `/:attemptId` return the attempt, its ordered tool trace and its artifacts with computed integrity. Tenant scoping is `(id, orgId)` on every query; a foreign attempt is a `404`. Raw transcripts require `ADMIN`; `diff` and `report` are member-readable. | The list is not paginated. Tool invocations are capped at 500 per response. There is no streaming, no webhook, no subscription — a client polls. |
| 12 | **UI** | The execution detail screen renders attempts from that API, labels every row from `attempt.simulated`, shows duration, tokens, provider-reported cost, the tool timeline and an artifact table with an integrity word (not a colour). It refuses to draw a progress bar or invent a cost. | The screen has been verified against **seeded** attempts, not against the real run's rows. Both come from the same endpoints and the same shapes; "the screen rendered this specific real run" was not executed. That is a gap in evidence, not in code. |

### What the chain proves, and what it does not

It proves: a real model, with a real shell, edited a real file, in a disposable clone, under
a mount and network policy that is measured rather than asserted; the platform recorded the
attempt, the tool trace, the diff, the cost and the checksums; and a re-read of the artifact
matches the recorded digest.

It does not prove: that the agent is good at engineering (one fixture, one bug); that the
sandbox survives a hostile repository (F2 remains); that a second adapter would fit the port
(the interface has known gaps, see `RUNTIME-ADAPTER-GUIDE.md` §7); that any of this runs in
CI (no CI execution); or that cost scales predictably (one run, $0.0006).

---

## 4. Capability claims, stated precisely

| Claim | Precise meaning | Status |
|---|---|---|
| "The agent has a shell" | `capabilities().shell = true`; the sandbox runs `opencode --auto`, whose tools include a shell. Measured by six tool calls, one of which executed `node --test`. | `VERIFIED` |
| "No network" | **No general egress; model traffic only via an allowlisted 443 proxy; all other sockets blocked.** TCP, UDP and DNS fail inside the namespace; the only route out is a unix socket to a host proxy that accepts `CONNECT` for an exact host on port 443. | `VERIFIED`, and overstated if quoted without the qualifier |
| "Write access is limited to a disposable clone" | The only host-backed `rw` mount is `<workspace>/repo` at `/workspace`. `/tmp`, `/run`, `/dev` and the XDG overlays are writable but ephemeral (overlay with a tmpfs upper layer). | `VERIFIED` inside the sandbox; `PARTIAL` end to end — the worker still copies adapter-referenced absolute paths into the artifact directory (F7) |
| "Approval is re-checked inside the worker" | `validateTaskActivity` does. `executeAgentActivity` does **not** (F18). A direct activity invocation can skip the check; reaching Temporal requires local access. | `PARTIAL` — the claim was corrected in `PHASE-3-SECURITY-RESULTS.md` §3 |
| "Resources are capped" | `nofile=1024`, `nproc=4096`, `AS=6 GiB` via `prlimit`; `SIGTERM`→`SIGKILL` to the process group. No CPU, memory-RSS or disk quota; `nproc` is per-uid. | `PARTIAL` |
| "The credential is scoped to the run" | The mount is an allowlist of opencode's own state paths. `opencode.db` — which holds the provider credential and the operator's session history — is still readable, because authentication lives there. | `NOT IMPLEMENTED` for scoping; the "whole `$HOME`" exposure is closed |

---

## 5. How to run a real execution

Real runs are **opt-in**. `AGENT_RUNTIME` defaults to `local-simulated`, which spends
nothing and calls no model. Nothing below happens unless you set the variables yourself.

### 5.1 Environment

The worker reads these. `AGENT_RUNTIME` is the switch; the rest are levers.

| Variable | Required | Meaning | Default |
|---|---|---|---|
| `AGENT_RUNTIME` | yes | `opencode-cli` selects the real adapter. Anything else is refused at boot. | `local-simulated` |
| `WORKSPACE_SOURCE_REPO` | yes for a real run | Repository cloned into each lease. A relative path resolves against the repository root. Unset means an **empty** workspace, and the adapter then refuses because there is no `repo/`. | unset |
| `AGENT_MODEL` | no | Provider-qualified model id. | `commandcode/deepseek/deepseek-v4-flash` |
| `AGENT_MAX_USD` | no | Hard per-run cap, checked against the provider-reported cost as the stream arrives. `0` is refused at boot for a real runtime. **Shipped as 0.5, not commented out.** | `0.5` |
| `AGENT_BWRAP_PATH` | no | `bwrap` binary. Resolved on `PATH` when omitted. If it is absent, the adapter fails closed rather than running unsandboxed. | `bwrap` on `PATH` |
| `AGENT_TIMEOUT_MS` | no | Adapter wall-clock budget, capped at 230 s by the activity. | `50000` |
| `WORKSPACE_ROOT` | no | Where leases live. API and worker must agree. | `.workspaces` |
| `ARTIFACT_ROOT` | no | Where the adapter's per-run scratch and the simulated reports live. | `.artifacts` |

Before the first paid run, confirm the runtime and the credential are visible to the
**worker's** user:

```bash
opencode --version                 # opencode v2.2.7
opencode --standalone auth list    # lists integration names, never secrets
bwrap --version                    # bubblewrap 0.11.1
```

### 5.2 The platform path (API → Temporal → worker → agent)

```bash
# Terminal A — Temporal dev server
pnpm temporal:start

# Terminal B — the three apps, with real execution selected.
AGENT_RUNTIME=opencode-cli \
WORKSPACE_SOURCE_REPO=infra/fixtures/sample-repo \
AGENT_MODEL=commandcode/deepseek/deepseek-v4-flash \
AGENT_MAX_USD=0.5 \
pnpm dev
```

Then create a task and run it. `LOW` is deliberate: it is the only risk class a `MEMBER`
can run without an approval row (D-006). Use `HIGH` if you want to exercise the gate.

```bash
TOKEN=$(curl -s http://localhost:4100/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"owner@northwind.test","password":"Passw0rd!demo"}' | jq -r .data.accessToken)

# ids from GET /v1/orgs and GET /v1/orgs/:orgId/workspaces/:workspaceId/projects
ORG=<orgId>; PROJECT=<projectId>

TASK=$(curl -s http://localhost:4100/v1/orgs/$ORG/projects/$PROJECT/tasks \
  -H "authorization: Bearer $TOKEN" -H "x-org-id: $ORG" \
  -H "idempotency-key: $(uuidgen)" -H 'content-type: application/json' \
  -d '{"title":"Fix the failing sum test",\
"goal":"The test suite fails. Find the bug in src/sum.js, fix it, and run node --test to prove it passes. Do not change the test file.",\
"riskClass":"LOW"}' | jq -r .data.id)

# A new task is draft. Promotion to ready is a human transition and requires a reason.
curl -s -X PATCH http://localhost:4100/v1/orgs/$ORG/tasks/$TASK \
  -H "authorization: Bearer $TOKEN" -H "x-org-id: $ORG" -H 'content-type: application/json' \
  -d '{"status":"ready","reason":"run the real-agent proof"}'

curl -s -X POST http://localhost:4100/v1/orgs/$ORG/tasks/$TASK/run \
  -H "authorization: Bearer $TOKEN" -H "x-org-id: $ORG"
```

Watch it:

```bash
# Temporal UI
open http://localhost:8233

# The rows, newest first
psql "$DATABASE_URL" -c \
  'select "attemptNumber","runtimeId","status","tokensIn","tokensOut","costUsd","simulated"
     from "AgentRun" order by "createdAt" desc limit 3;'
```

Read the result in the browser at `http://localhost:3100/reveilchat/tasks/<taskId>`.

### 5.3 The standalone proof script

`infra/scripts/p3-real-run.ts` does the same thing without the API or Temporal: it
provisions a temporary workspace, probes the sandbox, executes one real task, prints the
diff, re-runs the suite inside the sandbox, and checks that the fixture is untouched. It
uses `mkdtemp`, so it leaves nothing behind except a printed path.

```bash
npx tsx infra/scripts/p3-real-run.ts
```

It is a report, not a test: it exits non-zero if the agent fails to fix the bug or if the
fixture moved. It spends one small model call. Measured on this host: 16.4 s, 1,206/424
tokens, $0.00056 across six provider-reported `step_finish` events (stored as $0.0006 at
four decimals).

### 5.4 Cost expectation

The cheap model costs **about $0.0006 for a small task on a small repository**
($0.00056 measured, rounded by the column), and the harness prompt dominates the input: a
trivial "reply PONG" probe measured 43,598 input tokens and $0.0065 (Phase 3 baseline §3).
Budget **$0.001–$0.01 per small task**; a run against a real repository with many tool
calls will be higher, which is why `AGENT_MAX_USD` is a boot requirement rather than a
suggestion.

---

## 6. What is missing from this phase

Stated here, expanded in `PHASE-3-KNOWN-LIMITATIONS.md`:

- No evaluation framework. The directive's benchmark set, completion-rate and cost metrics
  across tasks do not exist. Six tests and one real run are not an evaluation.
- No workspace reaper. A hard kill leaves a directory and a row that never reaches a
  terminal state; `recover()` repairs a row but **nothing schedules it**.
- No CI execution. The workflow file exists; it has never run.
- No remote push, no branch, no pull request. The agent's work stays in a disposable clone.
- No multi-tenant fixture with two real repos. Tenant isolation is tested at the database
  and API layers, not with two live agent runs.
- No screen-reader session. Accessibility is asserted by axe and by markup tests.

---

## 7. Verification status of this document

`VERIFIED` for every number in §2 and §4, from database queries and commands run in this
session. `IMPLEMENTED` for the UI claim in §3 hop 12 (code and seeded tests exist; the real
run's rows were not opened in a browser). Where a claim in the delegation brief could not be
reproduced, the measured value is used and the difference is stated — the brief said
"~16.4 s"; the attempt duration is 16.445 s and the `AgentRun` duration is 16.758 s, and both
are printed rather than one being chosen silently.
