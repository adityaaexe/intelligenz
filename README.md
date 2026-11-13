# INTELLIGENZ

An autonomous AI engineering and intelligence harness with an enterprise control plane.

This repository is currently a **Phase 2 scaffold**: workspace structure, toolchain, CI definition
and local service scripts. It contains no product behaviour yet. Every export in `apps/*` and
`packages/*` is a single placeholder constant.

If you are looking for the Phase 1 design work — tokens, component inventory, information
architecture, and the four-screen prototype — it is still here and unchanged:
`DESIGN.md`, `docs/design/**`, `prototype/**`, `qa/**`.

---

## 1. State of the repository

| Layer | State | Note |
|---|---|---|
| Monorepo + workspaces | present | pnpm workspaces, no Turborepo (contract §2) |
| TypeScript + lint + tests | configured | `tsc --noEmit`, ESLint flat config, Vitest |
| CI definition | authored, **never executed** | no `gh`, no push credential on this host |
| Database | role + DB created | no schema, no migrations, no seed |
| Temporal dev server | starts, proven reachable | no workflows, no worker bootstrap |
| API | scaffold only | no modules, controllers, services or guards |
| Web | scaffold only | no routes, components or layout |
| Design system | scaffold only | tokens **not** ported yet |

Do not read this repository as a working product. Contract §13 vocabulary applies to every claim in
every document here: `VERIFIED`, `IMPLEMENTED`, `PARTIAL`, `BLOCKED`, `NOT IMPLEMENTED`.

The binding engineering rules live in **`docs/engineering/PHASE-2-CONTRACT.md`** (including the
v1.1 amendments). The measured starting point lives in `docs/engineering/PHASE-2-BASELINE.md`.
Architecture decisions live in `docs/decisions/`.

---

## 2. Requirements

| Tool | Version | Verified on this host |
|---|---|---|
| Node | 22.x | v22.23.2 |
| pnpm | 10.15.1 | 10.15.1 (via `packageManager`) |
| PostgreSQL | 18 | 18.6, host instance, port 5432 |
| Redis | 8 | 8.0.5, host instance, port 6379 |
| Temporal CLI | 1.10+ | installed on demand into `~/.local/bin` |

Docker is **not** used and is not installed. Local services are the host's PostgreSQL and Redis plus
the Temporal dev server (SQLite-backed single binary).

---

## 3. Ports

| Service | Port | Why |
|---|---|---|
| Web (Next.js) | **3100** | 3000 is occupied by another product's backend on this host |
| API (NestJS) | **4100** | 4000 is occupied by another product's backend on this host |
| Temporal gRPC | 7233 | free |
| Temporal UI | 8233 | free |
| PostgreSQL | 5432 | host instance |
| Redis | 6379 | host instance |

`3000` and `4000` must never be bound by this project — see contract §15 A1. Do not kill processes
listening on them; they belong to an unrelated system.

---

## 4. Quickstart

```bash
# 1. dependencies
pnpm install

# 2. environment (one time)
cp .env.example .env

# 3. database role + databases (idempotent)
pnpm db:bootstrap

# 4. Temporal dev server (separate terminal, foreground, Ctrl-C to stop)
pnpm temporal:start

# 5. the quality gates
pnpm verify
```

`pnpm dev` starts api + web + worker together. It currently refuses to run and prints which
entrypoints are missing: the applications are not implemented yet.

---

## 5. Layout

```
apps/
  web/                 @intelligenz/web        Next.js 15 App Router (scaffold)
  api/                 @intelligenz/api        NestJS 11, REST under /v1 (scaffold)
  worker/              @intelligenz/worker     Temporal worker (scaffold)
packages/
  contracts/           Zod schemas, shared types, event envelope (scaffold)
  database/            Prisma schema + client (scaffold, no schema yet)
  design-system/       --iz-* tokens + primitives (scaffold, no tokens yet)
  agent-runtime/       AgentRuntime + LocalSimulatedRuntime (scaffold)
infra/scripts/         bootstrap-db, start-temporal, dev, verify
.github/workflows/     ci.yml
docs/
  decisions/           ADR-001 … ADR-010
  engineering/         contract, baseline, implementation plan
  design/              FROZEN Phase 1 design output
prototype/             FROZEN Phase 1 prototype (plain HTML/CSS/JS, zero dependencies)
```

**Not created on purpose:** `apps/orchestrator`, `apps/research`, `apps/engineering`,
`apps/creative`. They have no behaviour yet; scaffolding empty services is speculative
(contract §3, ADR-002).

---

## 6. Scripts

| Command | What it does |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` in every workspace |
| `pnpm lint` | ESLint flat config over the repo, `--max-warnings=0` |
| `pnpm test` | Vitest (1 toolchain smoke test today) |
| `pnpm build` | build step of every workspace that has one — the three apps typecheck; packages export source and have no emit step yet |
| `pnpm verify` | the four gates above, sequentially, with a pass/fail summary |
| `pnpm dev` | api + web + worker together (blocked until entrypoints exist) |
| `pnpm db:bootstrap` | creates role `intelligenz`, DBs `intelligenz_dev` / `intelligenz_test` |
| `pnpm temporal:start` | installs the Temporal CLI if missing, then starts the dev server |

Scripts are `set -euo pipefail`, live in `infra/scripts/`, and contain no credential beyond the
documented local dev values (`intelligenz` / `intelligenz`).

---

## 7. Environment

`.env` is gitignored; `.env.example` is committed and documents every variable. Nothing in the
template is a real credential. `JWT_SECRET` is a placeholder — generate one with
`openssl rand -hex 32` for anything that is not local development.

Local-only values that must stay consistent across processes:

```
API  http://localhost:4100
WEB  http://localhost:3100
DB   postgresql://intelligenz:intelligenz@localhost:5432/intelligenz_dev
REDIS redis://localhost:6379
TEMPORAL localhost:7233  (namespace default, task queue intelligenz-tasks)
ARTIFACTS .artifacts/    (gitignored; worker, API and seed must agree)
```

---

## 8. What is deliberately absent

State this before reporting anything as complete:

- No authentication, no tenancy enforcement, no permissions.
- No database schema, migrations, or seed data.
- No API endpoints. `GET /health` does not exist yet.
- No UI routes. The Overview screen does not exist yet.
- No Temporal workflows or activities.
- No design tokens in `packages/design-system`.
- No container images (Docker absent).
- No CI run evidence (no `gh`, no push credential).
- No backup or restore procedure for PostgreSQL, the Temporal SQLite store, or `.artifacts/`.

Whether a given unit is `VERIFIED` is a question about command output, not about intent. Reproduce
it with `pnpm verify`.

---

## 9. Phase 1 artifacts (frozen)

`DESIGN.md`, `docs/design/**`, `prototype/**` and `qa/**` are the Phase 1 output and are **not**
edited by Phase 2 engineering work. They remain the design authority; engineering facts that
contradict them are recorded as amendments, not by rewriting the design.

The prototype has zero runtime dependencies and no network access. Open `prototype/index.html`
directly in a browser to view it. Its fixtures are simulated and must never be presented as live data.
