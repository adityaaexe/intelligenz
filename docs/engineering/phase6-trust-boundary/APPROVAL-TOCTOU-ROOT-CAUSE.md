# Approval-to-attempt TOCTOU — root cause

**Gate:** O1, `docs/engineering/phase5-recovery/REMEDIATION-REGISTER.md`
**Status at Phase 5 close:** PARTIAL — two executions holding the genuine attempt
id could both validate while the attempt remained `queued`.
**Status now:** PASS at `23db912`, after four independent review rounds.

## The stated defect

Phase 5's register recorded that two executions holding the same attempt id could
both pass authorisation while the attempt was `queued`. Temporal's workflow-id
dedupe was the only thing preventing a second agent, and that is not a security
control: it prevents two workflows with the *same id*, not two executions, and
anyone with Temporal access can dispatch an activity by name.

## Root cause, in layers

The register described a race. Fixing it exposed three further defects underneath,
each found by a reviewer rather than by the implementation.

### Layer 1 — authorisation was a check, not a claim

`validateTaskActivity` read the attempt, evaluated the approval binding, and
returned `{ runnable: true }`. Nothing was written. Two callers could therefore
both observe `queued`, both pass, and both proceed. The state was consulted, never
consumed.

### Layer 2 — the control was one activity upstream of the side effect

The first fix added a durable one-shot claim. It was correct — a conditional
`updateMany`, proven atomic under real concurrency — and **irrelevant**, because
it lived in validation while the side effects live in `executeAgentActivity`.
Activities are dispatched by name (`activities/index.ts`), so any workflow on the
worker's task queue could call the executor directly and skip validation entirely.

> Reviewer reproduction, `3aed33d`: a HIGH-risk task with **no approval row** was
> refused by validation with `APPROVAL_REQUIRED`, then **ran** when the executor
> was invoked directly. `status=succeeded`, `claimedByWorkflowRunId=null`.

The codebase already contained the correct pattern three lines away: the
isolation gate at `execute-agent.ts:211-213` is unbypassable *because* it sits at
the launch site. **Location, not logic, was the defect.**

### Layer 3 — the identity could be forged

The claim's ownership test was `claimedByWorkflowRunId === thisExecutionRunId`.
Correct logic. But `thisExecutionRunId` had a fallback: when no workflow context
existed, take the value from caller input — a convenience for direct invocation.

> Reviewer reproduction, `74207f0`: a standalone Temporal activity, dispatchable
> by name on the same task queue, supplied a victim's run id. With the victim
> already adopted it created attempt 2 under the victim's claim and ran
> concurrently. With the victim not yet adopted it spent attempt 1.

Both the attempt id and the run id are readable from workflow history by anyone
with Temporal access — which is the register's own stated precondition for O1. A
fallback that exists for convenience is an impersonation primitive.

### Layer 4 — the release probe asked a derived question

Fixing a fail-closed bug (a missing workflow was never classified `absent`, so a
deleted run stranded its claim forever) exposed a fail-open one in the same path:
the probe asked Temporal about `task-<taskId>` plus the holder's run id. A live
execution running under any other workflow id answered NOT_FOUND → `absent` →
**released while RUNNING**.

> Reviewer reproduction, `a75f121`: `liveStatus: RUNNING` → `released` → attempt
> `failed`, claim NULL.

The classifier was right; the inputs were wrong. A claim must be released on
evidence about *that execution*, not about a naming convention.

## The root cause in one sentence

Authorisation was enforced **where it was convenient** (validation, with a
fallback identity, and a probe keyed on a derived name) rather than **where the
side effect occurs, keyed on an identity the server minted**.

## Threat model

| Capability of the attacker | In scope |
|---|---|
| Temporal access: start workflows, dispatch activities by name, read workflow history | **Yes** |
| Repository content, `.git/config`, hooks, attributes | Yes (see `ARTIFACT-INTEGRITY-ROOT-CAUSE.md`) |
| Direct database write access | No — outside every control here, stated as a residual |
| Provider credential (any user) | No — separate Phase 7 workstream |

## Why the race needed real infrastructure to prove

Every claim about this control was verified against real PostgreSQL and real
Temporal, never a mock:

- two concurrent conditional updates, five rounds, one winner each;
- a real standalone activity on the production registry carrying four forged
  identity field names at once;
- two concurrent direct `runTaskWorkflow` starts with no attempt id;
- a live claim under a non-canonical workflow id.

A mocked repository cannot demonstrate EvalPlanQual re-evaluation, and a mocked
Temporal cannot demonstrate what a standalone activity can address.

## Residual, stated exactly

The claim **serialises execution; it does not authenticate the operator.** Whoever
wins the write executes. What changed is that only one of them can run.

Temporal access remains a trusted capability: a caller who can start a workflow
and dispatch activities can consume a reservation it did not initiate, bounded by
the approval binding for HIGH/CRITICAL and by the claim for one-execution-only.

## Evidence paths

- `docs/engineering/phase6-trust-boundary/FINAL-INDEPENDENT-REVIEW.md` — four rounds, F1–F4, N1–N15
- `docs/engineering/phase6-trust-boundary/APPROVAL-ATOMIC-CLAIM-VERIFICATION.md`
- `docs/engineering/phase6-trust-boundary/AG-603-IDENTITY-AND-AUTHORITY.md`
- `docs/engineering/phase6-trust-boundary/AG-604-CLAIM-IDENTITY-AND-WRITE-AUTHORITY.md`
- `apps/worker/src/activities/claim.ts`, `execute-agent.ts`, `attempts.ts`, `claim-release.ts`
