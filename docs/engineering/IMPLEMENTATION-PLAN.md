# INTELLIGENZ — Phase 2 Implementation Plan

> Written by @software-architect (AR-001), 2026-11-13.
> Executable decomposition of `docs/engineering/PHASE-2-CONTRACT.md`.
> Baseline: `docs/engineering/PHASE-2-BASELINE.md`. Decisions: `docs/decisions/ADR-001..010`.
>
> **Every unit has one owner-role and one file set.** Contract §14: do not parallelise two agents onto
> the same file. If a unit needs a file owned by another unit, it depends on that unit — it does not
> edit it.

---

## 0. Gate definitions

The delegation refers to "gates A–F from the directive". **No directive document exists in this
repository** (searched: no `*directive*`, `*spec*`, `*prd*` files). The gates below are therefore
**reconstructed** from contract §14 (sequencing), §12 (quality gates), and §3 (layout). The Leader
must confirm or correct this mapping before gate A closes; a mis-mapped gate invalidates the
acceptance checks that reference it.

| Gate | Name | Question it answers | Exit condition |
|---|---|---|---|
| **A** | Foundation | Can the repository build, typecheck, and share types across apps? | Workspace installs from a clean checkout; `pnpm -w typecheck` and `pnpm -w lint` pass; `@intelligenz/contracts` and `@intelligenz/design-system` are importable; tokens are byte-identical to Phase 1 |
| **B** | Data | Is the schema real, migrated, and tenant-safe at the query layer? | `migrate deploy` on an empty database succeeds; seed is idempotent; a query without `orgId` throws; two-tenant isolation test passes |
| **C** | API | Can an authorised caller create a project and a task, idempotently, through a validated state machine? | All §6 endpoints except run/cancel respond correctly under Supertest; unauthorised and cross-tenant requests fail with the documented codes |
| **D** | Execution | Does a task actually run, durably, and leave artifacts and audit evidence? | Worker executes `runTaskWorkflow`; `succeeded` carries artifact + events; retry does not duplicate; failure is recorded as `failed`; cancellation terminates `cancelled` |
| **E** | Surface | Does the control centre render the real system without inventing anything? | Overview renders 8 regions from the API; every region states its source; no fabricated value; all six non-live states reachable |
| **F** | Verification | Is the claim set honest and reproducible? | Five gate commands run with literal output; ten required test cases mapped (or explicitly blocked); security review complete; status report uses contract §13 vocabulary only |

Gate order is strict: **A → B → C → D → E → F**. Contract §14: contracts before implementations,
database before API, API before web, everything before CI claims.

---

## 1. Units

### Gate A — Foundation

| ID | Owner | Files | Depends on | Acceptance check |
|---|---|---|---|---|
| **A1** | `@devops` | `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `.gitignore`, `.env.example`, `README.md` (dev section only) | — | (1) `pnpm -w install` from a clean checkout produces exactly one `pnpm-lock.yaml` and exits 0. (2) `pnpm -w typecheck` exits 0 with an empty project set. (3) `.gitignore` covers `node_modules`, `.env`, `.temporal`, `.artifacts`, `dist`, `.next`, `coverage`. (4) `.env.example` lists every variable the API, worker, and web require, all with placeholder values, and `git grep -nE "(SECRET\|TOKEN\|PASSWORD)=" -- .env.example` finds no real value. (5) `README.md` dev section states the port offset (§3) and the Temporal prerequisite. **Note:** pnpm 10 blocks postinstall scripts by default — `onlyBuiltDependencies` must list `prisma`, `@prisma/client`, `@prisma/engines`, `argon2`, or `prisma generate` and the argon2 native build both fail silently. |
| **A2** | `@backend-architect` | `packages/contracts/**` | A1 | (1) Task state machine is a pure exported function; unit tests prove `draft → running` is rejected, `succeeded → running` is rejected, and `ready → queued` is permitted **only** with a `reason` and **only** once. (2) Event envelope Zod schema parses a valid fixture and rejects one missing `correlationId`. (3) A test asserts **no create/update DTO contains an `orgId` field**. (4) Package has zero runtime dependencies except `zod`. |
| **A3** | `@ui-designer` → `@frontend-react` | `packages/design-system/**` | A1 | (1) `sha256sum packages/design-system/src/tokens.css` equals `sha256sum prototype/assets/css/tokens.css` — verbatim port, no edits. (2) Exactly one Tailwind theme mapping exists (Tailwind v4 `@theme`); no second palette, no colour literal outside `tokens.css` (`grep -E "#[0-9A-Fa-f]{6}" packages/design-system/src --exclude=tokens.css` returns nothing). (3) Eight primitives exported: `Button`, `StatusPill`/`Badge`, `Table`, `MetricTile`, `Panel`, `EmptyState`, `Skeleton`, `Banner`. **No `Card`** — `DESIGN.md` §8 rejects content cards. (4) `StatusPill` renders a glyph and a text label, never colour alone. (5) Icon-only `Button` fails typecheck without `aria-label`. |

**Gate A exit:** A1–A3 green, plus a first commit containing the frozen Phase 1 artifacts. Until that
commit exists there is no recovery point for `prototype/`.

### Gate B — Data

| ID | Owner | Files | Depends on | Acceptance check |
|---|---|---|---|---|
| **B1** | `@database` | `packages/database/prisma/schema.prisma`, `prisma/migrations/**`, `src/index.ts`, `src/seed.ts` | A1, A2 | (1) `prisma validate` exits 0. (2) `prisma migrate deploy` against an empty `intelligenz_dev` succeeds; `migrate status` reports no pending. (3) Every tenant-owned model has a non-null `orgId` and a composite index whose **first** column is `orgId`. (4) Seed run twice produces identical row counts (idempotent). (5) `AuditEvent` has no `updatedAt`. |
| **B2** | `@database` | `packages/database/src/tenant.ts`, `src/audit.ts` | B1 | (1) `forTenant(orgA).task.findMany()` returns only org A rows when org B rows exist. (2) A `task.findMany()` through the extension with no resolvable `orgId` **throws** rather than returning everything. (3) `create` injects `orgId`; a caller-supplied `orgId` in `data` is either ignored or rejected — pick one and test it. (4) `$queryRaw` occurrences are confined to `packages/database` (lint rule). (5) The application DB role has `INSERT, SELECT` and **not** `UPDATE, DELETE` on `audit_events`; a test attempts an update and asserts failure. |

**Gate B exit:** B1–B2 green. The isolation test is the load-bearing one — it is contract test case #2.

### Gate C — API

| ID | Owner | Files | Depends on | Acceptance check |
|---|---|---|---|---|
| **C1** | `@node-developer` | `apps/api/src/main.ts`, `app.module.ts`, `config.ts`, `common/{filters,interceptors,pipes}/**` | A2, B2 | (1) `GET /v1/health` → 200 with no token. (2) `GET /v1/health/ready` → 200 only when DB and Temporal both answer; → 503 with the failing dependency named. (3) Error envelope is identical in shape for 400/401/403/404/409/422/500. (4) Unknown body keys are stripped, not persisted. (5) `pino` redaction covers `authorization`, `cookie`, `password`, `token`, `secret`, `apiKey`. |
| **C2** | `@node-developer` | `apps/api/src/auth/**` | C1 | (1) Login with a seeded user returns a token whose decoded payload has **only** `sub`, `jti`, `iat`, `exp`. (2) Unknown email and wrong password return byte-identical 401 bodies. (3) 6th attempt in 15 minutes → 429. (4) A grep of captured log output finds no password, hash, or token. (5) Hash verifies with argon2id and the parameters are recorded in the status report. |
| **C3** | `@node-developer` | `apps/api/src/tenancy/**` | C2 | (1) No token → 401. (2) Valid token, no membership for path org → **404 `ORG_NOT_FOUND`**. (3) `X-Org-Id` ≠ path org → **400 `ORG_HEADER_MISMATCH`**. (4) VIEWER creating a project → 403 naming `ADMIN`. (5) Delete a membership row mid-session; the next request → 404 immediately (contract test case #7). |
| **C4** | `@node-developer` | `apps/api/src/projects/**` | C3 | (1) ADMIN creates a project → 201 with `orgId` from the path. (2) MEMBER → 403. (3) List returns only the path org's projects. (4) A project ID from another org → 404, not 403. |
| **C5** | `@node-developer` | `apps/api/src/tasks/**` | C4, A2 | (1) Same `Idempotency-Key` twice → first 201, second **200 with the same task id**, exactly one row. (2) List is cursor-paginated; `limit` is capped and a bad cursor is 400, not 500. (3) `PATCH` with an illegal transition → 422 including the current state. (4) Detail returns latest run + artifacts. (5) No request DTO accepts `orgId`. |
| **C6** | `@node-developer` | `apps/api/src/runs/**` | C5, D1 | (1) `POST .../run` on a `ready` task → 202 + `workflowRunId`; task becomes `queued`. (2) On a `draft` task → 409, no workflow started. (3) `POST .../cancel` on a `running` task → 202; the task ends `cancelled` with an audit event. (4) Cancel on a terminal task → 409. |

**Gate C exit:** C1–C6 green under Supertest. Note the deliberate split: C6 depends on D1, so gate C
closes *after* the worker skeleton exists. That inversion is intentional — `POST /run` is not
testable without something to start.

### Gate D — Execution

| ID | Owner | Files | Depends on | Acceptance check |
|---|---|---|---|---|
| **D1** | `@devops` | `infra/scripts/dev-temporal.sh`, `infra/temporal/README.md`, `apps/worker/src/{worker.ts,config.ts}` | A1 | (1) Script exits non-zero with an install instruction when `temporal` is absent — not a connection timeout. (2) With the binary present, the worker connects to `127.0.0.1:7233` and registers `runTaskWorkflow` plus its activities. (3) Temporal UI on 8233 shows the task queue with ≥1 poller. |
| **D2** | `@backend-architect` | `apps/worker/src/workflows/run-task.workflow.ts`, `apps/worker/src/activities/**` | D1, B2, D3, D4, D5 | (1) Workflow file imports only `@temporalio/workflow` + `@intelligenz/contracts` (lint-enforced). (2) Happy path: task `succeeded`, one artifact row, five audit events. (3) An activity that throws always leaves `failed` with the error recorded — **never** `succeeded`. (4) Retry after a persisted result does not create a second artifact (checksum equal). (5) Cancellation leaves `cancelled` + audit event; no orphan `running` row. |
| **D3** | `@agent-engineer` | `packages/agent-runtime/src/{index.ts,types.ts,local-simulated.ts,registry.ts}` | A2 | (1) Two executions of the same request produce identical summary and identical artifact checksum. (2) A request requiring `shell` is rejected with `RUNTIME_CAPABILITY_MISSING` **before** any artifact is written. (3) Every result carries `simulated: true` and `runtimeId: "local-simulated"`. (4) A spy proves no network call and no filesystem write outside the artifact root. |
| **D4** | `@backend-architect` | `packages/agent-runtime/src/artifacts/{port.ts,fs-store.ts,checksum.ts}` | A2 | (1) `put` twice with identical bytes → one file, one row. (2) Key is derived from SHA-256 only; `filename` never appears in the path. (3) `get` with a different `orgId` → 404. (4) `filename` of `../../etc/passwd` cannot escape the root. (5) Row records checksum, size, contentType. |
| **D5** | `@backend-architect` | `packages/database/src/audit.ts`, `apps/api/src/audit/**`, `apps/worker/src/activities/emit-event.ts` | B2, A2 | (1) Each task state transition writes exactly one event **in the same transaction**. (2) `correlationId` survives HTTP → workflow → activity → event unchanged. (3) Dispatcher handles an unknown `eventType` without throwing. (4) `causationId` is `null` for root events and the causing `eventId` otherwise. |

**Package-placement note (needs Leader acknowledgement).** The contract's package list has no
`packages/storage`. The artifact port and filesystem adapter are therefore placed in
`packages/agent-runtime` — artifacts are produced by execution, the worker is the only writer, and
the package adds no vendor dependency (only `node:fs`, `node:crypto`). The API reads through the same
module. If the Leader prefers a dedicated `packages/storage`, that is a contract §3 amendment, not an
implementer's choice.

### Gate E — Surface

| ID | Owner | Files | Depends on | Acceptance check |
|---|---|---|---|---|
| **E1** | `@frontend-react` | `apps/web/{package.json,next.config.ts,tsconfig.json}`, `app/layout.tsx`, `lib/{api,session}.ts`, `app/api/session/route.ts`, `app/(auth)/login/page.tsx` | C1, C2, A3 | (1) Login sets an httpOnly, `SameSite=Lax` cookie; no token in `localStorage`. (2) Overview server fetch succeeds with the cookie forwarded. (3) Expired token → redirect to login with a return path, not a blank screen. (4) API unreachable → explicit banner naming the API URL; **no fixture fallback**. (5) No `@intelligenz/database` import in `apps/web` (lint). (6) `API_BASE_URL` from env, default `http://localhost:4100/v1`. |
| **E2** | `@frontend-react` | `apps/web/app/(control)/overview/**`, `apps/web/components/overview/**` | E1, C5, C6 | (1) Eight regions render in the contract §11 order: system health · active workflows · agent activity · task queues · awaiting approvals · recent decisions · usage and cost · critical alerts. (2) **Every region declares its source**: `api`, `not-instrumented`, or `simulated`. (3) No region renders a value the API did not return — a missing metric renders `—` or `Not instrumented`, never `0`. (4) Status is never colour-only. (5) 11px type floor, 24px target floor, tabular numerals. (6) Table has `<caption>` and `scope`; filters are keyboard reachable and survive reload in the URL. |
| **E3** | `@frontend-react` | `apps/web/components/states/**`, `app/(control)/overview/error.tsx`, `loading.tsx` | E2 | (1) Empty, loading, error, permission-denied, offline, degraded are each reachable and visually distinguishable. (2) Loading uses skeletons at final dimensions (no layout shift). (3) Permission-denied names the required role. (4) The `Simulated`/`Live` marker is present in every state and cannot be dismissed. (5) `prefers-reduced-motion` disables shimmer and pulse. |

**Gate E exit:** E1–E3 green. The acceptance check that matters most is E2(3): the contract forbids
fabricated live health, and this is where that rule is either kept or broken.

### Gate F — Verification and readiness

| ID | Owner | Files | Depends on | Acceptance check |
|---|---|---|---|---|
| **F1** | `@reviewer` | `docs/engineering/QUALITY-GATES.md` | A–E | Literal, unedited output of: `pnpm -w typecheck`, `pnpm -w lint`, `pnpm -w test`, `pnpm --filter @intelligenz/api test:e2e`, `pnpm -w build`. Each of the ten contract §12 test cases maps to a named test file + test name, **or** is recorded `BLOCKED` with the reason. |
| **F2** | `@security-architect` | `docs/engineering/SECURITY-REVIEW.md` | C, D, E | (1) Cross-tenant probe suite passes for every endpoint. (2) No secret in any log capture. (3) `.env` untracked; `.env.example` has no real values. (4) Dependency audit recorded with the tool and its date. (5) Findings ranked, each with a file and a fix. |
| **F3** | `@technical-writer` | `docs/engineering/STATUS.md`, `README.md` (dev + limitations sections) | F1, F2 | Status uses contract §13 vocabulary exclusively. Every unit reported `VERIFIED` / `IMPLEMENTED` / `PARTIAL` / `BLOCKED` / `NOT IMPLEMENTED` with evidence. The known-limitations list from the baseline is carried forward or explicitly closed. |
| **F4** | `@devops` | `.github/workflows/ci.yml` | F1 | Mirrors the five gate commands, uses `--frozen-lockfile`, holds no secrets. **Reported `IMPLEMENTED`, never `VERIFIED`** — no remote, no `gh`, no push credential (ADR-010). |

---

## 2. Vertical slice path

The one path that must work end to end before anything else is called done. Each step names the
observable that proves it.

| # | Step | Actor | Observable proof |
|---|---|---|---|
| 0 | Bootstrap | `@devops` | `infra/scripts/bootstrap-db.sh` creates role, DB, grants, runs `migrate deploy`, seeds. Re-running it is a no-op. |
| 1 | Start Temporal | `@devops` | `infra/scripts/dev-temporal.sh`; UI reachable at `:8233`; `.temporal/dev.db` created |
| 2 | Start worker | `@devops` | Worker log line names the task queue; Temporal UI shows a poller |
| 3 | Start API | `@node-developer` | `GET /v1/health/ready` → 200 with `{db: "ok", temporal: "ok"}` |
| 4 | Login | `@node-developer` | `POST /v1/auth/login` → token; decoded claims are `sub,jti,iat,exp` only |
| 5 | List orgs | `@node-developer` | `GET /v1/orgs` → exactly the seeded org |
| 6 | Create project | `@node-developer` | `POST /v1/orgs/:orgId/projects` → 201, `orgId` from path |
| 7 | Create task | `@node-developer` | `POST .../tasks` with `Idempotency-Key` → 201; repeat → 200, same id |
| 8 | Start run | `@node-developer` | `POST .../run` → 202 + `workflowRunId`; task `queued → running` |
| 9 | Execute | `@agent-engineer` | Worker activity invokes `LocalSimulatedRuntime`; Temporal history shows `executeAgent` |
| 10 | Persist | `@backend-architect` | `AgentRun` row; `Artifact` row with checksum; file exists at `{ARTIFACT_ROOT}/{orgId}/…` |
| 11 | Audit | `@backend-architect` | Five `AuditEvent` rows sharing one `correlationId`; `causationId` chain intact |
| 12 | Read back | `@frontend-react` | Overview lists the task as `Completed` with cost `—` and runtime `Simulated`; task detail shows artifacts |
| 13 | Prove isolation | `@reviewer` | A second org's token receives 404 for every ID from step 6–8 |
| 14 | Prove cancellation | `@reviewer` | Cancel a running task → `cancelled` + audit event; no `running` row remains |

Steps 0–2 are the first hard blockers: **Temporal CLI is not installed** (baseline §7.3).

---

## 3. Environment deviations this plan assumes

| # | Deviation | Why | Ratification needed |
|---|---|---|---|
| 1 | **Web 3100, API 4100** instead of 3000/4000 | Both contract ports are bound by another product's services (`/opt/reveil/repo/backend`, PIDs 1223/1228) | **Yes — Leader.** ADR-010. Every script, `.env.example`, test base URL, and README line depends on this. |
| 2 | Temporal **dev server**, not a cluster | Docker absent | No — contract §1 already states it |
| 3 | Artifact port in `packages/agent-runtime` | No `packages/storage` in contract §3 | **Yes — Leader.** §1 Gate D note |
| 4 | No container build, no CI run | Docker and `gh` absent | No — contract §0 already states it |

---

## 4. Contract test-case mapping (contract §12)

| # | Required case | Unit | Status |
|---|---|---|---|
| 1 | Unauthorized user cannot access protected project data | C1, C3 | Plannable |
| 2 | Tenant A cannot read tenant B records | B2, C3, F2 | Plannable — the primary isolation proof |
| 3 | Duplicate task submission creates one task | C5 | Plannable |
| 4 | Workflow retry does not duplicate irreversible work | D2, D4 | Plannable — content-addressed artifact + idempotent activity |
| 5 | Failed runtime execution is recorded as failed | D2, D3 | Plannable |
| 6 | **Approval-required action cannot execute before approval** | — | **BLOCKED.** The contract defines no approval entity, no policy model, and no approval endpoint (§6), and the task state machine (§6) has no `awaiting_approval` state. The test cannot be honestly written against a system with nothing to approve. Options for the Leader: (a) add `Task.requiresApproval` + an approval state + an endpoint (scope increase); (b) restate the case as a *policy check* that rejects `riskClass: high` in Phase 2 and record it `PARTIAL`; (c) waive it, documented. |
| 7 | Expired/revoked permission is rejected | C2, C3 | Plannable — expiry by short TTL, revocation by membership re-read per request (ADR-005) |
| 8 | Secrets never appear in logs | C1, C2, F2 | Plannable |
| 9 | Cancelled workflow terminates safely | D2, C6 | Plannable |
| 10 | Completed task carries result + audit evidence | D2, D5, E2 | Plannable |

Nine of ten are buildable. **#6 is not, without a contract amendment**, and that must be resolved
before gate F, not discovered during it.

---

## 5. Sequencing and collision rules

1. **One owner per file set.** A unit that needs a change in another unit's file returns to the
   Leader; it does not edit. The file lists above are the collision map.
2. **Interface before implementation.** A2 (contracts) closes before B1, C1, D3 touch it. A change to
   `packages/contracts` after gate B reopens every dependent unit.
3. **Schema before services, services before UI.** No screen is built against a guessed response
   shape; `@intelligenz/contracts` is the only response source.
4. **`LocalSimulatedRuntime` before the workflow.** D3 closes before D2 so the workflow is written
   against a real adapter, not a stub that later needs reshaping.
5. **No CI claim before all gates.** F4 is authored last and reported `IMPLEMENTED`.
6. **A blocked unit blocks its dependents, not the phase.** D1 blocked → C6, D2 blocked → E2's
   "active workflows" region. Those regions render `not-instrumented`, which is honest, rather than
   waiting for a fully green chain.

---

## 6. Definition of done for Phase 2

- [ ] Gates A–F closed, in order, with each unit's acceptance check quoted as output.
- [ ] The vertical slice (§2) completes from an empty database on a fresh shell.
- [ ] Nine of ten contract test cases exist as named tests (or #6 formally resolved).
- [ ] ADR-001..010 are consistent with the code. Where the code diverged, the ADR is updated or
      superseded — not silently contradicted.
- [ ] `STATUS.md` states, per unit, `VERIFIED` / `IMPLEMENTED` / `PARTIAL` / `BLOCKED` /
      `NOT IMPLEMENTED` with evidence, and carries the baseline's limitation list forward.
- [ ] No screen claims live data it does not have. Every region declares its source.
- [ ] `Simulated` appears wherever a simulated runtime, model, or cost is displayed.
- [ ] CI is `IMPLEMENTED`, never `VERIFIED`.

## 7. Explicitly out of scope for this plan

Not omitted by oversight — refused to keep the slice honest:

- The other fifteen destinations (placeholders remain placeholders).
- An approvals engine, policy evaluation, or the `apr_`/`dsc_` objects.
- Model routing logic, evaluations, or provider integration.
- `pgvector`, embeddings, retrieval, or the Knowledge Base.
- S3/object storage, retention jobs, or deletion.
- Container images, cloud provisioning, DNS, TLS, or secret management.
- Real agent runtimes and any sandbox for untrusted code.
- The workspace/environment scope level (ADR-005 open item).
