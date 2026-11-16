-- Phase 8.7: the proposal layer. One table, one enum, nothing touched.
--
-- The gap this closes: the programme layer (8.6) can schedule a graph, but nothing could
-- *propose* one. A model asked for a plan had no row to land in, no record of what was
-- validated, and no place for a human decision to be attached. Without this table the only
-- way to turn a proposal into work would be to hand it straight to `POST /programmes`,
-- which would make the model's output execution authority.
--
-- Additive only: no existing column is added, narrowed, or reinterpreted, and no existing
-- row is back-filled. A `Plan` is created by the planner endpoint and by nothing else, so
-- there is no legacy row that would need an invented proposal or an invented approver.
--
-- Three choices recorded here because the DDL does not explain them:
--
--   * `provider`, `providerModel` and `simulated` are columns, not fields of `proposal`.
--     The proposal is untrusted model output; provenance is what the server observed. A
--     model that could set these would be attesting to its own authenticity.
--
--   * `approvedContentHash` is nullable. A proposal that never reached a decision was never
--     approved, so there is no content it authorises. Null is the honest state; a
--     back-filled hash would claim a review that never happened. Submission recomputes the
--     hash from the stored proposal and refuses on a mismatch.
--
--   * `programmeId` is UNIQUE and ON DELETE SET NULL. One approved plan materialises into
--     at most one programme (the unique index is the guarantee, not a read-then-write
--     check), and pruning a programme must not destroy the approval that authorised it.
--     The user references are ON DELETE RESTRICT, matching `ApprovalRequest`: who proposed
--     and who approved are part of the record.

-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('proposed', 'invalid', 'approved', 'rejected', 'submitted');

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "status" "PlanStatus" NOT NULL DEFAULT 'proposed',
    "provider" TEXT NOT NULL,
    "providerModel" TEXT,
    "simulated" BOOLEAN NOT NULL DEFAULT true,
    "proposal" JSONB NOT NULL,
    "validation" JSONB NOT NULL,
    "approvedContentHash" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvalExpiresAt" TIMESTAMP(3),
    "rejectedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "programmeId" TEXT,
    "createdById" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Plan_programmeId_key" ON "Plan"("programmeId");

-- CreateIndex
CREATE INDEX "Plan_orgId_status_idx" ON "Plan"("orgId", "status");

-- CreateIndex
CREATE INDEX "Plan_orgId_createdAt_idx" ON "Plan"("orgId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_orgId_idempotencyKey_key" ON "Plan"("orgId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_rejectedById_fkey" FOREIGN KEY ("rejectedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_programmeId_fkey" FOREIGN KEY ("programmeId") REFERENCES "Programme"("id") ON DELETE SET NULL ON UPDATE CASCADE;
