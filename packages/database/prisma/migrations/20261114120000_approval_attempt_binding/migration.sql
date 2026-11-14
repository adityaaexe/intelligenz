-- Phase 5 (BE-501): approval → attempt binding.
--
-- Additive only. No column is dropped, narrowed, or reinterpreted, and no existing row
-- is rewritten.
--
-- `WorkflowRun.idempotencyKey` records the client's `Idempotency-Key` for the
-- `POST /run` that created the row. It exists so a retry of the same request can be
-- answered from the first request's outcome (same WorkflowRun, same ExecutionAttempt)
-- instead of reserving a second attempt. Nullable on purpose: every row written before
-- this migration carried no key, and back-filling one would invent a request the client
-- never made. Postgres treats NULLs as distinct in a unique index, so those legacy rows
-- coexist with one another while two runs with the same key collide.
ALTER TABLE "WorkflowRun" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "WorkflowRun_taskId_idempotencyKey_key"
  ON "WorkflowRun"("taskId", "idempotencyKey");
