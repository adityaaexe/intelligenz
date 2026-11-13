# INTELLIGENZ — Phase 2 Engineering Contract v1.0

> **Written by IT Leader. Binding for every subagent in Phase 2.**
> If a subagent needs to deviate, it must say so explicitly in its report with a reason.
> Design authority remains `DESIGN.md` + `docs/design/**`. This file governs *engineering*, not visual design.

---

## 0. Hard boundaries

- All work happens under `/home/ubuntu/intelligenz/`.
- **Never modify** `/home/ubuntu/Reveil-Chat`, `/home/ubuntu/Reveil-Social`, `/home/ubuntu/vc23`, `/home/ubuntu/creative-labs`, or any other existing project.
- `prototype/`, `DESIGN.md`, `docs/design/**` are **frozen reference artifacts**. Do not edit them except to append a note if an engineering fact contradicts them.
- No secrets in the repo. `.env` is gitignored; `.env.example` is committed with placeholder values.
- No cloud provisioning, no paid resources, no external deployments in this phase.

## 1. Verified environment (measured, not assumed)

| Capability | State |
|---|---|
| Node | v22.23.2 |
| npm / pnpm | 10.9.8 / 10.15.1 |
| git | 2.53.0 |
| PostgreSQL | 18.6, running, reachable via `sudo -u postgres psql`; peer auth for `postgres` user only |
| Redis | 8.0.5, running, `PONG` |
| Docker | **absent** |
| `gh` CLI | **absent** |
| Temporal CLI | **absent — must be installed** |
| Network | npm registry, GitHub API, GitHub releases all reachable (HTTP 200) |
| GitHub repo creation | available via MCP `create_repository` |

Consequences:
- No Docker ⇒ no containerised services. Use the host Postgres/Redis and the Temporal **dev server** (`temporal server start-dev`, SQLite-backed, single binary).
- No `gh` ⇒ no CLI repo creation, no `gh`-based CI. GitHub remote is created via MCP; a git remote push requires a credential the environment does not yet have, so **local git is the source of truth** and remote push is explicitly BLOCKED until a token exists.

## 2. Locked stack

| Layer | Decision |
|---|---|
| Language | TypeScript 5.x, `strict: true`, `noUncheckedIndexedAccess` |
| Monorepo | pnpm workspaces. **No Turborepo** — not justified at this size |
| Web | Next.js 15 App Router, React 19 |
| Styling | Tailwind CSS + `@intelligenz/design-system` tokens |
| API | NestJS 11, versioned REST (`/v1`) |
| Validation | Zod, shared from `@intelligenz/contracts` |
| ORM | Prisma |
| DB | PostgreSQL 18 (host instance) |
| Cache/queue | Redis 8 (host instance) |
| Workflows | Temporal TypeScript SDK + Temporal dev server |
| Tests | Vitest (unit/integration), Supertest (API), Playwright (E2E) |
| Logging | `pino`, structured JSON, correlation IDs |

## 3. Repository layout (create exactly this; nothing more)

```
intelligenz/
├── apps/
│   ├── web/                    # Next.js control centre
│   ├── api/                    # NestJS API
│   └── worker/                 # Temporal worker
├── packages/
│   ├── contracts/              # Zod schemas, shared types, event envelope
│   ├── database/               # Prisma schema, client, migrations, seed
│   ├── design-system/          # --iz-* tokens + primitive components
│   └── agent-runtime/          # RuntimeAdapter interface + local adapter
├── docs/
│   ├── decisions/              # ADR-001..010
│   ├── engineering/            # baseline, plan, status, test/security results
│   └── design/                 # FROZEN Phase 1 output
├── infra/
│   ├── scripts/                # dev bootstrap, temporal start, db setup
│   └── temporal/               # dev server config
├── prototype/                  # FROZEN Phase 1 prototype
├── .github/workflows/ci.yml
├── .env.example
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
├── DESIGN.md
├── README.md
└── BRIEF.md
```

**Do not create** `apps/orchestrator`, `apps/research`, `apps/engineering`, `apps/creative`. They have no behaviour yet and scaffolding empty services is speculative. Document this decision in `docs/decisions/ADR-002`.

## 4. Local service configuration

| Service | Value |
|---|---|
| API port | **4100** (amended — 4000 is occupied, see §15) |
| Web port | **3100** (amended — 3000 is occupied, see §15) |
| Temporal gRPC | 7233 |
| Temporal UI | 8233 |
| DB role | `intelligenz` / password `intelligenz` (local dev only) |
| DB name | `intelligenz_dev` |
| DB URL | `postgresql://intelligenz:intelligenz@localhost:5432/intelligenz_dev` |
| Redis URL | `redis://localhost:6379` |
| Temporal dev store | `.temporal/dev.db` (gitignored) |

Bootstrap must be scripted in `infra/scripts/bootstrap-db.sh` so the DB is reproducible:
create role, create database, grant, then `prisma migrate deploy`.

## 5. Identity and tenancy (non-negotiable)

- Auth: `@nestjs/jwt`, HS256, secret from `JWT_SECRET`. Access token TTL 15 minutes.
- Every protected request resolves: `userId` → `Membership[]` → current `orgId`.
- Roles: `OWNER | ADMIN | MEMBER | VIEWER`.
- **Every** data query is scoped by `orgId`. A guard alone is not sufficient — the repository/service layer must include `orgId` in the `where` clause. Cross-tenant reads must be impossible even if a guard is bypassed.
- `orgId` is never taken from the request body. It comes from the authenticated membership plus an `X-Org-Id` header that must match a membership row.
- Password hashing: `argon2` (or `bcrypt` if argon2 fails to build). Never store plaintext.

## 6. Vertical slice contract

**Organization → Project → Task → WorkflowRun → AgentRun → Artifact/Evidence → AuditEvent**

Required endpoints (all under `/v1`, all except auth/health require a bearer token):

| Method | Path | Behaviour |
|---|---|---|
| GET | `/health` | liveness; no auth |
| GET | `/health/ready` | readiness: DB + Temporal reachability |
| POST | `/auth/login` | email + password → access token |
| GET | `/orgs` | orgs the caller is a member of |
| POST | `/orgs/:orgId/projects` | create project (ADMIN+) |
| GET | `/orgs/:orgId/projects` | list projects in org |
| POST | `/orgs/:orgId/projects/:projectId/tasks` | create task; honours `Idempotency-Key` |
| GET | `/orgs/:orgId/projects/:projectId/tasks` | list tasks (paginated) |
| GET | `/orgs/:orgId/tasks/:taskId` | task detail incl. latest run + artifacts |
| PATCH | `/orgs/:orgId/tasks/:taskId` | status transition, validated by state machine |
| POST | `/orgs/:orgId/tasks/:taskId/run` | start workflow; returns `workflowRunId` |
| POST | `/orgs/:orgId/tasks/:taskId/cancel` | cancel if safe |

**Task state machine** (server-validated, reject anything else):
`draft → ready → queued → running → verifying → succeeded | failed | blocked | cancelled`
Only `ready → queued` may repeat via an explicit retry with a reason.

**Idempotency:** `(projectId, idempotencyKey)` unique. A duplicate POST returns the existing task with `200`, not a second row with `201`.

## 7. Event envelope

Every emitted event matches `spec §5.3`:

```json
{
  "eventId": "uuid",
  "eventType": "task.created.v1",
  "schemaVersion": 1,
  "tenantId": "uuid",
  "projectId": "uuid",
  "aggregateId": "uuid",
  "occurredAt": "ISO-8601",
  "actor": { "type": "user|agent|system", "id": "uuid" },
  "correlationId": "uuid",
  "causationId": "uuid|null",
  "idempotencyKey": "string",
  "payload": {}
}
```

Persisted to `AuditEvent`. Consumers must tolerate unknown `eventType` values.

## 8. Agent runtime contract

`packages/agent-runtime` exports:

```ts
interface RuntimeCapabilities {
  shell: boolean; network: boolean; filesystem: 'none'|'read'|'write';
  browser: boolean; mcp: boolean; imageInput: boolean;
}
interface ExecutionRequest {
  taskId: string; goal: string; allowedPaths: string[];
  allowedActions: string[]; riskClass: RiskClass;
  timeoutMs: number; budgetUsd: number; correlationId: string;
}
interface ExecutionResult {
  status: 'succeeded'|'failed'|'timeout'|'cancelled';
  summary: string; artifacts: ArtifactReference[];
  events: ExecutionEvent[]; usage: { tokensIn?: number; tokensOut?: number; usd?: number };
  error?: { code: string; message: string; retryable: boolean };
}
interface AgentRuntime {
  readonly id: string;
  capabilities(): Promise<RuntimeCapabilities>;
  health(): Promise<RuntimeHealth>;
  execute(req: ExecutionRequest, signal: AbortSignal): Promise<ExecutionResult>;
  cancel(executionId: string): Promise<void>;
}
```

Ship exactly one implementation in this phase: `LocalSimulatedRuntime` (deterministic, no external calls, produces a real artifact file). It must be clearly named and documented as simulated. Do **not** claim a real coding-agent integration.

## 9. Workflow contract

One Temporal workflow: `runTaskWorkflow(taskId, orgId)`.

Steps: `validateTask → recordStart → executeAgent (activity) → persistResult → emitEvent → complete`.
Requirements:
- Activity retry policy with `maximumAttempts: 3`, exponential backoff.
- `startToCloseTimeout` and `scheduleToCloseTimeout` set.
- Idempotent activities keyed by `taskId`.
- Cancellation propagates and leaves the task `cancelled` with an audit event.
- Failure leaves the task `failed` with the error recorded, never `succeeded`.

## 10. Design system migration

- Port `--iz-*` tokens from `prototype/assets/css/tokens.css` **verbatim** into `packages/design-system/src/tokens.css`.
- Expose them to Tailwind via `@theme` (Tailwind v4) or `theme.extend` (v3) — pick one, document it, no duplicate palette.
- **No new colour values.** If a component needs a colour the tokens lack, stop and report the gap.
- Build only the primitives Overview needs: `Button`, `Badge`/`StatusPill`, `Table`, `MetricTile`, `Card`/`Panel` (rules not shadows), `EmptyState`, `Skeleton`, `Banner`.
- Preserve: 11px type floor, 24px target floor, tabular numerals, colour-never-alone (glyph + text label).

## 11. Overview screen scope

Only Overview. It must render from the API when the API is reachable, and must state clearly when data is fixture-only.

Required regions: system health · active workflows · agent activity · task queues · awaiting approvals · recent decisions · usage and cost · critical alerts.

**Forbidden:** fabricated live health. If the API is down, the screen says so.

## 12. Quality gates

Every unit must report the literal command output for:

1. `pnpm -w typecheck`
2. `pnpm -w lint`
3. `pnpm -w test` (unit + integration)
4. `pnpm --filter @intelligenz/api test:e2e` (Supertest)
5. `pnpm -w build`

Required test cases (from directive §9):
1. Unauthorized user cannot access protected project data.
2. Tenant A cannot read tenant B records.
3. Duplicate task submission creates one task.
4. Workflow retry does not duplicate irreversible work.
5. Failed runtime execution is recorded as failed.
6. Approval-required action cannot execute before approval.
7. Expired/revoked permission is rejected.
8. Secrets never appear in logs.
9. Cancelled workflow terminates safely.
10. Completed task carries result + audit evidence.

## 13. Reporting vocabulary (mandatory)

- `VERIFIED` — reproduced by an actual test or inspection; quote the output.
- `IMPLEMENTED` — code exists, runtime verification incomplete.
- `PARTIAL` — some required behaviour exists.
- `BLOCKED` — an external dependency prevents progress; name it.
- `NOT IMPLEMENTED` — nothing exists.

A stub, fixture or mock is never described as a working integration.

## 14. Sequencing rule

Contracts before implementations. Database before API services. API before web. Everything before CI claims.

Do not parallelise two agents onto the same file. Report the file list you touched so the Leader can detect collisions.

---

## 15. Amendments v1.1 — ratified by IT Leader 2026-11-13

These override §4–§12 where they conflict. Each was raised by the architecture review with evidence and decided here.

### A1. Ports 3000/4000 are unavailable — use 3100/4100

Measured: `ss -ltnp` shows PIDs 1223 and 1228 listening on 3000 and 4000, `cwd=/opt/reveil/repo/backend`. That is a **different product's** live backend, running for days. It is not ours to stop, and nothing in this phase may bind those ports.

- Web: **3100**. API: **4100**. Temporal 7233 / UI 8233 verified free.
- Every command, env template and Playwright base URL uses these. Never 3000/4000.

### A2. `Workspace` is a first-class entity

The design IA models `Tenant → Workspace → Project → Environment`; §6 modelled `Organization → Project`. The IA is correct — an agency runs one workspace per client, and Phase 4 multi-tenancy would otherwise require a destructive migration.

Add `Workspace` between `Organization` and `Project`. `Project.workspaceId` is required. API routes become `/v1/orgs/:orgId/workspaces/:workspaceId/projects/...`. Org-level routes remain for org-scoped listing.

`Environment` stays a `Project.environment` enum value (`prod | staging | dev`) in Phase 2 — not a separate entity.

### A3. Approvals gate execution; the task state machine is unchanged

Test case 6 ("approval-required action cannot execute before approval") was unsatisfiable: §6 defined no approval model. Resolved without expanding the state machine.

- New entity `ApprovalRequest { id, orgId, taskId, riskClass, status: PENDING|APPROVED|REJECTED|CHANGES_REQUESTED, requestedById, decidedById, decisionNote, createdAt, decidedAt }`.
- Rule: a task with `riskClass` HIGH or CRITICAL **cannot** transition `ready → queued` unless an `APPROVED` ApprovalRequest exists for it. LOW/MEDIUM proceed without approval.
- The refusal is a `409` with a machine-readable `APPROVAL_REQUIRED` code, and it emits an audit event. It is not a silent no-op.
- The state machine in §6 is unchanged; approval is a precondition check, not a state.

### A4. Runtime `cancel` signature corrected

§8 had `cancel(executionId)` while `execute()` returned a result, never a handle — the interface could not obtain the id it was asked to cancel. Corrected to:

```ts
cancel(taskId: string): Promise<void>;
```

### A5. Artifact root and email normalisation

- `ARTIFACT_ROOT` env var, default `.artifacts/` (gitignored). Worker, API and seed must agree.
- `User.email` is stored **lower-cased** at the boundary with a unique index. No `citext` dependency — its availability is unverified, and a normalised column is portable.

### A6. Overview regions must declare a real source

§11's eight regions each get a declared backing source. Where a source genuinely does not exist yet, the region renders **`Not instrumented`** — it does not invent a number and it does not reuse a fixture silently.

| Region | Source |
|---|---|
| System health | `/health/ready` (DB + Temporal) |
| Active workflows | `WorkflowRun` where status running/queued |
| Agent activity | `AgentRun` latest N |
| Task queues | `Task` grouped by status |
| Awaiting approvals | `ApprovalRequest` where PENDING |
| Recent decisions | `AuditEvent` where action is a decision |
| Usage and cost | `AgentRun.usage` aggregate |
| Critical alerts | failed runs + overdue approvals |

An empty Overview that says why is correct. A full Overview built on fixtures is a lie.

### A7. Budget is recorded, not enforced

`budgetUsd` is advisory in Phase 2. The simulated runtime reports usage; nothing blocks on cost. No pricing source of truth exists. Say this plainly in docs — do not describe budget as a control.

### A8. No external specification document

§7 cites "spec §5.3"; no such file exists in the repo. **§7 of this contract is authoritative** for the event envelope. Do not block on a missing document.

