# INTELLIGENZ

An autonomous AI engineering control plane. A local vertical slice: organisation →
workspace → project → task → Temporal workflow → agent run → artifact and evidence →
audit event.

Two runtimes exist. The **default is simulated**: deterministic, no shell, no network, no
model call, $0. **Phase 3 added a real path**: `opencode-cli` runs an actual coding agent
inside a `bwrap` sandbox against a disposable clone of a repository. That path is opt-in,
spends provider credit, and is proven end to end on this host — one task, one fixture
repository, `$0.0006`.

**Phase 4 makes that path defensible.** The provider credential no longer enters the
sandbox: authentication is terminated by a host broker over a per-attempt unix socket
(`packages/egress-broker`). Resource limits are per-attempt cgroup v2 files — memory, pids
and CPU — with effective values read back from the kernel, and they are **opt-in** (see
*Enable cgroup enforcement*). Risk is derived server-side and approvals are bound,
single-use and re-checked at the worker. There is an evaluation harness, and its real
baseline is blocked by provider quota, not by code.

It runs on one host with PostgreSQL and the Temporal dev server. Redis is running but no
code path uses it. It is **not production-ready**: single host, shared kernel with no
seccomp or per-tenant uid, an unauthenticated Temporal listener on loopback, one database
role, no CI execution, no remote push, and no real evaluation baseline. Read
[`docs/engineering/PHASE-4-IMPLEMENTATION-STATUS.md`](docs/engineering/PHASE-4-IMPLEMENTATION-STATUS.md)
§7 and [`docs/engineering/DEPLOYMENT-READINESS.md`](docs/engineering/DEPLOYMENT-READINESS.md)
before treating any part of it as deployable.

> **Repository state.** The instructions below assume a checkout that contains the
> Phase 2, 3 and 4 source. At the time of writing the implementation is an uncommitted
> working tree on `phase-4/execution-trust`; the last commit is `c104e64`. If a fresh
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
sandbox, with a shell, editing a disposable clone, authenticating through a host broker
that holds the key. That path is proven, but narrow: one fixture repository, one adapter,
a small simulated-only evaluation set, and resource limits that are on only when you start
the worker through the cgroup wrapper.

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
[`docs/engineering/PHASE-4-TEST-RESULTS.md`](docs/engineering/PHASE-4-TEST-RESULTS.md) for the
current tree: typecheck 0, lint 0, build 0, **62 test files / 655 passed / 11 skipped**,
79 API e2e, 57 web e2e. The 11 skips are environmental and each prints its reason: 8 cgroup
kill tests need the full-tier wrapper, 2 live-provider contract cases need
`IZ_REAL_PROVIDER=1`, and 1 broker run needs a real provider.

`pnpm audit --audit-level high` **exits 0**: no high or critical advisory remains (the Phase 3
gate was red with two). Three vulnerabilities remain — 1 low, 2 moderate — carried through
Next.js dependencies; they are not waived, they are visible on every run.

---

## Run a real task (opt-in)

> **This spends money and uses a real provider credential.** Real execution is off by
> default. Nothing here happens unless you set `AGENT_RUNTIME=opencode-cli`, and the
> worker refuses to boot that adapter without a positive `AGENT_MAX_USD`.
>
> **The credential does not enter the sandbox.** The agent authenticates through a
> per-attempt unix socket to a host broker, which injects the provider key at request
> time. The sandbox holds a random canary that authenticates nothing. Read
> [`docs/engineering/PHASE-4-CREDENTIAL-ISOLATION.md`](docs/engineering/PHASE-4-CREDENTIAL-ISOLATION.md)
> for the traffic path and the mount table.
>
> **Resource limits are opt-in.** Start the worker through the cgroup wrapper or it runs
> with rlimits only and records `executionProfile = "rlimit-only"`. See *Enable cgroup
> enforcement* below.

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
| `AGENT_MODEL` | **Upstream** model id. The sandbox sees `izbroker/<key>`, never the vendor | required |
| `AGENT_BROKER_UPSTREAM_URL` | Provider base URL the host broker forwards to | required |
| `AGENT_BROKER_CREDENTIAL` | opencode integration id read from the host SQLite store | unset |
| `AGENT_BROKER_CREDENTIAL_ENV` | Or: environment variable holding the key | unset |
| `AGENT_MAX_USD` | Hard per-run cap, checked against provider-reported cost. `0` is refused | `0.5` |
| `AGENT_BWRAP_PATH` | Sandbox binary. Missing `bwrap` fails closed, never unsandboxed | `bwrap` on `PATH` |

**Where the credential lives since Phase 4.** Nowhere inside the sandbox. The agent
authenticates through a per-attempt channel to a host broker
(`packages/egress-broker`), which injects the provider key at request time and strips
anything the sandbox sent. The sandbox holds a random canary that authenticates
nothing, and no credential database is mounted — so `~/.local/share/opencode` is absent
rather than narrowed. See `docs/engineering/PHASE-4-BASELINE.md` for the measurement
that forced this, and `docs/engineering/PHASE-4-CREDENTIAL-ISOLATION.md` for the path.

**Fastest proof — no API, no Temporal.** Provisions a temporary workspace, runs one real
task, prints the diff, re-runs the suite inside the sandbox, and checks the fixture is
untouched:

```bash
npx tsx infra/scripts/p3-real-run.ts
```

The structured Gate A proof — sandbox probe, broker refusals attempted from **inside** the
sandbox, one real run, log scan, provider-reported cost — is:

```bash
npx tsx infra/scripts/p4-broker-proof.ts
```

**Live-provider contract tests.** Two adapter tests need a real provider and are skipped
by default. Both conditions are required:

```bash
IZ_REAL_PROVIDER=1 AGENT_MODEL=gemini-3.5-flash-lite \
  npx vitest run packages/agent-runtime/test/opencode-cli.test.ts
```

`IZ_REAL_PROVIDER` must be exactly `1`, and `AGENT_MODEL` must be non-empty; anything else
skips with the reason printed. There is no other switch — `OPENCODE_CLI_SKIP` no longer
exists.

**Enable cgroup enforcement (opt-in).** Aggregate memory, pid and CPU limits require one
root step and a wrapper. Without them the worker records `rlimit-only` and refuses `HEAVY`.

```bash
# Once, as root. Idempotent.
sudo bash infra/scripts/setup-cgroups.sh

# Then start the worker inside its delegated leaf:
sudo bash infra/scripts/worker-with-cgroup.sh pnpm dev
```

Verify with `cat /sys/fs/cgroup/intelligenz/cgroup.controllers` (expect `cpu memory pids`).
A plain directory or a non-delegated tree is reported as `unavailable`, not as
`enforced`. See `docs/engineering/PHASE-4-RESOURCE-ENFORCEMENT.md`.

**The product path — API → Temporal → worker → agent:**

```bash
# Terminal A
pnpm temporal:start

# Terminal B
AGENT_RUNTIME=opencode-cli \
WORKSPACE_SOURCE_REPO=infra/fixtures/sample-repo \
AGENT_MODEL=gemini-3.5-flash \
AGENT_BROKER_UPSTREAM_URL=https://generativelanguage.googleapis.com/v1beta/openai \
AGENT_BROKER_CREDENTIAL=google \
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
  database/            Prisma schema, migrations, seed
  design-system/       138 --iz-* tokens, 14 component modules
  workspace-manager/   paths, containment, git, bwrap argv, leases, reclaim
  agent-runtime/       AgentRuntime port · LocalSimulatedRuntime · OpencodeCliRuntime
  egress-broker/       per-attempt unix socket · capability token · credential injection
  evaluation/          benchmarks · judges · rubric · security gate · result ledger
infra/scripts/         bootstrap-db · start-temporal · dev · verify · eval
                       setup-cgroups · worker-with-cgroup · check-spawn-discipline
                       p3-real-run · p3-sandbox-audit · p4-broker-proof
infra/benchmarks/      8 fixtures, simulations, results, BASELINE-simulated.md
infra/fixtures/        sample-repo, the repository a real run clones
docs/
  decisions/           ADR-001 … ADR-010, OPEN-DECISIONS (D-006)
  engineering/         Phase 2/3/4 records: status, tests, security, resources, evaluation
  design/              frozen Phase 1 design output
prototype/             frozen Phase 1 prototype: plain HTML/CSS/JS, zero dependencies
```

Not created on purpose: `apps/orchestrator`, `apps/research`, `apps/engineering`,
`apps/creative`. They have no behaviour yet.

---

## What is real and what is simulated

**Real:** PostgreSQL rows, tenant scoping, role checks, task state machine, server-derived
risk, bound single-use approvals re-checked at the worker, Temporal workflow execution,
workflow run ids, artifact files with SHA-256 checksums and attempt provenance, audit
events with correlation ids, workspace leases and a reaper, attempt identity, tool traces.

**Real, opt-in:** the agent's work, when `AGENT_RUNTIME=opencode-cli`. A real model runs
in a `bwrap` sandbox against a disposable clone, edits files, runs a shell, authenticates
through a host broker, and reports tokens and cost. It is proven on one fixture
repository. It is not proven on a real codebase. **Resource enforcement is separately
opt-in** and needs the cgroup wrapper; without it the attempt says `rlimit-only`.

**Measured, but blocked:** the evaluation harness runs and its simulated baseline is
recorded. A **real** baseline does not exist: the provider's free tier returned
`429 RESOURCE_EXHAUSTED` (20 requests/day). See
[`docs/engineering/PHASE-4-EVALUATION-FRAMEWORK.md`](docs/engineering/PHASE-4-EVALUATION-FRAMEWORK.md).

**Simulated by default:** `LocalSimulatedRuntime` has no shell, no network, no repository
read, no model call, no code change, no cost. `AgentRun.model` is the literal string
`simulated`. Every surface labels a run from its `simulated` column, so the two cases are
never visually confused. The evaluation suite's 87.50 mean is a **harness self-test**, not
a model score.

**Not implemented:** everything except Overview and the execution detail screen. Fifteen of
sixteen navigation destinations are placeholders. There is no mutation UI: you can read,
not create, run, cancel or approve in the browser. Disk quota and I/O bandwidth are not
enforced. CI has never run. Nothing is pushed.

The full list: [`docs/engineering/PHASE-3-KNOWN-LIMITATIONS.md`](docs/engineering/PHASE-3-KNOWN-LIMITATIONS.md)
(thirty-one items, some superseded by Phase 4 and marked there). Phase 2's
[`KNOWN-LIMITATIONS.md`](docs/engineering/KNOWN-LIMITATIONS.md) is still true where not superseded.
Phase 4 residuals are in
[`docs/engineering/PHASE-4-IMPLEMENTATION-STATUS.md`](docs/engineering/PHASE-4-IMPLEMENTATION-STATUS.md) §7.

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
| Worker exits at boot: `AGENT_BROKER_UPSTREAM_URL is required` | Real runtime selected, but no broker configured | The sandbox has no credential; the broker is the only authentication path. Set the URL |
| Worker exits at boot: `A provider credential source is required` | Neither `AGENT_BROKER_CREDENTIAL` nor `AGENT_BROKER_CREDENTIAL_ENV` is set | Set one; the broker reads the key host-side |
| Attempts record `executionProfile = "rlimit-only"` | Worker started outside the cgroup wrapper | `sudo bash infra/scripts/setup-cgroups.sh`, then start via `worker-with-cgroup.sh` |
| `HEAVY` refused with `RESOURCE_PROFILE_UNAVAILABLE` | cgroups unavailable, and `HEAVY` requires aggregate limits | Run the setup script and the wrapper, or avoid `HEAVY` |
| Broker `403 BROKER_TOKEN` in a run that should work | The sandbox presented a foreign or absent capability | Check the per-attempt socket and config; a stale socket from a crashed attempt is unlinked on the next start |
| `EADDRINUSE` on the broker socket after a worker crash | A previous attempt left `broker.sock` (audit F6) | Per-attempt directories make this rare; remove the stale attempt directory |

---

## Documentation

| Document | What it answers |
|---|---|
| [`docs/engineering/PHASE-4-IMPLEMENTATION-STATUS.md`](docs/engineering/PHASE-4-IMPLEMENTATION-STATUS.md) | What Phase 4 actually runs, the executed chain, how to run a real task, and the residuals |
| [`docs/engineering/PHASE-4-TEST-RESULTS.md`](docs/engineering/PHASE-4-TEST-RESULTS.md) | Literal gate output, the 28 attack scenarios and the 15 authorization cases, with gaps stated |
| [`docs/engineering/PHASE-4-SECURITY-RESULTS.md`](docs/engineering/PHASE-4-SECURITY-RESULTS.md) | The independent audit, its verdict history, and the remediation record (F1–F3 closed, F4–F6 open) |
| [`docs/engineering/PHASE-4-CREDENTIAL-ISOLATION.md`](docs/engineering/PHASE-4-CREDENTIAL-ISOLATION.md) | Traffic path, where the secret lives, the mount table, adversarial results |
| [`docs/engineering/PHASE-4-RESOURCE-ENFORCEMENT.md`](docs/engineering/PHASE-4-RESOURCE-ENFORCEMENT.md) | Profiles, effective-vs-configured limits, measured kills, and what is **not** enforced |
| [`docs/engineering/PHASE-4-EVALUATION-FRAMEWORK.md`](docs/engineering/PHASE-4-EVALUATION-FRAMEWORK.md) | Benchmarks, rubric, disqualification, simulated baseline, blocked real baseline |
| [`docs/engineering/PHASE-4-WORKSPACE-RECOVERY.md`](docs/engineering/PHASE-4-WORKSPACE-RECOVERY.md) | Leases, the reaper decision table, the 13 crash tests, quarantine rules |
| [`docs/engineering/PHASE-4-IMPLEMENTATION-PLAN.md`](docs/engineering/PHASE-4-IMPLEMENTATION-PLAN.md) | The executed decomposition, unit by unit, recorded post-hoc |
| [`docs/engineering/PHASE-3-IMPLEMENTATION-STATUS.md`](docs/engineering/PHASE-3-IMPLEMENTATION-STATUS.md) | What Phase 3 runs, the real run's numbers, and where the chain stops being real |
| [`docs/engineering/PHASE-3-TEST-RESULTS.md`](docs/engineering/PHASE-3-TEST-RESULTS.md) | Phase 3 literal gate output and the fifteen security cases |
| [`docs/engineering/WORKSPACE-SECURITY-MODEL.md`](docs/engineering/WORKSPACE-SECURITY-MODEL.md) | The Phase 3 mount table and credential residual (superseded on the credential by Phase 4) |
| [`docs/engineering/EXECUTION-LIFECYCLE.md`](docs/engineering/EXECUTION-LIFECYCLE.md) | States, rows, cancellation, failure and recovery for an operator |
| [`docs/engineering/RUNTIME-ADAPTER-GUIDE.md`](docs/engineering/RUNTIME-ADAPTER-GUIDE.md) | How to write a second adapter against the port |
| [`docs/engineering/PHASE-3-KNOWN-LIMITATIONS.md`](docs/engineering/PHASE-3-KNOWN-LIMITATIONS.md) | Thirty-one limitations, flat, including the evaluation gap |
| [`docs/engineering/PHASE-2-CONTRACT.md`](docs/engineering/PHASE-2-CONTRACT.md) | The binding Phase 2 rules, including §15 amendments |
| [`docs/engineering/IMPLEMENTATION-STATUS.md`](docs/engineering/IMPLEMENTATION-STATUS.md) | Phase 2 per-unit status and the vertical slice |
| [`docs/engineering/TEST-RESULTS.md`](docs/engineering/TEST-RESULTS.md) | Phase 2 literal gate output |
| [`docs/engineering/SECURITY-RESULTS.md`](docs/engineering/SECURITY-RESULTS.md) | Phase 2 security findings; `PHASE-3-SECURITY-RESULTS.md` holds the Phase 3 audit and remediation |
| [`docs/engineering/DEPLOYMENT-READINESS.md`](docs/engineering/DEPLOYMENT-READINESS.md) | Why this is not deployable, and the path to staging |
| [`docs/engineering/KNOWN-LIMITATIONS.md`](docs/engineering/KNOWN-LIMITATIONS.md) | Phase 2 limitations, still true where not superseded |
| [`docs/decisions/`](docs/decisions/) | ADR-001 … ADR-010, D-006 and the open product decisions |
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

## Not production-ready

This build is a local vertical slice. The Phase 4 controls are real and measured; the
deployment around them is not. Before any shared environment, at minimum:

- a seccomp allowlist and either a per-tenant uid or a VM/microVM boundary — the sandbox
  shares the host kernel and the worker's uid today;
- the cgroup wrapper in the start path, with an alert when an attempt records `rlimit-only`;
- a filesystem quota and an I/O limit — neither is enforced by the current cgroups;
- an authenticated Temporal listener, a database role separated from the worker's
  credential store, and a secret manager instead of `opencode.db`;
- CI that actually runs, and a real evaluation baseline (currently **BLOCKED** by provider
  quota);
- audit F4–F6 closed, and a decision recorded for the open residuals in
  `PHASE-4-IMPLEMENTATION-STATUS.md` §7.

Nothing in this repository has been pushed to a remote.

---

Private and unlicensed. Do not deploy this build to a shared environment.
