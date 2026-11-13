# ADR-001 — Application architecture

Status: Accepted
Date: 2026-11-13

## Context

INTELLIGENZ needs three things that fail differently:

1. A **control centre** that renders dense operational tables, must be linkable and refresh-safe, and is read-mostly.
2. An **API** that owns authentication, tenant scoping, the task state machine, idempotency, and the Temporal client.
3. A **worker** that executes agent runs for minutes at a time, retries, and can be restarted without losing work.

The environment has one host, one Node runtime, no Docker, and no managed platform. The team is small. `BRIEF.md` describes six "layers" (planning, research, engineering, creative, memory, governance); that is the product's mental model for the UI, not a deployment topology.

The question is only: how many processes, and where does the client/server line fall?

## Decision

Three deployable processes, one repository:

```
Browser ──HTTP──► apps/web (Next.js 15, App Router, RSC)
                     │  server-side fetch, forwards bearer credential
                     ▼
                  apps/api (NestJS 11, REST /v1)
                     ├──► PostgreSQL 18 (Prisma)
                     ├──► Redis 8 (cache, rate limits)
                     └──► Temporal 7233 (start/signal/cancel)
                              ▲
                              │ task queue: intelligenz-runs
                  apps/worker (Temporal worker + activities)
                     ├──► PostgreSQL (result + audit persistence)
                     └──► packages/agent-runtime (LocalSimulatedRuntime)
```

- **`apps/web` is a client of the API, not a second backend.** Server components may fetch `/v1` for first paint, but they hold no domain rules, no Prisma client, and no Temporal client.
- **The API is NestJS, not Next.js route handlers.**
- The browser never reaches PostgreSQL, Redis, Temporal, or the artifact store.
- `/v1` is the only contract between web and API. It is defined in `packages/contracts` as Zod schemas, shared by both sides.

## Why not Next.js route handlers as the API

| Requirement | Route handlers | NestJS |
|---|---|---|
| Tenant scoping enforced on **every** query | per-route discipline; a new handler that forgets the check is a silent cross-tenant read | one guard + one Prisma client extension; forgetting it throws |
| Long-lived Temporal client | request-scoped module scope, re-created per lambda-shaped invocation | singleton provider, connection reused, closed on shutdown |
| Consistent error envelope | assembled per handler | exception filter, one shape |
| Long-running work | must offload to the worker anyway, so the handler is a thin proxy with extra steps | same, but the proxy is typed and testable with Supertest |
| Independent scaling | coupled to the UI build and deploy | scales with DB pool, independently |
| Non-browser clients later (CLI, integrations) | reachable but untested and undocumented | same surface, already exercised by tests |

The decisive argument is not ergonomics. It is that the contract requires cross-tenant reads to be **impossible even if a guard is bypassed** (contract §5). That is a property of the data-access layer, and it is far easier to guarantee when there is exactly one entry point that can construct a Prisma client.

## Consequences

### Positive

- Three processes can be started, tested, and reasoned about independently.
- The worker can crash, restart, or be scaled without touching the UI.
- The API is testable with Supertest against an in-process Nest app — no browser, no build.
- Future non-browser clients (CLI, partner integration) reuse `/v1` unchanged.
- The web app can be statically optimised for everything that is not data-dependent.

### Negative / costs

- Three dev processes plus Postgres, Redis, and Temporal. Bootstrapping is a script, not a single command.
- CORS, cookie `SameSite`, and credential forwarding become real problems. The chosen answer (httpOnly cookie set by the web tier, forwarded as `Authorization`) means **the web server participates in auth**, so a web outage is a login outage even when the API is healthy.
- Two TypeScript builds, two lint configs, two test runners' worth of setup surface.
- A permanent temptation to put "just one" aggregation query in a Next server component. That must be rejected in review or the boundary erodes.
- Deploying requires three artifacts and a migration step, not one.

## Alternatives considered

**Next.js only (route handlers + server actions).** Rejected. It collapses three failure domains into one build, makes the worker impossible without a second process anyway, and turns tenant scoping into per-route discipline. It would also force the Overview's data fetching and the task state machine into the same deploy cadence.

**Next.js + a managed backend (Supabase/Firebase).** Rejected. The product's central claim is a durable, auditable execution history with tenant isolation proof. Delegating persistence to a vendor whose row-level security is a second, differently-expressed policy language doubles the isolation model and makes the audit story depend on a vendor's logs. No account or budget authorisation exists for it either.

**tRPC between web and API.** Rejected. It couples the two release cadences and produces a contract that only TypeScript clients can consume — which is precisely wrong for a product that will expose `/v1` to integrations.

**GraphQL gateway.** Rejected. There is one client with known, fixed screens. A schema, resolvers, and a persisted-query layer would be pure cost at this stage.

## Revisit trigger

Split `apps/api` only when a capability needs a different runtime, a different security boundary (for example, executing untrusted code in a sandbox), or an independent scaling profile. Reconsider the web-as-credential-forwarder decision the moment a second client (mobile, CLI) needs the same session, or when an SSO requirement forces token handling into a dedicated identity service.
