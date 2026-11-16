# Phase 9 — cost model

**Status: model only. No cost figure in this repository is measured, and none is claimed.**
There is no billing integration, no token accounting and no provider invoice ingestion.

---

## 1. What is measurable today

| Input | Source | Quality |
|---|---|---|
| CPU time per attempt | `ExecutionAttempt.cpuTimeMs` (supervisor-reported) | measured, but only for attempts that reached a supervisor |
| Peak memory per attempt | `ExecutionAttempt.memoryPeakBytes` | measured, same caveat |
| Peak process count | `ExecutionAttempt.pidsPeak` | measured |
| Termination reason | `ExecutionAttempt.terminationReason` | enum, measured |
| Wall clock per attempt | `startedAt` / `finishedAt` | measured |
| Retry count | `attemptNumber`, `ProgrammeTask.attemptCount` | measured |
| Token usage | — | **not recorded anywhere** |
| Provider charge | — | **not available**; the adapter reports a simulated flag, not a bill |
| Host cost | — | **not attributed**; no node/hour rate is configured |
| Database / storage / network | — | **not measured** |

Therefore: per-attempt **resource** cost is partly measurable, per-attempt **money** is not.

## 2. Categories the model must keep separate

Mixing these produces a number that cannot be acted on.

| Category | Unit | Measured now | Would require |
|---|---|---|---|
| Model tokens | input/output tokens × price | no | adapter must report usage; price table per model |
| Provider charges | currency | no | provider billing export or API |
| Execution host | CPU-seconds, and node-hours when shared | CPU ms yes; node-hours no | a host rate and an allocation rule |
| Database | storage + IOPS + connection hours | no | provider metrics |
| Object/artifact storage | bytes-month | no | bucket metrics |
| Network egress | bytes | no | egress counters |
| Retries | duplicated work | count yes, cost no | token/cpu attribution per attempt |
| Verification | test minutes | no | CI timing |
| Failed attempts | wasted spend | count yes, cost no | same as retries |

A "cost per programme" that silently omits retries and failures is an optimistic number
presented as a measurement. The model must state which categories are included.

## 3. Definitions

- **Attempt resource cost** = `cpuTimeMs` × host CPU rate + `memoryPeakBytes` × seconds ×
  memory rate. Only computable once a host rate exists.
- **Programme cost** = Σ attempt resource cost + Σ provider charges + allocated shared cost.
  The allocation rule for shared cost is a policy decision, not a formula to invent.
- **Wasted cost** = cost of attempts whose `terminationReason` is not `completed`, plus
  duplicate attempts for the same task.
- **Cost per successful task** = total programme cost ÷ tasks `succeeded`. A programme that
  is `blocked` has no denominator; reporting `∞` or `0` would both be wrong — report "not
  applicable".

## 4. What a dashboard may show, and when

| Panel | Allowed when |
|---|---|
| CPU-seconds per programme | now — provided by `ExecutionAttempt.cpuTimeMs`, with a stated coverage caveat |
| Attempts and retries | now |
| Termination reason distribution | now |
| Wasted CPU | now, defined as §3 |
| Token usage | only after adapters report usage |
| Money | only after a price table exists **and** is dated |
| Cost trend | only after two periods of the same measurement |

Every panel must carry the date range it covers and the categories it includes.

## 5. Known unknowns that block a money figure

1. No adapter reports token counts.
2. No price table exists for any model, and prices change; a hard-coded price is a stale
   price.
3. No host rate is configured, so CPU-seconds cannot become currency.
4. Provider charges may include non-token items (storage, egress) that nothing here observes.
5. The simulated adapter consumes no provider spend at all, so a development figure is not a
   production figure.

## 6. Instrumentation the model needs

- `ExecutionAttempt`: add token counts only when an adapter can report them; a nullable
  column written from the adapter's own report, never estimated.
- A `cost_snapshot` per programme computed from attempts plus a dated price table — not a
  running total that drifts when prices change.
- A `wasted_attempt` classification derived from `terminationReason` and duplicate task
  dispatch, not from a heuristic on duration.

## 7. Status

| Item | Status |
|---|---|
| Model | **defined** (this document) |
| CPU-seconds per attempt | **measured** |
| Tokens | **not recorded** |
| Currency | **not computable** |
| Dashboard | **none**, and none may show money yet |

The honest current answer to "what does a programme cost?" is: *CPU time and attempt counts,
measurable; money, not measurable with the data this system records.*
