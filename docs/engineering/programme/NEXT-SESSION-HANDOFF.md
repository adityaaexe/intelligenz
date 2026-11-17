# Next-session handoff — Phase 8.3

Written at the end of the session that added the execution-enforcement gate. It is intended
to be enough on its own: a session that has read nothing else should be able to verify the
state, continue the work, and avoid the four traps in §6 without re-deriving any of it.

**Measured at:** `1cf3c58` on `phase-6/trust-boundary-closure`, tree clean.
**State file:** `docs/engineering/programme/EXECUTION-STATE.json` (`pnpm programme:check`).

---

## 1. What changed in 8.3

Three changes, all in this session. None of them is a new capability — each closes a gap
between what the documents claimed and what the code enforced.

### 1.1 The worker refuses to start outside its delegated cgroup

`apps/worker/src/main.ts:125` calls `assertExecutionEnforcement` — gate block at 115–155,
`NativeConnection.connect` at 183, `Worker.create` at 198. `pnpm dev` outside
`infra/scripts/worker-with-cgroup.sh` now exits 1 and never polls.

The defect it closes: `main.ts` probed cgroups at boot, logged
`cgroup isolation: UNAVAILABLE [CGROUP_MIGRATION_DENIED] … Profiles run as rlimit-only` at
`warn`, and then registered with Temporal and executed tasks anyway. Every task ran with
rlimit-only enforcement — no memory ceiling, no fork ceiling, no CPU budget, no I/O throttle
— and every test passed, because no test asserted the worker's own placement. The I/O and CPU
proofs (`6705712`) are true only for a worker launched through the wrapper, and nothing
enforced "launched through the wrapper".

Five checks, all from the process's actual state (`/proc/self/cgroup`, `/proc/self/mountinfo`,
the real control files) rather than from configuration:

| Check                              | Question                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `CGROUP_V2_UNIFIED`                | is `/proc/self/cgroup` exactly `0::…`, with no v1 lines (no hybrid)?      |
| `CGROUP_PATH_UNDER_ROOT`           | is this process at or below the delegation root, compared **by segment**? |
| `CGROUP_CONTROLLERS_DELEGATED`     | are `cpu`, `memory`, `pids` in both `cgroup.controllers` and `cgroup.subtree_control`? |
| `CGROUP_CONTROL_FILES_SANE`        | do `memory.max` and `pids.max` exist **and** read back as a limit?        |
| `CGROUP_MODE_ENFORCED`             | does the probe — which migrates a real child — report `enforced`?         |

The segment comparison is the part that is easy to get wrong: `/intelligenz-evil`
`startsWith` `/intelligenz` and is a sibling, not a child. There is a test for it.

Refusal shape: `ExecutionEnforcementError`, `code: "EXECUTION_ENFORCEMENT_UNAVAILABLE"`,
`failingChecks[]`, `actualCgroup`, `expectedCgroupPath`, `cgroupRoot`, `remediation`, exit 1.

**The opt-out** is `WORKER_ALLOW_UNENFORCED_EXECUTION`, parsed in
`apps/worker/src/config.ts` as `resources.allowUnenforcedExecution`, **default `false`**
(`readBoolean(env, name, false)` — not `true`, not "warn only"). The field comment states why
the default is off and which processes may take it (control-plane, diagnostics, migration
runners — never anything that polls a task queue). When set, boot logs a `warn` that names the
flag and says the process must not execute tasks.

`getCgroupCapability`'s tier reporting is untouched; the per-attempt record still reads it.
This adds a gate beside the probe, it does not replace it.

### 1.2 Leaf hygiene: dispose on every path, reconcile the rest

`apps/worker/src/cgroup-hygiene.ts`:

- `makeLeafId(label)` → `<label>-<pid>-<time36>-<sequence>`. An attempt identifier, not a pid:
  a pid alone is reused by the next run and collides with a leaked leaf.
- `disposeLeaf(handle)` → kill (`cgroup.kill`, kernel-wide, reaches escaped descendants), wait
  for `cgroup.procs` to empty, **refuse to `rmdir` while anything remains**, then remove. It
  never throws — a cleanup failure must not replace the assertion failure that caused the
  cleanup — and it returns `removed`, `killedPids`, `remainingPids`, `reason`.
- `classifyLeaf` / `listStaleTestLeaves` / `reconcileTestLeaves` → classification is pure, so
  every refusal is testable; reconciliation is dry-run by default, re-reads emptiness
  immediately before each `rmdir`, and deletes only names in a **test-owned allowlist**.
  Production leaves (execution workspace ids, UUIDs) and the launcher's `worker` leaf are
  refused by name, not by heuristics.

Operator command: `pnpm cgroups:reconcile` (add `--apply` to delete).
Bug it replaces: every `finally` did `await removeCgroup(handle)`, which returns `false` on a
busy leaf and throws nothing. A boolean nobody reads is not a cleanup path.

### 1.3 Programme state, validated

`docs/engineering/programme/` — `EXECUTION-STATE.json`, this handoff, and a `README.md` with
the rules. Schema in `packages/contracts/src/programme.ts`; validator
`pnpm programme:check`; 29 rejection tests in `packages/contracts/src/programme.test.ts`, one
of which parses the committed file.

---

## 2. Verify the state in five commands

```bash
git log -1 --format='%H %s'                     # expect 1cf3c58 test: prove delegated I/O…
git status --porcelain                          # expect empty
pnpm programme:check                            # expect VALID, 11 tasks
npx vitest run packages/contracts/src/programme.test.ts apps/worker/test/execution-enforcement.test.ts
pnpm enforcement:check                          # expect REFUSED here; VERIFIED via the wrapper
```

## 3. Gate snapshot

Recorded in the Phase 8 documents (not re-measured by this session, except where noted):

| Gate                        | Status                            | Recorded in                                  |
| --------------------------- | --------------------------------- | -------------------------------------------- |
| Approval → execution (O1)   | PASS                              | `PHASE7-GATE-MATRIX.md`                      |
| Gate G evidence             | PASS (scoped; F-G20 open)          | `phase6-trust-boundary/`                     |
| Gate M tenancy              | PASS (43 tests, 4 mutation proofs) | `phase6-trust-boundary/`                     |
| R-11 CPU/memory             | PASS at `TIER=full`               | `CPU-MEMORY-ENFORCEMENT-PROOF.md`            |
| R-13 I/O                    | PASS on device `259:0`            | `IO-ENFORCEMENT-PROOF.md`                    |
| Disk (R-12), Output (R-14)  | PASS at `TIER=full`               | `PHASE7-GATE-MATRIX.md`                      |
| R-05…R-10 host privilege    | BLOCKED — one sudoers line        | `HOST-PRIVILEGE-INVENTORY.md`                |
| R-17 CI, R-19 backup/restore| BLOCKED — no remote, no destination | `PHASE7-GATE-MATRIX.md`                    |
| R-20 independent review     | PARTIAL                           | `PHASE7-GATE-MATRIX.md`                      |
| R-21 documentation index    | PARTIAL — two Phase 7 files still missing | `PHASE7-GATE-MATRIX.md`              |
| **Production**              | **NO-GO**                         | `PHASE7-GATE-MATRIX.md` R-22                 |

R-11's stated boundary was "the tests only run through the documented launcher". As of 8.3 a
worker that is not launched that way cannot start, so the boundary is now enforced at boot
rather than documented. The proof itself was not re-run at the full tier this session.

## 4. Open work

Read `EXECUTION-STATE.json` for the full records; this is the short version. Nine tasks are
open, four of them blocked on an authorisation rather than on code:

| Task      | Blocked on                                                              |
| --------- | ----------------------------------------------------------------------- |
| P83-003   | sudoers change: remove `(ALL) NOPASSWD: ALL`, keep password sudo. Needs authorisation and a proven recovery path first. |
| P83-004   | `izbroker` / `izsandbox` identities — needs `useradd` and a service unit. Depends on P83-003. |
| P83-005   | A git remote and a push credential, so `ci.yml` runs once against a real Temporal. |
| P83-006   | A backup destination. A backup never restored is not a recovery process. |

Unblocked and next in line: **P83-007** (`io.max` inside per-attempt leaves — the I/O proof
measured the worker leaf, agent work runs in attempt leaves), **P83-008** (two concurrent
attempts, to prove accounting does not cross), **P83-009** (swap policy — the host is at 100 %
of 4 GiB), **P83-010** (independent review of this gate, which nobody but its author has
read), **P83-011** (write the two Phase 7 documents R-21 cites).

## 5. What this session did not verify

- **The full workspace test suite.** Targeted files only, by instruction: `execution-enforcement`
  (29), `cgroup-cleanup` (16), `cgroup` (15, 8 skipped at this tier — pre-existing), `capabilities`
  (7), `config` (16), `isolation` (13), `cpu-budget` (16, 3 skipped — pre-existing), `io-limits`
  (7, 1 skipped — pre-existing), `isolation-gate` (4), `programme` (29).
- **The full-tier run.** This host's shell runs in a tmux scope, so every cgroup suite reports
  tier `limited` and the kill tests skip. The gate's positive path was verified by running the
  assessment inside the leaf through the launcher (see §7), not by starting a full worker there.
- **`pnpm verify`**, and any deploy or restart. Services were left as they were found: Temporal
  and Postgres were already running and remain so.
- **R-11 / R-13 re-runs.** The proofs recorded at `6705712` were not repeated.

## 6. Traps — each of these has already cost a session

1. **Do not set `TMPDIR` to a long path.** The adapter builds
   `<scratch>/opencode-cli/<taskId>-<suffix>/broker/broker.sock`; a unix socket path over 107
   bytes is truncated at bind time and surfaces as `ECONNRESET` on every provider call. A long
   `TMPDIR` produced 11 false failures.
2. **Tier is `limited` unless you launch through the wrapper.** From a login/tmux scope a
   `cgroup.procs` write is refused (`EPERM`) against the *source* cgroup, because the source
   belongs to root. That is not a missing capability; it is the wrong launch. Use
   `sudo bash infra/scripts/worker-with-cgroup.sh …`. And since 8.3, a worker started outside
   it will not start at all — if you see `EXECUTION_ENFORCEMENT_UNAVAILABLE`, that is the gate
   working, not a bug to route around.
3. **`/sys/fs/cgroup/intelligenz/cpu-budget-857041-28855` holds a live process.** It is a
   `/bin/sh -c while :; do :; done` busy loop (pid 857053 at the time of writing, orphaned to
   init, running since 2026-11-14 18:25). The leaf cannot be removed while it is there, and
   `reconcile-test-cgroups` refuses it for that reason. Killing it is a deliberate decision
   with its own evidence requirement, not cleanup:
   `cat <leaf>/cgroup.kill` (or `kill -9 857053`), then re-run `pnpm cgroups:reconcile --apply`.
4. **`oom3-687854` is not a leaf this repository creates.** It matches no naming pattern in the
   code — it was made by hand — and reconciliation refuses it. Either adopt it into the
   allowlist with a reason, or remove it by hand after checking `cgroup.procs`. Do not widen the
   pattern to make it disappear: the allowlist is what stops an operator typo from deleting the
   worker's own leaf.

## 7. Reproducing the two demonstrations

One script prints the verdict for whatever process it runs in:

```bash
# refusal — from a login/tmux scope
pnpm enforcement:check          # exit 1, verdict REFUSED, checks named
# acceptance — inside the delegated leaf
sudo bash infra/scripts/worker-with-cgroup.sh npx tsx infra/scripts/execution-enforcement-probe.ts
#                               exit 0, verdict VERIFIED, actual /intelligenz/worker
```

End to end, the boot refusal itself (must exit 1 and print no `worker polling`):

```bash
npx tsx apps/worker/src/main.ts
# error  execution enforcement unavailable — refusing to register with Temporal
#        code=EXECUTION_ENFORCEMENT_UNAVAILABLE
#        failingChecks=["CGROUP_PATH_UNDER_ROOT","CGROUP_MODE_ENFORCED"]
#        actualCgroup=/user.slice/…/tmux-spawn-….scope  expectedCgroupPath=/intelligenz
```

The control that proves the refusal is the gate and not a broken boot:

```bash
WORKER_ALLOW_UNENFORCED_EXECUTION=true npx tsx apps/worker/src/main.ts
# warn  execution enforcement gate DISABLED by operator flag — this process must not execute tasks
# info  worker polling
```

Measured on this host at `1cf3c58`: refusal `EXIT=1` with zero Temporal log lines; control
reached `worker polling` and was killed by `timeout` (exit 124); in-leaf verdict `VERIFIED`.

## 8. First five things to do in a cold session

1. `pnpm programme:check` — if it is not VALID, the plan has drifted; fix the document before
   trusting it.
2. `pnpm -w typecheck && pnpm -w lint` — both were clean at the end of this session.
3. Read `apps/worker/src/main.ts` lines 115–155. That block is the whole 8.3 change and it is
   commented with why each check exists.
4. `pnpm cgroups:reconcile` — confirm the two refused leaves are still the only ones, and that
   no test run has added a third.
5. Pick the next unblocked task from §4. P83-007 is the one that extends a proof that already
   exists, so it is the cheapest honest next step.

---

## Checkpoint 8.6 — the programme layer exists (2026-11-16, `b4408e8`)

**This section supersedes the "first five actions" above** — the fail-closed gate and cleanup
are done; the boundary moved.

### What changed since the section above

| Commit | What |
|---|---|
| `1cf3c58` | I/O write throttling measured on the worker leaf: 245 MB/s → 4.3 MB/s (57×) at `wbps=4194304`, process in `0::/intelligenz/worker`. `io.max` restored. |
| `2321c0d` | **The programme layer.** `Programme` / `ProgrammeTask` (`dependsOn`) / `ProgrammeCheckpoint`, parent `runProgrammeWorkflow` dispatching CHILD `runTaskWorkflow`s, `POST /programmes`. Proven: one submission → three dependent tasks, checkpoints in order, three distinct claims. Failure isolation: a failed node blocks only its dependents. |
| `b4408e8` | e2e false red removed: gRPC retry timer no longer outlives the channel (`TEMPORAL_RPC_MAX_ATTEMPTS`, default 10 unchanged). e2e 75.8 s → 24–40 s. |

### Read this before writing code

1. `docs/engineering/phase8-autonomy/EXISTING-ARCHITECTURE-MAP.md` — measured, not proposed.
2. `apps/worker/src/workflows/run-programme.ts` — the parent. It **dispatches and awaits; it
   never authorises.** The claim, approval binding and launch-site gate stay in `runTaskWorkflow`.
3. `apps/worker/test/programme-execution.test.ts` — the three-task E2E. Every assertion reads
   **database rows**, never the return value.
4. `apps/worker/test/contract.test.ts` — exact-match on all **ten** activity names. Adding an
   activity without updating `PHASE-2-CONTRACT.md` §16 fails here, by design.

### What is NOT done, and the order I would take it

1. **No planner.** A human or client supplies the graph. The validator
   (`packages/contracts/src/programme-graph.ts`) is pure and planner-independent, so an LLM
   planner can be added and judged by the same five rules. This is the biggest remaining gap
   between "continues without a prompt" and "autonomous".
2. **Approval-gated nodes do not resume.** A HIGH node records `waiting_for_approval` and the
   programme ends `blocked`. Making the scheduler spend a grant would let it authorise
   execution — a governance decision, not a patch.
3. `P83-007` per-attempt `io.max` and `P83-008` per-attempt accounting — needed before
   `maxConcurrent > 1` is safe. The seam exists (default 1, ceiling 4).
4. `P83-003/004` — host privilege. **BLOCKED on operator authorisation**, not on code.
   `sudo -n true` still returns root.
5. `P83-011` — two Phase 7 documents the matrix still cites but that do not exist.

### Traps that cost time last session

- Do **not** set `TMPDIR` to a longer path: the broker unix socket limit is 107 bytes and a
  longer root produced 11 false failures.
- cgroup enforcement is tier-by-launch: run `infra/scripts/worker-with-cgroup.sh` or the worker
  refuses (correctly).
- A leaked `sh -c while :; do :; done` from a cpu-budget run spun for 36.7 h before it was
  found. Check `ps` before blaming the host.
- `oom3-687854` is empty but its two-segment name is produced by no code path — refused, not
  guessed.

### Verify a cold start in one command

```bash
pnpm -w typecheck && pnpm -w lint && pnpm -w test && pnpm --filter @intelligenz/api test:e2e && pnpm programme:check
```

---

## Checkpoint 8.7 — governed planner, and the authority review that came first (2026-11-16, `0b68b9b`)

**This section supersedes Checkpoint 8.6's "what is not done" list.** The planner exists,
the programme authority boundary was reviewed and repaired, and the Continue-As-New
boundary has been crossed in a test.

### Verified state

| Fact | Value |
|---|---|
| Branch | `phase-6/trust-boundary-closure` |
| Code head | `0b68b9ba11c9d96e128cd143156f2868b8ba74fa` |
| Worktree | clean |
| Models / migrations | 19 / **11** (both dev and `_test` up to date) |
| Activities | 10 (contract test asserts exact match) |
| Ledger | VALID, phase 8.7, 26 tasks (13 completed, 5 blocked, 8 planned) |
| Suite | 96 files, 1064 passed, 15 skipped (skip budget = baseline) |
| API E2E | 159 passed, exit 0 ×3, 21 s each |
| Production | **NO-GO** |

### What changed

| Commit | What |
|---|---|
| `34eaedf` | Seven authority defects closed. Children now run under `task-<taskId>`, so cancellation reaches them; a retried reservation answers `reserved`; a child that never starts is compensated; a terminal programme refuses reservation; held-elsewhere is `blocked`, not `failed`; a checkpoint cannot be relabelled; the `PROGRAMME_AUTHORITY_REFUSED` arm has a test. |
| `fced403` | Proposal contract: strict schema, reuses `validateProgrammeGraph`, canonical hash. |
| `0a222ba` | `POST/GET /plans`, approve/submit/reject. Approval creates no execution rows; four-eyes via `org-policy`; hash-bound; no retries inside the provider. |
| `0b68b9b` | `Programme.failureCode`; Continue-As-New crossed (3 runs, 2 crossings) with a negative control. The test forced a fix to the per-execution counter that would otherwise have continued for ever. |

### Read these before writing code

1. `docs/engineering/phase8.7-governed-planner/PHASE87-REPORT.md` — the full report, including what is NOT proven.
2. `docs/engineering/phase8.7-governed-planner/PROGRAMME-TRANSITIONS.md` — the seven statuses and every legal edge, with writers.
3. `apps/api/src/plans/plans.service.ts` — `approve()` deliberately contains no call to tasks, programmes or the orchestrator. Do not add one.
4. `apps/worker/test/programme-continue-as-new.test.ts` — the only proof the boundary works. Do not "simplify" it to a helper assertion.

### What is NOT done, in the order I would take it

1. **P87-011 — an unexplained E2E failure.** `approval-attempt-binding.e2e-spec.ts` → "reserves exactly one attempt and one grant" failed once in eight runs, passed seven times after, and passed in isolation. The assertion was never captured. Reproduce it before trusting a green suite; a flaky authority test is worse than a red one.
2. **P87-010 — no programme cancel endpoint.** Cancelling a task reaches a programme child now, but nothing cancels `programme-<id>`. The workflow's cancellation arm exists and is untested.
3. **P87-012 — the deadline path returns a status the row does not hold** (`blocked` vs `timed_out`). Small, pre-existing, disclosed.
4. **P87-009 — approval resumption is BLOCKED on decisions D1–D3** in `APPROVAL-RESUMPTION-DESIGN.md`. Do not implement it without them.
5. **P83-007/008 remain open.** `maxConcurrent` is still 1. Do not raise it.
6. **No real planner was run.** The `http-llm` provider is unconfigured; every planner test used a local stub. "The planner works" means the governed pipeline works, not that a model produced a good plan.

### New traps

- `packages/contracts` is bundled into the Temporal workflow sandbox. A `node:crypto` import anywhere in the barrel breaks worker start. `plan-hash.ts` is a separate subpath export for exactly this reason; keep it out of `index.ts`.
- `describe()` in `@temporalio/client` 1.25.0 does **not** expose `continuedExecutionRunId`. Read the link from `WorkflowExecutionContinuedAsNew.newExecutionRunId` in the closing run's history.
- `Plan` has RESTRICT foreign keys; any suite that drops tenants must delete plans first (`apps/api/test/helpers/tenancy.ts`).

### Verify a cold start in one command

```bash
pnpm -w typecheck && pnpm -w lint && pnpm -w test && pnpm --filter @intelligenz/api test:e2e && pnpm programme:check
```

---

## Checkpoint 8.8 — cancellation, deadline truthfulness, and an honest non-reproduction (2026-11-16, `d7a817d`)

**This supersedes the 8.7 "what is not done" list** for P87-010, P87-011 and P87-012.

### Verified state

| Fact | Value |
|---|---|
| Branch | `phase-6/trust-boundary-closure` |
| Code head | `d7a817d61a06` |
| Worktree | clean |
| Ledger | VALID, phase 8.8, 32 tasks (15 completed, 6 blocked, 11 planned) |
| Suite | 98 files, 1073 passed, 15 skipped (skip budget = baseline) |
| API E2E | 167 passed, exit 0 ×3 (~22 s) |
| Production | **NO-GO** |

### What changed

| Commit | What |
|---|---|
| `7fa4dd9` | P87-011: the failing test now prints statuses, codes and row counts on failure. **No assertion changed.** Investigation in `phase8.8-operations/`. |
| `78c7ff2` | P87-010: `POST /programmes/:id/cancel`. The writer of the terminal state is decided by `startedAt` — workflow if started, API if not. |
| `ad1e54d` | P87-010 tests: 4 worker + 8 API, asserting rows and the no-orphan invariants. |
| `701d134` | P87-012: unparseable deadline fails closed; the deadline and `GRAPH_INVALID` paths return the status the row holds. |
| `d7a817d` | P87-012 proof and limitations. |

### Read these before writing code

1. `docs/engineering/phase8.8-operations/PHASE88-GATE-MATRIX.md` — the state of every gate, including the ones that did not move.
2. `docs/engineering/phase8.8-operations/P87-011-APPROVAL-BINDING-INVESTIGATION.md` — why a green suite does **not** close it, and the deadlock that was disproven.
3. `docs/engineering/phase8.8-operations/PROGRAMME-CANCELLATION-CONTRACT.md` §2 — the single-writer table. Do not let the API write a terminal status for a started programme.
4. `apps/worker/src/workflows/run-programme.ts` `summarise(state, committed?)` — the override exists because the row is the record.

### What is NOT done, in priority order

1. **P87-011 is blocked on a captured occurrence**, not on an unknown cause. Do not "fix" it; do not close it because the suite is green.
2. **P88-001** — a cancelled programme can leave one `ProgrammeTask` at `running` with no live execution (known limitation 6.2 of P87-010). The current test asserts `stranded <= 1`; the target is 0.
3. **P88-003** — `P2034`/`P2028` are unmapped, so a transaction conflict answers 500.
4. **P88-002** — the deadline is not visible to an operator and a re-start recomputes the 6-hour budget (limitation L1). Needs a decision, not a column.
5. **P87-009 is BLOCKED_POLICY** on D1–D3 in `APPROVAL-RESUMPTION-DECISIONS.md`.
6. **Phase 9 ingestion is NOT RUN**: no PostHog SDK, no PostHog tool in this session, project identity unverified. Do not build a dashboard.
7. **P83-003/004, P83-005, P83-006, P83-007/008, P83-011** — unchanged.

### New traps

- The two P87-011 tools live in `apps/api/test/manual/` and are **not collected** (`vitest.config.mts` includes only `**/*.e2e-spec.ts`). Run them by hand; `run-deadlock-probe.ts` exits **1** when there is no deadlock — that is the answer, not a crash.
- `eslint.config.mjs` grants `no-console: off` **only** to `apps/api/test/manual/**`. Do not widen it.
- `prettier --check` is red on `approval-attempt-binding.e2e-spec.ts` at the *previous* commit too. It is pre-existing; do not reformat around assertions.
- `Date.parse` returns `NaN` for junk and every comparison with `NaN` is false. Any new time bound must check `Number.isFinite` first — that was a real fail-open bug.

### Verify a cold start in one command

```bash
pnpm -w typecheck && pnpm -w lint && pnpm -w test && pnpm --filter @intelligenz/api test:e2e && pnpm programme:check
```

---

## Checkpoint 8.9 — an operator preview, and the reliability work it displaced (2026-11-16, `430c39d`)

### Verified state

| Fact | Value |
|---|---|
| Branch | `phase-6/trust-boundary-closure` |
| Code head | `430c39d` (web preview) |
| Worktree | clean after the documentation commit |
| Ledger | VALID, phase 8.9, 35 tasks (17 completed, 6 blocked, 11 planned, 1 ready) |
| Web gates | typecheck 0, lint 0, 30/30 preview tests, next build pass |
| Production | **NO-GO** |

### The preview

- Page: `/preview` — **server-rendered**, reads the ledger from disk and `127.0.0.1:4100/health/ready`. No browser→API call, which is why the API stays private.
- URL: `https://sci-imagination-velocity-nhs.trycloudflare.com` (ephemeral — if it is dead, read the current one from `/tmp/opencode/preview/cloudflared.log`).
- Gate 1: Cloudflare `--allowed-mail` (verified to exist in cloudflared **2026.11.0**).
- Gate 2: HTTP Basic on `/preview` only; credentials in `/tmp/opencode/preview-credentials.txt` (mode 600, outside the repo). Rotate by editing the file and restarting `next start`; no rebuild needed.
- Stop: `kill "$(cat /tmp/opencode/preview/cloudflared.pid)"` after `ps` identity check.
- Documents: `docs/engineering/phase8.9-operator-preview/` — report, data contract, security review, verification matrix, P88-001 residue.

### What is NOT done, in priority order

1. **P88-001 is `ready`, not done.** Root cause: `reserveProgrammeTaskActivity` writes `ProgrammeTask.status='running'` inside the reservation transaction, and only a checkpoint can clear it; a cancellation in between strands the node. The fix design (settle in-flight nodes inside `finishProgrammeActivity`, one transaction, no new activity) is in `P88-001-CANCELLATION-RESIDUE.md`. Target: the cancellation test asserts **0** stranded nodes, not `<= 1`.
2. **P88-003** — `P2034`/`P2028` still unmapped; a transaction conflict answers 500.
3. **P88-002** — deadline still invisible to operators.
4. **P87-011** — still blocked on a captured occurrence; no new evidence.
5. **P87-009** — still BLOCKED_POLICY on D1–D3.
6. **P89-003** — the preview has not been opened from a real phone; headless only. The authorised-email leg is the operator's first visit.
7. Phase 9 ingestion — NOT RUN (no SDK/tool/project identity).

### New traps

- **Never stop processes by pattern.** A `pkill -f "pnpm start"` during this cycle killed the API and could have hit anything. Use the recorded PID.
- The web app is a **client-side SPA** for its existing screens: `src/lib/api.ts` calls `http://localhost:4100` **from the browser**. Any tunnel of 3100 alone breaks those screens on a phone. `/preview` exists because it fetches server-side; do not "fix" it by exposing 4100.
- `next start` serves a **prebuilt** `.next`: a new route needs a rebuild, and Basic-auth env vars are read at **runtime** (restart, not rebuild).
- `cloudflared` is a user binary at `~/.local/bin/cloudflared`, not a system package.
- The ledger's `head` names the last code commit; the checkout can be newer by documentation commits. The preview shows both rather than assuming they match.

### Verify a cold start in one command

```bash
pnpm -w typecheck && pnpm -w lint && pnpm -w test && pnpm --filter @intelligenz/api test:e2e && pnpm programme:check
```

### Preview follow-up (2026-11-17) — the tunnel lands on the dashboard

Opening the tunnel root used to show the tenant app's `/login`, whose **client bundle** calls
`NEXT_PUBLIC_API_URL=http://localhost:4100` from the visitor's browser. On a phone that is the
phone itself, so it failed with "The API could not be reached." The API is deliberately not
exposed to make login work: that would put the mutating app on a public ingress.

Instead, `apps/web/src/middleware.ts` redirects `/` and `/login` to `/preview` **only** when the
Host ends in `.trycloudflare.com` (307). Every other host — localhost, 127.0.0.1, any real
domain — is unchanged. `/preview` keeps Basic auth; the matcher widening is paired with an
`if (!isPreviewPath) return NextResponse.next()` so `/` and `/login` never reach the auth block.

Consequence to remember: **the full app is not reachable through the tunnel, by design.** If
someone needs it remotely, that is a separate decision with its own exposure review — not a
middleware tweak.

### Preview access, corrected (2026-11-17)

The operator could not get in on a phone. Two causes, both fixed:

1. **The redirect named the wrong origin.** `new URL('/preview', request.url)` emitted the
   *server's* origin (`http://localhost:3100/preview`), so a phone was told to retry on its own
   loopback. Replaced with an internal **rewrite** — no `Location`, so there is no absolute origin
   to get wrong. Tunnel detection accepts `cf-connecting-ip` as well as the host suffix, because
   the forwarded `Host` is the uncertain part.
2. **A second password gate.** Basic auth on `/preview` was the step that blocked the phone, and
   its password had appeared in a chat transcript. Removed; **Cloudflare Access is the only gate**.

Also fixed while checking: the **API listened on `0.0.0.0:4100`**, so anything on the LAN could
reach it directly and bypass the tunnel. It now starts with `API_HOST=127.0.0.1`; the web binds
`127.0.0.1:3100` through `pnpm start:preview`.

Verify with: `ss -ltnp | grep -E ':3100|:4100'` → both `127.0.0.1`. If either shows `0.0.0.0`,
the tunnel is not the only way in.
