# Approval atomic claim — verification record

**Commits under review:** `3aed33d` → `74207f0` → `a75f121` → `23db912` → `58476b0`
**Branch:** `phase-6/trust-boundary-closure`
**Final verdict for the gate:** **PASS** (granted at `23db912`; `58476b0` adds only
the N12/N13 corrections, verified by targeted suites). The verification table in `AG-604` uses
`a75f121` as its base — the lineage is consistent, the two documents just anchor at different
commits.

## The mechanism

One conditional write decides ownership. The database, not the application,
settles the race.

```sql
UPDATE "ExecutionAttempt"
   SET "claimedByWorkflowRunId" = $1, "claimedByWorkflowId" = $2, "claimedAt" = $3
 WHERE id = $4 AND "orgId" = $5 AND "taskId" = $6
   AND status = 'queued'
   AND "claimedByWorkflowRunId" IS NULL
```

`count === 1` is the grant. The loser blocks on the row lock, re-evaluates against
the committed row under READ COMMITTED and matches nothing. There is no
read-then-write (`execution-claim.test.ts:315` runs two concurrent claimants against real
PostgreSQL and asserts exactly one grant; a read-then-write implementation fails it).

The grant's audit row is written **in the same transaction** as the update
(`claim.ts:307-332`). That part is **inspection, not a test**: no test forces the transaction
to roll back after the update and asserts the absence of both the claim and the event. The
one-winner test proves the compare-and-swap, not the audit atomicity. A rollback test is the
trigger to state this as enforced. (The citation used to read `:230-247`, which no longer
resolves to the transaction.)

## Identity

`executionIdentity()` — **zero arguments**, reads
`Context.current().info.workflowExecution.runId` (and `…workflowId`). The identity
fields were **deleted** from the activity inputs, not ignored, so no production
path can supply one. Absent context is `EXECUTION_IDENTITY_UNAVAILABLE`,
non-retryable, refused before the first read and before the claim write.

A lost claim is classified by identity, never permission: same run + `queued`/
`running` → **retry**; different run → `EXECUTION_ALREADY_CLAIMED`; terminal →
refused.

## Enforcement at the launch site

`executeAgentActivity` refuses, in order, before any side effect:

1. no claimable identity;
2. no attempt named;
3. attempt not in this org + task;
4. no claim on the attempt;
5. claim held by another execution;
6. attempt not matching the named `WorkflowRun`;
7. for HIGH/CRITICAL: no live grant, revoked, expired, unbound, stale hash,
   un-consumed, pre-Phase-5 row, or bound to a different attempt.

Authorisation logic is **shared** with validation (`approvals/authorisation.ts`),
not duplicated, so the two altitudes cannot drift. One deliberate difference: the
`status === 'queued'` clause is not applied at launch, because it would refuse the
retry of an execution that already adopted its attempt. The claim is the exact
control there.

## Review history — four rounds, each with a real finding

| SHA | Verdict | What it found |
|---|---|---|
| `3aed33d` | **FAIL** | F1 launch site ignored the claim (an unapproved HIGH task ran); F2 adoption ignored it; F3 two no-attempt direct starts both ran; F4 wedge risk |
| `74207f0` | **FAIL** | N1 **High**: identity forgeable via caller fallback (standalone activity ran a duplicate under the victim's claim); N2 `absent` unreachable; N3 script; N4 persist/complete unchecked |
| `a75f121` | **PASS gate / FAIL commit** | N7 **regression from N2's fix**: a live claim released when the holder's workflow id was not `task-<taskId>`; N8 pre-dispatch accepted `succeeded`; N4 class open for emit/start |
| `23db912` | **PASS** | N12 legacy claims starve the batch; N13 the workflow-id writer had no failing test; N14/N15 stale comments |

Three of four rounds found a genuine bypass. The commit messages were confident
each time; the reviewer was right each time.

## What the tests prove, and how they would fail

| Property | Test | Fails when |
|---|---|---|
| One winner under concurrency | 5 rounds, real Postgres, one `count === 1` | predicate widened |
| Same run is idempotent | ×3, `claimedAt` unchanged | identity compared by nonce |
| Standalone activity cannot forge identity | 4 forged field names at once → `EXECUTION_IDENTITY_UNAVAILABLE`, `newAttempts=0` | fallback reintroduced |
| No-attempt direct start refused | 2 concurrent real Temporal starts → both `failed`, 0 `AgentRun` | validate-site refusal removed |
| Launch site enforces | direct call for unapproved HIGH → refused, zero side effects | entry check removed |
| Non-owner cannot adopt | intruder `EXECUTION_ATTEMPT_TAKEN`, owner succeeds | CAS conjunct removed |
| Live claim never released | `probe-<uuid>` live → `skipped_live`, claim intact, execution still completes | probe asks `task-<taskId>` |
| Legacy claims cannot starve | 5 NULL-id rows + 1 genuine, `batchSize 5` | candidate predicate removed |
| The writer is tested | claim from shipped validation, `probe-<uuid>` id | `validate-task.ts:259` deleted |

The five controls recorded in `AG-604` §5 were verified by mutation, each with the failing test
named. The remaining rows are backed by the tests cited, **not** by a recorded mutation. The
previous sentence — "Every row above was verified by mutation" — was not true, and it is the
kind of sentence that stops the next reviewer from checking.

## Residuals

1. **Serialisation, not authentication.** Whoever wins the write executes.
2. **Temporal access is a trusted capability.** A caller inside that boundary can
   consume a reservation it did not initiate — bounded to denial, not duplication.
3. **Unclaimed `running` attempts** are foreign to every execution: fail-closed,
   migration-window-only, row shape documented, predicate deliberately not relaxed.
4. **Deployment window.** A workflow in flight with no `attemptId` in history is
   refused on its next activity. Drain before rollout; fail-closed by design.
5. **`emitEventActivity`/`recordStartActivity`** are authorised for `Task`
   aggregates. Five other aggregate namespaces remain writable by name (N15).
6. **Two real-Temporal tests skip in CI** — no Temporal service in `ci.yml`.

## Gate status

**Approval-to-attempt: PASS**, with the boundary above stated rather than implied:
no second execution authority for one reserved attempt, enforced at the only path
to `runtime.execute`, on an identity the server mints.
