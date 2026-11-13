# Test results

> Run 2026-11-13 on the working tree at `/home/ubuntu/intelligenz`.
> Host: Node `v22.23.2`, pnpm `10.15.1`, PostgreSQL `18.6`, Temporal CLI `1.10.0`
> (server `1.32.2`), Chromium via Playwright `1.65.0`.
>
> Every block below is output from the command above it. Where output is trimmed,
> the trim is stated. Exit codes are the command’s own, captured with `$?`.

---

## 1. Gate results

### 1.1 Typecheck

```bash
pnpm -w typecheck
```

Exit code: `0`.

```text
Scope: 7 of 8 workspace projects
packages/agent-runtime typecheck$ tsc --noEmit -p tsconfig.json
packages/contracts typecheck$ tsc --noEmit -p tsconfig.json
packages/database typecheck$ prisma generate && tsc --noEmit -p tsconfig.json
packages/design-system typecheck$ tsc --noEmit -p tsconfig.json
packages/database typecheck: Loaded Prisma config from prisma.config.ts.
packages/database typecheck: Prisma schema loaded from prisma/schema.prisma.
packages/contracts typecheck: Done
packages/agent-runtime typecheck: Done
packages/database typecheck: ✔ Generated Prisma Client (7.10.1) to ./generated/prisma in 754ms
packages/design-system typecheck: Done
packages/database typecheck: Done
apps/api typecheck$ tsc --noEmit -p tsconfig.json
apps/web typecheck$ tsc --noEmit -p tsconfig.json
apps/worker typecheck$ tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.test.json
apps/web typecheck: Done
apps/api typecheck: Done
apps/worker typecheck: Done
```

### 1.2 Lint

```bash
pnpm -w lint
```

Exit code: `0`.

```text
> intelligenz@0.0.0 lint /home/ubuntu/intelligenz
> eslint . --max-warnings=0
```

No warnings, no errors, no output beyond the command echo.

### 1.3 Unit and integration tests

```bash
pnpm -w test
```

Exit code: `0`.

```text
 RUN  v5.1.0 /home/ubuntu/intelligenz

 Test Files  22 passed (22)
      Tests  239 passed (239)
   Duration  6.69s (tests 49%, import 45%, transform 4%, worker 1%)
```

`pnpm -w test` collects `apps/**/*.{test,spec}.ts` and `packages/**/*.{test,spec}.ts`.
It does not collect `apps/web/e2e/*.e2e.ts` or `apps/api/test/*.e2e-spec.ts`; those run
under the two commands below.

### 1.4 API E2E (Supertest, real PostgreSQL, real Temporal when reachable)

```bash
pnpm --filter @intelligenz/api test:e2e
```

Exit code: `0`.

```text
 RUN  v5.1.0 /home/ubuntu/intelligenz/apps/api

 Test Files  3 passed (3)
      Tests  42 passed (42)
   Duration  9.47s (tests 79%, import 19%, transform 1%)
```

The suite runs against `intelligenz_test`, not `intelligenz_dev`. A guard in
`apps/api/test/helpers/env.ts` refuses a database whose name does not end in `_test`.
Two orchestrator-unavailable tests wait for a 2-second probe timeout each; they are
the reason the suite takes ~9 seconds.

### 1.5 Web E2E (Playwright, Chromium, live API)

```bash
pnpm --filter @intelligenz/web test:e2e
```

Exit code: `0`.

```text
Running 36 tests using 1 worker

  ✓   1 [chromium-1440] › e2e/auth.e2e.ts:10:3 › authentication › an unauthenticated deep link to Overview is redirected to the login form (399ms)
  ✓   2 [chromium-1440] › e2e/auth.e2e.ts:27:3 › authentication › valid credentials reach the Overview, which has exactly one h1 reading "Overview" (554ms)
  ✓   3 [chromium-1440] › e2e/auth.e2e.ts:43:3 › authentication › a rejected sign-in stays on /login and never discloses whether the email exists (452ms)
  ✓   4 [chromium-1440] › e2e/keyboard.e2e.ts:9:1 › the first Tab reaches the skip link, which moves focus into main (698ms)
  ✓   5 [chromium-1440] › e2e/navigation.e2e.ts:9:1 › Approvals in the primary navigation routes to the module and names it (635ms)
  ✓   6 [chromium-1440] › e2e/overview.e2e.ts:15:3 › Overview › Task queues renders rows whose values come from the API (658ms)
  ✓   7 [chromium-1440] › e2e/overview.e2e.ts:80:3 › Overview › regions with no source say "Not instrumented" instead of inventing data (565ms)
  ✓   8 [chromium-1440] › e2e/overview.e2e.ts:93:3 › Overview › every piece of page content sits inside a landmark (683ms)
  -   9 [chromium-1440] › e2e/responsive.e2e.ts:12:1 › Overview does not scroll horizontally at 390px
  ✓  10 [chromium-1024] › e2e/auth.e2e.ts:10:3 › authentication › an unauthenticated deep link to Overview is redirected to the login form (410ms)
  ✓  11 [chromium-1024] › e2e/auth.e2e.ts:27:3 › authentication › valid credentials reach the Overview, which has exactly one h1 reading "Overview" (465ms)
  ✓  12 [chromium-1024] › e2e/auth.e2e.ts:43:3 › authentication › a rejected sign-in stays on /login and never discloses whether the email exists (426ms)
  ✓  13 [chromium-1024] › e2e/keyboard.e2e.ts:9:1 › the first Tab reaches the skip link, which moves focus into main (725ms)
  ✓  14 [chromium-1024] › e2e/navigation.e2e.ts:9:1 › Approvals in the primary navigation routes to the module and names it (708ms)
  ✓  15 [chromium-1024] › e2e/overview.e2e.ts:15:3 › Overview › Task queues renders rows whose values come from the API (626ms)
  ✓  16 [chromium-1024] › e2e/overview.e2e.ts:80:3 › Overview › regions with no source say "Not instrumented" instead of inventing data (581ms)
  ✓  17 [chromium-1024] › e2e/overview.e2e.ts:93:3 › Overview › every piece of page content sits inside a landmark (683ms)
  -  18 [chromium-1024] › e2e/responsive.e2e.ts:12:1 › Overview does not scroll horizontally at 390px
  ✓  19 [chromium-768] › e2e/auth.e2e.ts:10:3 › authentication › an unauthenticated deep link to Overview is redirected to the login form (386ms)
  ✓  20 [chromium-768] › e2e/auth.e2e.ts:27:3 › authentication › valid credentials reach the Overview, which has exactly one h1 reading "Overview" (484ms)
  ✓  21 [chromium-768] › e2e/auth.e2e.ts:43:3 › authentication › a rejected sign-in stays on /login and never discloses whether the email exists (411ms)
  ✓  22 [chromium-768] › e2e/keyboard.e2e.ts:9:1 › the first Tab reaches the skip link, which moves focus into main (546ms)
  ✓  23 [chromium-768] › e2e/navigation.e2e.ts:9:1 › Approvals in the primary navigation routes to the module and names it (544ms)
  ✓  24 [chromium-768] › e2e/overview.e2e.ts:15:3 › Overview › Task queues renders rows whose values come from the API (712ms)
  ✓  25 [chromium-768] › e2e/overview.e2e.ts:80:3 › Overview › regions with no source say "Not instrumented" instead of inventing data (526ms)
  ✓  26 [chromium-768] › e2e/overview.e2e.ts:93:3 › Overview › every piece of page content sits inside a landmark (523ms)
  -  27 [chromium-768] › e2e/responsive.e2e.ts:12:1 › Overview does not scroll horizontally at 390px
  ✓  28 [chromium-390] › e2e/auth.e2e.ts:10:3 › authentication › an unauthenticated deep link to Overview is redirected to the login form (439ms)
  ✓  29 [chromium-390] › e2e/auth.e2e.ts:27:3 › authentication › valid credentials reach the Overview, which has exactly one h1 reading "Overview" (497ms)
  ✓  30 [chromium-390] › e2e/auth.e2e.ts:43:3 › authentication › a rejected sign-in stays on /login and never discloses whether the email exists (403ms)
  ✓  31 [chromium-390] › e2e/keyboard.e2e.ts:9:1 › the first Tab reaches the skip link, which moves focus into main (505ms)
  ✓  32 [chromium-390] › e2e/navigation.e2e.ts:9:1 › Approvals in the primary navigation routes to the module and names it (914ms)
  ✓  33 [chromium-390] › e2e/overview.e2e.ts:15:3 › Overview › Task queues renders rows whose values come from the API (734ms)
  ✓  34 [chromium-390] › e2e/overview.e2e.ts:80:3 › Overview › regions with no source say "Not instrumented" instead of inventing data (484ms)
  ✓  35 [chromium-390] › e2e/overview.e2e.ts:93:3 › Overview › every piece of page content sits inside a landmark (549ms)
  ✓  36 [chromium-390] › e2e/responsive.e2e.ts:12:1 › Overview does not scroll horizontally at 390px (536ms)

  3 skipped
  33 passed (20.5s)
```

The three skips are one test, excluded from the 1440, 1024 and 768 projects by its own
`test.skip` guard. It runs at 390 px.

### 1.6 Build

```bash
pnpm -w build
```

Exit code: `0`.

```text
Scope: 7 of 8 workspace projects
apps/api build$ tsc --noEmit -p tsconfig.json
apps/web build$ next build
apps/worker build$ tsc --noEmit -p tsconfig.json
apps/web build:    ▲ Next.js 15.5.29
apps/web build:    Creating an optimized production build ...
apps/worker build: Done
apps/api build: Done
apps/web build:  ✓ Compiled successfully in 5.0s
apps/web build:    Skipping linting
apps/web build:    Checking validity of types ...
apps/web build:    Collecting page data ...
apps/web build:    Generating static pages (0/5) ...
apps/web build:    Generating static pages (1/5)
apps/web build:    Generating static pages (2/5)
apps/web build:    Generating static pages (3/5)
apps/web build:  ✓ Generating static pages (5/5)
apps/web build:    Finalizing page optimization ...
apps/web build:    Collecting build traces ...
apps/web build:    Route (app)                                 Size  First Load JS
apps/web build:    ┌ ○ /                                    1.09 kB         104 kB
apps/web build:    ├ ○ /_not-found                            123 B         103 kB
apps/web build:    ├ ƒ /[workspace]/[module]                  175 B         109 kB
apps/web build:    ├ ƒ /[workspace]/overview                11.2 kB         121 kB
apps/web build:    └ ƒ /login                               2.77 kB         112 kB
apps/web build:    + First Load JS shared by all             102 kB
apps/web build:      ├ chunks/488-b30401f8c5fd1fb7.js       46.3 kB
apps/web build:      ├ chunks/81fe6b28-18add7b20a4cb568.js  54.2 kB
apps/web build:      └ other shared chunks (total)          1.93 kB
apps/web build:    ○  (Static)   prerendered as static content
apps/web build:    ƒ  (Dynamic)  server-rendered on demand
apps/web build: Done
```

`next build` skips ESLint because `eslint.ignoreDuringBuilds` is true. Lint is a
separate gate (`pnpm -w lint`), run above. Type checking during build is still on.

---

## 2. Test inventory

| File | Tests | Kind |
|---|---:|---|
| `packages/contracts/src/dto.test.ts` | 25 | Unit |
| `packages/contracts/src/event-envelope.test.ts` | 12 | Unit |
| `packages/contracts/src/task-state-machine.test.ts` | 10 | Unit |
| `packages/database/test/seed.test.ts` | 7 | Integration (PostgreSQL) |
| `packages/database/test/tenant-scoping.test.ts` | 3 | Integration (PostgreSQL) |
| `packages/database/test/idempotency.test.ts` | 2 | Integration (PostgreSQL) |
| `packages/agent-runtime/test/local-simulated.test.ts` | 20 | Unit + filesystem |
| `apps/worker/test/contract.test.ts` | 5 | Unit |
| `apps/worker/test/ids.test.ts` | 6 | Unit |
| `apps/worker/test/config.test.ts` | 7 | Unit |
| `apps/api/test/jwt-secret-config.test.ts` | 15 | Unit |
| `apps/api/test/jwt-auth-claims.test.ts` | 7 | Unit |
| `apps/api/test/login-rate-limit.test.ts` | 11 | Unit |
| `apps/api/test/readiness-cache.test.ts` | 7 | Unit |
| `apps/api/test/task-transitions.test.ts` | 16 | Unit |
| `apps/api/test/orchestrator-retry-options.test.ts` | 3 | Unit |
| `apps/api/test/auth-tenancy.e2e-spec.ts` | 18 | E2E (Supertest + PostgreSQL) |
| `apps/api/test/tasks.e2e-spec.ts` | 20 | E2E (Supertest + PostgreSQL + Temporal) |
| `apps/api/test/health.e2e-spec.ts` | 4 | E2E (Supertest + PostgreSQL + Temporal) |
| `apps/web/src/lib/api.test.ts` | 12 | Unit |
| `apps/web/src/lib/overview.test.ts` | 22 | Unit |
| `packages/design-system/src/lib/format.test.ts` | 23 | Unit |
| `packages/design-system/src/lib/status.test.ts` | 6 | Unit |
| `packages/design-system/src/lib/sort.test.ts` | 13 | Unit |
| `packages/design-system/src/lib/runtime.test.ts` | 7 | Unit |
| `apps/web/e2e/{auth,keyboard,navigation,overview,responsive}.e2e.ts` | 36 collected, 33 executed | E2E (Playwright) |

Totals: 239 unit/integration, 42 API E2E, 36 web E2E collected.

---

## 3. Contract §12 test-case mapping

Contract §12 enumerates **ten** required cases. The delegation brief says twelve. No
eleventh or twelfth case appears in the contract or in
`docs/engineering/IMPLEMENTATION-PLAN.md` §4. Ten are mapped below. None was invented.

| # | Required case | Test that covers it | Status |
|---:|---|---|---|
| 1 | Unauthorized user cannot access protected project data | `apps/api/test/auth-tenancy.e2e-spec.ts` › `authentication` › “rejects a protected route with no token (401)”; `organisation scoping` › “rejects a request without X-Org-Id (403)” | `VERIFIED` |
| 2 | Tenant A cannot read tenant B records | `apps/api/test/auth-tenancy.e2e-spec.ts` › `tenant isolation` › “returns 404, not 403, for another organisation’s task”, “does not include another organisation’s task in a list”, “does not allow org B’s owner to reach org A’s project through a header swap”; `packages/database/test/tenant-scoping.test.ts` (3 tests) | `VERIFIED` against the two-organisation test database |
| 3 | Duplicate task submission creates one task | `apps/api/test/tasks.e2e-spec.ts` › `task creation` › “is idempotent: the same key returns the existing task with 200 and one row”; `packages/database/test/idempotency.test.ts` (2 tests) | `VERIFIED` |
| 4 | Workflow retry does not duplicate irreversible work | No automated test re-runs an activity or a workflow and counts rows. Nearest tests: `apps/worker/test/ids.test.ts` (deterministic ids), `apps/api/test/orchestrator-retry-options.test.ts` (reuse policy). | `PARTIAL` — gap |
| 5 | Failed runtime execution is recorded as failed | `packages/agent-runtime/test/local-simulated.test.ts` › “fails deterministically in the documented bucket and never invents an artifact” tests the runtime result, not the database record. Manual proof: `AG-001 deterministic failure proof` is `failed` with workflow run `failed`, agent run `failed`, 0 artifacts, `task.failed.v1`. | `PARTIAL` — gap in automated coverage |
| 6 | Approval-required action cannot execute before approval | `apps/api/test/tasks.e2e-spec.ts` › `approval gate (contract §15 A3)` › “refuses to start a HIGH risk task without an approved request”, “allows the same task once the request is approved”, “records an approval.decided.v1 audit event naming the approver”, “refuses a second decision on the same request (409)”, “requires a note when rejecting (400)” | `VERIFIED` |
| 7 | Expired/revoked permission is rejected | Expiry: `apps/api/test/auth-tenancy.e2e-spec.ts` › “rejects an expired token (401)”; `apps/api/test/jwt-auth-claims.test.ts` › “rejects a token whose iat is older than the 900s TTL even with a far-future exp”. Revocation: no test deletes or changes a membership mid-session. | `PARTIAL` — expiry verified, revocation untested |
| 8 | Secrets never appear in logs | No test captures log output and greps it. `apps/api/src/common/logger.ts` defines redaction paths for `authorization`, `cookie`, `password`, `passwordHash`, `token`, `secret`, `accessToken` and `set-cookie`. | `PARTIAL` — control exists, no test |
| 9 | Cancelled workflow terminates safely | `packages/agent-runtime/test/local-simulated.test.ts` › “cancel(taskId) aborts the in-flight execution for that task” tests the runtime only. Manual proof: `AG-001 worker-owned cancellation proof (fixed run finalisation)` is `cancelled`, has a finished `WorkflowRun`, a `task.cancelled.v1` event and no artifacts. | `PARTIAL` — gap in automated coverage |
| 10 | Completed task carries result + audit evidence | `apps/api/test/tasks.e2e-spec.ts` › `task creation` › “creates a task and writes exactly one task.created.v1 audit event” covers creation, not completion. Manual proof: `AG-001 retry proof` has 1 artifact, 1 evidence row and 6 audit rows (`task.created.v1`, 3 × `task.status_changed.v1`, `workflow.started.v1`, `task.succeeded.v1`). | `PARTIAL` — gap in automated coverage |

### 3.1 What the gaps mean

Cases 4, 5, 9 and 10 are exercised by the workflow and observed in the development
database, but no test in the repository starts the worker, waits for a workflow to
finish, and asserts the resulting rows. The distinction matters: the manual proof can
regress without a red gate. A worker-level integration test is the missing artifact.

Case 7 has a narrower gap: expiry is tested, revocation is not. The code re-reads role
and membership from the database on every request (`OrgScopeGuard`), so revocation
should take effect on the next call, but “should” is not evidence. No test deletes a
membership row between two requests.

Case 8 has no log-capture test at all. The redaction list is code, not a verified
property. A test that captures `pino` output during a login and a failed login, then
grep for the password, hash and token, would close it.

---

## 4. What the tests do not prove

**No two-tenant live fixture.** The development database has one organisation. Tenant
isolation is proven against a separate test database seeded with organisation A and
organisation B. That is a real database and a real API, but it is not the environment a
reviewer sees after `pnpm db:bootstrap`. No browser session has switched between two
live tenants.

**Worker execution is not in the automated suite.** The worker runs in the development
stack and the proof runs in `intelligenz_dev` record real Temporal run ids. The test
suite does not start the worker. Cases 4, 5, 9 and 10 therefore rest on manual
inspection, not on a gate.

**No load, soak, or concurrency testing.** No test sends concurrent requests beyond the
readiness-cache concurrency test. No latency, throughput or memory measurement exists.
The in-memory rate limiter’s 10,000-entry bound is unit-tested; the process under a real
flood is not.

**No screen-reader session.** Keyboard reachability (skip link), landmark structure and
role-based assertions are tested. No NVDA, JAWS, VoiceOver or Orca session was run. The
E2E suite is Chromium-only at four viewport sizes; Firefox, WebKit and Safari are not
tested.

**No visual regression and no dark-theme render.** No screenshot comparison runs in CI
or locally. The dark token block exists, but no UI path sets `data-theme`, so dark mode
has never rendered in this build.

**No mutation UI.** The web surface has no create, run, cancel or approve control. The
E2E suite therefore tests reads and authentication only. API mutations are covered by
Supertest, not by a browser.

**No log-capture assertion.** See case 8.

**No CI execution.** Every result here was produced on this host, by the same agent
that wrote the code. There is no independent pipeline run. CI is `IMPLEMENTED`, never
`VERIFIED`.

**No migration rollback, backup or restore test.** `prisma migrate deploy` is exercised;
`migrate reset`, downgrade, `pg_dump` and restore are not.

**No dependency or container scan beyond `pnpm audit`.** No SAST, DAST, image scan or
secret scan ran. `pnpm audit` is recorded in `SECURITY-RESULTS.md` §7.

**The web E2E run writes to the development database.** Sign-in writes
`session.started.v1` audit rows. The suite does not create tasks, but it is not
read-only against `intelligenz_dev`. The API E2E suite is isolated in
`intelligenz_test`.

---

## 5. Reproduce

From the repository root, with PostgreSQL, Redis, Temporal and the API/web/worker
running:

```bash
pnpm -w typecheck
pnpm -w lint
pnpm -w test
pnpm --filter @intelligenz/api test:e2e
pnpm --filter @intelligenz/web test:e2e
pnpm -w build
```

`pnpm verify` runs the first three and the build, sequentially, and prints a pass/fail
summary. It does not run either E2E suite; those are separate commands by design
because they need a live stack.
