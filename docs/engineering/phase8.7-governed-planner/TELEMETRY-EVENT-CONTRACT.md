# Programme telemetry event contract — Phase 8.7

**Status:** design only. No emission code exists. Nothing in this document has been
observed in PostHog.

---

## 0. Why this document exists, and what it refuses to claim

PostHog's connected project (`Default project`, id `693251`) reports
`ingested_event = false`, and the listed events have not been observed in the last 30
days. That is the measured state. It means:

- there is **no adoption metric** for programmes, plans or tasks;
- no dashboard built today would display programme data;
- any sentence of the form "programmes are being used" is unsupported.

Two failure modes are being avoided here, in order of severity:

1. **Fabricated activity.** Sending synthetic events to populate a dashboard would make
   the absence of usage invisible. Prohibited.
2. **Silent content leakage.** A planner receives a free-text objective. Telemetry that
   carried objectives, goals, acceptance criteria, prompts or model output would ship
   user content to a third party under the label "analytics".

The contract below is therefore **content-free by construction**: every property is a
count, an enum, an id, or a duration.

## 1. One source of truth

The authoritative record of a lifecycle transition is the `AuditEvent` row written in
the same transaction as the state change, with a deterministic idempotency key.

Telemetry is a **projection** of audit events, never a parallel truth:

```
state change + AuditEvent  ──(same transaction)──►  durable record
                                   │
                                   └──(after commit, best-effort)──►  PostHog
```

Consequences, all deliberate:

- an event cannot exist in PostHog that has no audit row, so telemetry cannot invent a
  transition;
- a failed PostHog delivery loses a metric, never a governance record;
- deduplication reuses the audit row's idempotency key as `$insert_id`, so a retried
  projection is not a second event.

If the projection is never built, the audit log remains complete. That is why emission is
allowed to be best-effort while audit is not.

## 2. Events

Twelve events. `Exists today` records what is already in the codebase, verified by grep
for `.v1` literals; everything else is proposed.

| # | Event | Triggering transition (owner) | Exists today | Classification |
|---|---|---|---|---|
| 1 | `programme_plan_proposed` | `PlansService.propose` persists a Plan with `status = proposed` or `invalid` | no (new `plan.proposed.v1`) | product |
| 2 | `programme_plan_validated` | same transaction: deterministic validation verdict recorded | no (folded into #1 payload today; split only if the verdict needs its own series) | operational |
| 3 | `programme_approval_requested` | a HIGH/CRITICAL task is created and an `ApprovalRequest` is opened (`TasksService.create` → approval row) | `approval.requested.v1` | operational |
| 4 | `programme_approval_decided` | `ApprovalsService.decide` records a decision | `approval.decided.v1` | operational |
| 5 | `programme_submitted` | `ProgrammesService.submit` commits Programme + ProgrammeTask rows | `programme.submitted.v1` | product |
| 6 | `programme_started` | `loadProgrammeActivity` commits `pending → running` | no | product |
| 7 | `programme_task_started` | `reserveProgrammeTaskActivity` returns `reserved` and the child starts under `task-<taskId>` | no | product |
| 8 | `programme_task_completed` | `recordProgrammeCheckpointActivity` records `succeeded` / `already_succeeded` | no | product |
| 9 | `programme_task_failed` | checkpoint records `failed` / `precondition_failed` / `cancelled` | no | operational |
| 10 | `programme_completed` | `finishProgrammeActivity` commits `succeeded` | `programme.finished.v1` | product |
| 11 | `programme_blocked` | `finishProgrammeActivity` commits `blocked`, with the reason code | `programme.finished.v1` | operational |
| 12 | `programme_cancelled` | `finishProgrammeActivity` commits `cancelled` from the non-cancellable scope | `programme.finished.v1` | operational |

Events 10–12 share one audit event today (`programme.finished.v1`) distinguished by
`payload.status`. Splitting them in PostHog is a projection decision, not a new write
path: the projector maps `status → event name` and must not emit two of the three.

### Properties, per event

Common to all: `org_id` (hashed or internal id — never an email), `programme_id`,
`plan_id` when applicable, `environment`, `schema_version`, and the audit
`idempotency_key` as `$insert_id`.

| Event | Additional properties | Deliberately absent |
|---|---|---|
| `programme_plan_proposed` | `provider` (`http-llm`), `provider_model`, `simulated` (bool), `task_count`, `issue_count`, `issue_codes[]` | objective text, task titles, goals, criteria |
| `programme_plan_validated` | `ok` (bool), `issue_codes[]`, `duration_ms` bucket | issue messages (they quote task content) |
| `programme_approval_requested` | `risk_class`, `task_id`, `policy_version` | goal, criteria |
| `programme_approval_decided` | `decision` (`approve`/`reject`/…), `risk_class`, `self_approval_refused` (bool), `latency_ms` bucket | decision note, approver email |
| `programme_submitted` | `task_count`, `edge_count`, `source` (`api`/`plan`), `plan_id` or null | objective |
| `programme_started` | `node_count` | — |
| `programme_task_started` | `risk_class`, `attempt_number`, `queue_wait_ms` bucket | task title |
| `programme_task_completed` | `outcome` (`succeeded`/`already_succeeded`), `duration_ms` bucket | summary text, artifact paths |
| `programme_task_failed` | `outcome`, `reason_code`, `risk_class` | error messages, stack traces, output |
| `programme_completed` | `node_count`, `wall_clock_ms` bucket, `successful_nodes` | objective |
| `programme_blocked` | `reason_code` (`APPROVAL_PENDING`, `DEPENDENCY_BLOCKED`, `NO_READY_NODE`), `blocked_nodes`, `waiting_approval_nodes` | node titles |
| `programme_cancelled` | `reason_code`, `dispatched_nodes`, `completed_nodes` | — |

`reason_code` must be an enum from the code, never a free-text message.

## 3. Deduplication

| Layer | Mechanism | Why |
|---|---|---|
| State change | `AuditEvent` unique `idempotencyKey`, deterministic per transition | a retried activity cannot write two audit rows |
| Projection | PostHog `$insert_id` = audit `idempotencyKey` | a retried projection cannot count twice |
| Retries of the whole request | existing `Idempotency-Key` on submission and approval | no second programme, no second event |

A projector that cannot find a stable key must **not** emit. An uncountable event is
better than a doubled one.

## 4. Privacy rules (non-negotiable)

Never emitted, in any property, at any level of nesting:

- prompts, system prompts, model responses or any planner input/output text;
- task `title`, `goal`, `acceptanceCriteria`, `decisionNote`, `failureReason` free text;
- artifact contents, file paths under a workspace, execution stdout/stderr, stack traces;
- credentials, tokens, API keys, cookies, connection strings;
- user email addresses or names — internal user ids only, and org ids as internal ids;
- approval `contentHash` values (they are content-derived and could be used as an oracle).

Allowed: enums, counts, booleans, internal ids, bucketed durations, and reason codes.

A reviewer must be able to verify the property list from the projector's type, not from a
runtime sample. The projector therefore takes a typed DTO per event; it never accepts
`Record<string, unknown>`.

## 5. Product versus operational

| Class | Events | Use |
|---|---|---|
| **Product** (adoption) | 1, 5, 6, 7, 8, 10 | "is the capability used", funnel plan → submit → start → complete |
| **Operational** (health) | 2, 3, 4, 9, 11, 12 | block reasons, failure rates, approval latency, cancellation |

Product metrics must not be derived from operational events. A blocked programme is not
"usage"; counting it as such would inflate adoption with work that never ran.

## 6. Safe-to-emit checklist, per event

An event may be emitted only when all five hold:

1. the audit row is written in the same transaction as the state change;
2. the property DTO is fully typed and contains no free text;
3. `$insert_id` is the audit idempotency key;
4. the event name maps 1:1 to a transition in §2 (no synthetic names);
5. the projector is disabled by default and enabled only by explicit configuration.

If any check fails, the event is not emitted. Silence is an acceptable outcome; an
invented event is not.

## 7. Rollout, in order

1. Land the audit events (already the pattern) — no PostHog code.
2. Add the projector behind a disabled-by-default port; a unit test asserts it performs
   **no network call** when unconfigured.
3. Enable it in one non-production environment; confirm a real event arrives.
4. Validate the received schema against §2 — property names, types, absence of free text.
5. Only then build a dashboard, and label it with the date range it actually covers.

Step 4 is the gate. A dashboard built before a real event has been observed is a drawing,
not a measurement.

## 8. What is NOT done

- No projector exists.
- No PostHog event has been sent by this repository.
- No dashboard, funnel or retention metric may be claimed.
- `programme_plan_proposed` and `programme_plan_validated` may remain one event; that is a
  deliberate open question for whoever builds the projector, and it does not justify
  emitting both now.
