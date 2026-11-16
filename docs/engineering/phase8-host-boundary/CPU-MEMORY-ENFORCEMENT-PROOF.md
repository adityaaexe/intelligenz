# CPU and memory enforcement proof — Phase 8.2C

**Measured at:** `6705712`, tree clean
**Verdict: R-11 PARTIAL → PASS.** The three previously skipped cgroup kill tests executed.

---

## 1. Why they skipped

Phase 7 recorded 53 passed / **3 skipped**, with the reason: the kernel refused migration
from the active tmux cgroup. That reason was correct and the conclusion drawn from it was
not — it was read as "the host cannot enforce", when the actual condition was "the process
was launched from the wrong place".

`infra/scripts/worker-with-cgroup.sh` exists precisely for this. It:

1. requires root, and refuses otherwise (`exit 2`),
2. writes **one** pid into `${WORKER_LEAF}/cgroup.procs`,
3. `exec setpriv --reuid --regid --init-groups -- "$@"` — no fork, no window outside the leaf,
4. sets `memory.max`/`pids.max` to `max` for the supervisor itself, deliberately, so the
   supervisor is not the OOM victim when an agent misbehaves.

The privilege shape is the minimum the kernel requires: a `cgroup.procs` write is authorised
against **both** source and destination, so a process in a login/tmux scope cannot be moved
without privilege. After that single write, no root remains in the execution path.

## 2. The run

```bash
sudo bash infra/scripts/worker-with-cgroup.sh \
  env TIER=full npx vitest run apps/worker/test/cpu-budget.test.ts
```

```
 Test Files  1 passed (1)
      Tests  16 passed (16)
exit=0
```

**16 passed, 0 skipped.** Previously: 13 executed, 3 skipped.

| Metric | Phase 7 | Phase 8.2 |
|---|---|---|
| Executed | 13 | **16** |
| Skipped | 3 | **0** |
| Gate | PARTIAL | **PASS** |

The three that now run are the kill tests — the ones that assert a process is actually
**terminated** when a CPU lifetime budget is exceeded, rather than merely measured.

## 3. What this changes

**R-11 CPU/memory: PASS**, with the boundary that the tests only run through the documented
launcher. That is not a limitation to hide — it is the correct operating procedure:

- a worker started *outside* the delegated leaf cannot enforce anything,
- so the launcher is a **deployment requirement**, not a convenience.

This should be enforced rather than documented: `apps/worker/src/capabilities.ts` already
detects the tier and emits a remediation string. The gap is that nothing *refuses to start*
a worker that is outside its leaf. Recorded as a Phase 8.2 finding:

> **A worker that cannot enter its delegated leaf should fail closed at boot, not report a
> degraded tier.** Otherwise a deployment mistake silently removes CPU, memory, PID and I/O
> enforcement while every test still passes in CI.

## 4. Coverage of the 16 tests

Per the file's own structure (not re-listed here): CPU rate limiting distinct from a
cumulative lifetime budget, descendant-process accounting inside a real subtree, peak
read-back, termination on budget exhaustion, memory limit, OOM classification, and cleanup
after a forced kill.

The distinction that matters and was previously only half-proven: **`cpu.max` is a rate;
a lifetime budget is cumulative.** A rate-limited process can still consume unlimited total
CPU; only the lifetime budget terminates it. Both are now asserted on a real cgroup.

## 5. What remains unproven

1. **Per-attempt leaves under concurrent load.** The suite exercises a leaf; it does not run
   two attempts simultaneously to prove there is no cross-attempt accounting.
2. **Enforcement under swap exhaustion.** Swap is 100% consumed (see
   `HOST-RESOURCE-PRESSURE.md` when written); a memory limit interacting with a full swap
   device is not tested.
3. **Boot refusal.** As above — a worker outside its leaf still starts.

## 6. Reproduction

```bash
# requires the delegation root to exist (setup-cgroups.sh, one-time, operator-run)
sudo bash infra/scripts/worker-with-cgroup.sh \
  env TIER=full npx vitest run apps/worker/test/cpu-budget.test.ts

# confirm placement
sudo bash infra/scripts/worker-with-cgroup.sh sh -c 'grep "::" /proc/self/cgroup'
# → 0::/intelligenz/worker
```

Without the launcher, the same command reports 13 passed / 3 skipped with the migration
refusal — which is why the launcher is mandatory rather than optional.
