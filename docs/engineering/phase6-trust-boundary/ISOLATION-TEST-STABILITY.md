# Isolation test stability

**Subject:** `apps/worker/test/isolation-gate.test.ts`
**Symptom inherited from Phase 5:** one failure in four runs, followed by three
green runs. Three green runs after one red run is not stability, and the recorded
cause — "volume-pool contention suspected" — was a guess.

**Result: root cause established, and it was not contention. The test was asserting
a deterministic outcome on a deliberately non-deterministic subject.**

## The rejected hypothesis

Phase 5's remediation register (O11) blamed volume-pool contention. Measured
before assuming:

| Check | Command | Result |
|---|---|---|
| Stray leases | `find /var/lib/intelligenz/mnt -name .intelligenz-lease \| wc -l` | **0** |
| Volume usage | `df -h /var/lib/intelligenz/mnt/vol-*` | all 8 volumes at **1%** |
| Failure rate | 6 serial runs | **1/6 = 16.7%** |

Zero stray sockets and effectively empty volumes are not the signature of pool
contention. The hypothesis was wrong.

## The actual cause

`packages/agent-runtime/src/runtimes/local-simulated.ts` deliberately injects
failure:

```
digest = sha256(taskId ␀ goal)            // local-simulated.ts:163
fails when hexModulo(digest, 0, 1000) < 150  // local-simulated.ts:326-333
```

The isolation fixture minted a **fresh UUID task id per run**, so which bucket a
run landed in was a coin flip. Measured over 3,000 task ids: **443 failures =
14.77%**, against **1/6 = 16.7% observed**. The observed rate and the designed
rate agree.

The test asserted `expect(result.status).toBe('succeeded')` on a subject that
failed ~1 run in 6.8 by design. That is a **test defect**, not an implementation
defect: no retry, sleep, or weakened assertion could have made it correct.

## The fix

The runtime documents three levers for forcing an outcome
(`local-simulated.ts §"Forcing the failure bucket"`). The third is per-task and
needs no global switch:

> A goal containing `[simulate:fail]` always fails, `[simulate:ok]` always succeeds.

`apps/worker/test/isolation-gate.test.ts:246-259` now uses a goal carrying
`[simulate:ok]`. The marker is checked **before** the hash, so it is
deterministic.

**No assertion was changed.** `expect(...).toBe('succeeded')` stands, every other
assertion in the test stands, and no retry or sleep was added.

## Evidence

```bash
for i in $(seq 1 10); do npx vitest run apps/worker/test/isolation-gate.test.ts; done
```

```
FINAL pass=10 fail=0 of 10
10 × "Tests  4 passed (4)"
```

Re-run after all Phase 6 code was in place: **10/10**. Later, 5 further runs
alongside `isolation.test.ts`: **17/17 tests, 5/5 runs**.

## Classification

| Question | Answer |
|---|---|
| Implementation defect? | **No.** `LocalSimulatedRuntime` behaved exactly as documented. |
| Test-isolation defect? | **Yes.** Random `taskId` + a designed 15% failure bucket + an assertion of success. |
| Fixed by suppression? | **No.** No retry, no sleep, no `skip`, no weakened assertion. |
| Stable now? | **Yes** — 15 consecutive green runs across two sessions. |

## Correction to the Phase 5 record

`docs/engineering/phase5-recovery/REMEDIATION-REGISTER.md` O11 previously read
"volume-pool contention suspected". It has been corrected to the measured cause
and notes that the earlier hypothesis was wrong. The Phase 5 report is not
otherwise rewritten: the flake was real, and it was discovered there.

## Residual

The failure bucket is a legitimate product behaviour in the simulated adapter. Any
future test that asserts a *specific* outcome against `LocalSimulatedRuntime` must
use a marker or the environment override, or it will re-introduce this class of
flake. This is a property of the adapter, not a defect to remove.
