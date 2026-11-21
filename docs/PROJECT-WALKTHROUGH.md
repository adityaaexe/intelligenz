# INTELLIGENZ — Project Details & Walkthrough

> **Status (as of 2026-11-21, branch `phase-6/trust-boundary-closure`, HEAD `ede3327`)**: local vertical slice, **not production-ready**. Production remains **NO-GO**. This document is a factual walkthrough; it cites repo files and recorded evidence. Where something is blocked, unverified, or historical, it is labelled.

## 1. What this project is

INTELLIGENZ is an autonomous AI engineering control plane. The implemented vertical slice covers:

```text
organisation → workspace → project → task
  → Temporal workflow → agent run → artifact/evidence → audit event
```

It is designed for a multi-tenant control centre with human approval gates, execution evidence, and isolation controls. The product design authority is `BRIEF.md`, `DESIGN.md`, and `docs/design/*`; the engineering contract and phase records live under `docs/engineering/*`.

### What is real today

| Area | Status | Evidence / source |
|---|---|---|
| PostgreSQL data model, tenant scoping, role checks | Verified in phase records / tests | `packages/database/prisma/schema.prisma`, `docs/engineering/TEST-RESULTS.md`, `docs/engineering/PHASE-4-TEST-RESULTS.md` |
| NestJS API under `/v1`, auth, tasks, approvals, execution reads, health | Implemented/verified in phase records | `apps/api/src/main.ts`, `apps/api/api-contract.md`, phase test results |
| Next.js control centre (Overview, login, execution detail, preview) | Implemented; Overview/detail verified in earlier phases, preview verified in Phase 8.9 | `apps/web/src/app/*`, `docs/engineering/phase8.9-operator-preview/VERIFICATION-MATRIX.md` |
| Temporal worker + `runTaskWorkflow` activities | Implemented/verified in phase records | `apps/worker/src/main.ts`, `apps/worker/src/workflows/*` |
| Simulated agent runtime (default) | Verified | `packages/agent-runtime/src/runtimes/local-simulated.ts`, phase docs |
| Real `opencode-cli` runtime (opt-in) | Verified narrow path; spend/capability gated | `packages/agent-runtime/src/runtimes/opencode-cli.ts`, `docs/engineering/PHASE-3-IMPLEMENTATION-STATUS.md`, `PHASE-4-*` |
| Host egress broker / credential isolation | Verified in Phase 4 records | `packages/egress-broker/*`, `docs/engineering/PHASE-4-CREDENTIAL-ISOLATION.md` |
| Cgroup v2 resource enforcement | Verified under wrapper; partial/default rlimit-only outside wrapper | `apps/worker/src/cgroup/*`, `infra/scripts/worker-with-cgroup.sh`, `docs/engineering/PHASE-4-RESOURCE-ENFORCEMENT.md` |
| Execution enforcement boot gate | Implemented in Phase 8.3 | `apps/worker/src/main.ts`, `docs/engineering/programme/NEXT-SESSION-HANDOFF.md` |
| Programme ledger / governed planner / operator preview | Partial by phase; see programme state | `docs/engineering/programme/EXECUTION-STATE.json`, Phase 8.7/8.8/8.9 docs |

### What is not real / not ready

- **Not production-ready / NO-GO** — `docs/engineering/DEPLOYMENT-READINESS.md`, Phase 8.9 report.
- **No cloud deployment packaged** — no Docker images, Terraform/cloud infra, TLS/WAF, managed secrets, backup/PITR, observability stack.
- **CI authored but not proven on a remote runner from this checkout** — `.github/workflows/ci.yml` exists; local `infra/scripts/verify.sh` is the local gate.
- **Most control-centre navigation destinations are placeholders** — only Overview and execution detail are meaningful product surfaces; Phase 8.9 added `/preview`.
- **Real-agent path is narrow** — opt-in, costs money, requires credentials/broker/cgroup wrapper for full enforcement, narrow evaluation baseline.
- **Open/blocked programme items remain** — see §9.

## 2. Repository layout

```text
.
├── apps/
│   ├── api/                    # NestJS 11 REST API (/v1), auth, health, tasks, approvals, executions
│   ├── web/                    # Next.js 15 control centre (3100), login, overview, execution detail, preview
│   └── worker/                 # Temporal worker, workflows/activities, execution enforcement, cgroups, reaper
├── packages/
│   ├── agent-runtime/          # AgentRuntime port, simulated runtime, opencode-cli adapter, sandbox probes
│   ├── contracts/              # Zod DTOs, event envelope, task state machine, programme schemas
│   ├── database/               # Prisma schema/migrations/seed/client
│   ├── design-system/          # 138 --iz-* tokens, Tailwind v4 bridge, React primitives
│   ├── egress-broker/          # Per-attempt unix socket broker, auth stripping, credential injection
│   ├── evaluation/             # Benchmarks, judges, rubric, mode-labelled result ledger
│   └── workspace-manager/      # Workspace paths, containment, clone/snapshot, bwrap, leases, reclaim
├── infra/
│   ├── benchmarks/             # Benchmark fixtures/results/simulations
│   ├── fixtures/               # sample-repo for real agent proof
│   └── scripts/                # dev/bootstrap/temporal/verify/cgroups/eval/proof scripts
├── docs/
│   ├── decisions/              # ADR-001..010, OPEN-DECISIONS
│   ├── design/                 # IA, component inventory, review checklist, screen specs
│   └── engineering/            # Phase records, security/test/readiness docs, programme ledger
├── prototype/                  # Frozen static HTML/CSS/JS design prototype
├── qa/                         # QA artifacts/screenshots
├── BRIEF.md                    # Product/design brief
├── DESIGN.md                   # Design system authority
├── README.md                   # Operational overview
└── docs/PROJECT-WALKTHROUGH.md # This file
```

## 3. Application and package breakdown

### Apps

| App | Package | Purpose | Key entrypoints | Dev command |
|---|---|---|---|---|
| API | `@intelligenz/api` | NestJS 11 REST API under `/v1`; auth, tenancy/RBAC, tasks, approvals, executions, health, SSE/reads as implemented | `apps/api/src/main.ts`, `apps/api/src/app.factory.ts` | `pnpm --filter @intelligenz/api dev` |
| Web | `@intelligenz/web` | Next.js 15 control centre on 3100; login, workspace overview, execution detail, read-only preview | `apps/web/src/app/layout.tsx`, `apps/web/src/app/[workspace]/overview/page.tsx`, `apps/web/src/app/[workspace]/tasks/[taskId]/page.tsx`, `apps/web/src/app/preview/page.tsx` | `pnpm --filter @intelligenz/web dev` |
| Worker | `@intelligenz/worker` | Temporal worker polling task queue; runs task workflows/activities; enforces execution gate; manages workspaces/cgroups/reaper | `apps/worker/src/main.ts`, `apps/worker/src/workflows/*`, `apps/worker/src/activities/*` | `pnpm --filter @intelligenz/worker dev` |

### Packages

| Package | Purpose | Key exports/areas |
|---|---|---|
| `@intelligenz/contracts` | Shared Zod DTOs, event envelope, task state machine, programme schemas/helpers | `src/index.ts`, `plan-hash`, programme/plan/approval/execution schemas |
| `@intelligenz/database` | Prisma schema, migrations, seed, lazy Prisma client | `prisma/schema.prisma`, `prisma/migrations/*`, `src/index.ts` |
| `@intelligenz/design-system` | 138 `--iz-*` tokens, Tailwind v4 bridge, React primitives | `src/tokens.css`, `src/theme.css`, `src/index.ts` |
| `@intelligenz/agent-runtime` | Runtime port, `LocalSimulatedRuntime`, `OpencodeCliRuntime`, sandbox probes/health | `src/index.ts`, `src/runtimes/*` |
| `@intelligenz/egress-broker` | Host-side credential broker over per-attempt unix socket; strips inbound auth; injects real credential | `src/index.ts`, `src/broker.ts`, `src/credential.ts` |
| `@intelligenz/evaluation` | Benchmark harness, deterministic judges, rubric, result ledger/report | `src/index.ts`, `infra/benchmarks/*` |
| `@intelligenz/workspace-manager` | Workspace provisioning, containment, git clone/snapshot, bwrap command/profile, leases/reclaim | `src/index.ts`, `src/sandbox.ts`, `src/manager.ts` |

## 4. Technology stack

| Layer | Technology | Notes |
|---|---|---|
| Runtime | Node 22.x, TypeScript, pnpm 10.15.1 | Root `package.json`, `tsconfig.base.json` |
| API | NestJS 11, Zod, argon2, pino, `@nestjs/jwt` | `apps/api/package.json` |
| Web | Next.js 15.5.x, React 19.3.x, Tailwind CSS 4, design-system package | `apps/web/package.json` |
| Orchestration | Temporal SDK 1.25.0 (dev server locally) | `apps/worker/package.json`, `infra/scripts/start-temporal.sh` |
| Database | PostgreSQL 18 expected, Prisma 7, `@prisma/adapter-pg` | `packages/database/package.json`, `.env.example` |
| Cache | Redis declared in env; no Phase 2 code path uses it | `.env.example`, README/known limitations |
| Sandbox | bubblewrap (`bwrap`), cgroup v2, unix sockets | workspace-manager, egress-broker, worker scripts |
| Testing | Vitest 5, Playwright, Testing Library, supertest | root and app package manifests |
| Design | Static prototype + 138 CSS tokens + design docs | `prototype/`, `DESIGN.md`, `docs/design/*` |

## 5. Local setup walkthrough

### 5.1 Prerequisites

- Node 22.x
- pnpm 10.15.1 (`corepack prepare pnpm@10.15.1 --activate`)
- PostgreSQL 18+ reachable at `localhost:5432`
- `sudo -u postgres psql` access for bootstrap (as documented)
- Network access on first Temporal start (downloads Temporal CLI to `~/.local/bin`)

> Docker is **not** required. Do **not** use ports 3000/4000 on this host; INTELLIGENZ uses 3100/4100.

### 5.2 Install and configure

```bash
pnpm install --frozen-lockfile
cp .env.example .env
# Set a strong JWT secret (required; placeholder is rejected)
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" .env
```

### 5.3 Bootstrap database

```bash
pnpm db:bootstrap
pnpm --filter @intelligenz/database db:generate
pnpm --filter @intelligenz/database db:migrate:deploy
pnpm --filter @intelligenz/database db:seed
```

### 5.4 Start services

Terminal A:

```bash
pnpm temporal:start
```

Terminal B:

```bash
pnpm dev
```

`infra/scripts/dev.sh` starts API (4100), web (3100), and worker in parallel. It refuses to start if ports 3100/4100/7233 are already in use.

### 5.5 Access

| Surface | URL | Notes |
|---|---|---|
| Web login | `http://localhost:3100/login` | Seeded users from `packages/database/prisma/seed.ts` |
| Overview | `http://localhost:3100/reveilchat/overview` | Seeded workspace slug is `reveilchat` |
| Read-only preview | `http://localhost:3100/preview` | Server-rendered; access gate behavior depends on env/middleware |
| API health | `http://localhost:4100/health/ready` | 200 ready / 503 dependency down |
| Temporal UI | `http://localhost:8233` | Dev server UI |

Seeded dev users (from README/seed):

| Email | Password | Role |
|---|---|---|
| `owner@northwind.test` | `Passw0rd!demo` | OWNER |
| `admin@northwind.test` | `Passw0rd!demo` | ADMIN |
| `member@northwind.test` | `Passw0rd!demo` | MEMBER |
| `viewer@northwind.test` | `Passw0rd!demo` | VIEWER |

> These credentials are for local development only. Never reuse them in a shared environment.

## 6. Build, test, and verification

### Root commands

```bash
pnpm typecheck      # workspace typecheck
pnpm lint           # eslint --max-warnings=0
pnpm test           # vitest run
pnpm build          # workspace build
pnpm verify         # infra/scripts/verify.sh (typecheck, lint, test, build)
```

### Focused checks

```bash
pnpm --filter @intelligenz/api test:e2e
pnpm --filter @intelligenz/web test:e2e
pnpm programme:check
pnpm enforcement:check
```

### Verification discipline

- Do not claim "tests pass" unless you ran them in the current session and saw output.
- Report status as `verified`, `partially_verified`, or `not_verified`.
- Historical gate numbers in phase docs are evidence for that recorded point in time, not proof of the current unmodified tree unless rerun.

## 7. Real agent runtime (opt-in, spend/capability gated)

The real runtime is **not** the default. Default is `LocalSimulatedRuntime` (deterministic, no shell/network/model, $0).

To opt in, you need:

- `AGENT_RUNTIME=opencode-cli`
- `WORKSPACE_SOURCE_REPO` (or configured source)
- `AGENT_MODEL` and broker/provider credential configuration
- `AGENT_MAX_USD` > 0
- `bwrap` available
- cgroup wrapper for aggregate enforcement claims (`infra/scripts/worker-with-cgroup.sh`)

Useful scripts:

```bash
npx tsx infra/scripts/p3-real-run.ts
npx tsx infra/scripts/p4-broker-proof.ts
```

Read before using:

- `docs/engineering/PHASE-3-IMPLEMENTATION-STATUS.md`
- `docs/engineering/PHASE-4-CREDENTIAL-ISOLATION.md`
- `docs/engineering/PHASE-4-RESOURCE-ENFORCEMENT.md`
- `docs/engineering/WORKSPACE-SECURITY-MODEL.md`

## 8. Security model (current, honest)

### Enforced / measured controls (by phase records)

- Tenant scoping on API queries; role checks.
- Approval-bound execution and server-derived risk (Phase 4/6/7 records).
- Egress broker: sandbox receives canary credential, not provider key.
- Cgroup v2 limits and execution enforcement gate when launched correctly.
- Audit/event trail for workflow transitions.

### Known gaps / residual risks

- Single-host, shared-kernel sandbox model; not a VM/microVM boundary.
- No seccomp profile claimed as complete production boundary.
- No production secret manager / rotation / TLS/WAF/observability stack.
- Readiness/limiter and some controls are process-local.
- CI remote execution not proven from this checkout.
- Historical docs may be stale relative to HEAD; always check programme ledger and git HEAD.

See: `docs/engineering/SECURITY-RESULTS.md`, `PHASE-3-SECURITY-RESULTS.md`, `PHASE-4-SECURITY-RESULTS.md`, `DEPLOYMENT-READINESS.md`, and `docs/engineering/phase8.9-operator-preview/PREVIEW-SECURITY-REVIEW.md`.

## 9. Current programme state

Source of truth: `docs/engineering/programme/EXECUTION-STATE.json` (validate with `pnpm programme:check`).

At the time of this walkthrough (ledger updated 2026-11-16T17:45:00Z, ledger head `430c39d...`, git HEAD `ede3327`):

- Phase: **8.9**
- Tasks: **35 total** — 17 completed, 6 blocked, 11 planned, 1 ready
- Ready: **P88-001** (Settle interrupted node when programme is cancelled)
- Blocked highlights: P83-003/P83-004 host privilege/split identity; P83-005 CI; P83-006 backup/restore; P87-009 policy-blocked approval resumption; P87-011 intermittent approval-binding E2E
- Production: **NO-GO**

For current operator-facing preview details, read:

- `docs/engineering/phase8.9-operator-preview/PHASE89-REPORT.md`
- `docs/engineering/phase8.9-operator-preview/VERIFICATION-MATRIX.md`
- `docs/engineering/phase8.9-operator-preview/PREVIEW-SECURITY-REVIEW.md`
- `docs/engineering/phase8.9-operator-preview/CLOUDFLARE-TUNNEL-RUNBOOK.md`

## 10. Key documents index

| Document | Purpose |
|---|---|
| `README.md` | Quick operational overview and setup |
| `BRIEF.md` | Product brief / design intent |
| `DESIGN.md` | Design system and UI authority |
| `docs/PROJECT-WALKTHROUGH.md` | This detailed walkthrough |
| `docs/engineering/IMPLEMENTATION-STATUS.md` | Phase 2 implementation status |
| `docs/engineering/PHASE-3-IMPLEMENTATION-STATUS.md` | Phase 3 real runtime status |
| `docs/engineering/PHASE-4-IMPLEMENTATION-STATUS.md` | Phase 4 execution trust status |
| `docs/engineering/DEPLOYMENT-READINESS.md` | Why not deployable; staging/prod gaps |
| `docs/engineering/KNOWN-LIMITATIONS.md` | Phase 2 limitations (still relevant where not superseded) |
| `docs/engineering/PHASE-3-KNOWN-LIMITATIONS.md` | Phase 3 limitations |
| `docs/engineering/SECURITY-RESULTS.md` | Phase 2 security results |
| `docs/engineering/PHASE-3-SECURITY-RESULTS.md` | Phase 3 security audit/remediation |
| `docs/engineering/PHASE-4-SECURITY-RESULTS.md` | Phase 4 security audit/remediation |
| `docs/engineering/TEST-RESULTS.md` | Phase 2 test results |
| `docs/engineering/PHASE-3-TEST-RESULTS.md` | Phase 3 test results |
| `docs/engineering/PHASE-4-TEST-RESULTS.md` | Phase 4 test results |
| `docs/engineering/programme/EXECUTION-STATE.json` | Machine-readable programme state |
| `docs/engineering/programme/NEXT-SESSION-HANDOFF.md` | Latest handoff / cold-start notes |

## 11. Walkthrough for a new contributor

1. **Read** `README.md`, this file, `BRIEF.md`, and `docs/engineering/programme/EXECUTION-STATE.json`.
2. **Install/bootstrap** using §5. Confirm `.env` has a real `JWT_SECRET`.
3. **Run local stack**: `pnpm temporal:start` and `pnpm dev`.
4. **Sign in** at `http://localhost:3100/login` with seeded credentials.
5. **Inspect Overview** (`/reveilchat/overview`) and execution detail routes.
6. **Run `pnpm verify`** before claiming a change is clean; report exact command status.
7. **For execution-trust work**, read Phase 4 docs before touching sandbox/broker/cgroup code.
8. **For programme work**, update `EXECUTION-STATE.json` only through valid state transitions and run `pnpm programme:check`.
9. **Never claim production readiness** from local green tests alone; deployment-readiness gaps are explicit.

---

*This document is descriptive, not aspirational. If code and docs disagree, trust code + measured command output, then update docs.*
