# Security results

> Phase 2 security review and remediation record, 2026-11-13.
> Scope: the local build in `/home/ubuntu/intelligenz`, API on `:4100`, web on `:3100`.
>
> This document separates three kinds of statement:
> **reported** by the security review, **verified** by a command in this session, and
> **not verified**. Nothing reported is promoted to verified without its own evidence.

---

## 1. Verdict

The Phase 2 security review graded the build **FAIL**. One **Critical** finding and
five further findings were fixed before this record was written.

| # | Finding | Severity | State |
|---:|---|---|---|
| 1 | The published `JWT_SECRET` placeholder signed tokens the live API accepted as `OWNER` | Critical | **FIXED**, rejection verified |
| 2 | Tokens without `exp`, `iat` or `sub` were accepted | High | **FIXED**, verified by tests |
| 3 | A `MEMBER` could fabricate a `succeeded` task through four `PATCH` calls | High | **FIXED**, verified by unit and E2E tests |
| 4 | No security headers on the API or the web app | Medium | **FIXED**, verified by live response headers |
| 5 | Unlimited login attempts | Medium | **FIXED** in-process; `PARTIAL` for multiple replicas |
| 6 | Every unauthenticated readiness request opened a Temporal connection and a Postgres query | Medium | **FIXED**, verified by tests and live `ageMs` |

Open findings are in §6. They are not counted as fixed.

---

## 2. The Critical finding: a public signing key

### 2.1 What shipped

At commit `d75f988`, `.env.example` contained:

```text
JWT_SECRET=replace-me-with-openssl-rand-hex-32
```

Verified with:

```bash
git show HEAD:.env.example | grep -n JWT_SECRET
# 45:JWT_SECRET=replace-me-with-openssl-rand-hex-32
```

The value is 35 characters. It passed a `length >= 32` check. It was published in the
repository, so it was not a secret in any sense.

### 2.2 What the review found

The live API accepted an HS256 token signed with that published value. The token
claimed an existing user id and was treated as that user, with that user’s `OWNER`
role. No password was involved, and the token did not need an expiry claim the service
would enforce.

This is a complete authentication bypass. Anyone able to read the repository could mint
a token for any user whose id they could guess or obtain, including an owner. The API
did not distinguish a forged token from a real one because the signature was valid: it
was signed with the key the service trusted.

### 2.3 Why the length check did not help

A length check answers “is this string long enough to be a key”, not “is this string
secret”. A published 35-character placeholder is long enough and worth nothing. The
current validator says this in code:

> the 35-character placeholder this repository published in `.env.example` passed a
> `length >= 32` test and was used to forge an `OWNER` token against the running API.

### 2.4 Reproduction and re-verification

- The review reproduced the forgery against the running API. That reproduction is
  **reported** here, not re-run: the vulnerable configuration no longer boots.
- The fix was independently re-verified. A token signed with the same published value,
  carrying a UUID `sub`, `iat` and `exp`, now returns `401`. The token was built with
  Node’s HMAC, not with a library:

```js
const crypto = require('node:crypto');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const header = b64({ alg: 'HS256', typ: 'JWT' });
const payload = b64({
  sub: '00000000-0000-4000-8000-000000000001',
  email: 'owner@northwind.test',
  iat: now,
  exp: now + 900,
});
const signature = crypto
  .createHmac('sha256', 'replace-me-with-openssl-rand-hex-32')
  .update(`${header}.${payload}`)
  .digest('base64url');
console.log(`${header}.${payload}.${signature}`);
```

```bash
# token signed with "replace-me-with-openssl-rand-hex-32"
curl -s -o body.txt -w "HTTP %{http_code}\n" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Org-Id: 00000000-0000-4000-8000-000000000002" \
  http://localhost:4100/v1/orgs
```

```text
HTTP 401
{"error":{"code":"UNAUTHORIZED","message":"The access token is missing, invalid or expired."},"correlationId":"7de5a380-071c-4d30-8182-10d53320436f"}
```

### 2.5 The fix

1. **Key rotation.** The signing key was rotated. The API no longer accepts a token
   signed with the published value. `.env` is gitignored and has mode `600`.
2. **Placeholder denylist.** `describeJwtSecretProblem` rejects the old placeholder,
   `REPLACE_ME`, `replace_me`, `changeme`, `change-me`, `change_me`, `secret`, `test`,
   `testing`, `development`, `password`, `your-secret-here` and `your_secret_here`.
3. **Entropy proxy.** It rejects a single repeated character, a repeated weak word
   (`secret-secret-…`), a key shorter than 32 characters, and a key that is neither
   64+ hex characters nor at least three of lowercase/uppercase/digit/symbol.
4. **Boot failure, not a fallback.** There is no default. `main.ts` exits non-zero
   before `listen` when the key is absent or unacceptable.
5. **The template cannot boot.** `.env.example` now contains `JWT_SECRET=REPLACE_ME`.
   Copying it verbatim fails with an explicit message. Verified:

```text
describeJwtSecretProblem('REPLACE_ME') => is a placeholder from .env.example, not a generated key
describeJwtSecretProblem('replace-me-with-openssl-rand-hex-32') => is a placeholder from .env.example, not a generated key
```

**15 tests** cover this validator in `apps/api/test/jwt-secret-config.test.ts`.

### 2.6 Residual risk in the fix

The key is a static value in a local `.env`. There is no secret manager, no rotation
schedule, no KMS, and no audit of who read the file. Rotation is a manual edit and a
restart. That is acceptable for a local slice and not acceptable for a shared
environment.

---

## 3. Token claims

Before the fix, the verifier checked the signature and, when present, `exp`. A
correctly signed token without `exp` never expired. A token without `iat` defeated
`maxAge`. A token without `sub` had no user to authenticate.

The current guard:

- Pins `algorithms: ['HS256']`. An `alg: none` token cannot pass.
- Sets `maxAge` to the 900-second TTL, computed from `iat`.
- Parses the payload with a Zod schema that makes `sub`, `email`, `iat` and `exp`
  required. A missing claim fails `safeParse` and returns `401`.
- Requires `sub` to be a UUID.
- Returns one message for expired, malformed and wrong-signature tokens. The message
  does not tell an attacker which part was closest.

Verified by 7 tests in `apps/api/test/jwt-auth-claims.test.ts`, including:

- “rejects a correctly signed token with no exp claim”
- “rejects a correctly signed token with no iat claim”
- “rejects a correctly signed token with no sub claim”
- “rejects a token whose iat is older than the 900s TTL even with a far-future exp”
- “rejects a token signed with a different key”

**Revocation** is not a token blacklist. `OrgScopeGuard` re-reads role and membership
from the database on every request, so removing a membership should revoke access on
the next call even with an unexpired token. No test exercises that deletion; the gap is
recorded in `TEST-RESULTS.md` §3, case 7.

---

## 4. Human versus system transitions

### 4.1 The fabrication path

The task state machine is:

```text
draft → ready → queued → running → verifying → succeeded | failed | blocked | cancelled
```

It answers “may the task reach this state”, not “may this caller put it there”. Before
the split, a `MEMBER` could send four `PATCH` requests:

```text
ready → queued → running → verifying → succeeded
```

and produce a terminal success with no `WorkflowRun`, no `AgentRun`, no artifact and no
execution. The audit trail would show a success that never happened.

### 4.2 The fix

`PATCH` may drive only the edges a human owns:

| Edge | `PATCH` |
|---|---|
| `draft → ready` | allowed |
| `blocked → ready` (with `reason`) | allowed |
| `ready → queued` | `409 TRANSITION_IS_SYSTEM_MANAGED` — use `POST /run` |
| `queued → running` | `409 TRANSITION_IS_SYSTEM_MANAGED` |
| `running → verifying` | `409 TRANSITION_IS_SYSTEM_MANAGED` |
| `verifying → succeeded` | `409 TRANSITION_IS_SYSTEM_MANAGED` |
| `verifying → failed` | `409 TRANSITION_IS_SYSTEM_MANAGED` |
| `running → failed` | `409 TRANSITION_IS_SYSTEM_MANAGED` |
| `queued/running → cancelled` | refused here — use `POST /cancel` |

The worker performs execution edges. A task with no workflow run cannot reach
`succeeded` through the API.

### 4.3 Verification

- 16 tests in `apps/api/test/task-transitions.test.ts`, including “refuses the four-call
  path at the second call and leaves the task non-terminal”.
- 2 E2E tests in `apps/api/test/tasks.e2e-spec.ts`: “refuses a user-driven fabrication
  path at the second call and leaves the task non-terminal” and “refuses every
  execution edge on a task that is in that state (409, not 422)”.
- The refusal is `409`, not `422`: the edge exists in the machine; the caller is not
  allowed to drive it. `422` is reserved for edges the machine does not have.

---

## 5. The other fixed findings

### 5.1 Security headers

**API** — verified live on a `401` response:

```text
HTTP/1.1 401 Unauthorized
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Cross-Origin-Resource-Policy: same-site
Content-Security-Policy: default-src 'none'; frame-ancestors 'none'
```

`X-Powered-By` is removed in `app.factory.ts`. The middleware is registered before
every other stage, so the exception filter’s responses carry the headers too.

What each prevents:

- `nosniff`: a JSON body containing user-controlled text cannot be re-interpreted as
  HTML by a legacy client.
- `X-Frame-Options: DENY` and `frame-ancestors 'none'`: no page can frame an API
  response and turn content sniffing into a click target.
- `Referrer-Policy`: API URLs contain organisation and task ids; a link followed from
  an error page must not leak the path to a third party.
- `Cross-Origin-Resource-Policy: same-site`: another site cannot embed the response.
  CORS blocks reading; CORP blocks the request being usable at all.
- API CSP: if a proxy ever serves an API error page as `text/html`, it has no scripts,
  no framing and no default sources.

**Web** — verified live on `/login`:

```text
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' http://localhost:4100; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
Strict-Transport-Security: max-age=63072000; includeSubDomains
```

Two CSP directives are deliberately loose and documented in `next.config.ts`:
`script-src 'unsafe-inline'` because Next injects the RSC flight payload inline, and
`style-src 'unsafe-inline'` because React writes style attributes. Without them the
page does not hydrate or render. This weakens CSP as an XSS mitigation; it does not
make XSS harmless, because `connect-src` is restricted and there is no `unsafe-eval` in
production.

`Strict-Transport-Security` is sent over plain HTTP in this build, where it has no
effect. It becomes meaningful only behind TLS.

### 5.2 Login rate limiting

- 5 attempts per 15 minutes per `(ip, email)`.
- The sixth returns `429 RATE_LIMITED` with `Retry-After`.
- The limiter runs before the password check, and the refusal is identical for a known
  and an unknown email. It is not an account-existence oracle.
- A successful sign-in clears the counter.
- A refused attempt does not extend the window.
- The tracked-pair map is bounded at 10,000 entries, so an attacker cannot choose how
  much memory the process holds.

Verified by 11 tests in `apps/api/test/login-rate-limit.test.ts`.

What it prevents: unlimited password guessing and the argon2 CPU cost that comes with
it. What it does not: a distributed attack across many addresses, or a second API
replica. The window is in-process. The effective limit is `replicas × 5`.

### 5.3 Readiness probe caching

`GET /health/ready` is unauthenticated. Before the cache, every request opened a
Temporal connection and ran a Postgres query. That is an amplification surface: one
cheap request causes two dependency round trips.

The current route:

- Caches the document for 2 seconds on a monotonic clock.
- Collapses concurrent misses into one probe.
- Keeps a cached `not_ready` as `503`.
- Reports `ageMs` so a caller can see the document’s age.

Verified live on three consecutive requests:

```text
status=ready ageMs=0
status=ready ageMs=21
status=ready ageMs=46
```

And by 7 tests in `apps/api/test/readiness-cache.test.ts`.

---

## 6. Findings deliberately not fixed

Each of these is recorded in `docs/decisions/OPEN-DECISIONS.md` with a recommendation
and an owner. None is a silent omission.

### 6.1 Separation of duties on approvals — `OPEN`

**What happens.** An `ADMIN` who creates a `CRITICAL` task can approve their own
request and run it. The decision endpoint requires `ADMIN` or higher but does not
compare `requestedById` with the deciding user. An `APPROVED` row is also a standing
authorisation: it authorises every future run of that task, not one run.

**Why it was not patched.** Both halves are legitimate designs. Refusing self-approval
is normal “four eyes” control, but it can deadlock an organisation whose only admin is
the person doing the work. Per-run approval changes the data model and the retry
workflow. This is a product policy decision, not an engineering call.

**What would unblock it.** Option B in `OPEN-DECISIONS.md`: refuse self-approval with
`409 SELF_APPROVAL_FORBIDDEN`, with an escape hatch for a one-admin organisation. Then
option C when retries become common: `ApprovalRequest.consumedByRunId`.

### 6.2 Artifact `uri` disclosure — `OPEN`

**What happens.** `GET /v1/orgs/:orgId/tasks/:taskId` returns `artifacts[].uri`, which
is an absolute path under `ARTIFACT_ROOT`. Any `MEMBER` can read it. The path discloses
the host layout and the artifact root. The bytes are not fetchable through the API, so
this is disclosure, not access.

**Why it was not patched.** The UI uses the field for provenance. Removing it would
break the design requirement, and normalising it to a storage-relative key is a
storage-interface change that belongs with the object-store work.

**What would unblock it.** Return a storage-relative key, and serve bytes through a
signed URL endpoint when artifact download exists.

### 6.3 Audit append-only by convention — `OPEN`

**What happens.** `AuditEvent` has no `updatedAt`. API writes go through `AuditService`;
the worker writes through `emitEventActivity`. Both validate the event envelope, but
there are two writers, and nothing in the database prevents `UPDATE` or `DELETE`.
Verified:

```sql
select privilege_type from information_schema.table_privileges
where grantee = 'intelligenz' and table_name = 'AuditEvent';
```

```text
DELETE
INSERT
REFERENCES
SELECT
TRIGGER
TRUNCATE
UPDATE
```

The application role can rewrite history. The audit trail is evidence, not proof.

**Why it was not patched.** The fix is a grant change plus a `BEFORE UPDATE OR DELETE`
trigger: an infrastructure and migration change with a maintenance window. Bolting it
onto an application unit would leave the role still able to write.

**What would unblock it.** Revoke `UPDATE`, `DELETE` and `TRUNCATE` from the
application role; add a trigger that raises; give the application a separate role that
can only `INSERT` and `SELECT` on this table. Record the migration in the deployment
runbook.

### 6.4 Transitive dependency advisories — `OPEN`

`pnpm audit --audit-level high` exits `1` with 2 high and 4 moderate advisories, plus
one low. All are transitive build tooling. None is reachable from request handling:

| Severity | Package | Vulnerable | Patched | Path | Advisory |
|---|---|---|---|---|---|
| high | `postcss` | `<=8.5.11` | `>=8.5.12` | `apps/web > next > postcss` | GHSA-6g55-p6wh-862q |
| high | `postcss` | `<=8.5.17` | `>=8.5.18` | `apps/web > next > postcss` | GHSA-r28c-9q8g-f849 |
| moderate | `postcss` | `<8.5.10` | `>=8.5.10` | `apps/web > next > postcss` | GHSA-qx2v-qp2m-jg93 |
| moderate | `postcss` | `<=8.5.22` | `>=8.5.23` | `apps/web > next > postcss` | GHSA-fxqj-rqcc-2cmp |
| moderate | `glob` | `>=9.0.0 <=14.0.1` | `>=14.0.2` | `apps/api > @nestjs/cli > glob` | GHSA-3g3m-2fjr-6pw4 |
| moderate | `minimatch` | `>=7.0.0 <11.0.1` | `>=11.0.1` | `. > typescript-eslint > … > minimatch` | GHSA-g3hv-75wg-m249 |
| low | `deepmerge` | `>=4.2.0 <=4.3.1` | `<0.0.0` (no fix) | `apps/api > @nestjs/cli > … > deepmerge` | GHSA-gcqx-w48m-w2h4 |

The vulnerable `postcss` is the copy nested inside `next@15.5.29` (`8.4.31`).
`apps/web`’s direct `postcss` is `8.5.32`, which is patched. A blanket
`pnpm.overrides` pin would replace a known advisory with an untested resolution and
could break the Next build.

**Why it was not patched.** The fix is a Next.js and ESLint upgrade, with its own
regression surface. It should ride with the next framework bump, not with a security
patch that has no runtime exposure.

**What would unblock it.** Upgrade `next` to a release that pins `postcss >=8.5.18`
and `@nestjs/cli`/`typescript-eslint` to versions with patched `glob`/`minimatch`, then
re-run the build and E2E suite. Track the advisories until then.

### 6.5 `Cache-Control` on authenticated responses — `OPEN`

No API middleware sets `Cache-Control`. The checked responses (`/health`,
`/health/ready`, a `401` on `/v1/orgs`) carry none. There is no shared cache in front
of the API today, so nothing stores them. If a CDN or reverse proxy is placed in front
without `Vary: Authorization` or `Cache-Control: private, no-store`, a `GET /v1/orgs`
response could be served to another tenant.

**Why it was not patched.** Adding `no-store` now would disable caching for a future
endpoint that legitimately wants it, and the current topology has no cache to defeat.

**What would unblock it.** Set `Cache-Control: no-store` on every authenticated
response in the same middleware as the security headers, or prove the proxy never
caches.

### 6.6 Token in `sessionStorage` — accepted trade-off

The access token is held in memory and mirrored to `sessionStorage`. It is readable by
any script that achieves XSS in the origin. An `httpOnly` cookie is not.

The alternative requires a same-origin backend-for-frontend to hold the cookie and
translate it into the `Authorization` header, because the API authenticates with a
bearer token and defines no cookie auth. Phase 2 has no BFF.

Mitigations: `sessionStorage` rather than `localStorage` (dies with the tab), a
15-minute TTL with no refresh endpoint, and a strict CSP. The trade-off is documented in
`apps/web/src/lib/session.ts`.

### 6.7 CI’s `JWT_SECRET` is rejected by the hardened validator

`.github/workflows/ci.yml` sets `JWT_SECRET: ci-placeholder-not-a-real-secret`. The
hardened validator rejects it:

```text
describeJwtSecretProblem('ci-placeholder-not-a-real-secret')
=> does not contain enough entropy (use 64+ hex characters, or mix three of lowercase, uppercase, digit and symbol)
```

No CI run has been observed, so this has not failed a pipeline. If the workflow is ever
extended to boot the API or run the API E2E suite, it will fail at configuration load.
The value must become a CI-only generated secret, or the workflow must not boot the API.

**Why it was not fixed.** `.github/workflows/ci.yml` is outside this unit’s file scope
and CI is `BLOCKED` on a remote and a credential. It is recorded here so the first
person to enable CI does not debug a mystery boot failure.

---

## 7. Dependency audit — literal result

```bash
pnpm audit --audit-level high
```

Exit code: `1`.

```text
┌─────────────────────┬────────────────────────────────────────────────────────┐
│ high                │ PostCSS: Arbitrary file read and information           │
│                     │ disclosure via attacker-controlled sourceMappingURL in │
│                     │ CSS comments                                           │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Package             │ postcss                                                │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Vulnerable versions │ <=8.5.11                                               │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Patched versions    │ >=8.5.12                                               │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Paths               │ apps__web>next>postcss                                 │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-6g55-p6wh-862q      │
└─────────────────────┴────────────────────────────────────────────────────────┘
┌─────────────────────┬────────────────────────────────────────────────────────┐
│ high                │ PostCSS: Path Traversal in Previous Source Map         │
│                     │ Auto-Loading (sourceMappingURL) leads to Arbitrary     │
│                     │ .map File Disclosure                                   │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Package             │ postcss                                                │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Vulnerable versions │ <=8.5.17                                               │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Patched versions    │ >=8.5.18                                               │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Paths               │ apps__web>next>postcss                                 │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-r28c-9q8g-f849      │
└─────────────────────┴────────────────────────────────────────────────────────┘
7 vulnerabilities found
Severity: 1 low | 4 moderate | 2 high
```

The command reports seven advisories. It does not report zero. Anyone claiming this
build is dependency-clean is wrong.

---

## 8. Residual risk

The build is materially safer than the one that graded FAIL. It is still a local
development slice with these open risks.

**Transport.** No TLS anywhere. Passwords and bearer tokens cross `localhost` in
cleartext. On a shared network, a bearer token is replayable for its 15-minute lifetime.
The web app sends HSTS, but over HTTP it does nothing.

**Edge.** No WAF, no reverse proxy, no DDoS protection, no global rate limit. The login
limiter is per-process and resets on restart. Readiness is cached but still cheap to
call.

**Secrets.** One static signing key in a local `.env` with mode `600`. No secret
manager, no rotation, no access audit, no separation between environments. The CI
workflow’s placeholder is invalid under the hardened validator.

**Audit integrity.** The application role can `UPDATE` and `DELETE` audit rows. A
compromised API process can erase its own trail.

**Authorisation.** Self-approval of a critical task by the same admin who created it is
allowed. A standing approval authorises future runs. The control is weaker than the
approvals queue implies.

**Disclosure.** Artifact paths are returned to any member. The path names the host
layout and the artifact root.

**Dependencies.** Seven advisories, two high, in build tooling. No runtime exposure
identified, but the build is not clean.

**Detection.** No monitoring, no alerting, no log aggregation. A forged-token attempt
produces a `401` line on stdout that nobody collects. A successful forgery would produce
normal `200` lines.

**Isolation evidence.** Tenant isolation is proven against a two-organisation test
database, not against the single-organisation development database. A live two-tenant
exercise has not been run.

**Assurance.** No penetration test, no SAST, no DAST, no dependency policy, no security
regression suite. The tests listed above are the whole assurance surface.

### What a production deployment would still require

1. TLS termination with HSTS, and no plaintext listener.
2. A secret manager with rotation, separate credentials per environment, and no
   long-lived signing key in a file.
3. A shared rate-limit store (Redis or the edge) so the limit is not per-replica.
4. A reverse proxy or WAF with request limits, and `Cache-Control: no-store` on
   authenticated responses.
5. Audit immutability at the database grant and trigger level.
6. Separation of duties on approvals, or an explicit product decision that self-approval
   is accepted.
7. Artifact storage behind signed URLs, with storage-relative keys.
8. Dependency upgrades that clear the high advisories, plus a CI policy that fails on
   new high findings.
9. Log aggregation, metrics, alerting on authentication failures and approval
   anomalies.
10. A two-tenant live exercise, a screen-reader review, and an external penetration
    test before handling real data.

---

## 9. Method and limits of this record

- The original forgery was performed by the security review against the vulnerable
  build. It is reported, not re-run here.
- The fixed build was probed in this session: the same forged token returns `401`, the
  headers are present, and the readiness cache reports `ageMs`.
- The validator behaviour was executed directly through
  `describeJwtSecretProblem`, not inferred from the source.
- The audit was run with `pnpm audit --audit-level high` on 2026-11-13. Its exit code
  was `1`.
- No SAST, DAST, container scan, secret scan or penetration test was run. Their absence
  is a limit of this record, not a clean result.
