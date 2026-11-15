# Harness hygiene — the two leaks, and what they make the suite say

**Task:** H-601. **Branch:** `phase-6/trust-boundary-closure` at `cfc1f26`.
**Method:** read-only. No source changed, no test run (the runner was held by another
agent on a shared test database), no `DELETE`/`UPDATE`/`TRUNCATE` issued. Every count
below is from a `SELECT` executed in this session against `intelligenz_test`, or from a
file read; anything I could not observe is marked as such.

**One correction to the brief before anything else.** `apps/worker/test/isolation.test.ts`
does not write to the database. It imports `node:fs`, `node:os`, `node:path`,
`@intelligenz/contracts` and `../src/isolation` — there is no Prisma import in the file, and
it creates only `iz-isolation-*` directories under `/tmp` (cleaned in `afterAll`, line 38).
The file that creates `isolation-*` users is **`isolation-gate.test.ts`**, via
`tenant('isolation-vm' | 'isolation-forged-env' | 'isolation-forged-input' |
'isolation-restricted')` at lines 162, 233, 275 and 314. A fix applied to
`isolation.test.ts` would change nothing.

---

## 1. Measured state

### 1.1 The test database

Two `SELECT` readings, at 16:17 and 16:22 UTC:

| Table | Rows |
|---|---|
| `User` | **0** |
| `Organization` | **0** |
| `Workspace` / `Project` / `Membership` | 0 / 0 / 0 |
| `Task` / `WorkflowRun` / `AgentRun` | 0 / 0 / 0 |
| `ExecutionAttempt` / `ExecutionWorkspace` | 0 / 0 |
| `ApprovalRequest` / `AuditEvent` | 0 / 0 |

**Zero rows is not evidence of clean teardown.** The cumulative counters say what happened
to the rows that were here:

| Table | `n_tup_ins` | `n_tup_del` | `n_live_tup` |
|---|---|---|---|
| `User` | 11,305 | 9,890 | 0 |
| `Membership` | 1,424 | **0** | 0 |
| `Organization` | 10,553 | 9,886 | 0 |
| `ExecutionAttempt` | 11,602 | 10,501 | 0 |
| `AgentRun` | 1,385 | 1,177 | 0 |

`Membership` is the tell: **1,424 inserts, zero deletes, zero live rows.** A cascade from
`organization.delete` is counted in `n_tup_del`; a `TRUNCATE` is not. So this database has
been emptied by a global truncate, not by per-tenant teardown.

Only one `TRUNCATE` exists in the tree — `apps/api/test/helpers/database.ts:138` — reached
from `resetDatabase()` and from `startSuite().close()` (`apps/api/test/helpers/app.ts:53`
and `:65`). `prisma migrate reset` is the other way to produce that signature.
`_prisma_migrations` has 8 rows, only 1 finished in the last four hours (13:23 today), so
the database was **not** recreated — the rows were truncated in place.

**Consequence:** the orphan population cannot be measured now. The evidence of the leak was
destroyed by the same harness whose hygiene is in question, and by a mechanism (§4) that is
itself a cross-suite hazard. The surviving trace is the counter table above.

### 1.2 `/tmp`

```
tmpfs  /tmp  tmpfs  rw,nosuid,nodev,nr_inodes=1048576,inode64,usrquota  3.8G  3.0G  777M
```

`/usr/lib/systemd/system/tmp.mount` sets `size=50%,nr_inodes=1m,x-systemd.graceful-option=usrquota`.
The active mount option is `usrquota`, so an allocation failure here is reported as
**EDQUOT — "Disk quota exceeded"**, not ENOSPC. That is why the failure read
`git init: Disk quota exceeded`: the errno is a property of the mount, not of git.

Composition at 16:17, by size:

| Path | Size | Owner |
|---|---|---|
| `/tmp/opencode-clean.db` | 1,011 MB | a stale SQLite copy, last written Nov 14, open by nothing |
| `/tmp/opencode/*` | 907 MB (581 entries) | agent/reviewer scratch — `p5rev` 340 MB, `astryx-api` 192 MB |
| `/tmp/jest_rs` | 247 MB | Jest transform cache (Jest, which this repo does not use) |
| `/tmp/scratch/intelligenz` | 153 MB | a copy of this repository (the reviewers' scratch tree) |
| `/tmp/tmp.gKKBZQIDVK` | 157 MB | a Temporal CLI download left behind |
| `/tmp/node-compile-cache*`, `/tmp/tcli`, `/tmp/metro-cache` | ~106 MB | Node/tooling caches |
| **all `intelligenz-*` + `iz-*` dirs** | **3.3 MB** (73 dirs) | **this test suite** |

The suite owns 3.3 MB of a 3.0 GB problem. See §5 for what that means.

---

## 2. Problem 1 — the tenant leak

### 2.1 The chain

| # | Step | Where |
|---|---|---|
| 1 | Creates Organization, Workspace, Project and **User** (`<label>-<uuid8>@example.test`) | `apps/worker/test/helpers/database.ts:73-105`, user at `:95-97` |
| 2 | 111 fixture-creation sites in 17 test files — 94 per-test `tenant(...)` calls across 12 files, plus 17 single-tenant suites. `execution-boundary.test.ts` alone creates 37. | `await tenant('...')` / `await createTenant(...)` |
| 3 | Cleanup is `afterAll`-only — no `afterEach` anywhere in the worker suites | `isolation-gate.test.ts:152-158` |
| 4 | One loop, no per-tenant guard: the first throw ends cleanup for the rest | `isolation-gate.test.ts:156` |
| 5 | The user delete swallows its own failure | `helpers/database.ts:213` — `.catch(() => undefined)` |
| 6 | The only detector is a **global** user count in another package | `packages/database/prisma/seed.ts:543`, asserted `seed.test.ts:42-45` |

The intended cleanup is correct in shape: `dropTenant` removes every `onDelete: Restrict`
relation on `Organization` before deleting it (`ExecutionWorkspace`, `ExecutionAttempt`,
`ApprovalRequest`, `AuditEvent` — schema lines 593, 708, 846, 884, all present at
`helpers/database.ts:199-207`), nulls `AgentRun.workspaceId` first (`:201`), then deletes the
user. I checked every `Restrict` relation in `schema.prisma` against that list: **as the
schema stands, the list is complete.** It is a hand-maintained list, so it becomes wrong the
day a new `Restrict` relation is added — a latent trap, not a current defect.

### 2.2 Why the cleanup does not run on abort

Four mechanisms for the database leak, and one habit that appears in both problems:

| # | Mechanism | Evidence | Leaves behind |
|---|---|---|---|
| 1 | **Process abort** — SIGINT/SIGTERM, OOM kill, worker crash. `afterAll` never runs. | Not observable in code; it is the definition of an aborted hook. | Every tenant created before the abort — up to 37 from one file. |
| 2 | **Hook timeout.** `afterAll`'s first await is `harness?.close()`, which awaits `worker.run()` draining. Neither config sets `hookTimeout` (`vitest.config.mts:3-15`), so the Vitest default 10 s applies, against activities with a 30 s `startToCloseTimeout` (`execution-harness.ts:207`). A timeout abandons the rest of the hook. | `isolation-gate.test.ts:155` | All tenants of that file. |
| 3 | **`dropTenant` throws mid-loop.** No `try`/`catch` around the loop and no per-tenant isolation, so tenant *n* failing means tenants *n+1…* are never attempted. Reachable by a foreign-key surprise (see §2.1), a lock wait, or a serialization error while a truncate holds `ACCESS EXCLUSIVE`. | `isolation-gate.test.ts:156` | All tenants after the failing index. |
| 4 | **Swallowed delete failure.** The organization is gone, the user is not, and nothing reports it. | `helpers/database.ts:213` | One user per occurrence, permanently. |
| 5 | **Never-cleaned roots** — not a database mechanism; recorded here because it is the same habit, quantified in §3.2. Six files create a `mkdtemp` root and contain **zero** `rm(` calls. | §3.2 | Disk, not database. |

`close()` is **not** one of them. I read it: every await inside is `.catch(() => undefined)`
and the whole body is wrapped in `try { … } catch {}` (`execution-harness.ts:225-236`). It
cannot throw. AG-603 §7.5 records that "the harness now makes `close()` non-throwing so
cleanup cannot be skipped" — that is true for the throw path and only the throw path. It
closes the `close()`-throws path; it does not touch 1, 2, 3-for-`dropTenant`, or 4.

### 2.3 The arithmetic of `expected 12 to be 4`

`4 seeded + 8 orphaned = 12`, exactly. The harness itself records the eight:
`execution-harness.ts:222` — *"eight orphaned tenants turned an unrelated suite red"*.
That reconciles the observed message with the leak, and it is the most likely account.

It is not the only account. With **zero** leaks, the same number is reachable by scheduling:
`seed()` measures `user.count()` at the end of its `beforeAll`, while the other files in
`packages/database` are running in parallel against the same database (the root config sets
no `fileParallelism`). Their live fixtures at that instant:

| File | Users live during its tests |
|---|---|
| `tenant-scoping.test.ts` | up to 2 (dropped in `afterEach`, so live between tests) |
| `execution-identity.test.ts` | up to 7 |
| `idempotency.test.ts` | up to 3 |
| worker suites, if the runner schedules them together | up to 94 |

`4 + 8 = 12` sits inside `4 … 16` for the database package alone, and inside `4 … 110` once
the worker suites are scheduled alongside. **I cannot tell which mechanism produced the
observed failure:** the run log is gone and the database was truncated. Both are real, and
the second one does not require anything to go wrong.

### 2.4 Verdict on `seed.test.ts`

**The global assertion is wrong on its own terms. The leak is a second, independent defect.**

`SeedSummary` has eleven fields. Ten are organisation-scoped:

```
organizations  → count({ where: { id: organization.id } })
workspaces     → count({ where: { orgId: organization.id } })
projects       → count({ where: { orgId: organization.id } })
memberships    → count({ where: { orgId: organization.id } })
tasks, workflowRuns, agentRuns, approvalRequests, pendingApprovals, auditEvents → orgId
users          → count()                          ← packages/database/prisma/seed.ts:543
```

`memberships` already proves the same fact, scoped, one line below the failing assertion
(`seed.test.ts:44`). A user in a seeded fixture is a user *with a membership in the seeded
organisation*; `user.count()` counts every account any suite has ever created, including one
belonging to a suite that is mid-test in another worker. On a database shared by 81 files
running in parallel (the last recorded run, `TEST-RESULTS.md`), a table-global aggregate has
no stable expected value.

Fixing the leak makes it *usually* pass. It does not make it correct, and the next person
who writes a similarly-shaped assertion will inherit the same trap.

Two secondary defects in the same file, same class:

- `seed.test.ts` **leaves its fixture behind** — it calls `seed()` twice and has no teardown
  beyond `$disconnect()` (`:27-29`). It is a polluter as well as a victim.
- It never takes the API suite's advisory lock, so a `pnpm -C apps/api test` run alongside
  `pnpm -w test` can truncate the seeded organisation between `beforeAll` and an assertion.
  The root config excludes `*.e2e-spec.ts` by filename glob (§4), so this needs a deliberate
  second command — which `TEST-RESULTS.md` documents as gate 4.

---

## 3. Problem 2 — `/tmp`

### 3.1 The one deliberate large writer is not in `/tmp`

`packages/workspace-manager/test/volumes.test.ts:795-914` ("surfaces a full volume as a typed
workspace failure") writes a 4 MiB chunk in a loop until the kernel refuses, asserts
`written > 850 MB` (`:864`), then asserts a fresh 2 MiB write fails with `ENOSPC` (`:857`).

That writes into a **leased 1 GiB ext4 loop volume**, not `/tmp`. Measured:
`/proc/self/mountinfo` shows eight of them at `/var/lib/intelligenz/mnt/vol-1 … vol-8`
(`/dev/loop6,11,12,13,14,15,16,17`), and `/` has 288 GB free. The workspace root inside that
test is a `mkdtemp` of `intelligenz-enospc-` (`:874`) — kilobytes, removed in `finally`
(`:911-912`).

So this test is not what fills `/tmp`. It has a different hazard: its cleanup is a `finally`,
which does not run when Vitest kills the test at its 120 s timeout (`:914`). A killed run
leaves an 850 MB filler file on a loop device; the next suite to lease that device gets a
volume that fails writes, and the resulting `ENOSPC` names the wrong test.

### 3.2 Who writes where, and whether cleanup is guaranteed

| Owner | Prefix(es) under `tmpdir()` | Declared at | Cleanup | Guaranteed? |
|---|---|---|---|---|
| `apps/worker/test/evidence-provenance.test.ts` | `intelligenz-evidence-db-` | `:68` | **none** — file contains 0 `rm(` | **never** |
| `apps/worker/test/evidence-capture-failure.test.ts` | `intelligenz-evidence-failure-` | `:134` | **none** (0 `rm(`) | **never** |
| `apps/worker/test/evidence-capture-points.test.ts` | `intelligenz-capture-points-` | `:168` | **none** (0 `rm(`) | **never** |
| `apps/worker/test/isolation-gate.test.ts` | `intelligenz-isolation-test-` | `:137` | **none** (0 `rm(`) | **never** |
| `apps/worker/test/execution-persistence.test.ts` | `intelligenz-worker-test-` | `:77` | **none** (0 `rm(`) | **never** |
| `apps/worker/test/workspace-lifecycle.test.ts` | `intelligenz-workspace-test-` | `:68` | **none** (0 `rm(`) | **never** |
| `apps/worker/test/reaper.test.ts` | `intelligenz-reaper-{workspaces,artifacts,scratch}-` | `:215-217` | `afterAll` `rm` | only if the hook completes and `dropTenant` did not throw first |
| `apps/worker/test/execution-boundary.test.ts` | `intelligenz-boundary-test-` | `:283` | `afterAll` `rm` | on normal exit |
| `apps/worker/test/isolation.test.ts` | `iz-isolation-` | `:49` | `afterAll` `rm` over an array | on normal exit |
| `packages/workspace-manager/test/*` | `intelligenz-{hostile,snapshot,nested-git,escape,manifest,race,ws,sandbox,evidence-*}-` | 12 files | `afterAll`/`finally` `rm` | on normal exit |
| `packages/evaluation/test/*` | `iz-{judge,runner,work,work-stale}-` | `:32` (judge), `:87-248` (runner) | `afterAll` `rm` | on normal exit |
| `packages/agent-runtime/test/*` | `intelligenz-{f1,egress,isolation,home,mount-ws,git-sandbox,git-marker,no-git,local-simulated,broker-run-*,real-*,pg,runtime-contract}-` | 9 files + 1 helper | mostly `finally` | on normal exit |
| `packages/egress-broker/test/*` | `intelligenz-{broker,credential,broker-sandbox}-` | 3 files | `finally` | on normal exit |
| `apps/api/test/executions.e2e-spec.ts` | `intelligenz-api-{artifacts,workspaces}-` | `:84-85` | `afterAll` `rm` | on normal exit |

Six files leak **unconditionally** — not on abort, on every run. Measured consequence: 73
directories and 3.3 MB at rest, with 6–9 `intelligenz-evidence-db-*` (276 KB each) and 14
`intelligenz-evidence-failure-*` from the runs of the last two hours.

The volume is small but the **count** is unbounded, and `/tmp` has `nr_inodes=1048576`
(8 % used). This does not threaten a run today; it is a slow inode leak in a directory that
the whole host shares.

### 3.3 The shared lock file — a second way `/tmp` turns into a red security test

`volumes.test.ts:80` and `io-limits.test.ts:81` both serialise on
`join(tmpdir(), 'intelligenz-volumes-test.lock')`. `acquireTestLock` tolerates exactly one
errno:

```ts
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;   // volumes.test.ts:100-101
```

`open(LOCK_PATH, 'wx')` on a full tmpfs fails with `EDQUOT`, which is re-thrown, so
`beforeAll` fails and the whole file goes red — including the containment tests ("cannot be
deleted outside the volume by `..` or by a symbolic link", `:426`) — with an error that
reads like a product defect. The lock that exists to make two suites safe makes both fail
together when the filesystem that holds it is under pressure.

### 3.4 Correction to the premise

The suite does not fill `/tmp`: measured footprint at rest is 3.3 MB of 3.0 GB used. The
tmpfs was already at ~80 % from other tooling (a 1.06 GB stale SQLite copy, 907 MB of agent
scratch, 247 MB of Jest cache, a 153 MB copy of this repo). Against 777 MB free, whatever a
run writes — including a 96 MB Temporal history database that lives in the repo, not `/tmp` —
is the last few per cent. `git init` (`packages/workspace-manager/test/helpers/git.ts:65`)
is simply the first `mkdir` in the run that needed a block.

I did not observe the failed run, so I can state the errno mechanism and the measured
composition; I cannot state which allocation crossed the line.

---

## 4. Suites with the same shape

| Suite | Shared, global thing | Isolation | What it invites |
|---|---|---|---|
| `packages/database/test/seed.test.ts` | `user.count()` global; seeded fixture left behind | none | false red on any concurrent fixture (§2.4) |
| `apps/api/test/**` (7 e2e files) | `TRUNCATE … RESTART IDENTITY CASCADE` on 15 tables | advisory lock **among themselves only** (`database.ts:100-133`) | wipes any other suite's rows if run beside them; erases leak evidence (§1.1) |
| `packages/database/test/{tenant-scoping,execution-identity,idempotency}` | same database, `afterEach` teardown | own tenant, no lock | live fixtures visible to `seed.test.ts`'s count |
| `apps/worker/test/*` (12 files, 94 per-test fixtures + 17 suite fixtures) | same database | own tenant, `afterAll` only | §2.2 |
| `volumes.test.ts` + `io-limits.test.ts` | one pool of 8 host devices | `/tmp` lock file, stale-breaker 180 s | §3.3; a killed run leaves a device full or the lock held |
| `cgroup.test.ts` + `cpu-budget.test.ts` | host cgroup tree | `skipIf(tier)` | evidence vanishes on a host without cgroup v2 `full` |
| every Temporal suite | one dev server, one `.temporal/dev.db` (96 MB, monotonic) | unique task queue per harness | history never truncated; no per-file isolation needed |
| `resolveScratchRoot` default | `/tmp/intelligenz-runtime` — one fixed path | none | two concurrent worker runs share a scratch root (`apps/worker/src/config.ts:320-331`, default at `:327`) |

---

## 5. Where the harness lies about security

This is the part that matters. A harness that fails is inconvenient; a harness that reports
a security property it did not test is worse.

| # | Mechanism | Affected proofs | It looks |
|---|---|---|---|
| 1 | **`describe.skipIf(!temporalEnabled)` with no warning.** `isolation-gate.test.ts` has no `console.warn` block at all; `execution-boundary.test.ts:309-315` warns only when `!enabled`. CI runs no Temporal service (`ci.yml:26-48` — postgres and redis only). | The isolation gate's 4 tests (1 skip block), 10 temporal-gated blocks in `execution-boundary`, plus persistence, identity, approval-binding and evidence-capture | **green** — 0 executed, 0 failed, 15 skipped (`TEST-RESULTS.md`) |
| 2 | **Absence assertions are satisfied by a neighbour's truncate.** `expect(await client.agentRun.count({ where: { orgId } })).toBe(0)` (`isolation-gate.test.ts:227, 265, 309`) is the *only* proof the gate refused before provisioning. `expect(attempts).toHaveLength(1)` (`:209`) is the proof nothing else ran. | the isolation gate's core claim | **green for the wrong reason** when rows are deleted between launch and read; **red** when the same deletion empties `attempts` |
| 3 | **`dropTenant` swallows.** `user.delete(...).catch(() => undefined)` | fixture hygiene | locally **green** (nothing reports it), remotely **red** in an unrelated package with a message that names no cause |
| 4 | **Global count in the seed.** | `seed.test.ts:42-45` | **red** — observed twice, and it sent two reviewers after the wrong suite |
| 5 | **Resource-gated skips.** `skipIf(SET === null)` (`volumes.test.ts:149, 285, 425, 496, 794`), `skipIf(!bwrapAvailable)` (`sandbox-env-isolation.test.ts:65`) | volume delete-containment; sandbox environment isolation | **green** on a host with no loop volumes or no bubblewrap |
| 6 | **`e2e-spec.ts` is invisible to the root glob.** `apps/**/*.{test,spec}.ts` does not match `executions.e2e-spec.ts` (hyphen, not dot). The exclusion is enforced by filename convention and a comment (`apps/api/vitest.config.mts:14-18`), not by an `exclude` entry. | the whole API e2e gate | "`pnpm -w test` is green" is **not** "the suite is green"; and adding the pattern to the root config recreates the truncate race the comment describes |

**The rule I would adopt:** a security test that did not run is not a passing test. Count
*executed* tests, not passed ones, and fail when the count drops below a recorded floor.

One documentation defect in the same family: `ISOLATION-TEST-STABILITY.md:52` cites
`isolation-gate.test.ts:246-259` for the `[simulate:ok]` marker. The marker is at
`:321-324`; the file grew by the AG-603 harness rewrite. A reader following the citation
finds the wrong lines. The claim is still true; the reference is not.

---

## 6. Remediation plan — smallest correct change per item, ranked by false signal removed

Not implemented. Each item is stated as the minimum edit that removes the defect rather than
the symptom.

### R1 — Scope the seed count (1 line, removes the false red that has already misled two reviewers)

`packages/database/prisma/seed.ts:543`

```ts
// from
prisma.user.count(),
// to
prisma.user.count({ where: { memberships: { some: { orgId: organization.id } } } }),
```

`seed.test.ts:42-45` then asserts a fact about the fixture rather than about the database,
and the expected value 4 becomes true regardless of what else is running. The smaller still
alternative: delete the `users` field and rely on `memberships`, which is already asserted at
`:44` and is the same statement, scoped. This is the only change here that is correct even
if every other item is skipped.

**Why first:** one line, no behavioural risk, and it eliminates an entire class — "assert a
table-global aggregate on a database shared by 81 parallel files" — plus the specific
failure that produced `expected 12 to be 4`.

### R2 — Make a skip visible (2 lines + one CI assertion, removes the entire false-green class)

1. `vitest.config.mts:8` — `passWithNoTests: true` → `false`. This catches the **mis-glob**
   case (`apps/api`'s e2e files are already invisible to the root pattern); it does **not**
   catch "collected but all skipped", which is why item 3 exists. The two are complementary,
   not alternatives.
2. Add the missing `console.warn` to `isolation-gate.test.ts` (the pattern already exists in
   `execution-boundary.test.ts:309`) so the reason is in the log where the skip is.
3. CI: run with `--reporter=json --outputFile`, then fail when `numSkipped` exceeds the
   recorded baseline (15, per `TEST-RESULTS.md`). A new skip is then a red gate.

**Why second:** it is the cheapest change that stops "the security suite did not run" from
being reported as "the security suite passed", and it covers all six rows of §5, not one.

### R3 — Centralise tenant teardown (1 helper + 12 call sites, the only item that survives a SIGKILL)

`apps/worker/test/helpers/database.ts`:

```ts
export async function dropAllTenants(client, tenants) {
  const failures = [];
  for (const fixture of tenants) {
    try { await dropTenant(client, fixture); }
    catch (error) { failures.push({ orgId: fixture.orgId, error }); }
  }
  if (failures.length > 0) throw new AggregateError(...);
}
```

and replace the bare `for (const fixture of tenants) await dropTenant(...)` in the 12
`afterAll`s. Independent attempts mean tenant *n* failing no longer abandons *n+1…*, and one
aggregate error names every tenant that survived.

To cover mechanism 1 (abort), which no `afterAll` can cover: give each fixture a
deterministic label prefix and sweep it in `beforeAll` —

```ts
await client.organization.deleteMany({ where: { slug: { startsWith: `${label}-` } } });
```

— so an aborted run self-heals on the next run of the same file instead of poisoning another
package. Both halves are ~15 lines in one file.

**Why third:** it removes the persistent leak and the misattribution, but it is more code
than R1/R2 and the false-red class it fixes is already removed at the assertion by R1.

### R4 — Move fixture roots off tmpfs, and stop leaking six of them

- One line in `vitest.config.mts`: `test: { env: { TMPDIR: '<repo>/.test-tmp' } }`. Node's
  `os.tmpdir()` reads `TMPDIR` at call time, so every existing `mkdtemp(join(tmpdir(), …))`
  follows it. This removes the 3.8 GB ceiling and the `EDQUOT` errno from the whole suite at
  once. **Verify before adopting** — I could not run the suite to confirm Vitest 5 populates
  `process.env` before module-scope `tmpdir()` calls; if it does not, the same result is a
  `fixtureRoot(prefix)` helper applied at the 62 `mkdtemp` sites.
- Add `await rm(root, …)` to the six files in §3.2, or route them through a shared
  `temporaryRoot()` that registers its own `afterAll` — six deletions, one place.
- Trade-off to state explicitly: the tmpfs ceiling is accidental protection. Moving to `/`
  trades a bounded filesystem for 288 GB. The deliberate version is a test-owned directory
  with an explicit cap, which `io-limits` and `volumes` already prove elsewhere.

### R5 — Correct AG-603 §7.5

"the harness now makes `close()` non-throwing so cleanup cannot be skipped" is true for one
mechanism of four. The sentence should name the ones that remain (§2.2 items 1, 2, 3, 4), or
the next reader will treat the leak as closed.

---

## 7. What this diagnosis does not establish

| Question | Status |
|---|---|
| Which run produced `expected 12 to be 4`, and whether it was an abort or a parallel overlap | **Unknown.** No run log survives; the database was truncated. Both mechanisms are established; the instance is not. |
| The orphan population at the time | **Unmeasurable now.** Erased by the truncate whose signature is in §1.1. |
| That the suite fills `/tmp` | **Contradicted by measurement** — 3.3 MB at rest against 3.0 GB used by other tooling. |
| That `test.env.TMPDIR` in Vitest 5 is applied before module-scope `tmpdir()` calls | **Not verified** — would require running the suite, which this task forbids. |
| That `dropTenant` currently fails on any real fixture | **No such failure observed.** The delete list matches the schema's `Restrict` relations today; the risk is the hand-maintained list, not a present break. |
| Code paths other than `apps/api/test/helpers/database.ts:138` truncating the test database | **One other**: `prisma migrate reset --force`. The migrations table shows a single deploy at 13:23 today, not a re-application of all 8, so no reset has run since. |

Verification status for this document: **partially_verified** — every file reference and
database count was read in this session; no test was executed by design, so the runtime
behaviour of the remediations is unproven.
