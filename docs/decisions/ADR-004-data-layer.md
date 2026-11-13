# ADR-004 — Data layer

Status: Accepted
Date: 2026-11-13

## Context

The vertical slice is `Organization → Project → Task → WorkflowRun → AgentRun → Artifact → AuditEvent`, plus `User` and `Membership` for identity. Every row below `Organization` is tenant-owned. The product's enterprise persona expects isolation proof, not isolation claims.

PostgreSQL 18.6 is installed and running on the host with peer auth for `postgres` only; the application role must be created by a script. Prisma is fixed by contract §2.

## Decision

**PostgreSQL 18 (host instance) + Prisma, one database `intelligenz_dev`, one schema, all tenant-owned tables carry a non-null `orgId`.**

### Schema shape

- `Organization`, `User`, `Membership` (`userId`, `orgId`, `role`) with `@@unique([userId, orgId])`.
- `Project` (`orgId`), `Task` (`orgId`, `projectId`), `WorkflowRun` (`orgId`, `taskId`), `AgentRun` (`orgId`, `workflowRunId`), `Artifact` (`orgId`, `agentRunId`), `AuditEvent` (`orgId`, `aggregateId`).
- Every child table carries `orgId` **denormalised**, even though it is reachable through its parent. Reason: a tenant filter that requires a join is a filter that will be omitted. `orgId` on the row makes the `where` clause one term and makes the composite index useful.
- Composite indexes lead with `orgId`: `@@index([orgId, projectId, createdAt])`. A tenant-scoped list query is then an index range scan, not a filter after the fact.
- IDs are `cuid()`/ULID-style opaque strings, never sequential integers. `INFORMATION-ARCHITECTURE.md` §3.2 requires opaque, stable IDs, and sequential IDs leak tenant volume.

### Tenant scoping mechanism

`packages/database` exports **only** `forTenant(orgId)` — never a raw `PrismaClient` — to `apps/api` and to worker activities. `forTenant` returns a Prisma client extended with a query guard that:

1. injects `orgId` into `where` for every tenant-owned model on `find*`, `update*`, `delete*`, `count`, `aggregate`;
2. injects `orgId` into `data` on `create*`;
3. **throws** if a tenant-owned model is queried through the extension without a resolvable `orgId`.

This is the enforcement that satisfies contract §5's "impossible even if a guard is bypassed". Its limit is honest and must be documented in code: `$queryRaw` and `$executeRaw` bypass extensions entirely. Therefore raw SQL is banned in `apps/api` except in `packages/database`, where each occurrence is reviewed against an explicit `orgId` predicate.

### Why no pgvector yet

There is no embedding, semantic search, or retrieval feature in the Phase 2 slice. `Knowledge Base` and `Research Lab` are placeholders. Adding the extension now would:

- add a host dependency the bootstrap script must install with elevated privileges (not guaranteed available),
- create a column with no writer and no reader,
- and signal a retrieval architecture that has not been designed (chunking, model, dimensionality, index type are all undecided).

The decision is deferred, not rejected. The `Artifact` table's `contentType` and the future `Source` model are the seams where it will attach.

### Migration strategy

- `prisma migrate dev --name <change>` locally to author migrations; SQL is reviewed before commit.
- `prisma migrate deploy` in `infra/scripts/bootstrap-db.sh` and in CI. Never `db push` against a database that anyone depends on.
- Migrations are forward-only in Phase 2. A destructive change is authored as expand → backfill → contract across separate migrations, never as a single `DROP COLUMN` while code still reads it.
- The seed is idempotent (`upsert` on natural keys) so it can run repeatedly: one org, three users covering OWNER/ADMIN/VIEWER, one project, three tasks in different states.

## Consequences

### Positive

- One connection pool, one backup target, one migration history.
- Transactions span task state change, run record, artifact metadata, and audit event — the audit write cannot be lost while the state change succeeds.
- Denormalised `orgId` makes cross-tenant leakage a single missing predicate, which is exactly the failure a reviewer can see in a diff.
- Prisma's generated types remove a class of DTO drift between API and database.
- Postgres 18 gives `uuidv7()` and improved `jsonb` performance if needed later.

### Negative / costs

- **One database for every tenant.** A noisy neighbour or a bad migration affects all tenants. There is no per-tenant restore.
- Prisma's extension API does not cover nested writes fully: an `include`/`select` relation must be checked separately, and a nested `create` inside a parent write needs its `orgId` supplied explicitly. This is a review burden, not a solved problem.
- Prisma adds a query engine layer; complex aggregate queries (Overview posture counts) may need `$queryRaw` and therefore leave the guarded path.
- Postgres 18 is recent enough that some hosted providers and some Prisma versions have edge cases. Pinning the minor version is required.
- Migration authoring on a shared dev database invites drift between developer machines; the bootstrap script is the only supported path.
- No read replica, no partitioning, no connection pooler (PgBouncer absent). Fine at this size, wrong at any real size.

## Alternatives considered

**Drizzle ORM.** Rejected for this phase only. It gives SQL-shaped control that suits the tenant predicate better, and its migration output is more transparent. Prisma wins on one axis that matters here: generated types shared through `packages/database` reduce hand-written mapping code across api and worker, and the contract fixes Prisma. If the tenant extension proves leaky, Drizzle is the fallback and this ADR should be superseded rather than patched.

**Schema-per-tenant.** Stronger isolation, credible for the "private deployment" commercial model. Rejected now: migration fan-out across N schemas, connection-per-tenant complexity, and the contract specifies a single database. It is the right answer for a large enterprise tenant, and the wrong answer for a dev slice with one tenant.

**Event-sourced aggregates (store events, derive state).** Rejected. The UI needs current state in single-digit milliseconds across eight regions; deriving it per request is a projection pipeline that does not exist. `AuditEvent` records history alongside mutable state — history *and* state, which is what the product actually needs.

**MongoDB / document store.** Rejected. The object graph is relational and the audit trail benefits from transactional integrity. Nothing in the product wants schema flexibility.

## Open item

Whether `citext` is available on this Postgres build (it would let `User.email` be case-insensitive without a lower-cased shadow column). **Unknown — must be resolved before migration 001 is frozen.** Fallback: store `email` lower-cased at the application boundary and add a unique index on it.

## Revisit trigger

Revisit when any of these becomes true: the Overview's aggregate queries cannot be expressed without `$queryRaw` on more than two endpoints (the guarded path is being bypassed too often); a second tenant with real data volume arrives; a private/enterprise deployment requires schema-per-tenant or row-level security; or the Prisma extension demonstrably fails to cover nested writes, in which case Drizzle is the fallback and this ADR is superseded rather than patched.
