# INTELLIGENZ

An autonomous AI engineering control plane. Phase 2 is a local vertical slice:
organisation → workspace → project → task → Temporal workflow → simulated agent run
→ artifact and evidence → audit event.

It runs on one host with PostgreSQL and the Temporal dev server. Redis is running but
no Phase 2 code path uses it. It is **not production-ready**. The runtime is simulated
and says so on screen. Read
[`docs/engineering/DEPLOYMENT-READINESS.md`](docs/engineering/DEPLOYMENT-READINESS.md)
before treating any part of it as deployable.

> **Repository state.** The instructions below assume a checkout that contains the
> Phase 2 source. At the time of writing the implementation is an uncommitted working
> tree: the only commit is the scaffold. If a fresh clone contains no `apps/api/src`
> or `apps/web/src`, the tree was never committed. See
> `docs/engineering/DEPLOYMENT-READINESS.md` §2.3.

---

## What you get in five minutes

- A control centre at `http://localhost:3100`, signed in as a seeded owner.
- An Overview screen that reads live data from the API: system health, task queues,
  agent activity, approvals, usage and cost, critical alerts.
- Two regions and one line that say `Not instrumented`, because no API source exists.
  They do not invent numbers.
- A working Temporal workflow, started through the API rather than the browser, that
  executes a simulated agent, writes a real artifact file, and records an audit trail.

You do not get a coding agent. The runtime has no shell, no network and no model call.
`LocalSimulatedRuntime` is deterministic and costs `$0.0000`.

---

## Prerequisites

| Requirement | Version | Check |
|---|---|---|
| Node.js | 22.x | `node -v` |
| pnpm | 10.15.1 | `pnpm -v` |
| PostgreSQL | 18, running on `localhost:5432` | `pg_isready` |
| `sudo -u postgres psql` | passwordless | `sudo -u postgres psql -c 'select 1'` |
| Network (first Temporal start only) | — | downloads the CLI to `~/.local/bin` |

Docker is **not** required and is not installed. Ports **3000** and **4000** belong to
another product’s live backend on this host. This project uses **3100** and **4100**.
Do not stop the processes on 3000/4000.

### Generate a signing key first

```bash
cp .env.example .env
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" .env
```

`.env.example` contains `JWT_SECRET=REPLACE_ME` on purpose. The API refuses to boot
until it is replaced with a real key. That is the intended failure: a public signing
key lets anyone mint a token for any user.

---

## Four commands

```bash
# 1. Install workspace dependencies
pnpm install

# 2. Create the role, three databases, apply migrations, and seed
pnpm db:bootstrap && pnpm --filter @intelligenz/database db:seed

# 3. Terminal A — Temporal dev server (gRPC 7233, UI 8233, SQLite at .temporal/dev.db)
pnpm temporal:start

# 4. Terminal B — API, web and worker
pnpm dev
```

`pnpm db:bootstrap` does not seed. The seed command is separate; without it there are
no users and login fails.

Wait for `intelligenz api listening` in Terminal B, then open:

```text
http://localhost:3100/login
```

**Seeded login**

| Email | Password | Role |
|---|---|---|
| `owner@northwind.test` | `Passw0rd!demo` | OWNER |
| `admin@northwind.test` | `Passw0rd!demo` | ADMIN |
| `member@northwind.test` | `Passw0rd!demo` | MEMBER |
| `viewer@northwind.test` | `Passw0rd!demo` | VIEWER |

After sign-in you land on the workspace Overview:

```text
http://localhost:3100/reveilchat/overview
```

The path is `/{workspace-slug}/overview`. The seeded workspace slug is `reveilchat`.

---

## Ports

| Service | Port | Notes |
|---|---:|---|
| Web (Next.js) | **3100** | `http://localhost:3100` |
| API (NestJS) | **4100** | `http://localhost:4100`, routes under `/v1` |
| Temporal gRPC | 7233 | dev server, `127.0.0.1` only |
| Temporal UI | 8233 | `http://localhost:8233` |
| PostgreSQL | 5432 | host instance |
| Redis | 6379 | running, declared, unused by Phase 2 code |

Do not use 3000 or 4000. The API rejects them at boot.

---

## Verify it is alive

```bash
curl -s http://localhost:4100/health/ready
```

Ready:

```json
{"status":"ready","service":"intelligenz-api","checks":{"postgres":{"status":"up","latencyMs":11},"temporal":{"status":"up","latencyMs":5}},"ageMs":0}
```

`503` means a dependency is down; the body names which one. The Overview shows the same
state and does not fabricate health.

Run the gates:

```bash
pnpm verify
```

That runs typecheck, lint, unit/integration tests and build, sequentially. The two E2E
suites are separate because they need the live stack:

```bash
pnpm --filter @intelligenz/api test:e2e
pnpm --filter @intelligenz/web test:e2e
```

Current results, with literal output: [`docs/engineering/TEST-RESULTS.md`](docs/engineering/TEST-RESULTS.md).

---

## Repository map

```text
apps/
  api/                 NestJS 11 · 14 routes (12 under /v1) · port 4100
  web/                 Next.js 15 App Router · Overview + login · port 3100
  worker/              Temporal worker · runTaskWorkflow + six activities
packages/
  contracts/           Zod DTOs, event envelope, task state machine
  database/            Prisma schema (12 models), migrations, seed
  design-system/       138 --iz-* tokens, 14 component modules
  agent-runtime/       AgentRuntime port + LocalSimulatedRuntime
infra/scripts/         bootstrap-db · start-temporal · dev · verify
docs/
  decisions/           ADR-001 … ADR-010, OPEN-DECISIONS
  engineering/         contract, baseline, plan, status, tests, security, deployment
  design/              frozen Phase 1 design output
prototype/             frozen Phase 1 prototype: plain HTML/CSS/JS, zero dependencies
```

Not created on purpose: `apps/orchestrator`, `apps/research`, `apps/engineering`,
`apps/creative`. They have no behaviour yet.

---

## What is real and what is simulated

**Real:** PostgreSQL rows, tenant scoping, role checks, task state machine, approvals,
Temporal workflow execution, workflow run ids, artifact files with SHA-256 checksums,
audit events with correlation ids.

**Simulated:** the agent’s work. No shell, no network, no repository read, no model
call, no code change, no cost. `AgentRun.model` is the literal string `simulated`. The
Overview labels a zero recorded cost as `Simulated`; in this build that is the only
runtime, so the label is accurate.

**Not implemented:** everything except Overview. Fifteen of sixteen navigation
destinations are placeholders. Approvals and task detail exist as APIs with no screens.
There is no mutation UI: you can read, not create, run, cancel or approve in the browser.

The full list: [`docs/engineering/KNOWN-LIMITATIONS.md`](docs/engineering/KNOWN-LIMITATIONS.md).

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| API exits at boot with `JWT_SECRET is a placeholder…` | `.env` still has `REPLACE_ME` or a weak value | Run the `openssl rand -hex 32` command above |
| Login fails for every account | Database was migrated but not seeded | `pnpm --filter @intelligenz/database db:seed` |
| `EADDRINUSE` on 3100 or 4100 | Another process owns the port | `ss -ltnp "sport = :4100"`; stop only a process you started |
| `/health/ready` returns `503` with `temporal: down` | Temporal dev server is not running | `pnpm temporal:start` |
| Overview says the API is unreachable | API is down or `NEXT_PUBLIC_API_URL` is wrong | Check `http://localhost:4100/health` |
| Worker logs `connection refused` | Temporal is not running | Start Temporal before `pnpm dev` |
| `sudo: a password is required` during bootstrap | The host does not allow passwordless `sudo -u postgres` | Run `bootstrap-db.sh` as a user with that access, or create the role manually |

---

## Documentation

| Document | What it answers |
|---|---|
| [`docs/engineering/PHASE-2-CONTRACT.md`](docs/engineering/PHASE-2-CONTRACT.md) | The binding Phase 2 rules, including §15 amendments |
| [`docs/engineering/IMPLEMENTATION-STATUS.md`](docs/engineering/IMPLEMENTATION-STATUS.md) | Per-unit status and the vertical slice, hop by hop |
| [`docs/engineering/TEST-RESULTS.md`](docs/engineering/TEST-RESULTS.md) | Literal gate output and the contract test-case mapping |
| [`docs/engineering/SECURITY-RESULTS.md`](docs/engineering/SECURITY-RESULTS.md) | The Critical finding, each fix, and what remains open |
| [`docs/engineering/DEPLOYMENT-READINESS.md`](docs/engineering/DEPLOYMENT-READINESS.md) | Why this is not deployable, and the path to staging |
| [`docs/engineering/KNOWN-LIMITATIONS.md`](docs/engineering/KNOWN-LIMITATIONS.md) | Forty-two limitations, stated plainly |
| [`docs/decisions/`](docs/decisions/) | ADR-001 … ADR-010 and the open product decisions |
| [`apps/api/api-contract.md`](apps/api/api-contract.md) | Route map, envelopes, error codes, state machine |
| [`DESIGN.md`](DESIGN.md) · [`docs/design/`](docs/design/) · [`prototype/`](prototype/) | Frozen Phase 1 design authority |

---

## Status vocabulary

Every claim in the engineering documents uses contract §13:

- `VERIFIED` — reproduced by a test or inspection; the output is quoted.
- `IMPLEMENTED` — code exists; runtime verification is incomplete.
- `PARTIAL` — some required behaviour exists.
- `BLOCKED` — an external dependency prevents progress; it is named.
- `NOT IMPLEMENTED` — nothing exists.

A stub, fixture or mock is never described as a working integration.

---

Private and unlicensed. Do not deploy this build to a shared environment.
