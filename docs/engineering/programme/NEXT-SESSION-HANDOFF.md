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
