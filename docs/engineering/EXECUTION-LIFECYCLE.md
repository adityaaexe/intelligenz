# Execution lifecycle

**What this is:** the states a real execution passes through, which component owns each
transition, which row records it, and what happens when the run is cancelled, fails, or is
interrupted.
**Audience:** an operator or on-call engineer reading the database at 2 a.m.
**Date:** 2026-11-13

---

## 1. The components

| Component | Owns | Does not own |
|---|---|---|
| **API** (`apps/api`) | Task status, `WorkflowRun` creation, approval checks, starting and cancelling the Temporal workflow, execution reads | Any workspace directory, any adapter call |
| **Temporal** | Workflow state, activity retries, cancellation delivery, deadlines | The database rows, the sandbox |
| **Worker activities** (`apps/worker/src/activities`) | `ExecutionAttempt`, `ExecutionWorkspace`, `AgentRun`, `ToolInvocation`, `Artifact`, `Evidence` writes; the workspace lease; artifact materialisation | Workflow decisions |
| **Workspace manager** (`packages/workspace-manager`) | Paths, the in-memory state machine, `git` operations, `bwrap` argv | Any Prisma call |
| **Adapter** (`packages/agent-runtime`) | Running the agent, killing its process group, producing a result | Any database row |

The split that matters: the **manager decides a path and a transition**; the **activity
writes the row**. Neither does both, so the in-memory machine and the database cannot
silently disagree about who moved.

---

## 2. States and owners

```
requested ──► provisioning ──► ready ──► executing ──► preserving ──► completed
                   │                        │
                   └──► failed              ├──► failed
                                            └──► cancelled
```

| Transition | Trigger | Component that writes it | Where |
|---|---|---|---|
| `(none) → requested` | A real adapter is selected and the attempt is about to run | `leaseWorkspace()` | `ExecutionWorkspace` insert |
| `requested → provisioning` | Immediately after the row exists, before `git clone` | `leaseWorkspace()` → `setState` + `manager.provision()` | `ExecutionWorkspace.state` |
| `provisioning → ready` | Clone/worktree succeeded and `HEAD` resolved | `leaseWorkspace()` | `ExecutionWorkspace` update (`readyAt`, `baseCommit`, `branch`, canonical `rootPath`) |
| `provisioning → failed` | Clone failed, no `HEAD`, or the directory was removed | `manager.provision()` catch → `leaseWorkspace()` | `ExecutionWorkspace.state` + `error {stage, code, message}` |
| `ready → executing` | The adapter is about to be spawned | `markExecuting()` | `manager.transition` + `ExecutionWorkspace.state` |
| `executing → preserving` | The adapter returned; bytes are about to be copied | `markPreserving()` | `manager.transition` + row |
| `preserving → completed` | Artifacts materialised, checkout removed | `releaseWorkspace({outcome:'completed'})` → `cleanup()` | row + `cleanedAt` |
| `executing/preserving → failed` | Non-zero exit, timeout, cost cap, thrown error | `releaseWorkspace({outcome:'failed'})` | row + `cleanedAt` |
| `executing/preserving → cancelled` | Temporal cancellation or an adapter-reported cancel | `releaseWorkspace({outcome:'cancelled'})` | row, `cleanedAt` left **null** |
| `(any non-terminal) → cancelled` | Task cancelled before the workspace exists | `POST /cancel` on the task; no workspace row | `Task`, `WorkflowRun` |

`provisioning → requested` also exists, for one purpose only: a recovery that found no
directory at all. Nothing else may move backwards.

**A row and a handle are not the same thing.** The manager's `handles` map is process
memory. A fresh manager (which every activity invocation creates) has an empty map, so
`manager.get(id)` returns `undefined` until something provisions or adopts that id in
that process. The row is the durable record; the handle is a cache.

One edge where they can disagree: a failure that arrives while the handle is still `ready`
(an error before `markExecuting`) has no `ready → failed` edge. `cleanup()` walks it
`ready → preserving → completed` in memory, while the row is written `failed` by
`releaseWorkspace`. The row is authoritative for an operator; the in-memory state is gone
when the activity ends.

### 2.1 What is deliberate about these edges

- `preserving` is a state, not a flag. "The checkout is being deleted but the evidence is
  being kept" must survive a crash, or a retry deletes the transcript.
- `ready → executing` **and** `executing → ready` are both legal: a warm workspace can be
  reused by a retry.
- `failed → provisioning` does **not** exist. A failed workspace is evidence; reusing its
  directory would make the failure unreproducible. A retry gets a new `workspaceId`.
- `completed`, `failed` and `cancelled` are terminal. `cleanup()` early-returns for
  `completed` and `cancelled`; for `failed` it still removes the checkout.

---

## 3. The happy path, step by step

A newly created task is `draft`. Promotion to `ready` is a human transition
(`PATCH /v1/orgs/:orgId/tasks/:taskId`, `{status:'ready', reason}` — the reason is
required by the DTO even though the machine does not require it for `draft → ready`).
The table starts at the point a task is already `ready`.

| # | Step | Row written | State after |
|---:|---|---|---|
| 1 | `POST /v1/orgs/:orgId/tasks/:taskId/run` — task must be `ready`; approval checked if HIGH/CRITICAL; no active run; `WorkflowRun` created and task set `queued` in one transaction | `WorkflowRun(status=queued)`, `AuditEvent(task.status_changed)` | task `queued`, run `queued` |
| 2 | Temporal starts `runTaskWorkflow` (`workflowId = task-<taskId>`, `REJECT_DUPLICATE`) | — | — |
| 3 | `validateTaskActivity` re-reads the task, checks status and approval | — | — |
| 4 | `recordStartActivity` adopts the `WorkflowRun` by Temporal run id, sets it `running`, task `running` | `WorkflowRun(status=running)`, `AuditEvent(workflow.started)` | task `running` |
| 5 | `executeAgentActivity` → `startAttempt` | `ExecutionAttempt(attemptNumber=n, status=running, runtimeId, simulated)` | attempt `running` |
| 6 | `leaseWorkspace` → insert + provision + update | `ExecutionWorkspace(requested → provisioning → ready)` | workspace `ready` |
| 7 | `markExecuting` | row update | workspace `executing` |
| 8 | `runtime.execute()` — the sandbox runs, the model thinks, tools fire | nothing yet (the adapter is writing its own scratch files) | — |
| 9 | `markPreserving` | row update | workspace `preserving` |
| 10 | `materializeArtifacts` copies the adapter's files into `<workspace>/artifacts`, re-hashing each | — | — |
| 11 | `finalizeAttempt` | `ExecutionAttempt(status=succeeded, finishedAt, simulated)` | attempt terminal |
| 12 | `releaseWorkspace(completed)` → `cleanup(keepArtifacts:true)` | `ExecutionWorkspace(state=completed, cleanedAt)` — checkout removed, `artifacts/` kept | workspace terminal |
| 13 | `persistResultActivity` | `AgentRun`, `ToolInvocation×n`, `Artifact×n`, `Evidence×n`, `WorkflowRun(status, finishedAt)`, attempt↔run link | — |
| 14 | `emitEventActivity` | `AuditEvent(task.succeeded)` | — |
| 15 | `completeTaskActivity` | `Task.status = succeeded` | task terminal |

Steps 11 and 13 are deliberately separate: the attempt is finalised by the activity that
ran it, and the durable result is written by an activity that can be retried idempotently.
A crash between them leaves a finalised attempt with no `AgentRun` — visible, and
repairable by re-running `persistResultActivity` with the same result payload.

---

## 4. Where the rows land

### `ExecutionWorkspace` — one per attempt

| Column | Key | Notes |
|---|---|---|
| `id` | PK | Deterministic: `execution-workspace:<workflowRunId>:<attemptNumber>` |
| `orgId`, `taskId` | FK | Tenant-scoped |
| `agentRunId` | FK, nullable | Set by `persistResultActivity` (the `AgentRun` does not exist yet at provision time) |
| `state` | | `requested … cancelled` (`WorkspaceState`) |
| `rootPath` | **unique** | Absolute, canonical, `0700`. Two rows can never claim one directory |
| `sourceKind` | | `clone` \| `worktree` \| `empty` |
| `sourceRef` | | The configured source repository, or `null` |
| `baseCommit`, `branch` | | Read from the checkout the manager just created |
| `readyAt`, `cleanedAt` | | `cleanedAt` is **null** for `cancelled` (F13) |
| `expiresAt` | | Present in the schema, **read by nothing** — no reaper |
| `error` | JSON | `{stage, message, code}` from a provisioning or cleanup failure |

### `ExecutionAttempt` — one per activity invocation

| Column | Key | Notes |
|---|---|---|
| `id` | PK | Deterministic: `execution-attempt:<workflowRunId>:<attemptNumber>` |
| `workflowRunId`, `taskId`, `orgId` | FK | |
| `agentRunId` | FK, nullable | Null when the attempt never produced a run |
| `attemptNumber` | | 1-based, no default |
| `runtimeId`, `simulated` | | Written by the executor from the adapter's report |
| `status` | | `queued \| running \| succeeded \| failed \| cancelled \| timed_out` |
| `startedAt`, `finishedAt`, `error` | | |

**`@@unique([workflowRunId, attemptNumber])` is the identity.** A retry is a new attempt,
never a silent second run under the first one's id.

### `AgentRun` — one per `(workflow run, runtime, attempt)`

| Column | Key | Notes |
|---|---|---|
| `id` | PK | `agent-run:<workflowRunId>:<runtimeId>:<attemptNumber>` |
| `workflowRunId` | FK | |
| `runtimeId`, `model`, `runtimeVersion` | | Model from `providerMeta.model`; version from the adapter (`opencode v2.2.7`) |
| `status` | | Mirrors the result status |
| `tokensIn`, `tokensOut` | | `0` when unknown — the schema cannot express `undefined` |
| `costUsd` | `Decimal(12,4)` | Provider-reported; `null` when the adapter reported nothing |
| `simulated` | | The adapter's report, never a default |
| `attemptNumber`, `workspaceId` | | |
| `providerMeta` | JSON | Model, session id, steps, egress decisions, tool count, truncation |

### `ToolInvocation` — one per observed tool call

| Column | Notes |
|---|---|
| `agentRunId`, `sequence` | **unique together**; ordering is `sequence`, not time |
| `tool`, `summary` | `summary` is redacted and `VarChar(500)` |
| `occurredAt` | Supplied by the adapter. No default: the database must not invent a time |

Capped at **200 rows per run**. A longer trace is truncated, and the truncation is
recorded in `AgentRun.providerMeta.toolInvocations` so the gap is visible.

### `Artifact` — one per `(org, task, kind, checksum)`

| Column | Notes |
|---|---|
| `id` | `artifact:<taskId>:<kind>:<checksum>` — content-addressed |
| `kind`, `uri`, `checksum`, `sizeBytes` | `uri` is an absolute host path written by the worker |
| `createdAt` | The **only** link to an attempt. There is no `attemptId` |

`@@unique([orgId, taskId, kind, checksum])` means a re-run that produces identical bytes
is the same artifact; a re-run that produces different bytes is a second row.

Before an artifact row exists, the bytes must be on disk under
`<workspace>/artifacts`. `materializeArtifacts` recomputes the digest from the bytes it
writes, so the row's checksum is a fact about the durable copy, not about the adapter's
claim.

### `Evidence` — one per artifact

`kind = 'artifact_checksum'`, `uri` = the artifact path, `producedBy` = the runtime id.
Unique on `(orgId, taskId, kind, uri)`. It is the statement "this runtime produced bytes
with this digest", separate from the artifact row.

### `AuditEvent` — task and workflow transitions only

| Column | Notes |
|---|---|
| `action`, `eventType` | e.g. `task.succeeded` / `task.succeeded.v1` |
| `aggregateType`, `aggregateId` | `Task` / `WorkflowRun` |
| `correlationId` | Survives HTTP → workflow → activity |
| `idempotencyKey` | Indexed per tenant (`@@index`), **not unique**. `emitEventActivity` looks for an existing `(orgId, idempotencyKey)` before creating, and treats `task.cancelled.v1` as a singleton. A race between two writers with no shared key is open — documented in `emit-event.ts`. |
| `occurredAt`, `payload` | |

**There is no audit event for an artifact write, a checksum verification, a workspace
provisioning, or a tool call.** The trail covers task and workflow transitions. An
auditor asking "who wrote this artifact" gets an answer from `Evidence`, not from
`AuditEvent`.

---

## 5. Attempt numbering

`startAttempt()` reads `max(attemptNumber)` for the workflow run, inserts `max + 1`, and
retries up to five times on `P2002` (unique violation). The unique constraint is the
authority under a race; the read is an optimisation.

- Attempt numbers are **per workflow run**, not per task. A task that fails terminally and
  is re-run gets a new `WorkflowRun` and its attempts start at 1 again.
- `(workflowRunId, attemptNumber)` is unique. `id` is derived from the same pair, so a
  retried activity that re-inserts hits the same primary key instead of creating a second
  row.
- A Temporal retry of `executeAgentActivity` creates **a new attempt**. Three attempts of
  one activity are three rows. That is the intended meaning of "the third try".
- A retry of `persistResultActivity` (a different activity) does **not** create a new
  attempt; it recomputes the same `agentRunId` and upserts.

`workspaceId` is likewise `<workflowRunId>:<attemptNumber>`, so **a retry gets a fresh
directory**, not the failed one.

---

## 6. Cancellation

Cancellation has three layers, and each does something different.

### 6.1 The API

`POST /v1/orgs/:orgId/tasks/:taskId/cancel`:

1. Task must be `queued` or `running`, else `409 TASK_NOT_CANCELLABLE`.
2. **Temporal first.** `cancelTaskWorkflow('task-<taskId>')`. If the orchestrator is
   unreachable, the API returns `503 ORCHESTRATOR_UNAVAILABLE` and **does not** mark the
   task cancelled — a task that is cancelled in the UI while the workflow keeps working is
   worse than a failed request.
3. Then, in one transaction: task → `cancelled`, active `WorkflowRun` →
   `cancelled` + `finishedAt`, `AuditEvent(task.cancelled)` with `orchestrator` in the
   payload.

### 6.2 Temporal

The workflow receives `CancelledFailure`. It runs `recordCancellation` in a
`CancellationScope.nonCancellable`, because an activity started inside an already-cancelled
scope would itself be cancelled before reaching the server, leaving the task `running`
forever.

- `completeTaskActivity(cancelled)` — if the task was already terminal (the API got there
  first), `changed` is `false` and no second audit event is written.
- Otherwise `AuditEvent(task.cancelled.v1)` with `cause: 'workflow_cancelled'`.
- The workflow **rethrows**, so Temporal records the execution as cancelled rather than as
  a successful workflow that stopped early.

### 6.3 The activity and the adapter

`executeAgentActivity` subscribes to `cancellationSignal()` and:

1. `controller.abort(reason)` — the `AbortSignal` the adapter was given is aborted.
2. `runtime.cancel(task.id)` — converges on the adapter's own cancel path, so an adapter
   that tracks executions by task id cleans up exactly as it would for a direct call.

The adapter's `runInProcessGroup` has registered a kill function:

```
process.kill(-child.pid, 'SIGTERM')     // the whole group
  … after killGraceMs (default 5 s) …
process.kill(-child.pid, 'SIGKILL')     // the whole group
```

The child is spawned `detached: true` (session and group leader), so every descendant
inherits the group id unless it calls `setsid`. `--unshare-pid` and `--die-with-parent`
give two more independent reasons a grandchild cannot outlive the run. Measured: a
backgrounded `(sleep 2; echo late > file) &` did not write the file when the run was
killed at 250 ms, and did write it in the positive control.

### 6.4 The workspace after cancellation

| What | Result |
|---|---|
| Workspace state | `cancelled` (terminal) |
| Checkout | **Still on disk.** `cleanup()` early-returns for `cancelled`; `cleanedAt` stays `null` |
| Artifacts | Whatever was copied before the abort. A cancelled run may have none |
| `AgentRun` | Written by `persistResultActivity` with the result the adapter returned (`cancelled`) |
| `ExecutionAttempt` | `cancelled`, `finishedAt` set |
| Directory | Unbounded growth: every cancelled run leaves a full clone (F13) |

The checkout is deliberately kept — "a cancelled workspace is evidence" — but nothing ever
removes it, which is a leak, not a retention policy. See §8.

---

## 7. Failure

### 7.1 What is recorded

A failure is recorded at the level where it happened, and no higher:

| Failure | Recorded in | Not recorded |
|---|---|---|
| Task not runnable / no approval | `Task.status = failed`, `WorkflowRun.error`, `AuditEvent(task.failed)` | No `AgentRun` — nothing ran, and inventing a runtime id would be a fabricated fact |
| Workspace provisioning failed | `ExecutionWorkspace(state=failed, error{stage,code,message})`, `ExecutionAttempt(failed)`, `Task.failed` | No `AgentRun` |
| Adapter returned `failed` | `AgentRun(status=failed, error)`, `ExecutionAttempt(failed)`, `Task.failed`, artifacts if any were produced | — |
| Adapter returned `timeout` | Same, with `RunStatus.timed_out` on the attempt/run and `error.retryable` from the adapter | — |
| Activity threw and exhausted three attempts | `Task.failed`, `WorkflowRun.error`, `AuditEvent` | No `AgentRun` — the workflow does not know the runtime produced it |
| Temporal cancellation | `Task.cancelled`, `AuditEvent`, attempt/workspace `cancelled` | — |

### 7.2 The rule

> **A failed run can never be persisted as `succeeded`.**

It is enforced in four places, not by convention:

1. `ExecutionResult.status` is a closed union; `persistResultActivity` maps it through
   `RUN_STATUS` and writes that value to `AgentRun`, `ExecutionAttempt` and `WorkflowRun`.
2. `executeAgentActivity` returns a `failed` banner result for any non-retryable
   pre-execution error, so the workflow never sees a success it did not earn.
3. `recordUnexpectedFailure` writes `failed` for anything that is not a cancellation, and
   the comment says why no `AgentRun` is written.
4. The workflow returns `status: 'failed'` when validation fails or an activity refuses,
   and the task's terminal write uses that value.

There is no `catch { return success }` path. The one place a "success" could be fabricated
is an adapter that returns `succeeded` without doing work (F12: a goal of `--help` produced
a green run with zero events). That is an adapter honesty bug, fixed by refusing an empty
parsed stream — `OPENCODE_EMPTY_STREAM` is the proposed guard and is **not yet in the
code**; `--help` is still accepted as a goal. See `PHASE-3-KNOWN-LIMITATIONS.md`, "A goal
beginning with `-` is still parsed as an `opencode` flag".

---

## 8. Recovery

### 8.1 What `workspace-manager.recover()` does

It takes a workspace id, looks the handle up **in the current process's map**, and:

| Situation | Action |
|---|---|
| State is not `provisioning` | Returns the handle unchanged |
| Directory does not exist | `provisioning → requested` — indistinguishable from "never started", so it is requeued rather than failed |
| Directory exists but has no `.git` | `provisioning → failed` with `{stage:'recover', code:'WORKSPACE_PROVISION_FAILED'}` |
| Directory and `.git` exist | Reads `HEAD` **inside `bwrap`** (`readHeadSandboxed`, because an agent may have written `.git`) → `provisioning → ready` |

It does not touch the database. The row is still `provisioning` after `recover()` returns;
something must write the new state.

### 8.2 The fact that matters

**Nothing schedules recovery.**

- `recover()` is called only from `packages/workspace-manager/test/workspace-manager.test.ts`.
- `adopt()` — the function that puts a database row back into the manager's map — is also
  called only from tests.
- Every activity invocation constructs a **new** manager (`createWorkspaceManager({root})`
  in `leaseWorkspace`), so its map is empty. A fresh manager asked to `recover(id)` throws
  `WORKSPACE_NOT_FOUND` with the message "adopt its row first".

So after a worker crash mid-provision:

- the directory may exist (half-cloned or complete),
- the row says `provisioning`,
- the next attempt gets a **new** workspace id and ignores it,
- and the stale directory stays until someone removes it by hand.

### 8.3 What an operator can do today

```sql
-- Workspaces that never reached a terminal state
select id, "taskId", state, "rootPath", "createdAt"
from "ExecutionWorkspace"
where state in ('requested','provisioning','ready','executing','preserving')
order by "createdAt";

-- Attempts still marked running
select id, "taskId", "attemptNumber", "runtimeId", status, "startedAt"
from "ExecutionAttempt"
where status = 'running'
order by "startedAt";
```

Then, deliberately and by hand:

1. Check the directory: `ls -la <rootPath>` and `ls <rootPath>/repo/.git`.
2. If it is a usable checkout, delete `repo/` and keep `artifacts/`; the next attempt will
   provision fresh.
3. Update the row to `failed` with an error, or `cancelled`, whichever is true. Do not
   write `completed` for a run that did not complete.
4. If the attempt has no `AgentRun`, leave it — a missing run is the honest record that
   nothing was persisted.

A reaper and a startup recovery pass are **NOT IMPLEMENTED**. They are listed in
`PHASE-3-KNOWN-LIMITATIONS.md` as "No workspace reaper" and "Nothing schedules
`workspace-manager.recover()`".

---

## 9. Artifact retrieval and integrity

### 9.1 The read path

```
GET /v1/orgs/:orgId/artifacts/:artifactId            → metadata + computed integrity
GET /v1/orgs/:orgId/artifacts/:artifactId/content    → bytes, or a typed refusal
GET /v1/orgs/:orgId/tasks/:taskId/executions/:id     → attempt + trace + artifacts
```

Every response resolves the stored absolute `uri` through the locator:

1. Resolve against `ARTIFACT_ROOT` or `WORKSPACE_ROOT`.
2. `realpath` the candidate; require it to be inside one of the roots **after** symlink
   resolution.
3. A path outside every root → `404` (never "here is the path").
4. A path that does not exist → its parent must still be contained, then `410`.

### 9.2 The checksum

`verifyArtifact()` re-reads the bytes and computes SHA-256. It never trusts the column.

| Result | Meaning | HTTP |
|---|---|---|
| `verified` | Bytes exist and match the recorded digest | `200` |
| `failed` | Bytes exist and disagree | **`409 ARTIFACT_INTEGRITY_FAILED`** |
| `unknown` | File gone, unreadable, or outside the roots | `410 ARTIFACT_GONE` (or `404` if outside every root) |

The `409` is raised **before a single header is written** (`artifacts.controller.ts`), so a
client never receives a `200` with a truncated body and a checksum that does not match it.
The response carries `{checksum: ["Expected <digest> for artifact <id>."]}`.

On success the response sets:

```
Content-Type: <by kind>
Content-Length: <verified size>
ETag: "sha256-<digest>"
X-Artifact-Checksum: <digest>
Content-Disposition: attachment; filename="<safe name>"
```

The filename is derived from the **logical** path, never the stored absolute path, and is
sanitised (`[^A-Za-z0-9._-]` → `_`) because a quote or newline in a header is an injection
primitive.

### 9.3 Role gate

| Artifact kind | VIEWER | MEMBER | ADMIN | OWNER |
|---|---|---|---|---|
| metadata (`GET /artifacts/:id`) | yes | yes | yes | yes |
| `diff`, `report` content | yes | yes | yes | yes |
| `transcript` content | **403** | **403** | yes | yes |

The check is in the service, not `@Roles`, because it depends on the artifact's `kind`,
which is only known after the row is loaded.

### 9.4 What integrity does not prove

- It proves the bytes match the digest **recorded in the same database**. A worker-level
  compromise can rewrite both.
- It does not prove the bytes are the agent's real output — only that they are the bytes
  that were stored.
- It does not prove the artifact belongs to the attempt that lists it: attribution is a
  time window (§4, `Artifact`). One open workflow per task makes it unambiguous today.

---

## 10. A worked trace of the real run

Read this against the rows in §4; it is the same run described in
`PHASE-3-IMPLEMENTATION-STATUS.md` §2.

```
14:02:47.636  Task created (LOW)                              AuditEvent task.created
14:02:47.656  task.status_changed ready → queued              AuditEvent
14:02:47.678  task.status_changed queued → running            AuditEvent
14:02:47.709  WorkflowRun started                             AuditEvent workflow.started
14:02:48.211  task.status_changed running (workflow)          AuditEvent
14:02:48.342  ExecutionAttempt #1 started                     ExecutionAttempt(running, opencode-cli, simulated=false)
14:02:48.398  ExecutionWorkspace ready                        baseCommit 371d5f42, branch main, source clone
14:02:48.4xx  workspace executing
14:03:04.740  six tool calls observed                         ToolInvocation ×6
14:03:04.787  attempt succeeded, finishedAt                   ExecutionAttempt(succeeded)
14:03:04.796  workspace completed, cleanedAt                  checkout removed, artifacts kept
14:03:04.897  AgentRun finished                               1206/424 tokens, $0.0006, opencode v2.2.7
14:03:04.923  Artifact transcript                             13,545 B, 3874cc46…
14:03:04.930  Artifact diff                                   284 B, 584e34c9…
14:03:04.98   Task succeeded                                  AuditEvent task.succeeded
```

Duration: **16.4 s adapter-reported** (its own summary), 16.445 s for the attempt, and
16.758 s for the `WorkflowRun` row (`startedAt` 14:02:48.139 → `finishedAt` 14:03:04.897).
Note that `AgentRun.startedAt` is copied from the workflow run, so `AgentRun`'s 16.758 s is
the workflow span, not the model's time. The 83 ms between the attempt's `finishedAt`
(04.787) and the task's success (04.980) is artifact materialisation, persistence and the
audit write.
