# Phase 6 — test results

**Commit under test:** `9461d2773a2902dee91d0f36a22977356548c01e`
**Parent:** `58476b0a105c3fb405d63278d38e1eb965fc28d4`
**Branch:** `phase-6/trust-boundary-closure`
**Environment:** local, Linux, PostgreSQL on the loopback socket, Temporal 1.32.2 reachable during the runs noted below.

Every number here is from output in this session. Nothing is carried forward from a previous phase's report.

## Toolchain

| Component | Value |
|---|---|
| Package manager | pnpm (workspace) |
| Test runner | Vitest |
| Database | PostgreSQL, Prisma 7 |
| Orchestrator | Temporal (tests that need it skip without a server) |

## Final run at `9461d27`

| Gate | Command | Exit | Result |
|---|---|---|---|
| Lint | `pnpm -w lint` | **0** | `--max-warnings=0`, no output |
| Typecheck | `pnpm -w typecheck` | **0** | all workspace projects clean |
| Tests | `pnpm -w test` | **0** | **81 files · 878 passed · 15 skipped · 0 failed** |
| API e2e | `pnpm --filter @intelligenz/api test:e2e` | **0** | **7 files · 97 passed · 0 failed** |
| Build | `pnpm -w build` | **0** | clean |
| Migration (fresh DB) | `DATABASE_URL=…fresh… npx prisma migrate deploy` | **0** | **8 migrations applied · 16 tables** |

One `[enospc]` line appears in the test log:

```
[enospc] provision state=failed code=WORKSPACE_PROVISION_FAILED stage=source
         message=ENOSPC: no space left on device, mkdir '/var/lib/intelligenz/mnt/vol-8/repo'
```

That is a **logged** line from a test that deliberately provokes a full volume to prove the
per-attempt ceiling. It is not a failure: the run exited 0 with 0 failed.

## Skipped, not passed

**15 tests skip.** An earlier version of this section said they were "all live-Temporal",
which was **false**, and an independent review caught it by counting the gates: there are
**51 `skipIf` sites** in the suite, gated on at least four different conditions —
`!temporalEnabled`, `!databaseEnabled`, `TIER !== 'full'` (cgroup enforcement), and bwrap
tier gates. The 15 that skip on this host are the **environment-limited** ones: cgroup
enforcement, I/O limits, and the bwrap tier probes — not the Temporal ones.

The consequence of the wrong attribution was worse than a wrong sentence. If Temporal had
been *down*, at least 37 tests would have skipped; 15 is only possible with Temporal
**live**, which means the evidence suites (`F-G2`, `F-G13`, `F-G14`, `F-G18`, `F-G19`) and
the claim/identity suites did execute. That is the honest reading, and it is the opposite
of what this document previously claimed.

It also means a **skip budget of 15 is a ceiling computed from the wrong set** — a new skip
would hide underneath it. The correct guard is per-gate, not a single number: fail if
`temporalEnabled` is true and a Temporal-gated test skips, and fail if a `TIER === 'full'`
test appears in the skipped list on a host that claims the full tier.

Skips are counted as *skipped*, never as passed. Two mechanisms can skip a whole file while
the summary reads as a pass: a hook exceeding `hookTimeout` (was 10 s, now 60 s — one known
trigger removed, the **class** not fixed), and an abort under `EDQUOT` from the `/tmp`
tmpfs quota. Both are recorded in `HARNESS-HYGIENE.md`; neither is a green result.


## Progression across Phase 6

| Commit | What it added | Tests |
|---|---|---|
| `3aed33d` | durable one-shot claim | 763 passed / 15 skipped |
| `74207f0` | claim enforced at the launch site | 780 / 15 |
| `a75f121` | identity fallback removed, release evidence-based | 809 / 15 |
| `23db912` | release on the recorded pair, write authority | 822 / 15 |
| `58476b0` | N12 candidate filter, N13 writer test | 822 / 15 |
| **`9461d27`** | **Gate G host evidence** | **878 / 15** |

+56 tests in Gate G alone. Each of the first four steps followed a review that found a real
bypass; none of the numbers above was reached by weakening an assertion.

## Gate G focused

| Suite | Tests | Note |
|---|---|---|
| `snapshot.test.ts` | — | traversal, bounds, `.git` metadata |
| `change-manifest.test.ts` | 13 | attacks 1/2/3, statuses, bounds, canonical digest |
| `hostile-repository.test.ts` | 3 | dormant helpers + **positive control** + mutation |
| `evidence-capture-order.test.ts` / `-points` | 5 | ordering invariants, per-attempt semantics |
| `evidence-provenance.test.ts` | 8 | attempt-owning workspace, unbound → non-authoritative |
| `execution-boundary.test.ts` | 38 | claim, launch site, release, write authority |
| `execution-claim.test.ts` | 15 | concurrency, retry, terminal refusal |
| `execution-identity.test.ts` | 19 | forge attempts, no-arg identity |
| `reaper.test.ts` | 17 | release classification |

## Repeats for stability

| Run | Result |
|---|---|
| `isolation-gate.test.ts` ×10 (flake fix) | 10/10 runs, 40/40 tests |
| `isolation-gate.test.ts` ×5 (Phase 6 close) | 5/5 runs, 4/4 each |
| Claim concurrency | 5 rounds per run, one winner each |

Bounded repeats, recorded; no retry-until-green anywhere.

## Pre-fix sensitivity

A test that cannot fail is not evidence. Verified failures against the pre-fix code:

| Finding | Verified by |
|---|---|
| N7 live-claim release | `released` on `a75f121` where `skipped_live` is required (detached worktree, that commit's own migrations) |
| N13 writer | `expected null to be 'probe-…'` with `validate-task.ts:259` deleted |
| N12 batch starvation | `expected undefined to match object { outcome: 'released' }` |
| N8 pre-dispatch `succeeded` | removal made it resolve `{changed:true}` |
| Provenance (Gate G) | 2 failed / 5 passed with the sibling workspace id winning |
| Claim enforcement F1–F3 | reviewer removed each check; its own repro succeeded each time |

## What is not covered

1. **CI.** No remote, no push credential, and no Temporal service in `ci.yml`. Every number
   above is a local run. Gate K remains **BLOCKED**.
2. **Kernel-enforced I/O.** `io.max` is writable and the controller delegated, but process
   migration is denied outside the wrapper script. PARTIAL.
3. **Credential custody.** No test can pass, because no boundary exists: same UID, in-process
   broker.
4. **Multi-tenant adversarial.** Cross-tenant lookups are covered per-endpoint; there is no
   systematic adversarial suite.
5. **Gate G signing.** The manifest is hashed, not signed. No key exists.
