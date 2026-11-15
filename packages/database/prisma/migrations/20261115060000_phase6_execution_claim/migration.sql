-- Phase 6 (AG-601): the one-shot execution claim.
--
-- Additive only. No column is dropped, narrowed, or reinterpreted, and no existing row
-- is rewritten.
--
-- The defect this closes: two executions holding the same `attemptId` could both pass
-- `validateTaskActivity` while the attempt was `queued` — the gate read the status and
-- wrote nothing — and both could proceed toward execution authority. Temporal's
-- workflow-id dedupe was the only thing standing between one approval and two agents.
--
-- The fix is a durable claim, written by a single conditional UPDATE whose predicate
-- requires `status = 'queued'` AND `claimedByWorkflowRunId IS NULL`, so exactly one
-- claimant wins. `claimedByWorkflowRunId` holds the **Temporal** run id, which is
-- stable across activity retries within one execution and different for a duplicate
-- execution; it is deliberately not `WorkflowRun.id`, which the API writes before any
-- workflow exists and which a duplicate `POST /run` would therefore share.
--
-- NULL means unclaimed, which is the correct reading of every row written before this
-- migration: none of them was claimed, because the column did not exist.
ALTER TABLE "ExecutionAttempt" ADD COLUMN "claimedByWorkflowRunId" TEXT;
ALTER TABLE "ExecutionAttempt" ADD COLUMN "claimedAt" TIMESTAMP(3);

-- Not unique. One execution may hold several attempts over its life (a retry after a
-- crash is a new attempt), so uniqueness is per attempt, enforced by the conditional
-- UPDATE, not per claim holder. The index serves both the claim read-back and the
-- operator question "what did this run claim".
CREATE INDEX "ExecutionAttempt_claimedByWorkflowRunId_idx"
  ON "ExecutionAttempt"("claimedByWorkflowRunId");
