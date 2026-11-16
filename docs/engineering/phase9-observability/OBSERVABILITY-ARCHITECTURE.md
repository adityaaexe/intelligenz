# Phase 9 — observability architecture

**Status: design. OpenTelemetry is not installed in this repository** (no dependency, no
exporter, no instrumentation). Nothing below is running.

---

## 1. What already exists, measured

| Capability | State |
|---|---|
| Structured logs | `pino` in the API, `@temporalio/worker` logger in the worker, `logLevel: 'silent'` in tests |
| Correlation | `correlationId` is created per request and flows into audit rows, workflow input, activity input and `WorkflowRun` |
| Audit trail | `AuditEvent` with deterministic idempotency keys — the authoritative record |
| Execution identity | Temporal workflow id + run id; `ExecutionAttempt.claimedByWorkflowId/RunId` |
| Resource accounting | `ExecutionAttempt.cpuTimeMs`, `memoryPeakBytes`, `pidsPeak`, `terminationReason`, `cleanupState` |
| Distributed tracing | **none** — no trace id, no span, no propagation header |
| Metrics endpoint | **none** — the API exposes `/health`/readiness only |

## 2. The boundaries a trace must cross

```
HTTP request (API)
  └─ program/plan decision (service, one transaction)
      └─ Temporal start (client)
          └─ runProgrammeWorkflow (scheduler)
              └─ reserveProgrammeTaskActivity
              └─ child runTaskWorkflow  ──► its six activities
                  └─ executeAgentActivity
                      └─ provider call (opencode-cli / simulated)
                  └─ persistResult / emitEvent / completeTask
              └─ recordProgrammeCheckpointActivity
              └─ finishProgrammeActivity
```

A trace that stops at the Temporal boundary answers "the API was fast" and nothing else.
The interesting latency and failure live inside the workflow and the adapter.

## 3. Identity design

| Field | Existing | Plan |
|---|---|---|
| `correlationId` | yes, end to end | keep; becomes the trace's business correlation |
| `trace_id` / `span_id` | no | W3C `traceparent` injected at the API edge, carried in workflow input, extracted in activities |
| `programmeId` / `taskId` / `attemptId` | yes | span attributes, not high-cardinality metric labels |
| Temporal linkage | workflow id + run id | span attributes `temporal.workflow_id`, `temporal.run_id` |

Rules:

- `trace_id` is **not** a database column. An audit row that needs it records it in the
  payload; a column would imply an index and a retention policy nobody has decided.
- High-cardinality ids (task, attempt) are span attributes, never metric dimensions.
- The `correlationId` already survives Continue-As-New because it is workflow input; the
  trace id must be carried the same way or spans will not join across a boundary.

## 4. What to instrument first, in order

1. **API edge**: one server span per request, with route and status only. No request bodies.
2. **Temporal client start**: a span per start, with workflow id and type.
3. **Worker**: an activity interceptor that opens a span per activity from the propagated
   context, with activity type and attempt number.
4. **Adapter call**: one span around the provider invocation, with duration and outcome. No
   prompt or output content.
5. **Programme lifecycle**: spans for `reserve`, `checkpoint`, `finish`; the checkpoint
   sequence as an attribute.

Deliberately last: per-task child workflow spans. They are numerous, and the parent's
checkpoint already records the child's run id, which is enough to join by hand until volume
justifies the cost.

## 5. Metric candidates, once tracing is real

| Metric | Type | Labels | Why |
|---|---|---|---|
| `programme_duration_seconds` | histogram | status, reason_code | is the scheduler getting slower |
| `programme_blocked_total` | counter | reason_code | the approval/dependency split |
| `task_dispatch_latency_seconds` | histogram | risk_class | queue wait vs execution |
| `attempt_failures_total` | counter | error_class, adapter | where failures concentrate |
| `approval_wait_seconds` | histogram | risk_class | governance latency, not engineering latency |

No label may be a free-text field. `reason_code` is the enum from `Programme.failureCode`.

## 6. Error reporting

PostHog error tracking is proposed only after ingestion is verified (§5 of the telemetry
contract). Until then, errors are the API's exception filter, the worker logger, and the
audit trail. An error-tracking integration that has never received an event is not an error
reporting capability.

## 7. Gates

| Gate | Status |
|---|---|
| OTel SDK installed | **no** |
| Trace propagation across the Temporal boundary | **no** |
| One end-to-end trace observed for a real programme | **NOT RUN** |
| Metrics endpoint | **none** |
| Retention / sampling policy | **undecided** |
| PII review of span attributes | **not done** — must precede any export |

Until the first end-to-end trace is observed, "observability" is a folder name.
