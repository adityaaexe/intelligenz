# INTELLIGENZ

An autonomous AI engineering control plane. A local vertical slice: organisation →
workspace → project → task → Temporal workflow → agent run → artifact and evidence →
audit event.

Two runtimes exist. The **default is simulated**: deterministic, no shell, no network, no
model call, $0. **Phase 3 adds a real path**: `opencode-cli` runs an actual coding agent
inside a `bwrap` sandbox against a disposable clone of a repository. That path is opt-in,
spends provider credit, and is proven end to end on this host — one task, one fixture
repository, `$0.0006`.

It runs on one host with PostgreSQL and the Temporal dev server. Redis is running but no
code path uses it. It is **not production-ready**, and the real runtime has an open
security condition: the sandbox can read the provider credential it runs with. Read
[`docs/engineering/DEPLOYMENT-READINESS.md`](docs/engineering/DEPLOYMENT-READINESS.md) and
[`docs/engineering/WORKSPACE-SECURITY-MODEL.md`](docs/engineering/WORKSPACE-SECURITY-MODEL.md)
before treating any part of it as deployable.

> **Repository state.** The instructions below assume a checkout that contains the
> Phase 2 and Phase 3 source. At the time of writing the implementation is an uncommitted
> working tree on `phase-3/real-agent-runtime`; the last commit is `43d5c17`. If a fresh
> clone contains no `apps/api/src` or `apps/web/src`, the tree was never committed. See
> `docs/engineering/DEPLOYMENT-READINESS.md` §2.3.

---

## What you get in five minutes

- A control centre at `http://localhost:3100`, signed in as a seeded owner.
- An Overview screen that reads live data from the API: system health, task queues,
  agent activity, approvals, usage and cost, critical alerts.
- Two regions and one line that say `Not instrumented`, because no API source exists.
  They do not invent numbers.
- A working Temporal workflow, started through the API rather than the browser, that
  writes a real artifact file and records an audit trail.
- An execution detail screen at `/{workspace}/tasks/{taskId}`: attempts, tool timeline,
  artifact integrity, provider-reported cost.

You do **not** get a coding agent by default. `LocalSimulatedRuntime` is deterministic, has
no shell, no network and no model call, and costs `$0.0000`.

If you opt in (§ *Run a real task*), you get a real agent — `opencode v2.2.7` in a `bwrap`
sandbox, with a shell, editing a disposable clone. That path is proven, but narrow: one
fixture repository, one adapter, no evaluation set, and a credential residual that makes it
unsuitable for a repository whose contents are sensitive.

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

Current results, with literal output:
[`docs/engineering/PHASE-3-TEST-RESULTS.md`](docs/engineering/PHASE-3-TEST-RESULTS.md) for
the current tree. Note that `pnpm audit --audit-level high` currently exits 1 (two high
PostCSS advisories through Next.js); that gate is red, not waived.

---

## Run a real task (opt-in)

> **This spends money and uses a real provider credential.** Real execution is off by
> default. Nothing here happens unless you set `AGENT_RUNTIME=opencode-cli`, and the
> worker refuses to boot that adapter without a positive `AGENT_MAX_USD`.
>
> **Do not point this at a repository whose contents are sensitive.** The sandbox can read
> the provider credential it authenticates with, and can send it to the provider. Read
> [`docs/engineering/WORKSPACE-SECURITY-MODEL.md`](docs/engineering/WORKSPACE-SECURITY-MODEL.md)
> §5 first.

**Prerequisites, measured on this host:**

| Requirement | Check | Value here |
|---|---|---|
| `bwrap` (bubblewrap) | `bwrap --version` | 0.11.1 |
| `opencode`, authenticated | `opencode --version` · `opencode --standalone auth list` | v2.2.7, credential present |
| A repository to clone | `WORKSPACE_SOURCE_REPO` | `infra/fixtures/sample-repo` |
| Temporal | `pnpm temporal:start` | 127.0.0.1:7233 |

**The switch and its levers:**

| Variable | Meaning | Default |
|---|---|---|
| `AGENT_RUNTIME` | `opencode-cli` enables real execution; `local-simulated` does nothing | `local-simulated` |
| `WORKSPACE_SOURCE_REPO` | Repository cloned per attempt. Unset = empty workspace, and the adapter refuses | unset |
| `AGENT_MODEL` | Provider-qualified model id | `commandcode/deepseek/deepseek-v4-flash` |
| `AGENT_MAX_USD` | Hard per-run cap, checked against provider-reported cost. `0` is refused | `0.5` |
| `AGENT_BWRAP_PATH` | Sandbox binary. Missing `bwrap` fails closed, never unsandboxed | `bwrap` on `PATH` |

**Fastest proof — no API, no Temporal.** Provisions a temporary workspace, runs one real
task, prints the diff, re-runs the suite inside the sandbox, and checks the fixture is
untouched:

```bash
npx tsx infra/scripts/p3-real-run.ts
```

**The product path — API → Temporal → worker → agent:**

```bash
# Terminal A
pnpm temporal:start

# Terminal B
AGENT_RUNTIME=opencode-cli \
WORKSPACE_SOURCE_REPO=infra/fixtures/sample-repo \
AGENT_MODEL=commandcode/deepseek/deepseek-v4-flash \
AGENT_MAX_USD=0.5 \
pnpm dev
```

Then create a task and run it (the snippets use `jq` and `uuidgen`; the task must be
`ready`, and `LOW` needs no approval — see D-006, which is itself an open policy decision):

```bash
TOKEN=$(curl -s http://localhost:4100/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"owner@northwind.test","password":"Passw0rd!demo"}' | jq -r .data.accessToken)
ORG=<orgId>; PROJECT=<projectId>          # GET /v1/orgs, then …/workspaces/:wsId/projects

TASK=$(curl -s http://localhost:4100/v1/orgs/$ORG/projects/$PROJECT/tasks \
  -H "authorization: Bearer $TOKEN" -H "x-org-id: $ORG" \
  -H "idempotency-key: $(uuidgen)" -H 'content-type: application/json' \
  -d '{"title":"Fix the failing sum test","goal":"The test suite fails. Find the bug in src/sum.js, fix it, and run node --test to prove it passes. Do not change the test file.","riskClass":"LOW"}' \
  | jq -r .data.id)

# A new task is draft. Promotion to ready is a human transition and requires a reason.
curl -s -X PATCH http://localhost:4100/v1/orgs/$ORG/tasks/$TASK \
  -H "authorization: Bearer $TOKEN" -H "x-org-id: $ORG" \
  -H 'content-type: application/json' \
  -d '{"status":"ready","reason":"run the real-agent proof"}'

curl -s -X POST http://localhost:4100/v1/orgs/$ORG/tasks/$TASK/run \
  -H "authorization: Bearer $TOKEN" -H "x-org-id: $ORG"
```

Watch it in the Temporal UI (`http://localhost:8233`) or read the result at
`http://localhost:3100/reveilchat/tasks/<taskId>`. The API exposes the same history at
`GET /v1/orgs/:orgId/tasks/:taskId/executions`.

**Cost.** About **$0.001–$0.01 per small task** with the cheap model. Measured on the
fixture: 16.4 s, 1,206 input / 424 output tokens, and **$0.00056** across six
provider-reported `step_finish` events — stored as `$0.0006` because the column keeps four
decimals. The harness prompt dominates the input — a trivial "reply PONG" probe cost
$0.0065 and 43.6k input tokens — so budget the upper end for anything real. `AGENT_MAX_USD`
is enforced during the run, against the provider's own reported cost.

**What you get, and what you do not.** A real agent with a shell, editing a disposable
clone; a diff produced inside the sandbox; a redacted transcript; 6 tool calls recorded as
rows; SHA-256 per artifact; a cost. No commit, no branch, no push, no pull request. The
clone is deleted after the run; `artifacts/` survives.

---

## Repository map

```text
apps/
  api/                 NestJS 11 · 18 documented routes · port 4100
  web/                 Next.js 15 App Router · Overview, login, execution detail · port 3100
  worker/              Temporal worker · runTaskWorkflow + six activities
packages/
  contracts/           Zod DTOs, event envelope, task state machine
  database/            Prisma schema (15 models), migrations, seed
  design-system/       138 --iz-* tokens, 14 component modules
  workspace-manager/   paths, containment, git, bwrap argv, lifecycle
  agent-runtime/       AgentRuntime port · LocalSimulatedRuntime · OpencodeCliRuntime
infra/scripts/         bootstrap-db · start-temporal · dev · verify · p3-real-run · p3-sandbox-audit
infra/fixtures/        sample-repo, the repository a real run clones
docs/
  decisions/           ADR-001 … ADR-010, OPEN-DECISIONS
  engineering/         Phase 2 record + Phase 3 execution, security, lifecycle
  design/              frozen Phase 1 design output
prototype/             frozen Phase 1 prototype: plain HTML/CSS/JS, zero dependencies
```

Not created on purpose: `apps/orchestrator`, `apps/research`, `apps/engineering`,
`apps/creative`. They have no behaviour yet.

---

## What is real and what is simulated

**Real:** PostgreSQL rows, tenant scoping, role checks, task state machine, approvals,
Temporal workflow execution, workflow run ids, artifact files with SHA-256 checksums,
audit events with correlation ids, workspace leases, attempt identity, tool traces.

**Real, opt-in:** the agent's work, when `AGENT_RUNTIME=opencode-cli`. A real model runs
in a `bwrap` sandbox against a disposable clone, edits files, runs a shell, and reports
tokens and cost. It is proven on one fixture repository. It is not proven on a real
codebase, and its sandbox has an open credential condition (§ *Run a real task*).

**Simulated by default:** `LocalSimulatedRuntime` has no shell, no network, no repository
read, no model call, no code change, no cost. `AgentRun.model` is the literal string
`simulated`. Every surface labels a run from its `simulated` column, so the two cases are
never visually confused.

**Not implemented:** everything except Overview and the execution detail screen. Fifteen of
sixteen navigation destinations are placeholders. There is no mutation UI: you can read,
not create, run, cancel or approve in the browser.

The full list: [`docs/engineering/PHASE-3-KNOWN-LIMITATIONS.md`](docs/engineering/PHASE-3-KNOWN-LIMITATIONS.md)
(thirty-one items). Phase 2's [`KNOWN-LIMITATIONS.md`](docs/engineering/KNOWN-LIMITATIONS.md) is
still true where not superseded.

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
| Real run fails with `SANDBOX_UNAVAILABLE` | `bwrap` is not installed, and the adapter refuses to run unsandboxed | Install bubblewrap, or set `AGENT_BWRAP_PATH` |
| Real run fails with `WORKSPACE_REQUIRED` | `WORKSPACE_SOURCE_REPO` is unset, so the lease is empty and there is no `repo/` | Set it to a local path or a clone URL |
| Worker exits at boot: `AGENT_MAX_USD must be greater than 0` | `AGENT_RUNTIME=opencode-cli` with `AGENT_MAX_USD=0` | Set a positive cap; a real runtime with no cap is refused on purpose |

---

## Documentation

| Document | What it answers |
|---|---|
| [`docs/engineering/PHASE-3-IMPLEMENTATION-STATUS.md`](docs/engineering/PHASE-3-IMPLEMENTATION-STATUS.md) | What Phase 3 actually runs, the real run's numbers, and where the chain stops being real |
| [`docs/engineering/PHASE-3-TEST-RESULTS.md`](docs/engineering/PHASE-3-TEST-RESULTS.md) | Literal gate output and the fifteen security cases, with gaps stated |
| [`docs/engineering/WORKSPACE-SECURITY-MODEL.md`](docs/engineering/WORKSPACE-SECURITY-MODEL.md) | The mount table, what is not enforced, and the credential residual |
| [`docs/engineering/EXECUTION-LIFECYCLE.md`](docs/engineering/EXECUTION-LIFECYCLE.md) | States, rows, cancellation, failure and recovery for an operator |
| [`docs/engineering/RUNTIME-ADAPTER-GUIDE.md`](docs/engineering/RUNTIME-ADAPTER-GUIDE.md) | How to write a second adapter against the port |
| [`docs/engineering/PHASE-3-KNOWN-LIMITATIONS.md`](docs/engineering/PHASE-3-KNOWN-LIMITATIONS.md) | Thirty-one limitations, flat, including the evaluation gap |
| [`docs/engineering/PHASE-2-CONTRACT.md`](docs/engineering/PHASE-2-CONTRACT.md) | The binding Phase 2 rules, including §15 amendments |
| [`docs/engineering/IMPLEMENTATION-STATUS.md`](docs/engineering/IMPLEMENTATION-STATUS.md) | Phase 2 per-unit status and the vertical slice |
| [`docs/engineering/TEST-RESULTS.md`](docs/engineering/TEST-RESULTS.md) | Phase 2 literal gate output |
| [`docs/engineering/SECURITY-RESULTS.md`](docs/engineering/SECURITY-RESULTS.md) | Phase 2 security findings; `PHASE-3-SECURITY-RESULTS.md` holds the Phase 3 audit and remediation |
| [`docs/engineering/DEPLOYMENT-READINESS.md`](docs/engineering/DEPLOYMENT-READINESS.md) | Why this is not deployable, and the path to staging |
| [`docs/engineering/KNOWN-LIMITATIONS.md`](docs/engineering/KNOWN-LIMITATIONS.md) | Phase 2 limitations, still true where not superseded |
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
