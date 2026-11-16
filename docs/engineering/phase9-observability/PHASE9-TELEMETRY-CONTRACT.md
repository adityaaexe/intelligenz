# Phase 9 — telemetry contract

**Status: design plus a verification gate that has not been passed.**
No SDK is installed, no event has been sent, and no ingestion has been read back. This
document does not claim otherwise.

---

## 0. Prerequisite, measured

| Fact | Evidence |
|---|---|
| PostHog SDK in source or dependencies | **none** — no match for `posthog` in any `package.json`, `apps/**`, `packages/**` |
| PostHog key in `.env.example` | **none** |
| OpenTelemetry dependency | **none** — matches exist only inside `apps/web/.next` build artefacts |
| PostHog tool in this session's catalog | **none** — `search("posthog")` returns nothing |
| Project identity `693251` | **unverified** — cannot be checked without a tool or credential |
| Events ingested | **unknown/unverified**; the Phase 8.7 note that `ingested_event=false` cannot be re-confirmed here |

Consequence: every statement below is a contract, not an observation. Phase 9's
"prove ingestion" step is **NOT RUN**, and no dashboard, adoption number, funnel or
reliability metric may be derived until it passes.

## 1. Source of truth

`AuditEvent` remains authoritative. Telemetry is a projection:

```
state change + AuditEvent (same transaction)  ──►  durable record
                              └── best-effort ──►  PostHog, $insert_id = audit idempotency key
```

An event must never exist in PostHog without an audit row. A failed projection loses a
metric, never a governance record. This is the same rule as
`docs/engineering/phase8.7-governed-planner/TELEMETRY-EVENT-CONTRACT.md`; Phase 9 extends the
taxonomy, it does not replace the rule.

## 2. Event taxonomy

Names are the directive's. The column "exists as audit event" is measured, not assumed:
`programme.submitted.v1`, `programme.finished.v1`, `approval.*`, `task.*`, `attempt.*`,
`execution.claim*` are already written today; the rest are proposed.

### Programme

| Event | Trigger | Exists as audit | Notes |
|---|---|---|---|
| `programme.created` | `POST /programmes` commits | `programme.submitted.v1` | projection maps `source: api` |
| `programme.planned` | `POST /plans` commits `proposed` | `plan.proposed.v1` | |
| `programme.submitted` | plan submit commits a programme | `plan.submitted.v1` + `programme.submitted.v1` | emit **once**, from `plan.submitted` |
| `programme.started` | `loadProgrammeActivity` commits `pending → running` | **no** | add `programme.started.v1` |
| `programme.completed` | `finishProgrammeActivity` commits `succeeded` | `programme.finished.v1` | projection filters `payload.status` |
| `programme.blocked` | commits `blocked` | `programme.finished.v1` | carries `payload.code` (`APPROVAL_PENDING`, `DEPENDENCY_BLOCKED`, `NO_READY_NODE`) |
| `programme.cancelled` | commits `cancelled` | `programme.finished.v1` + `programme.cancel_requested.v1` | |
| `programme.deadline_exceeded` | commits `timed_out` | `programme.finished.v1` | `payload.code = DEADLINE_EXCEEDED` |

`programme.completed`, `.blocked`, `.cancelled` and `.deadline_exceeded` are **one audit
event**. The projector maps `status → event name` and must emit exactly one of the four; a
projector that emitted all four would multiply every programme by four.

### Task

`task.ready`, `task.dispatched`, `task.started`, `task.completed`, `task.failed`,
`task.retry_scheduled`, `task.waiting_for_approval`.

Existing audit events cover `created`, `status_changed`, `succeeded`, `failed`, `cancelled`,
`transition_refused`. `dispatched`, `retry_scheduled` and `waiting_for_approval` have no
audit row today; add them only where the transition is durable (a retry counter, a
checkpoint), not from a log line.

### Attempt

`attempt.claimed` (`execution.claim_granted.v1`), `attempt.rejected`
(`execution.claim_refused.v1`), `attempt.cancelled` (no audit row — add if the attempt row
records the reason), `attempt.resource_exceeded` (`ExecutionAttempt.terminationReason`),
`attempt.cleanup_completed` (`ExecutionAttempt.cleanupState`).

### Recovery

`recovery.started`, `recovery.completed`, `recovery.failed`. **No audit event exists and no
recovery subsystem exists.** These are defined for Phase 9 implementation, not emitted.

### Governance

`approval.requested`, `.granted`, `.rejected`, `.revoked`, `.expired` — all exist as
`approval.*.v1` audit events.

### Verification

`verification.started`, `.passed`, `.failed`. **No verification subsystem exists** beyond the
test suites. These are for the Phase 9 verification service; until it exists they are not
emitted, and a test-suite result must not be dressed as a product event.

## 3. Properties — the allowed set

`programme_id`, `task_id`, `attempt_id`, `org_id` (internal, not slug/email), `execution_role`,
`adapter`, `model_id`, `risk_class`, `execution_tier`, `status`, `duration_ms` (bucketed),
`retry_count`, `error_class` (enum), `cost_micros` (only when measured — see the cost model),
`occurred_at`, `correlation_id`, `trace_id`, `schema_version`.

**Never**: secrets, provider tokens, credential-store contents, environment variables, raw
source, prompts, model output, task goals/criteria, decision notes, artifact paths or
contents, stack traces, hashes derived from content.

The projector takes a typed DTO per event. `Record<string, unknown>` is not accepted: absence
of free text must be verifiable from the type, not from a runtime sample.

## 4. Deduplication and ordering

| Layer | Mechanism |
|---|---|
| Audit | deterministic `idempotencyKey` per transition (existing) |
| Projection | PostHog `$insert_id` = that key |
| Retried request | existing `Idempotency-Key` on submission/approval |

No stable key ⇒ do not emit. An uncountable event is better than a doubled one.

Ordering is not guaranteed by the transport; dashboards must not assume causality from
arrival order. Every event carries `occurred_at` from the audit row, which is the ordering
truth.

## 5. Ingestion verification — the gate

Required, in order. **None has been performed.**

1. Install the SDK (a dependency change, separately reviewed).
2. Prove the **project identity**: a write key alone does not prove the project. Compare a
   read-back event's project id with the expected one before enabling anything.
3. Send **one** clearly-labelled test event (`environment: "verification"`, a fixed
   `verification_run_id`).
4. Read it back through the same project's API, not from a local log.
5. Inspect the received properties against §3; confirm the absence of free text.
6. Confirm no duplicate arrived for one `$insert_id`.
7. Remove or isolate the test event where the platform supports it.

A dashboard built before step 5 is a drawing. A retention or adoption claim built before
step 4 is false.

## 6. What this contract deliberately excludes

- No synthetic events for adoption.
- No client-side (web) events in Phase 9: the authoritative transitions are backend.
- No PII, and no org identifier that is a customer name.
- No "all systems healthy" aggregate. Health is a query over real events, not an event.

## 7. Current status

| Item | Status |
|---|---|
| Taxonomy | **defined** (this document) |
| Audit events that back it | **partially exist** (table above) |
| Missing audit events (`programme.started`, task `dispatched`/`waiting_for_approval`) | **not implemented** |
| SDK installed | **no** |
| Project identity verified | **NOT RUN** — no tool/credential |
| Controlled event sent | **NOT RUN** |
| Event read back | **NOT RUN** |
| Dashboard | **none**, and none may be built yet |
