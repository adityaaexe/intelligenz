# INTELLIGENZ API — route map and wire contract

**Unit:** BE-002 · NestJS API · Phase 2
**Base URL:** `http://localhost:4100` (never 3000/4000 — contract §15 A1)
**Version:** all resource routes are under `/v1`. `/health*` is unversioned.
**Status:** implemented and covered by `apps/api/test/`.

This file is the contract the web client codes against. It is generated from the
running implementation, not from intention: every status code and body shape below
is asserted by an API test.

---

## 1. Envelope

### Success

```json
{ "data": { } }
```

Lists add pagination metadata:

```json
{
  "data": [],
  "meta": { "limit": 25, "hasMore": false, "nextCursor": null }
}
```

### Error — every failure, including framework 404s and 500s

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request body or query is invalid.",
    "details": { "riskClass": ["Invalid option: expected one of ..."] }
  },
  "correlationId": "8b0e2f5e-5a51-4f5e-9f5e-6c0e5d3b7c11"
}
```

`details` is present only for validation failures (and a few codes that carry a
reason). It is keyed by dotted field path, so a form can map it directly.

`correlationId` is echoed from `X-Correlation-Id` when that header is a UUID, and
generated otherwise. Quote it in bug reports: it is on the HTTP access log and on
every audit row written by the request.

### Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Body or query failed its schema; see `details` |
| `INVALID_CURSOR` | 400 | Cursor does not belong to this list |
| `UNAUTHORIZED` | 401 | Missing, malformed or expired token; bad credentials |
| `FORBIDDEN` | 403 | Not a member of the org, header/path mismatch, or role too low |
| `NOT_FOUND` | 404 | Resource absent **or in another organisation** |
| `CONFLICT` | 409 | Concurrent change (compare-and-swap lost) |
| `TRANSITION_IS_SYSTEM_MANAGED` | 409 | The edge is legal in the machine but may not be driven by a user (see §5) |
| `APPROVAL_REQUIRED` | 409 | HIGH/CRITICAL task queued without an approved request |
| `ALREADY_DECIDED` | 409 | Approval request already decided |
| `TASK_NOT_CANCELLABLE` | 409 | Task is not `queued`/`running` |
| `WORKFLOW_ALREADY_RUNNING` | 409 | An execution for this task is still open under the deterministic workflow id |
| `INVALID_TRANSITION` | 422 | State machine refused the edge; `details.transition` says which |
| `RATE_LIMITED` | 429 | Too many sign-in attempts for this `(ip, email)`; `Retry-After` says when |
| `ORCHESTRATOR_UNAVAILABLE` | 503 | Temporal unreachable; nothing was started |
| `INTERNAL_ERROR` | 500 | Server bug; the message is deliberately opaque |

**404, never 403, for another tenant's record.** A 403 would confirm the id exists.

---

## 2. Headers

| Header | Required | Purpose |
|---|---|---|
| `Authorization: Bearer <jwt>` | all but `/health*`, `/v1/auth/login` | Access token, HS256, 15 min |
| `X-Org-Id: <uuid>` | all `/v1/orgs/:orgId/...` except `GET /v1/orgs` | Selects the tenant; must match the path and a membership row |
| `Idempotency-Key` | optional on task creation | Duplicate key → existing task, `200` |
| `X-Correlation-Id` | optional | UUID; echoed in errors and audit |

A missing `X-Org-Id` is `403`. A header that differs from the `:orgId` path segment
is `403` before any query runs.

---

## 3. Roles

Hierarchy, high to low: `OWNER > ADMIN > MEMBER > VIEWER`. A route's requirement is
a **minimum**: `@Roles('ADMIN')` admits ADMIN and OWNER.

Roles come from the database on **every** request, not from the token. Removing a
membership revokes access on the next call, even with an unexpired token.

---

## 4. Route map

### Health (no auth)

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/health` | — | `200 { status: "ok", service, uptimeSeconds }` |
| GET | `/health/ready` | — | `200` ready / `503` not ready, see §7 |

### Auth

| Method | Path | Role | Body | Response |
|---|---|---|---|---|
| POST | `/v1/auth/login` | public | `{ email, password }` | `200 { data: { accessToken, tokenType, expiresIn, user, memberships } }` |

`401` for both an unknown email and a wrong password, with an identical body.

Rate limit: **5 attempts per 15 minutes per `(ip, email)` pair**. The sixth answers
`429 { error: { code: "RATE_LIMITED" } }` with a `Retry-After` header in seconds.
The limiter runs before the password is checked and the refusal is identical for a
known and an unknown email — it must not become an account-existence oracle. A
successful sign-in clears the counter. The window is in-process memory: with more
than one API replica the effective limit is `replicas × 5` and must move to a shared
store before it is a real control.

### Organisations

| Method | Path | Role | Response |
|---|---|---|---|
| GET | `/v1/orgs` | any authenticated | `200 { data: [{ id, name, slug, role, workspaces: [{ id, name, slug }] }] }` |

No `X-Org-Id` needed: this route is the list of organisations the caller may name.
Workspaces are nested so the client can build project paths without a second call.

### Projects

| Method | Path | Role | Body | Response |
|---|---|---|---|---|
| GET | `/v1/orgs/:orgId/workspaces/:workspaceId/projects` | any member | — | `200 { data: [{ id, orgId, workspaceId, key, name, environment, taskCount, createdAt, updatedAt }] }` |
| POST | `/v1/orgs/:orgId/workspaces/:workspaceId/projects` | **ADMIN** | `{ key: /^[A-Z0-9]{2,8}$/, name, environment: prod\|staging\|dev }` | `201 { data: Project }` |

`409 CONFLICT` when the key is already used in that workspace.
`404` when the workspace is not in that org.

### Tasks

| Method | Path | Role | Body | Response |
|---|---|---|---|---|
| GET | `/v1/orgs/:orgId/projects/:projectId/tasks?limit&cursor` | any member | — | `200 { data: Task[], meta }` — newest first |
| POST | `/v1/orgs/:orgId/projects/:projectId/tasks` | **MEMBER** | `{ title, goal, riskClass, priority?, acceptanceCriteria[] }` + optional `Idempotency-Key` | `201` created / `200` duplicate — `{ data: Task, meta: { created: boolean } }` |
| GET | `/v1/orgs/:orgId/tasks/:taskId` | any member | — | `200 { data: TaskDetail }` |
| PATCH | `/v1/orgs/:orgId/tasks/:taskId` | **MEMBER** | `{ status, reason? }` | `200 { data: Task }` — human-owned edges only, see §5 |
| POST | `/v1/orgs/:orgId/tasks/:taskId/run` | **MEMBER** | — | `202 { data: { taskId, workflowRunId, workflowId, temporalRunId, status: "queued" } }` |
| POST | `/v1/orgs/:orgId/tasks/:taskId/cancel` | **MEMBER** | — | `200 { data: { taskId, status: "cancelled", workflowRunId, orchestrator } }` |

`TaskDetail` = the task plus `project`, `workspace`, `latestRun` (or `null`),
`artifacts[]` (max 20) and `approvals[]`.

`Task` = `{ id, orgId, projectId, workspaceId, title, goal, status, riskClass,
priority, acceptanceCriteria, createdById, idempotencyKey, createdAt, updatedAt }`.

Pagination: `limit` 1–100, default 25. `meta.nextCursor` is `null` on the last page;
pass it back as `?cursor=`. A cursor from a different list is `400 INVALID_CURSOR`.

`run` answers `202` because the workflow was accepted, not completed. If Temporal is
unreachable it answers `503 ORCHESTRATOR_UNAVAILABLE` and the task stays `ready` —
never `running`.

The workflow id is `task-<taskId>`. A second start while an execution is still open is
`409 WORKFLOW_ALREADY_RUNNING`; a start after the previous execution closed as
failed/cancelled/terminated is *not* refused — the id may be reused for a retry. The
task state machine still decides whether a retry is reachable: only `blocked → ready`
(with a reason) re-opens a task, so a task that ended `failed` or `cancelled` stays
terminal even though Temporal would accept a new run.

`cancel` requires the task to be `queued` or `running`; otherwise
`409 TASK_NOT_CANCELLABLE`. `orchestrator: "not_found"` means Temporal had no
execution to cancel, which is not an error.

### Approvals

| Method | Path | Role | Body | Response |
|---|---|---|---|---|
| GET | `/v1/orgs/:orgId/approvals?limit&cursor` | any member | — | `200 { data: Approval[], meta }` — PENDING only, risk-ranked |
| POST | `/v1/orgs/:orgId/approvals/:approvalId/decision` | **ADMIN** | `{ decision: approve\|reject\|request_changes, note? }` | `200 { data: Approval }` |

Risk ranking is `CRITICAL → HIGH → MEDIUM → LOW`, oldest first inside a class.
`note` is required for `reject` and `request_changes`, optional for `approve`.

`Approval` = `{ id, taskId, riskClass, status, createdAt, decidedAt, decisionNote,
task: { id, title, status, riskClass, projectId, workspaceId }, requestedBy,
decidedBy }`.

---

## 5. Task state machine

`draft → ready → queued → running → verifying → succeeded | failed | blocked | cancelled`

plus `queued → cancelled`, `running → cancelled`, `blocked → ready` (retry).
Self-transitions are not edges, including `failed → failed`.

Anything else is `422 INVALID_TRANSITION`.

### What `PATCH` may do — and what only the orchestrator may do

The machine above is the **global** truth (`@intelligenz/contracts`), used by the
worker as well. It answers "may the task reach this state", not "may this caller put
it there". `PATCH` therefore allows only the edges a human owns:

| Edge | `PATCH` |
|---|---|
| `draft → ready` | allowed |
| `blocked → ready` (with `reason`) | allowed |
| `ready → queued` | `409 TRANSITION_IS_SYSTEM_MANAGED` — use `POST /run` |
| `queued → running` | `409 TRANSITION_IS_SYSTEM_MANAGED` |
| `running → verifying` | `409 TRANSITION_IS_SYSTEM_MANAGED` |
| `verifying → succeeded` | `409 TRANSITION_IS_SYSTEM_MANAGED` |
| `verifying → failed` | `409 TRANSITION_IS_SYSTEM_MANAGED` |
| `running → failed` | `409 TRANSITION_IS_SYSTEM_MANAGED` |
| `queued/running → cancelled` | refused here — use `POST /cancel` |

This is deliberate and is an integrity boundary, not a permission nicety. Without it
a MEMBER could send `ready → queued → running → verifying → succeeded` over four
calls and produce a terminal success with no workflow run, no agent run and no
artifact — a "succeeded" task that never executed. The worker performs the
execution edges; `PATCH` cannot.

`→ ready` requires a `reason` (`400 VALIDATION_ERROR` without one). That is stricter
than the machine — `draft → ready` does not need one — on purpose: the retry path can
never arrive without an explanation.

---

## 6. Approval gate (contract §15 A3)

A `HIGH` or `CRITICAL` task cannot reach `queued` — which now means `POST /run`, since
`PATCH` may not perform that edge (§5) — unless an `APPROVED` approval request exists
for it.

- Refusal: `409 APPROVAL_REQUIRED`.
- The refusal writes a `task.transition_refused.v1` audit event. It is not a silent
  no-op.
- Creating a HIGH/CRITICAL task automatically creates a `PENDING` approval request
  and an `approval.requested.v1` event, so the queue is always populated.
- Deciding a request does **not** move the task. Approval is a precondition, not a
  state: the task stays `ready` and someone runs it.

---

## 7. `GET /health/ready`

This route returns a health document, not the error envelope — a per-dependency
status cannot be expressed as `{ error: { code, message } }`.

```json
{
  "status": "not_ready",
  "service": "intelligenz-api",
  "checks": {
    "postgres": { "status": "up", "latencyMs": 12 },
    "temporal": { "status": "down", "latencyMs": 2001, "detail": "timeout" }
  },
  "ageMs": 0
}
```

`200` only when **both** are `up`. `503` otherwise. `detail` is a classification
(`timeout`, `unavailable`, `deadline_exceeded`, `not_found`, `error`), never a driver
message.

The document is cached for **2 seconds** (monotonic clock) and concurrent misses
collapse into one probe, because this route is unauthenticated and each miss opens a
Temporal connection plus a Postgres query. `ageMs` is the age of the document: `0`
on the request that performed the probe, up to `1999` on a cache hit. A cached
`not_ready` is still `503` — the status code belongs to the document, not to the
request that fetched it.

---

## 8. Idempotency

`POST /tasks` with `Idempotency-Key: <string ≤255>`:

- first request → `201`, `meta.created: true`;
- identical key, same project → `200`, `meta.created: false`, same task id;
- the key is not compared against the payload. A retry after a timeout may have
  rebuilt the body; the contract says to return the existing task.

Without the header, the server generates a key, which makes that request
non-idempotent — it did not ask to be.

---

## 9. Audit events

Every row in `AuditEvent` is built by one service and validated against the
`EventEnvelope` from `@intelligenz/contracts` (contract §7).

| Event | When |
|---|---|
| `task.created.v1` | task created |
| `task.status_changed.v1` | any accepted transition, including `ready → queued` on run |
| `task.transition_refused.v1` | approval gate refusal |
| `task.cancelled.v1` | cancellation |
| `workflow.started.v1` | Temporal accepted the workflow |
| `workflow.start_failed.v1` | start failed and was compensated |
| `approval.requested.v1` | HIGH/CRITICAL task created |
| `approval.decided.v1` | approve / reject / request changes |
| `project.created.v1` | project created |
| `session.started.v1` / `session.failed.v1` | login success / failure |

Identity events (`session.*`) carry `projectId: null`: `EventEnvelope.projectId` is a
required UUID, and a login has no project. Inventing one would be a lie in the audit
trail.

A failed login for an **unknown** email produces no row — `AuditEvent.orgId` is a
required foreign key and there is no tenant to attribute it to. It is logged instead.

---

## 10. Ambiguities in contract §6 and how they were resolved

| # | Ambiguity | Resolution |
|---|---|---|
| 1 | §6 abbreviates project routes as `/orgs/:orgId/projects`; §15 A2 adds `Workspace` | Projects are addressed as `/v1/orgs/:orgId/workspaces/:workspaceId/projects`. Task routes keep the shorter `/v1/orgs/:orgId/projects/:projectId/tasks` shape the delegation specified. |
| 2 | No endpoint lists workspaces | Nested `workspaces[]` in `GET /v1/orgs` and in the login response. An extra endpoint would have exceeded "exactly the §6 table". |
| 3 | Nothing ever creates an `ApprovalRequest` | Created automatically (PENDING) when a HIGH/CRITICAL task is created. Without it the queue could only ever hold seed data. |
| 4 | `Task.idempotencyKey` is non-null but the header is optional | A missing header is replaced with `auto-<uuid>`, which is unique per call. Documented in §8. |
| 5 | `PATCH` can reach `queued` without a run | **Resolved against the machine.** `PATCH` may only drive `draft → ready` and `blocked → ready`; every execution edge is `409 TRANSITION_IS_SYSTEM_MANAGED`. `POST /run` is the only path to `queued`, and the only path that creates a `WorkflowRun`. |
| 6 | Response envelope is unspecified | `{ data }` / `{ data, meta }` for success, `{ error, correlationId }` for failure. |
| 7 | Approval decision schema does not exist in `@intelligenz/contracts` | Defined in `apps/api/src/approvals/approval.dto.ts`. It should move to contracts when the worker or web needs it. |
| 8 | `POST /run` returns "workflowRunId" but the status code is unspecified | `202 Accepted`, with the run id in the body. |
| 9 | `AuditEvent.projectId` is nullable but `EventEnvelope.projectId` is required | Domain events are validated in full. Identity events keep every other envelope field and store `projectId: null`. |
