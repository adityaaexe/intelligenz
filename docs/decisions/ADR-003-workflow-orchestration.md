# ADR-003 — Workflow orchestration

Status: Accepted
Date: 2026-11-13

## Context

An agent run is a long, expensive, side-effecting operation. It can take minutes to tens of minutes, it costs money per token, and it produces artifacts that must not be duplicated by a retry. The process running it will be restarted — by a deploy, a crash, or an operator.

Three things must hold:

1. A run survives process death and resumes without duplicating irreversible work.
2. A transient failure is retried, a deterministic rejection is not.
3. Cancellation reaches the running work and leaves the task in a terminal, auditable state.

**Environment constraint, not a preference:** Docker is absent. There is no container runtime, so there is no containerised Temporal cluster. The available option is `temporal server start-dev`, a single binary with a SQLite-backed store.

## Decision

Use **Temporal TypeScript SDK** with the **dev server** (`temporal server start-dev --db-filename .temporal/dev.db --port 7233 --ui-port 8233`).

One workflow: `runTaskWorkflow(taskId, orgId)`.

```
validateTask ─► recordStart ─► executeAgent ─► persistResult ─► emitEvent ─► complete
```

- `executeAgent` is an **activity**. Everything that touches the network, the filesystem, the database, or a clock is an activity.
- Activities are idempotent, keyed by `taskId` (plus attempt).
- Retry policy: `maximumAttempts: 3`, exponential backoff, `initialInterval: 2s`, `backoffCoefficient: 2`, `maximumInterval: 30s`.
- Timeouts: `startToCloseTimeout: 15m`, `scheduleToCloseTimeout: 20m`, `heartbeatTimeout: 30s`.
- Non-retryable failures use a typed `ApplicationFailure` with `nonRetryable: true`: validation failure, budget exhausted, permission denied, task already terminal. Retrying a deterministic rejection three times wastes money and delays the truth.
- Cancellation: Temporal cancellation scope → activity `AbortSignal` → runtime `cancel()` → task `cancelled` + audit event.

### The sandbox rule that governs the file layout

Temporal's TypeScript worker executes workflow code in a deterministic V8 sandbox. Workflow files **must not** import `@prisma/client`, `node:fs`, `node:crypto`, or call `Date.now()` / `Math.random()` directly. Any nondeterminism must come from an activity result.

This is not a style rule — it fails at runtime with a sandbox error that is easy to misdiagnose. Therefore:

```
apps/worker/src/
  workflows/run-task.workflow.ts     # imports: @temporalio/workflow, @intelligenz/contracts only
  activities/                         # may import database, fs, crypto, agent-runtime
  worker.ts                           # registers both
```

### What durability buys here

The product's claim is that any outcome traces back to the instruction that caused it. Temporal's event history is a **replayable execution record** — what ran, when, how many attempts, what each returned. That is evidence, not just plumbing. An in-process queue would require reconstructing the same narrative from logs, after the fact, and would be wrong whenever a process died mid-write.

## Consequences

### Positive

- Work survives restarts; a deploy does not lose in-flight runs.
- Retry semantics are declarative and visible in the Temporal UI (8233), which is also the debugging surface.
- Cancellation is real: a scope propagates into the activity, not a flag polled by convention.
- Run history is durable and queryable, and becomes the backbone of the "what happened" evidence trail.
- Timers (timeouts, retries, scheduled work) need no cron.

### Negative / costs

- **New operational dependency** with a real learning curve: determinism, versioning, replay, and activity idempotency are all disciplines the team must acquire.
- **Dev server is not production.** SQLite store, single process, no HA, no retention policy. Crash or delete `.temporal/dev.db` and all history is gone. Every durability claim in Phase 2 is scoped to "survives worker restart", never "survives host loss".
- **Workflow versioning is now a permanent obligation.** Changing workflow code while runs are open requires `patched()` or version gates. A team that ignores this breaks in-flight runs silently.
- Extra latency: every step is a persistence round trip. A five-step workflow is slower than five function calls.
- Debugging requires reading a history, not a stack trace.
- The 15-minute `startToCloseTimeout` is a guess. A real coding agent may exceed it, which forces either a longer timeout or a heartbeat-and-continue pattern. Unknown — must be resolved with the first real runtime.

## Alternatives considered

**BullMQ on the available Redis 8.** Rejected. It is genuinely simpler and Redis is already running, but: retries are at-least-once with no per-attempt history, there are no durable timers, cancellation is a cooperative convention rather than a propagated scope, and the audit trail would have to be reconstructed from worker logs. For a product whose differentiator is provable execution history, that is the wrong trade.

**In-process queue (`setTimeout` + a table of pending jobs).** Rejected outright. Any deploy loses work, and the "resumed" state after a crash is indistinguishable from a hung task.

**Postgres-backed queue (`pgboss` / `graphile-worker`).** A serious contender: one fewer dependency, transactional enqueue with the state change, and it is durable. Rejected because it provides no execution history model and no cancellation semantics beyond a status column; the workflow would still have to be reconstructed as a state machine by hand. Revisit if Temporal's operational cost proves disproportionate to one workflow.

**Temporal Cloud.** Rejected — no account, no credentials, no budget authorisation. Not a technical rejection.

**AWS Step Functions / GCP Workflows.** Rejected — same credential and budget block, plus vendor lock-in to a state language that cannot run TypeScript activities natively.

## Revisit trigger

Revisit when (a) more than five workflows exist and dev-server history loss starts to matter, (b) a real runtime needs executions longer than 15 minutes, or (c) a second host makes the dev server a single point of failure for execution. The first two are near-term.
