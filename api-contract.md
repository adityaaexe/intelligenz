# API contract — Phase 5 delta (BE-501)

This file records **only the endpoints that changed in Phase 5**, so `@frontend`, `@reviewer`
and the worker unit have one place to read the delta. The full contract remains
`docs/engineering/PHASE-2-CONTRACT.md`; this file does not restate it.

---

## `POST /v1/orgs/{orgId}/tasks/{taskId}/run`

Approval-gated runs are now **bound to a reserved execution attempt**. The reservation
happens in the same database transaction that consumes the approval, before Temporal is
contacted, so a grant can never be spent by a run that does not exist.

### Request

Unchanged body (all fields optional assertions): `executionProfile`, `sourceRef`,
`baseCommit`.

New optional header:

| Header            | Rules                                                        |
| ----------------- | ------------------------------------------------------------ |
| `Idempotency-Key` | 1–255 characters after trimming. Same key + same task = replay. |

### Response `202`

```jsonc
{
  "data": {
    "taskId": "…",
    "workflowRunId": "…",
    "attemptId": "…",        // NEW — the attempt the approval was spent by
    "workflowId": "task-…",
    "temporalRunId": "…",    // WIDENED — may be null while the start RPC is in flight
    "status": "queued"
  }
}
```

`attemptId` is what a client should follow to read the execution it just authorised
(`GET /v1/orgs/{orgId}/tasks/{taskId}/executions`). Do not infer it as "the newest attempt".

`temporalRunId` is `null` only in the window between the reservation commit and the start
RPC returning — which a replayed `POST /run` can observe. Treat `null` as "not yet
assigned", never as an error.

### Idempotency behaviour

| First request's outcome                | Replay with the same `Idempotency-Key`                      |
| -------------------------------------- | ----------------------------------------------------------- |
| `202` (run queued/running)             | `202` with the **same** `workflowRunId` and `attemptId`      |
| `503 ORCHESTRATOR_UNAVAILABLE`         | `503` — the stored outcome is replayed, no new attempt       |
| `409 WORKFLOW_ALREADY_RUNNING`         | `409` with the same code                                     |
| Any other closed state                 | `409 CONFLICT`, naming the terminal status                   |

A replay never creates an `ExecutionAttempt`, never consumes an approval, and never
starts a workflow.

### New / changed error codes

| HTTP | Code                          | When                                                                 |
| ---- | ----------------------------- | -------------------------------------------------------------------- |
| 409  | `APPROVAL_CONSUMED`           | unchanged — the grant was already spent (now also reachable on replay) |
| 409  | `APPROVAL_STALE`              | unchanged — content/profile/source changed after approval             |
| 409  | `WORKFLOW_ALREADY_RUNNING`    | unchanged                                                             |
| 409  | `CONFLICT`                    | the task changed mid-start, **or** two requests raced on one `Idempotency-Key` |
| 503  | `ORCHESTRATOR_UNAVAILABLE`    | unchanged — **the grant stays consumed** and the attempt is `start_failed` |

### Failure semantics a client must know

- **A `503` does not refund the approval.** The attempt is marked
  `failed` with `terminationReason: "start_failed"`, the `WorkflowRun` is `failed`, and the
  task returns to `ready`. A retry needs a **new approval**; replaying the same
  `Idempotency-Key` returns the same `503`.
- **Retrying without a key** is a different request: it will be refused with
  `409 APPROVAL_CONSUMED` once the grant was spent.

---

## Worker-side codes (not HTTP)

These appear in `WorkflowRun.error.code` and in the `task.failed.v1` audit payload when
`validateTaskActivity` refuses a run — including one started directly through Temporal,
bypassing this API.

| Code                         | Meaning                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| `APPROVAL_REQUIRED`          | no live grant                                                                             |
| `APPROVAL_NOT_RESERVED`      | grant never consumed, **or** consumed with no attempt link, **or** the run named no attempt |
| `APPROVAL_ATTEMPT_MISMATCH`  | **new** — the named attempt is not the one that spent the grant, does not exist for this task, or has already been taken (not `queued`) |
| `APPROVAL_REVOKED`           | revoked after approval                                                                    |
| `APPROVAL_EXPIRED`           | past `expiresAt`                                                                          |
| `APPROVAL_UNBOUND`           | pre-Phase-4 grant with no content hash                                                    |
| `APPROVAL_STALE`             | content, risk class, execution profile or source changed after approval                    |
