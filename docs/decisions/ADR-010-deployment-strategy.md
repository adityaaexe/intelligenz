# ADR-010 — Deployment strategy

Status: Accepted
Date: 2026-11-13

## Context

Contract §0 forbids cloud provisioning, paid resources, and external deployments in this phase. The environment confirms why that is not merely a policy choice:

| Capability | Measured state |
|---|---|
| Docker | absent (`docker: command not found`) |
| `gh` CLI | absent (`gh: command not found`) |
| Temporal CLI | absent (`temporal: command not found`) |
| Node | v22.23.2 |
| PostgreSQL | 18.6, accepting connections on 127.0.0.1:5432 |
| Redis | 8.0.5, `PONG` |
| Ports 3000 / 4000 | **already bound** by `node /opt/reveil/repo/backend/api-server/index.js` and `socket-server/index.js`, running for over a day |

No container runtime means no image can be built locally, so a container artifact cannot be verified even if it were written. No `gh` means no CLI-based CI authoring or secret configuration. No credentials means no push, no registry, no cloud API.

## Decision

**Local-first, and local-only for Phase 2.**

1. Every artifact must run on this host with `pnpm`, `node`, the host PostgreSQL, the host Redis, and the Temporal dev server. No artifact may require Docker.
2. Three processes are started by scripts, not by an orchestrator:
   - `infra/scripts/bootstrap-db.sh` — role, database, grants, `prisma migrate deploy`, seed.
   - `infra/scripts/dev-temporal.sh` — `temporal server start-dev --db-filename .temporal/dev.db`.
   - `pnpm -w dev` — web, api, worker concurrently.
3. Deployment artifacts are **prepared but not executed**: a `Dockerfile` per app and a `compose.yaml` may be written, and must be labelled in the README as *unbuilt and unverified*. Writing a container file that has never been built is documentation, not a deployment capability, and must never be reported as one.
4. `.github/workflows/ci.yml` is written from the contract's gate list, but **CI is `IMPLEMENTED`, never `VERIFIED`** in Phase 2: no remote exists, no `gh`, no push credential. The gate commands are run locally and their literal output is what gets reported.
5. No provisioning. No DNS, no TLS, no reverse proxy, no secret manager, no registry, no cloud account.

### Port conflict — a blocker, stated plainly

Contract §4 assigns **web 3000** and **api 4000**. Both are occupied by another product's long-running services under `/opt/reveil/repo/backend`. Those processes are outside this project and must not be stopped, restarted, or signalled by this team.

Consequence: `apps/web` and `apps/api` **cannot bind the contract's ports** while those processes run. Options, in order of preference:

1. **Offset** — web 3100, api 4100, and record the deviation from contract §4 in the status report. Lowest risk, no interference.
2. Coordinate a stop of the `/opt/reveil` services — requires the owner's consent and would break another product. Not acceptable without explicit authorisation.
3. Same ports in a network namespace — needs privileges and adds a debugging cost that outweighs the benefit at this stage.

This ADR records that option 1 is the intended path, and that the contract's port table is **not satisfiable as written on this host**. The Leader must ratify the offset, because silently choosing different ports would make every contract-derived command wrong.

## Consequences

### Positive

- Zero cloud spend, zero credential handling, zero chance of touching another product's infrastructure.
- The system is reproducible from a script on a fresh checkout of this host.
- Verification claims are local and honest: a command was run, its output was quoted.
- Preparing container artifacts now means the deployment shape is designed while it is still cheap to change.

### Negative / costs

- **No production-shaped verification.** No TLS termination, no reverse proxy, no real object store, no secret manager, no process supervisor, no restart policy, no log aggregation. Everything that usually breaks at deploy time is untested.
- **The host's versions become accidental requirements.** Node 22.23.2, Postgres 18.6, Redis 8.0.5. A container would pin them; a host does not, and an upgrade on the host silently changes the runtime.
- **No CI means no independent verification.** Every gate result is self-reported by the agent that ran it, on the machine that produced the code. That is a weaker claim than a green pipeline and must be labelled as such.
- **The port offset makes the contract's documented commands wrong.** Anyone following contract §4 will hit `EADDRINUSE`. The deviation must be propagated to every script, `.env.example`, README, and test base URL, or the next agent will lose an hour to it.
- Dev-server Temporal and host Postgres have no backup. A mistake is unrecoverable.
- No remote git means no off-host backup of the source until a credential exists.

## Alternatives considered

**Install Docker now.** Not available: it requires a package installation the environment does not provide, and it would still not grant a registry, an account, or budget authorisation. It also would not make the *deployment* real — only the build.

**Deploy to a PaaS (Vercel for web, Railway/Fly for api and worker).** Blocked: no account, no credentials, no budget authorisation, no data-residency decision. Also structurally awkward — a managed platform gives no Temporal dev server and no host Postgres, so it would force a different orchestration choice (see ADR-003) before the first feature ships.

**Docker Compose for everything, written now and run later.** Rejected as the primary path. An unbuildable compose file is not a plan; it is a liability that reads like a plan. Compose may exist as a prepared artifact, clearly labelled unverified.

**Run all three processes in one Node process for simplicity.** Rejected. It removes the ability to restart the worker independently, which is the entire reason the worker exists (ADR-001/003).

**Nginx + systemd on this host as a "production" setup.** Rejected. It would touch host-level configuration shared with another product, and would create a production claim with no capacity, backup, or monitoring to support it.

## Revisit trigger

Revisit when any of the following becomes true: a credential exists for a git remote; Docker becomes available; a budget and account are authorised; or the product needs to be reachable by anyone other than this host. The first of those unblocks CI, which is the cheapest real improvement and should be prioritised over cloud hosting.
