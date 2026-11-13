# ADR-005 — Tenancy and identity

Status: Accepted
Date: 2026-11-13

## Context

Two failure modes dominate multi-tenant SaaS incidents, and both are cheap to prevent at design time and expensive to fix later:

1. **A tenant identifier taken from the request body or a query parameter.** The caller controls it, so the caller chooses which tenant to read.
2. **Isolation enforced only by a route guard.** Every new controller is an opportunity to forget the decorator, and a forgotten decorator is silent.

The product also has a commercial requirement that makes this a selling point, not just hygiene: an enterprise lead must be able to see *proof* of isolation (BRIEF §2).

Contract §5 fixes: HS256 JWT, 15-minute access token, `argon2`, roles `OWNER | ADMIN | MEMBER | VIEWER`, `orgId` never from the body, `X-Org-Id` must match a membership.

One ambiguity in the contract is material and must be resolved here: identity is reachable from **three** places — the path (`/orgs/:orgId/...`), the header (`X-Org-Id`), and the token's subject's memberships. Contract §5 says all three exist but does not say which wins.

## Decision

### Resolution order (normative)

For every request under `/v1/orgs/:orgId/**`:

1. Verify the JWT. Extract `sub` (userId). Missing/expired/invalid → `401`.
2. Load the caller's memberships for `sub` (no cache in Phase 2 — see below).
3. Resolve the target org: **`data.orgId = path.orgId`**. If `X-Org-Id` is present and differs from the path, reject `400 ORG_HEADER_MISMATCH`. The header is a client convenience, never an authority.
4. If no active membership row exists for `(sub, path.orgId)` → `404 ORG_NOT_FOUND`. Deliberately not `403`: a non-member must not learn that the org exists.
5. If a membership exists but the role lacks the required capability → `403 ROLE_INSUFFICIENT`, with the required role named in the body.
6. Call the use case with `orgId` as a **function argument**, not from a request-scoped ambient value.

The path is authoritative because it is the resource being addressed, it is already in every route the contract specifies, and it is visible in access logs. The header exists only so a client can pin a "current org" across calls; treating it as authority would let a client address org A while claiming org B.

### Why `orgId` never comes from the body

A body is fully attacker-controlled and is the field most likely to be bound automatically into a DTO and then into a Prisma `where`. Even a DTO with `orgId` stripped is one refactor away from being re-added. The rule is therefore structural: **there is no `orgId` field in any request DTO.** `packages/contracts` enforces this by omission, and a lint/test asserts that no create/update schema contains `orgId`.

### Why the query layer, not only the guard

A guard answers "may this principal act on this org?" It does not answer "does this query touch only this org's rows?" Those are different questions, and the second is the one that causes leaks.

`packages/database.forTenant(orgId)` (ADR-004) injects the predicate at the client level. A controller that forgets `@UseGuards` is then still unable to read another tenant's rows — it simply has no client that can express the query. This is defence in depth with one honest gap: `$queryRaw` bypasses it, so raw SQL is confined to `packages/database`.

### Token contents

```json
{ "sub": "<userId>", "jti": "<uuid>", "iat": 0, "exp": 0 }
```

**No `orgId` and no `role` in the token.** Reasons:

- A role change or membership revocation must take effect on the next request, not after up to 15 minutes. Contract test case #7 ("expired/revoked permission is rejected") is only honestly satisfiable if membership is re-read.
- A token carrying `orgId` forces a re-issue on every org switch, which turns a UI action into an auth event.
- Claims are a cache. Caches of authorisation state are how stale permissions persist.

Cost: one membership query per request. Phase 2 accepts it. If it becomes a bottleneck, cache memberships in Redis with a 30-second TTL **and** an explicit revocation pub/sub — never a longer TTL without invalidation, because that reintroduces the staleness this decision exists to prevent.

### Password handling

`argon2id`, memory cost 19 MiB, time cost 2, parallelism 1 (OWASP baseline). Hash parameters are stored in the encoded hash string, so raising them later is a login-time rehash, not a migration. Contract permits `bcrypt` as a fallback if argon2 fails to build; if that happens it must be cost 12 **and** recorded in the status report as a deviation, because bcrypt truncates at 72 bytes.

Login responses are constant-shaped and constant-timed: unknown email and wrong password return the same `401 INVALID_CREDENTIALS`. Rate limit: 5 attempts per 15 minutes per `(email, ip)` in Redis.

### Roles

| Capability | OWNER | ADMIN | MEMBER | VIEWER |
|---|---|---|---|---|
| Read projects/tasks/artifacts | ✓ | ✓ | ✓ | ✓ |
| Create project | ✓ | ✓ | ✗ | ✗ |
| Create task, start run | ✓ | ✓ | ✓ | ✗ |
| Cancel run | ✓ | ✓ | ✓ | ✗ |
| Manage members / roles | ✓ | ✗ | ✗ | ✗ |

Static matrix in `packages/contracts`. No policy engine (see below).

## Consequences

### Positive

- Cross-tenant reads require two independent mistakes, not one.
- Revocation is immediate; there is no window in which a removed member still reads data.
- `orgId` is a required argument on every use case, so "which tenant is this?" is answered at the call site, in code, visibly.
- The three-source ambiguity is closed with a stated precedence and a specific error code.
- The permission matrix is small enough to test exhaustively.

### Negative / costs

- **One extra query per request.** At low volume this is noise; at high volume it is the first thing to optimise, and optimising it reintroduces the staleness problem.
- **No token revocation list.** A stolen token is valid for up to 15 minutes. Logout is client-side only. Acceptable for Phase 2, not for an enterprise claim of "immediate session termination".
- **No refresh token.** The operator is logged out after 15 minutes of inactivity. That is a UX cost the contract has chosen; it must be visible in the UI rather than silently redirecting.
- The static role matrix does not model per-project or per-environment grants, which `INFORMATION-ARCHITECTURE.md` §8 implies ("workspace policy forbids `prod` access for the current role"). That is a future capability and a known gap.
- `404` for non-membership means a legitimate user who mistypes an org ID gets a confusing "not found" rather than "no access". Chosen deliberately; the UI must explain it.

## Alternatives considered

**`orgId` in the JWT.** Rejected for the staleness reason above, and because it makes "switch org" a token-minting operation.

**A single `tenantId` claim plus RLS in PostgreSQL.** Genuinely stronger — the database, not the application, enforces isolation via `SET LOCAL app.tenant_id` and row-level security policies. Rejected for Phase 2 because Prisma's connection pooling makes `SET LOCAL` per-request fragile (a pooled connection can leak session state), and because it requires a second policy language the team must maintain in parallel with the Prisma extension. This is the correct end state for an enterprise/private deployment; it should supersede this ADR when connection handling is settled.

**A policy engine (OPA/Cedar) for authorisation.** Rejected. Four roles and five capabilities do not justify a policy language, a sidecar, and a decision cache. The static matrix is auditable in a code review, which is the property that matters.

**Session cookies with server-side sessions instead of JWT.** Rejected by contract; also would require a session store and CSRF handling. Worth revisiting if the product ever needs instant global logout.

## Open item

`INFORMATION-ARCHITECTURE.md` §1 models scope as **Tenant → Workspace → Project → Environment**. Contract §5–6 models **Organization → Project** with no workspace level, and no environment column on any entity. These are not the same model, and the difference is not cosmetic: the IA's URL scheme is `/{workspace}/{module}`, and an agency persona runs one workspace per client.

**Unknown — must be resolved by the Leader before the web routing unit (E1) starts.** Options: (a) treat `Organization` as the IA's workspace and drop the tenant level for private deployments; (b) add a `Workspace` table between org and project in Phase 2; (c) ship Phase 2 with Organization-as-workspace and record the collapse as a known limitation. Option (c) is the smallest correct step for the slice, but it contradicts the IA and must be an explicit decision, not a drift.

## Revisit trigger

Revisit when any of these becomes true: SSO/OIDC or SCIM provisioning is required (the token shape and the identity provider both change); the IA's per-environment permission rule (`prod` restricted by role) must be enforced, which needs a grant model finer than the four-role matrix; the membership read becomes a measurable bottleneck; or the workspace level is resolved in favour of a real `Workspace` entity, at which point the URL scheme, the header, and the claim resolution all change together.
