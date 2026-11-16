# Existing architecture map — Phase 8.6 P0-D

**Measured at:** `4f10d67` · **Method:** reading the repository, not the roadmap

---

## 1. What exists, precisely

| Layer | Reality | Location |
|---|---|---|
| **Programme model** | **Does not exist.** `grep -cE "^model (Programme\|Program\|TaskDependency\|Checkpoint)"` → **0** | `packages/database/prisma/schema.prisma` |
| Models present (15) | `Organization Workspace User Membership Project Task WorkflowRun AgentRun Artifact Evidence ExecutionWorkspace ExecutionAttempt ToolInvocation ApprovalRequest AuditEvent` | same |
| **Workflows** | **One**: `run-task.ts` | `apps/worker/src/workflows/` |
| Activities | **Six**: validate, recordStart, executeAgent, persistResult, emitEvent, completeTask | `apps/worker/src/activities/index.ts` |
| Workflow start | **One call site**, reached from `POST /run` | `apps/api/src/orchestrator/orchestrator.service.ts:149` |
| Redis | **Not used in source** — no `ioredis`/`redis` import outside tests | — |
| Task lifecycle | `TaskStatus` enum: `draft ready queued running verifying succeeded failed blocked cancelled` | schema |

## 2. The gap, stated exactly

```
POST /run  ──►  start runTaskWorkflow(task-<id>)  ──►  one task  ──►  ends
```

That is the entire orchestration. Consequences:

1. **Nothing schedules a second task.** After A completes, B is eligible only if a human calls `POST /run` again.
2. **No dependency edges exist.** `Task` has `projectId`, `workspaceId`, no `dependsOn`.
3. **No programme state.** There is no row that says "these five tasks are one objective".
4. **No continuation, so no autonomy.** `AUTONOMOUS OPERATION: NOT YET PROVEN` is not a reporting gap; it is an accurate description of the code.

What *does* exist and must be reused, not rebuilt:

- the durable task workflow with its claim, approval binding, evidence capture and write authority;
- `ExecutionAttempt` with `claimedByWorkflowRunId` — the one-shot execution claim;
- `WorkflowRun.temporalRunId` and the idempotency key;
- the six activities with their authority checks;
- `TaskStatus` as the per-task state, already transition-validated in `apps/api/src/tasks/`.

## 3. The smallest design that produces real continuation

**Do not build a second orchestrator.** Temporal already runs durable child workflows; the programme engine is a parent workflow that dispatches `runTaskWorkflow` as children.

```
submitProgramme (one API call)
        │
        ▼
runProgrammeWorkflow(programmeId)                    ← NEW parent
        │  reads dependency graph
        │  computes ready set
        ├─► child runTaskWorkflow(task-A)  ──► verified
        │        (all existing claim/approval/evidence controls unchanged)
        ├─► child runTaskWorkflow(task-B)  ──► verified   (B depended on A)
        └─► child runTaskWorkflow(task-C)  ──► verified
        │
        ▼
    programme terminal ──────────────────────────────► evidence chain
```

### New schema (additive only)

| Model | Fields that matter |
|---|---|
| `Programme` | `id`, `orgId`, `projectId`, `objective`, `status`, `createdAt` |
| `ProgrammeTask` | `programmeId`, `taskId`, `dependsOn String[]`, `status`, `attemptCount` |
| `ProgrammeCheckpoint` | `programmeId`, `sequence`, `taskId`, `outcome`, `evidenceJson` |

Nullable/defaulted, no back-fill: every existing `Task` remains valid and unparented.

### Why a parent workflow and not a polling scheduler

A polling scheduler needs its own lease, its own duplicate-suppression and its own restart recovery — all of which Temporal already provides for workflows. A parent workflow gets durability, replay, child cancellation and Continue-As-New for free, and it cannot double-dispatch because workflow execution is single-threaded and deterministic.

The trade-off, stated: a programme that must survive for weeks will need Continue-As-New and a bounded history; a programme whose workers are down stays durable but makes no progress. Both are correct behaviours, not defects.

### The one thing that must not be duplicated

`runTaskWorkflow` keeps **all** of its controls. The parent must not re-implement the claim, the approval gate, or the evidence capture — it dispatches and awaits. Any design that lets the programme layer authorise execution would reopen the O1 defect this project spent four review rounds closing.

## 4. What "autonomous" will mean when it is true

`THREE-TASK-E2E`: one `submitProgramme` call, then **no further operator input**, and the assertion is on durable rows:

1. `Programme.status = 'succeeded'`;
2. three `ProgrammeCheckpoint` rows in dependency order;
3. three `Task.status = 'succeeded'` with their own `ExecutionAttempt` claims;
4. an artifact/evidence chain per task;
5. **zero** additional API calls after submission.

A test that asserts "the workflow returned" does not prove this. The claim must be read back from the database.

## 5. Failure modes the parent must handle, and how

| Failure | Behaviour |
|---|---|
| Child task fails permanently | Mark that `ProgrammeTask` failed; **do not** stop independent branches; block only its dependents |
| Child times out | Retry per the task's own retry policy; a new `ExecutionAttempt`, never a reused claim |
| Worker dies mid-child | Temporal retries the child; the claim's `claimedByWorkflowRunId` distinguishes the retry from a duplicate |
| Approval required | Child blocks; programme records `waiting_for_approval`; independent tasks continue |
| Duplicate submission | Idempotency key on `Programme`; a second submit returns the existing programme |
| Controller restart | Programme state is in Postgres and in workflow history; nothing is held in memory |

## 6. What this map deliberately does not decide

- **Planner.** Whether the dependency graph is authored by a human, produced by an LLM and validated, or both. The validation contract (no cycles, no missing deps, no task without acceptance criteria) is independent of who writes it, so it can be built first and the planner plugged in after.
- **Adapter selection.** One runtime is wired today; the parent must not hard-code it.
- **Per-attempt isolation (8.5).** Prerequisite for *concurrent* programme branches. Sequential A→B→C does not need it; parallel branches do.
