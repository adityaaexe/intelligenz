# Phase 2 implementation status

> Measured 2026-11-13 against the working tree at `/home/ubuntu/intelligenz`.
> Status vocabulary is contract §13: `VERIFIED`, `IMPLEMENTED`, `PARTIAL`, `BLOCKED`,
> `NOT IMPLEMENTED`. A status is a statement about evidence, not effort.
>
> This document covers the local vertical slice. It is not a production readiness
> statement; that is `DEPLOYMENT-READINESS.md`.

---

## 1. Headline measurements

Every number below was produced by the command named beside it in this session.

| Measure | Value | Source |
|---|---:|---|
| Workspace projects | 7 (`apps/api`, `apps/web`, `apps/worker`, 4 packages) | `pnpm -w typecheck` output: `Scope: 7 of 8 workspace projects` |
| TypeScript / TSX lines | 19,220 | `find apps packages -name '*.ts' -o -name '*.tsx'` (excluding `node_modules`, `.next`, generated Prisma) |
| API routes | 14 across 6 controllers | `grep -E '@(Get\|Post\|Patch)' apps/api/src/**/*.controller.ts` (pattern written with `\|` for Markdown; the executed regex used `|`) |
| Prisma models / enums | 12 / 8 | `grep -c '^model '`, `grep -c '^enum '` on `schema.prisma` |
| Migrations | 2 | `ls packages/database/prisma/migrations` |
| Unit + integration tests | 239 passed in 22 files | `pnpm -w test` |
| API E2E tests | 42 passed in 3 files | `pnpm --filter @intelligenz/api test:e2e` |
| Web E2E tests | 36 total: 33 passed, 3 skipped | `pnpm --filter @intelligenz/web test:e2e` |
| Navigation destinations | 16 declared, 1 implemented | `apps/web/src/lib/nav.ts` |
| Design tokens | 138, byte-identical to the frozen prototype | `sha256sum` on both files: `0b15d62a…` |
| Git history | 1 commit (`d75f988`), 93 working-tree entries (65 untracked) | `git log --oneline`, `git status --porcelain` |

The working tree is not committed. The only commit is the scaffold; every Phase 2
source file is an uncommitted change. See `DEPLOYMENT-READINESS.md` §2.3.

---

## 2. Unit status

| Unit | What it built | Primary files | Status |
|---|---|---|---|
| **DO-001** | pnpm workspace, strict TS, ESLint, Vitest, local scripts, CI definition | root manifests, `infra/scripts/**`, `.github/workflows/ci.yml` | `VERIFIED` local toolchain; CI `IMPLEMENTED`, not run |
| **BE-001** | Zod contracts, event envelope, state machine, 12-model schema, 2 migrations, idempotent seed | `packages/contracts/**`, `packages/database/prisma/**` | `VERIFIED`; audit grants `PARTIAL` |
| **BE-002** | 14 routes / 6 controllers, auth, tenancy, RBAC, tasks, approvals, health, error envelope | `apps/api/src/**` | `VERIFIED` |
| **AG-001** | `runTaskWorkflow`, 6 activities, deterministic ids, `LocalSimulatedRuntime`, artifact writer | `apps/worker/src/**`, `packages/agent-runtime/**` | `VERIFIED` simulated path; `PARTIAL` automated coverage |
| **FE-001** | Login, session, shell, 8-region Overview, 15 placeholders, design system | `apps/web/src/**`, `packages/design-system/**` | `VERIFIED` for Overview; `PARTIAL` for product surface |
| **FE-002** | Playwright suite, 4 viewports, real stack | `apps/web/e2e/**`, `playwright.config.ts` | `VERIFIED` |
| **BE-003** | Content-addressed unique indexes, retry reuse policy, run finalisation | migration SQL, `orchestrator.service.ts`, `persist-result.ts` | `VERIFIED` unit/schema; `PARTIAL` end-to-end retry proof |
| **SEC-002** | Key validation, required claims, human/system split, headers, login limit, readiness cache | `apps/api/src/{config,auth,common,tasks,health}/**`, `next.config.ts` | `VERIFIED` fixed findings; open findings listed |

The subsections below give the evidence for each row.

### DO-001 — Repository scaffold and local operations

**Built**

- pnpm workspace, strict TypeScript base, ESLint flat config, Prettier, Vitest.
- Local scripts: database bootstrap, Temporal dev server, combined dev process, gate
  runner.
- CI definition that mirrors the local gates.
- `.env.example` with every variable the three apps read.

**Files**

`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.mjs`,
`vitest.config.mts`, `.prettierrc.json`, `.github/workflows/ci.yml`,
`infra/scripts/{bootstrap-db,dev,start-temporal,verify}.sh`, `.env.example`,
`.gitignore`.

**Status**

`VERIFIED` for the local toolchain. `IMPLEMENTED` for CI, not executed.

**Evidence**

- `pnpm -w typecheck`, `pnpm -w lint`, `pnpm -w test`, `pnpm -w build`: exit 0
  (literal output in `TEST-RESULTS.md` §1).
- CI: `gh` is absent, the repository has no remote, and no workflow run exists. The
  workflow is a file, not a verified pipeline.
- `infra/docker/` does not exist. Docker is absent on this host.

---

### BE-001 — Contracts and data model

**Built**

- Zod DTOs for login, project creation, task creation, status update, pagination.
- Event envelope schema with a versioned `eventType` pattern.
- Task state machine as a pure function: 11 edges, terminal states terminal.
- Prisma schema: 12 models, 8 enums, tenant `orgId` on all 10 tenant-owned models.
- Two migrations: `20261113075043_init`, `20261113092930_content_addressed_uniques`.
- Idempotent development seed: 1 organisation, 1 workspace, 1 project, 4 users, 8
  tasks, 2 workflow runs, 2 agent runs, 3 approval requests, 7 audit events.

**Files**

`packages/contracts/src/**`, `packages/database/prisma/schema.prisma`,
`packages/database/prisma/migrations/**`, `packages/database/prisma/seed.ts`,
`packages/database/src/**`.

**Status**

`VERIFIED` for schema, contracts and seed. `PARTIAL` for one sub-item: the audit table
is append-only by convention, not by database grant. The application role holds
`UPDATE` and `DELETE` on `AuditEvent` (see `SECURITY-RESULTS.md` §6.3).

**Evidence**

- 25 DTO tests, 12 envelope tests, 10 state-machine tests, 7 seed tests, 3 tenant
  scoping tests, 2 idempotency tests (`pnpm -w test --reporter=verbose`).
- `prisma migrate deploy` applied both migrations; `intelligenz_dev` contains 15
  tasks, 10 workflow runs, 6 agent runs, 3 artifacts, 3 evidence rows and 245 audit
  events when counted at 11:50 UTC. The seed creates 8 tasks and 2 workflow runs; the
  additional rows are proof runs executed against seeded and dedicated tasks. The
  audit count grows by one `session.started.v1` row per E2E sign-in.
- `information_schema.table_privileges` for role `intelligenz` on `AuditEvent`:
  `SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER`.

---

### BE-002 — API

**Built**

- NestJS 11 application with 12 routes under `/v1`, plus unversioned `/health` and
  `/health/ready` (14 total).
- JWT authentication, organisation membership resolution, role hierarchy
  `OWNER > ADMIN > MEMBER > VIEWER`.
- Tenant scoping in the service layer, not only in guards.
- Task creation with `Idempotency-Key`, cursor pagination, state-machine validation.
- Approval queue and decision endpoint.
- Workflow start and cancellation through Temporal.
- Error envelope `{ error, correlationId }`, validation details keyed by field path.
- Structured JSON logging with correlation IDs and redaction paths.

**Files**

`apps/api/src/**`, `apps/api/api-contract.md`.

**Status**

`VERIFIED`.

**Evidence**

- 42 API E2E tests in 3 files, exit 0 (`TEST-RESULTS.md` §1.4).
- Live readiness at 11:50 UTC:
  `{"status":"ready","service":"intelligenz-api","checks":{"postgres":{"status":"up","latencyMs":11},"temporal":{"status":"up","latencyMs":5}},"ageMs":0}`.
- Route count and status codes are asserted route by route in
  `apps/api/api-contract.md` §4.
- Unauthenticated `GET /v1/orgs` returns `401` with the security headers present.

---

### AG-001 — Worker and agent runtime

**Built**

- One Temporal workflow, `runTaskWorkflow`, on task queue `intelligenz-tasks`.
- Six activities: validate, record start, execute, persist, emit, complete.
- Deterministic ids derived from `(run, runtime)` and `(task, kind, checksum)`.
- `LocalSimulatedRuntime`: deterministic result, real artifact file, SHA-256 checksum,
  abort handling, timeout handling, capability declaration.
- Artifact writer scoped to `ARTIFACT_ROOT`.
- Cancellation propagation from Temporal activity context to the runtime abort signal.

**Files**

`apps/worker/src/**`, `packages/agent-runtime/src/**`.

**Status**

`VERIFIED` for the simulated path, by inspection of proof runs. `PARTIAL` for
automated coverage: no test in the repository starts the worker and asserts a
completed database row.

**Evidence**

- 20 runtime tests, 5 workflow-contract tests, 6 deterministic-id tests, 7 worker
  configuration tests (`pnpm -w test --reporter=verbose`).
- Dev database contains seven proof-run tasks with a real
  `WorkflowRun.temporalRunId`: two `succeeded`, one `failed`, four `cancelled`
  (including one run marked “fixed run finalisation”). The succeeded task
  `AG-001 retry proof` has exactly 1 `Artifact` and 1 `Evidence` row after a retry.
- Failed run `AG-001 deterministic failure proof`: task `failed`, workflow run
  `failed`, agent run `failed`, 0 artifacts, `task.failed.v1` audit event.
- Cancelled runs: `task.cancelled.v1` audit event and a finished workflow run; no
  artifacts.
- No model call, no shell, no network. See §4.

---

### FE-001 — Web control centre

**Built**

- Login screen, in-memory plus `sessionStorage` session, redirect back to the
  requested path.
- Application shell with 16 navigation destinations, grouped as the design specifies.
- Overview screen with eight required regions, declared sources, per-region error and
  retry, API-unreachable banner, not-ready banner.
- Fifteen placeholder module pages that name the missing screen and API surface.
- Design system: 138 tokens ported byte-for-byte, 14 component modules, Tailwind v4
  `@theme` mapping.

**Files**

`apps/web/src/**`, `apps/web/next.config.ts`, `apps/web/e2e/**`,
`packages/design-system/**`.

**Status**

`VERIFIED` for the Overview scope. `PARTIAL` for the product surface: only Overview
is implemented.

**Evidence**

- 33 Web E2E tests passed across 1440, 1024, 768 and 390 px viewports; 3 skipped by
  design (the 390-only reflow test).
- `pnpm -w build` exits 0; route table lists `/`, `/login`, `/[workspace]/overview`,
  `/[workspace]/[module]`, `/_not-found`.
- Token parity: `sha256sum packages/design-system/src/tokens.css
  prototype/assets/css/tokens.css` returns the same digest,
  `0b15d62a7d5623ba727a73ffa307ae0ec0962fa5f46a5c20f49dbadec321a6a3`.
- Overview tests assert that task rows match the API’s task list, that regions with
  no source say `Not instrumented`, and that all page content sits inside a landmark.
- No approvals screen. Approvals exists as an API only.

---

### FE-002 — Browser E2E

**Built**

- Playwright configuration with four viewport projects and a real stack: seeded
  Postgres, API on 4100, Temporal on 7233.
- Specs for authentication, keyboard skip link, navigation, Overview truthfulness,
  landmarks, and 390 px reflow.

**Files**

`apps/web/playwright.config.ts`, `apps/web/e2e/**`.

**Status**

`VERIFIED`.

**Evidence**

- `36` tests collected, `33` passed, `3` skipped, exit 0.
- The three skips are the same test under the 1440, 1024 and 768 projects. The test
  calls `test.skip(testInfo.project.name !== 'chromium-390')`; it is measured only at
  390 px.

---

### BE-003 — Retry and constraint fixes

**Built**

- Unique indexes on `Artifact(orgId, taskId, kind, checksum)` and
  `Evidence(orgId, taskId, kind, uri)`.
- Workflow id reuse policy changed from `REJECT_DUPLICATE` to
  `ALLOW_DUPLICATE_FAILED_ONLY`, so a failed or cancelled run can be retried without
  reserving the id forever.
- Deterministic row ids plus `upsert` in `persistResultActivity`, so a retried
  activity updates the same rows.
- Run finalisation for cancellation, including the worker-owned cancellation path.

**Files**

`packages/database/prisma/migrations/20261113092930_content_addressed_uniques/migration.sql`,
`apps/api/src/orchestrator/orchestrator.service.ts`,
`apps/worker/src/activities/{persist-result,ids}.ts`,
`apps/worker/src/workflows/run-task.ts`.

**Status**

`VERIFIED` at the unit and schema level. `PARTIAL` for an automated end-to-end retry
proof: the only evidence that a retry produces one artifact is a manual proof run.

**Evidence**

- 3 orchestrator retry-policy tests, 6 deterministic-id tests, 2 database idempotency
  tests.
- Migration SQL creates both unique indexes.
- `AG-001 retry proof` has one artifact and one evidence row after a successful retry.
- No test re-runs `persistResultActivity` and counts rows. This is a documented gap in
  `TEST-RESULTS.md` §3, case 4.
- `apps/worker/src/activities/persist-result.ts` still contains a comment claiming the
  schema has no unique constraint on `(taskId, kind, checksum)`. The schema does have
  it. The comment is stale; the code is not. Not fixed here because this unit may not
  edit code.

---

### SEC-002 — Security remediation

**Built**

- `JWT_SECRET` validation at boot: placeholder denylist, repeated-character and
  repeated-word rejection, minimum length, entropy proxy.
- Required `exp`, `iat` and `sub` claims on every access token.
- Human-versus-system transition split: `PATCH` can only drive `draft → ready` and
  `blocked → ready`.
- Security headers on the API and the web app.
- Login rate limiting: 5 attempts per 15 minutes per `(ip, email)`, bounded map,
  uniform refusal.
- Readiness probe cache: 2-second monotonic TTL, concurrent misses collapsed.
- Refusal events: `task.transition_refused.v1`, `workflow.start_failed.v1`.

**Files**

`apps/api/src/config/app-config.ts`, `apps/api/src/auth/jwt-auth.guard.ts`,
`apps/api/src/auth/login-rate-limit.ts`, `apps/api/src/common/security-headers.ts`,
`apps/api/src/tasks/human-transitions.ts`,
`apps/api/src/health/readiness-cache.ts`, `apps/web/next.config.ts`, `.env.example`,
plus the tests named in `SECURITY-RESULTS.md`.

**Status**

`VERIFIED` for the fixed findings. Open findings are listed in
`SECURITY-RESULTS.md` §6 and are not silently counted as fixed.

**Evidence**

- 15 JWT-secret tests, 7 claim tests, 11 rate-limit tests, 7 readiness-cache tests,
  16 transition tests.
- A token forged with the previously published placeholder
  `replace-me-with-openssl-rand-hex-32` now returns `401` from the live API
  (`SECURITY-RESULTS.md` §2.4).
- Live API response on an unauthenticated request carries `X-Content-Type-Options`,
  `X-Frame-Options`, `Referrer-Policy`, `Cross-Origin-Resource-Policy` and
  `Content-Security-Policy`; `X-Powered-By` is absent.
- Live readiness cache observed: `ageMs=0`, `ageMs=21`, `ageMs=46` on three
  consecutive requests.

---

## 3. The vertical slice, hop by hop

The contract path is
`Organization → Workspace → Project → Task → WorkflowRun → AgentRun → Artifact/Evidence → AuditEvent`.
The table states what is real at each hop and what is simulated. “Real” means a row in
PostgreSQL, a file on disk, or a Temporal execution observed through its run id.

| Hop | What is real | What is simulated | Evidence |
|---|---|---|---|
| Organization | `northwind-labs` row; 4 memberships with distinct roles | Nothing | 1 organisation in `intelligenz_dev`; login response returns it |
| Workspace | `reveilchat` row, unique on `(orgId, slug)`; used as the URL segment | Nothing | `/{workspace}/overview` resolves to `/reveilchat/overview` |
| Project | `CTRL` / “Control Plane”, environment `prod`, under the workspace | Nothing | E2E reads the project list from `GET /v1/orgs/:orgId/workspaces/:workspaceId/projects` |
| Task | 15 rows; idempotency key per `(projectId, key)`; state machine and risk class enforced | Nothing | Task counts and statuses queried from `Task` |
| WorkflowRun | One row per start; `workflowId = task-<taskId>`; `temporalRunId` assigned by Temporal | Nothing in the run record; the work it orders is simulated | 7 proof runs with non-null `temporalRunId`; seeded runs use `run-task-…` ids |
| AgentRun | Row with `runtimeId = local-simulated`, `model = simulated`, token counts, `costUsd = 0.0000`, terminal status | All of the work: no model, no tools, no repository access | Query of `AgentRun` joined through `WorkflowRun` |
| Artifact / Evidence | `result.md` file on disk; SHA-256 checksum; `Artifact` and `Evidence` rows | The file’s content: a deterministic report about plumbing, not a code change | 3 artifact rows and 3 evidence rows; 6 `result.md` files exist on disk |
| AuditEvent | 245 rows; validated event envelope; correlation id shared within each request and carried into the workflow | Nothing | 6 rows for a successful run: created, 3 status changes, `workflow.started.v1`, succeeded |

### 3.1 What each hop actually proves

**Organization → Workspace → Project.** These are ordinary foreign-key relationships.
The workspace slug is the first URL segment, so a wrong slug produces an explicit empty
state rather than a silent fallback. The project is the only project in the seed and
the only one the E2E suite reads.

**Task.** Creation, idempotency, pagination and the state machine are real. A HIGH or
CRITICAL task creates a `PENDING` `ApprovalRequest` in the same transaction. A task
cannot reach `queued` through `PATCH`; only `POST /run` does that, and only after the
approval gate passes for HIGH/CRITICAL.

**WorkflowRun.** Temporal executes the workflow. The workflow id is deterministic, so
Temporal itself rejects a duplicate start while a run is open. The workflow performs no
database writes directly; every write goes through an activity.

**AgentRun.** The record is real and durable. The execution behind it is not. The
runtime declares `shell: false`, `network: false`, `browser: false`, `mcp: false`,
`imageInput: false`, and `filesystem: 'write'` scoped to the artifact root. It writes a
report, computes its checksum and returns token counts derived from a hash of the task.
It calls no model and costs nothing.

**Artifact / Evidence.** The file write is real. The API returns artifact metadata but
has no download route and never re-reads the file to verify the checksum. Six
`result.md` files exist under `.artifacts/`; three have `Artifact` rows. The other
three are unreferenced. Nothing reconciles disk and database, and there is no retention
job.

**AuditEvent.** Events are written by the API's `AuditService` and the worker's
`emitEventActivity`. Both validate the event against the envelope.
The correlation id survives HTTP → workflow → activity → event. The table is
append-only by convention only: the application database role can `UPDATE` and
`DELETE` it.

---

## 4. The agent runtime is simulated

The only runtime is `LocalSimulatedRuntime`, id `local-simulated`.

**What it does**

- Derives its outcome from `sha256(taskId + "\0" + goal)`: step count, findings,
  summary text, token counts, and a ~15% failure bucket.
- Accepts two goal markers: `[simulate:fail]` and `[simulate:ok]`. The environment
  variable `LOCAL_SIMULATED_OUTCOME` can override every run in a process.
- Writes `<ARTIFACT_ROOT>/<orgId>/<taskId>/result.md` and returns its SHA-256 checksum
  and byte size.
- Emits `started`, `progress`, `artifact-written` and `finished` events.
- Observes an `AbortSignal` at step boundaries; `cancel(taskId)` aborts the in-flight
  execution for that task.
- Returns `timeout` with a retryable error when the request budget is exceeded.
- Refuses to write outside the artifact root.
- Reports `usage.usd = 0` as a measured fact, not as an unknown value.

**What it does not do**

- It does not spawn a process or a shell.
- It does not open a socket, resolve a DNS name, or call a provider API.
- It does not read the repository, a diff, a file outside the artifact root, or a
  browser.
- It does not call a model. `AgentRun.model` is the literal string `simulated`.
- It does not produce a code change, a test run, or a review.
- It does not spend money. A run costs `$0.0000` because nothing was purchased.

A run through this adapter proves dispatch, timeout, cancellation, artifact writing,
checksumming, persistence, tenant scoping and audit emission. It proves nothing about
coding ability, model quality, latency realism or cost realism. Any sentence that
describes this as an agent doing engineering work is wrong.

---

## 5. How to run it

**Prerequisites**

- Node 22 (`v22.23.2` measured).
- pnpm 10.15.1 (`packageManager` pins it).
- PostgreSQL 18 running on `localhost:5432`, with passwordless `sudo -u postgres psql`.
- Network access on the first Temporal start, so the CLI can be downloaded to
  `~/.local/bin`.
- Docker is not required. Ports 3000 and 4000 must not be used; they belong to another
  product on this host.

**Four commands**

```bash
# 1. Dependencies
pnpm install

# 2. Environment: the template will not boot until a real key exists
cp .env.example .env
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" .env

# 3. Database: role, three databases, migrations, then the seed
pnpm db:bootstrap
pnpm --filter @intelligenz/database db:seed

# 4. Run: Temporal in one terminal, the three apps in another
pnpm temporal:start
pnpm dev
```

`pnpm db:bootstrap` applies migrations but does **not** seed. The seed command is
separate. Without it there are no users and login fails.

**Ports**

| Service | Port |
|---|---:|
| Web (Next.js) | 3100 |
| API (NestJS) | 4100 |
| Temporal gRPC | 7233 |
| Temporal UI | 8233 |
| PostgreSQL | 5432 |
| Redis | 6379 (running; no Phase 2 code path uses it) |

**Seeded login**

- Email: `owner@northwind.test`
- Password: `Passw0rd!demo`
- Other roles: `admin@northwind.test`, `member@northwind.test`,
  `viewer@northwind.test`, same password.
- Workspace URL: `http://localhost:3100/reveilchat/overview`
- Login URL: `http://localhost:3100/login`

**First check**

```bash
curl -s http://localhost:4100/health/ready
```

A ready response is `200` with `postgres` and `temporal` both `up`. A `503` names the
dependency that is down. The Overview shows the same state; it does not fabricate
health.

---

## 6. What is not here

Only Overview is implemented among 16 navigation destinations. There is no approvals
screen, no task creation form, no project screen, no workflow studio, no agent command
centre. The API supports more than the web surface exposes.

The detailed list, including the three `Not instrumented` areas on the Overview and the
proof-run rows in the development database, is in `KNOWN-LIMITATIONS.md`.
