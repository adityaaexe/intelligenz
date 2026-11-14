# Phase 5 — Test Results (this cycle)

All commands run in `/home/ubuntu/intelligenz` on `phase-5/isolation-readiness`.

## Gates, final run

| Command | Exit | Counts |
|---|---|---|
| `pnpm -w typecheck` | 0 | 10 projects, API test tsconfig now included |
| `pnpm -w lint` | 0 | `--max-warnings=0` |
| `pnpm -w test` | 0 | **69 files, 748 passed, 15 skipped (763)** |
| `pnpm --filter @intelligenz/api test:e2e` | 0 | **7 files, 97 passed** |
| `pnpm -w build` | 0 | api + web + worker |
| `pnpm audit --audit-level high` | 0 | 0 high/critical; 1 low, 2 moderate remain |
| `bash infra/scripts/check-spawn-discipline.sh` | 0 | 5 blocked, 1 allowed |

## New suites this cycle

| Suite | Tests | Result |
|---|---|---|
| `packages/workspace-manager/test/volumes.test.ts` | 16 | PASS |
| `packages/workspace-manager/test/output-cap.test.ts` | 24 | PASS |
| `apps/worker/test/cpu-budget.test.ts` | 16 | PASS (13 + 3 tier-gated) |
| `apps/worker/test/isolation.test.ts` | 13 | PASS |
| `apps/worker/test/isolation-gate.test.ts` | 4 | PASS (1 observed flake) |
| `apps/api/test/isolation-reporting.e2e-spec.ts` | 6 | PASS |
| `apps/api/test/approval-attempt-binding.e2e-spec.ts` | 12 | PASS |
| `apps/worker/test/approval-attempt-binding.test.ts` | 17 | PASS |

## CPU: rate vs lifetime — the distinction, asserted

| Scenario | Result | Reason recorded |
|---|---|---|
| Under lifetime budget | not killed | `completed` |
| Exactly at budget | not killed | within budget by contract |
| One microsecond over | killed once | `cpu_budget` |
| `cpu.max`-throttled, under lifetime budget | **not** a budget kill | `completed` / `crashed` |
| Wall-clock exceeded | killed | `timed_out` |
| `cpu.stat` unreadable | no kill, no invented reason | unknown |

The third and fourth rows are the regression that matters: a throttled run must never be reported as budget exhaustion.

## Isolation refusal — measured side effects

A `vm` profile on this host produces, in the database:

```
ExecutionAttempt   1  (failed, executionProfile='vm',
                       terminationReason='isolation_unavailable', agentRunId=null)
AgentRun           0
ExecutionWorkspace 0
ToolInvocation     0
```

Refusal happens before provisioning, before any broker request, and before the single `runtime.execute` call site.

## Skips, and why they are not passes

| Skipped | Reason |
|---|---|
| 11 provider-gated contract cases | `IZ_REAL_PROVIDER` unset — no live provider in the default suite |
| 3 cgroup tier cases | cgroup tier is `limited` outside `worker-with-cgroup.sh`; run separately under the wrapper |

Skipped is not passed. The provider-gated and cgroup-gated tests are listed here so a green total cannot hide them.

## Flake

`isolation-gate.test.ts > proceeds under restricted-shared-kernel and records the effective tier` failed once in four runs, passed 3/3 afterwards. Suspected volume-pool contention after the full suite. Recorded as a pending defect, not as noise.
