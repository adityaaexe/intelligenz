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
| `ARTIFACT_INTEGRITY_FAILED` | 409 | The bytes on disk do not match the recorded SHA-256; nothing is served |
| `ARTIFACT_GONE` | 410 | The artifact row exists but its file is no longer on this host |
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
| POST | `/v1/orgs/:orgId/projects/:projectId/tasks` | **MEMBER** | `{ title, goal, priority?, acceptanceCriteria[], executionProfile?, sourceRef?, baseCommit?, riskClass? }` + optional `Idempotency-Key` | `201` created / `200` duplicate — `{ data: Task, meta: { created: boolean } }` |
| GET | `/v1/orgs/:orgId/tasks/:taskId` | any member | — | `200 { data: TaskDetail }` |
| PATCH | `/v1/orgs/:orgId/tasks/:taskId` | **MEMBER** | `{ status, reason? }` | `200 { data: Task }` — human-owned edges only, see §5 |
| POST | `/v1/orgs/:orgId/tasks/:taskId/run` | **MEMBER** | — | `202 { data: { taskId, workflowRunId, attemptId, workflowId, temporalRunId, status: "queued" } }` |
| POST | `/v1/orgs/:orgId/tasks/:taskId/cancel` | **MEMBER** | — | `200 { data: { taskId, status: "cancelled", workflowRunId, orchestrator } }` |

`TaskDetail` = the task plus `project`, `workspace`, `latestRun` (or `null`),
`artifacts[]` (max 20) and `approvals[]`.

`Task` = `{ id, orgId, projectId, workspaceId, title, goal, status, riskClass,
priority, acceptanceCriteria, createdById, idempotencyKey, createdAt, updatedAt }`.

**`riskClass` is server-derived (D-006).** The value in the response — and the value
the approval gate reads — is computed by `apps/api/src/risk` from the content, the
`executionProfile`, the `sourceRef`/`baseCommit` and the repository-trust policy.
`riskClass` in the **request** is advisory only: it is compared with the derived class
and a disagreement is recorded (`clientAttemptedDowngrade` / `clientAttemptedEscalation`,
audited as `task.risk_class_overridden.v1`), but it is never obeyed. Sending
`riskSource`, `derivedRiskClass`, `riskPolicyVersion` or `riskFactors` is accepted and
then discarded; those fields are server-owned. The derivation itself
(`riskFactors`, `riskSource`, `derivedRiskClass`, `riskPolicyVersion`) is **not** part
of this response — it is evidence for the audit trail and the gate, not a client
contract. `LOW` requires a read-only task on an allowlisted repository pinned to a
commit; anything unknown is at least `MEDIUM`.

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
| POST | `/v1/orgs/:orgId/approvals/:approvalId/revoke` | **ADMIN** | — | `200 { data: Approval }` — idempotent on an already-revoked row |

Risk ranking is `CRITICAL → HIGH → MEDIUM → LOW`, oldest first inside a class.
`note` is required for `reject` and `request_changes`, optional for `approve`.

`Approval` = `{ id, taskId, riskClass, status, createdAt, decidedAt, decisionNote,
expiresAt, consumedAt, revokedAt, task: { id, title, status, riskClass, projectId,
workspaceId }, requestedBy, decidedBy }`.

An approval is a **grant**, not a flag (D-006):

- **Self-approval is refused.** `403 SELF_APPROVAL_FORBIDDEN` when the requester
  approves their own request. The org-level escape hatch is compiled in and empty
  (`apps/api/src/approvals/org-policy.ts`); enabling it is a code change.
- **The grant is bound at decision time** to the task's content hash, derived class,
  policy version, execution profile and `sourceRef`/`baseCommit`. Changing any of them
  afterwards makes the grant unusable (`409 APPROVAL_STALE`).
- **It expires.** `expiresAt` is the decision time plus `APPROVAL_TTL_HOURS`
  (default **24 h**). An expired row is flipped to `EXPIRED` when the gate reads it
  and the run is refused with `409 APPROVAL_EXPIRED`.
- **It is single-use.** Consumption is a conditional update
  (`status='APPROVED' AND consumedAt IS NULL AND revokedAt IS NULL`); the loser of a
  race gets `409 APPROVAL_CONSUMED`, never a second execution.
- **It can be revoked** while `APPROVED`. A consumed grant can still be revoked, but
  `consumedAt` stays: revocation stops future runs, it does not undo the past one.
  `409 APPROVAL_NOT_REVOCABLE` for a row that was never granted.
- `consumedByAttemptId` is `null` for a grant spent by `POST /run` until the worker
  links the attempt; `consumedAt` is what makes it spent.
- A pre-Phase-4 row has `taskContentHash = null` and cannot authorise a run:
  `409 APPROVAL_UNBOUND`. It is not backfilled.

### Executions (Phase 3)

One row per **attempt**, not per task. A Temporal retry produces a second attempt, so
"the third time we tried" is addressable without reading timestamps.

| Method | Path | Role | Response |
|---|---|---|---|
| GET | `/v1/orgs/:orgId/tasks/:taskId/executions` | any member | `200 { data: ExecutionAttemptSummary[] }` — newest first |
| GET | `/v1/orgs/:orgId/tasks/:taskId/executions/:attemptId` | any member | `200 { data: { attempt, toolInvocations[], artifacts[] } }` |

```json
{
  "id": "uuid",
  "taskId": "uuid",
  "workflowRunId": "uuid",
  "attemptNumber": 1,
  "runtimeId": "opencode-cli",
  "runtimeVersion": "2.2.7",
  "simulated": false,
  "status": "succeeded",
  "startedAt": "2026-11-13T10:00:00.000Z",
  "finishedAt": "2026-11-13T10:00:42.000Z",
  "durationMs": 42000,
  "tokensIn": 43598,
  "tokensOut": 120,
  "costUsd": "0.0005",
  "error": null,
  "workspace": {
    "id": "uuid",
    "state": "completed",
    "sourceKind": "clone",
    "baseCommit": "…",
    "branch": "main",
    "readyAt": "…",
    "cleanedAt": "…"
  }
}
```

- `simulated` is **required** and comes from the adapter's own report. `false` means a
  real model call happened. The UI must label every row from this field; never infer it
  from `runtimeId`.
- `costUsd` is a **string** (Decimal), so `0.1985` does not become
  `0.19850000000000001`. `null` means "not reported", which is not `0`.
- `attemptNumber` is unique per `workflowRunId`; `attemptNumber: 3` implies attempts 1
  and 2 exist (or existed) for that run.
- `workspace` is `null` for simulated runs and for attempts that failed before a
  workspace was provisioned. `state` is the `WorkspaceState` enum
  (`requested|provisioning|ready|executing|preserving|completed|failed|cancelled`).
- No absolute host path appears in this response. `workspace.id` is the handle; the
  directory is not the client's business.

`toolInvocations` (detail only) are **summaries**, already redacted by the adapter,
ordered by `sequence`. They are capped at 200 rows per run; a truncated trace is
recorded in the run's `providerMeta`, not silently shortened.

Artifact attribution in the detail response is by **`Artifact.attemptId`** — the attempt
that produced the bytes. The Phase 3 `(taskId, runtimeId, time window)` heuristic is
**gone**: two attempts in the same second, or a retried run, made a window guessable
but not knowable. A row whose `attemptId` is `NULL` (written before the column existed,
or whose attempt was pruned) is returned with `attemptId: null` and
`unattributed: true`. It is **never** attributed to the newest run.

### Artifacts (Phase 3)

| Method | Path | Role | Response |
|---|---|---|---|
| GET | `/v1/orgs/:orgId/artifacts/:artifactId` | any member | `200 { data: Artifact }` |
| GET | `/v1/orgs/:orgId/artifacts/:artifactId/content` | any member for `diff` / `report`; **`ADMIN`+ for `transcript`** | `200` raw bytes, `403` raw transcript to a lower role, `409` integrity failure, `410` file gone |

```json
{
  "id": "uuid",
  "taskId": "uuid",
  "attemptId": "uuid or null",
  "unattributed": false,
  "runtimeId": "opencode-cli",
  "kind": "transcript",
  "uri": "org/task/workspace-1/artifacts/transcript.ndjson",
  "checksum": "sha256 hex",
  "sizeBytes": 1234,
  "integrity": "verified",
  "createdAt": "…",
  "mediaType": "application/x-ndjson"
}
```

- `attemptId` is the provenance link. `unattributed: true` (and `attemptId: null`)
  means the row predates the column or its attempt was pruned — a consumer must not
  read that as "the latest run".

- `uri` is **logical**: relative to the configured artifact root that stores the bytes,
  posix separators, never an absolute host path.
- `integrity` is computed **at read time** by hashing the file: `verified` (matches),
  `failed` (bytes differ), `unknown` (file missing or unreadable). It is never a stored
  `true`, and `unknown` must render as "unverified".
- **A raw transcript download requires `ADMIN` or higher.** A transcript is model and
  shell output — whatever the agent read, printed or was told — so it is the
  highest-risk artifact the platform stores, and downloading it is an administrative
  act (debugging a run), not a viewing one. `VIEWER` and `MEMBER` keep:
  - the **metadata** (`GET /artifacts/:id`, including `kind`, `checksum`, `integrity`);
  - the **`diff`** artifact, which is the redacted change the run produced;
  - the **`report`** artifact, when one exists.

  The check is per artifact kind, so it cannot be expressed as a route-level role: the
  row is loaded first and a `transcript` is refused with
  `403 FORBIDDEN — Raw transcripts require the ADMIN role or higher.` before any byte is
  read. A refused request never partially streams.
- `content` re-hashes before the first byte is written:
  - mismatch → `409 ARTIFACT_INTEGRITY_FAILED`;
  - missing file → `410 ARTIFACT_GONE`;
  - path outside every configured root → `404 NOT_FOUND` (never the path);
  - role below `ADMIN` on a `transcript` → `403 FORBIDDEN`;
  - success → the bytes plus `ETag: "sha256-…"` and `X-Artifact-Checksum`.
- A transcript is **redacted at collection time** (before it is written) and capped at
  5 MiB. Exceeding the cap appends one `{"type":"truncated"}` line and stops; the
  artifact never grows past the cap.
- `kind` selects the media type: `transcript` → `application/x-ndjson`, `diff` →
  `text/x-diff`, `report` → `text/markdown; charset=utf-8`, anything else →
  `application/octet-stream`.

`TaskDetail.artifacts[].uri` uses the same logical form.

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

## 6. Approval gate (contract §15 A3, tightened by D-006)

A `HIGH` or `CRITICAL` task cannot reach `queued` — which now means `POST /run`, since
`PATCH` may not perform that edge (§5) — unless a **live, bound, unconsumed** `APPROVED`
approval request exists for it.

The gate (`apps/api/src/approvals/approval-gate.service.ts`) requires all five:

1. `status = APPROVED`;
2. `consumedAt IS NULL`;
3. `revokedAt IS NULL`;
4. `expiresAt` in the future (a null expiry is `createdAt + TTL`, never "forever");
5. `taskContentHash` equals the hash of the task's **current** content, derived class,
   execution profile and `sourceRef`/`baseCommit`.

Every refusal is a `409` with a specific code, and writes a
`task.transition_refused.v1` audit event. It is not a silent no-op:

| Code | Meaning |
|---|---|
| `APPROVAL_REQUIRED` | no live grant (no row, or none in a usable state) |
| `APPROVAL_STALE` | the grant was for different content/profile/source; `details.approval` names the field(s) |
| `APPROVAL_CONSUMED` | the grant was already spent — including losing a concurrent race |
| `APPROVAL_EXPIRED` | past `expiresAt`; the row is flipped to `EXPIRED` and audited |
| `APPROVAL_REVOKED` | withdrawn by an admin |
| `APPROVAL_UNBOUND` | a pre-Phase-4 row with no content hash; it cannot prove what it approved |

- `POST /run` **consumes** the grant. The consumption is a compare-and-swap
  (`updateMany` on `id + orgId + status + consumedAt IS NULL + revokedAt IS NULL`), and
  `count === 0` is a refusal, not a retry. It runs inside the same transaction as the
  `ready → queued` reservation, so a failed reservation does not spend the grant.
- `PATCH → queued` performs the same checks with `consume: false` and then refuses with
  `409 TRANSITION_IS_SYSTEM_MANAGED`; it can never queue anything, so it must not burn
  a grant.
- Creating a HIGH/CRITICAL task automatically creates a `PENDING` approval request
  (with a content hash and a 24 h expiry) and an `approval.requested.v1` event, so the
  queue is always populated.
- Deciding a request does **not** move the task. Approval is a precondition, not a
  state: the task stays `ready` and someone runs it.
- A failed start (`503 ORCHESTRATOR_UNAVAILABLE`) still spends the grant. The
  reservation commits before Temporal is contacted; refunding it would need a second
  race against a run that may have started after all. The cost is one re-approval after
  an outage; the alternative costs the control.

### 6.1 The execution reservation, and the end of the direct start (Phase 6)

`POST /run` is the only path that creates an `ExecutionAttempt`, and that attempt is now
the **only** thing that authorises an execution.

- `POST /run` creates the `WorkflowRun` and a `queued` `ExecutionAttempt`, spends the
  grant naming that attempt, and starts `runTaskWorkflow` with `attemptId`.
- The worker's first activity *claims* the attempt: one conditional
  `UPDATE … WHERE status = 'queued' AND "claimedByWorkflowRunId" IS NULL`, keyed to
  Temporal's run id. `count === 1` is the grant; nothing else can claim it afterwards.
- The worker's **executor** re-reads that claim before it does anything. It refuses an
  execution that holds no claim, a claim held by another execution, and — for `HIGH` and
  `CRITICAL` tasks — an approval that has been revoked, expired, or re-bound since
  validation ran.
- Adoption (`queued → running`) is conditional on the row carrying the adopting
  execution's claim, so an attempt cannot be run by an execution that did not claim it.

**Removed: starting `runTaskWorkflow` without an attempt id.** Until Phase 6 a caller
with Temporal access could start the workflow by name with `{ taskId, orgId }` and no
reservation; validation skipped the claim entirely and the execution ran unclaimed. Two
such starts of one `LOW` task ran concurrently — two successes milliseconds apart, one
`AgentRun`, and `claimedAt` NULL on both, so the duplicate was invisible in the execution
record. There is no replacement control for that shape, so the path is **refused**
(`EXECUTION_CLAIM_REFUSED`, non-retryable) at validation *and* at the executor: an
execution that names no attempt cannot be shown to be the only one.

Operationally this means a manual/back-office start must now carry the `attemptId` that
`POST /run` minted — the value returned in the `202` body, and the same one the grant's
`consumedByAttemptId` names. There is no supported way to run a task that `POST /run` did
not reserve.

**Stranded reservations.** A worker that dies between the claim and adoption leaves a
`queued` attempt claimed by a workflow run that no longer exists. The reaper releases
such a claim only when Temporal reports that specific run as **not found** or
**terminal** — never on age alone — and records `execution.claim_released.v1` with the
evidence. The attempt is marked `failed` / `ATTEMPT_ABANDONED` in the same write. Task
and workflow-run status are not reconciled by that pass (see the Phase 6 record).

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
| `task.created.v1` | task created (carries `riskClass`, `riskSource`, `riskPolicyVersion`) |
| `task.status_changed.v1` | any accepted transition, including `ready → queued` on run |
| `task.transition_refused.v1` | approval gate refusal (`payload.code` names the reason) |
| `task.risk_class_overridden.v1` | the caller asserted a class different from the derived one (`direction: downgrade\|escalation`) |
| `security.risk_signal.v1` | the task requested credentials or host paths |
| `task.cancelled.v1` | cancellation |
| `workflow.started.v1` | Temporal accepted the workflow |
| `workflow.start_failed.v1` | start failed and was compensated |
| `approval.requested.v1` | HIGH/CRITICAL task created |
| `approval.decided.v1` | approve / reject / request changes — carries the binding (`riskClassAtApproval`, `policyVersion`, `executionProfile`, `expiresAt`) |
| `approval.consumed.v1` | an execution spent the grant (`consumedByAttemptId` may be null at spend time) |
| `approval.expired.v1` | the gate found the grant past `expiresAt` and flipped it to `EXPIRED` |
| `approval.revoked.v1` | an admin withdrew an `APPROVED` grant (`afterUse` when it had been consumed) |
| `approval.self_approval_refused.v1` | the requester tried to approve their own request |
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
