-- Phase 4, unit B (DB-401): execution trust.
--
-- Additive only. Nothing is dropped, renamed or narrowed. Every column added to an
-- existing table is nullable or carries a default, so the 20 Task / 10 Artifact /
-- 4 ApprovalRequest / 4 ExecutionAttempt / 3 ExecutionWorkspace rows written before
-- this migration survive without being rewritten. No row is updated by this file.
--
-- Generated with:
--   pnpm exec prisma migrate diff --from-config-datasource \
--     --to-schema prisma/schema.prisma --script
-- and applied **verbatim**. There is no hand-edited DATA section this time: unlike
-- the Phase 3 migration, no existing column changes meaning, so there is nothing to
-- backfill and nothing that could be reverted into a lie.
--
-- ─── What changes, and why ──────────────────────────────────────────────────
--
-- 1. ApprovalRequest becomes a grant rather than a note.
--    Phase 3 wrote one APPROVED row and nothing consumed it, so a single approval
--    authorised every retry forever, and nothing bound it to the content that was
--    approved. New columns: the content hash the decision was made against, the risk
--    class the approver actually saw, the policy that produced it, the execution
--    profile it authorises, an expiry, single-use consumption, and withdrawal.
--
-- 2. Artifact gains direct provenance.
--    Phase 3 attributed artifacts to attempts by comparing timestamps — a heuristic
--    with no FK and no test that could fail. `attemptId` and `workspaceId` replace the
--    guess for new rows. They are nullable and deliberately **not backfilled**: NULL
--    is the truthful state of every pre-Phase-4 artifact, and inventing an attempt
--    link for those rows would manufacture evidence. Callers must read NULL as
--    "unattributed", not as "attempt zero".
--
-- 3. ExecutionAttempt records resources and cause of termination.
--    Recorded, not yet enforced. `terminationReason` separates "the run failed" from
--    "we killed it", which Phase 3 could not express.
--
-- 4. ExecutionWorkspace gains a lease and a cleanup ledger.
--    Without a lease holder, an expiry and a heartbeat, a reaper cannot distinguish a
--    live run from a directory left by a dead worker, so the safe action is to reap
--    nothing — which is exactly what Phase 3 did. `cleanupAttempts` / `cleanupError`
--    make a repeatedly failing cleanup visible instead of infinite.
--
-- 5. Task records where its risk class came from.
--    `riskClass` itself is **not** redefined here. The API unit will begin writing a
--    server-derived value into it under a server-controlled rule; this migration only
--    adds the evidence trail (`riskSource`, `derivedRiskClass`, `riskPolicyVersion`,
--    `riskFactors`) beside it. Existing rows get `riskSource = 'client'`, which is the
--    honest description of a column that was populated from the request body.
--
-- Explicitly out of scope: no evaluation tables. The Phase 4 eval harness writes JSON
-- on disk; a table would imply a query surface that does not exist yet.
--
-- ─── The enum question, answered by measurement, not by folklore ────────────
--
-- Two enum types gain labels: ApprovalStatus += EXPIRED, REVOKED; WorkspaceState +=
-- allocated, finalizing, cleanup_pending, cleaned, cleanup_failed, quarantined.
-- Postgres enum labels are positional, so these are appended and no existing label is
-- touched. No label is removed, renamed or reordered.
--
-- The received wisdom is "ALTER TYPE ... ADD VALUE cannot run inside a transaction,
-- so split the migration". Both halves of that were measured on this host
-- (PostgreSQL 18.6) before deciding, because a split that is not needed is worse than
-- no split: it turns one atomic unit of intent into two partially-applied ones.
--
--   (a) ADD VALUE inside an explicit transaction is allowed on this server:
--         BEGIN;
--         ALTER TYPE "probe_status" ADD VALUE 'C';   -- succeeds
--         COMMIT;
--
--   (b) What is *not* allowed is using a new label in the transaction that added it:
--         BEGIN;
--         ALTER TYPE "probe_status" ADD VALUE 'E';
--         ALTER TABLE probe_t ALTER COLUMN s SET DEFAULT 'E';
--         -- ERROR: unsafe use of new value "E" of enum type probe_status (SQLSTATE 55P04)
--         -- the ROLLBACK also discards the ADD VALUE, so the retry starts clean.
--
--   (c) Prisma 7.10.1 does **not** wrap a migration file in a transaction on
--       PostgreSQL. Proven by applying a two-statement file whose second statement
--       was invalid: the first statement's effect survived the failure and the
--       migration was recorded as failed (`finished_at IS NULL`, error 42701).
--
-- Therefore this file needs no split, and splitting would not have bought atomicity
-- anyway (see (c)). The ordering matters and is what makes it safe: the ADD VALUE
-- statements come first and nothing in this file uses a new label — no new column
-- defaults to one, no data statement references one. A future migration that needs
-- `DEFAULT 'cleaned'` must be its own file, because by then the label is committed.
--
-- If this project is ever ported to PostgreSQL 11 or earlier, both constraints bite at
-- once and Prisma cannot express the workaround: run each ADD VALUE by hand, in
-- autocommit, before `migrate deploy`:
--   psql "$DATABASE_URL" -c "ALTER TYPE \"ApprovalStatus\" ADD VALUE 'EXPIRED'"
--   ... one statement per invocation, no explicit BEGIN ...
-- then deploy the remainder. That path is documented, not tested — the target is 18.
--
-- ─── ROLLBACK (no down migrations in Prisma; run by hand, in this order) ────
--   ALTER TABLE "ApprovalRequest" DROP CONSTRAINT "ApprovalRequest_consumedByAttemptId_fkey";
--   DROP INDEX "ApprovalRequest_consumedByAttemptId_idx";
--   DROP INDEX "ApprovalRequest_expiresAt_idx";
--   DROP INDEX "ApprovalRequest_orgId_taskId_status_idx";
--   ALTER TABLE "ApprovalRequest" DROP COLUMN "taskContentHash", DROP COLUMN "riskClassAtApproval",
--     DROP COLUMN "policyVersion", DROP COLUMN "executionProfile", DROP COLUMN "expiresAt",
--     DROP COLUMN "consumedAt", DROP COLUMN "consumedByAttemptId", DROP COLUMN "revokedAt",
--     DROP COLUMN "revokedById";
--   ALTER TABLE "Artifact" DROP CONSTRAINT "Artifact_workspaceId_fkey";
--   ALTER TABLE "Artifact" DROP CONSTRAINT "Artifact_attemptId_fkey";
--   DROP INDEX "Artifact_workspaceId_idx";
--   DROP INDEX "Artifact_attemptId_idx";
--   ALTER TABLE "Artifact" DROP COLUMN "attemptId", DROP COLUMN "workspaceId";
--   DROP INDEX "ExecutionWorkspace_state_leaseExpiresAt_idx";
--   ALTER TABLE "ExecutionWorkspace" DROP COLUMN "leaseExpiresAt", DROP COLUMN "leaseOwner",
--     DROP COLUMN "lastHeartbeatAt", DROP COLUMN "cleanupAttempts", DROP COLUMN "cleanupError";
--   ALTER TABLE "ExecutionAttempt" DROP COLUMN "executionProfile", DROP COLUMN "cpuTimeMs",
--     DROP COLUMN "memoryPeakBytes", DROP COLUMN "pidsPeak", DROP COLUMN "terminationReason",
--     DROP COLUMN "cleanupState";
--   ALTER TABLE "Task" DROP COLUMN "riskSource", DROP COLUMN "derivedRiskClass",
--     DROP COLUMN "riskPolicyVersion", DROP COLUMN "riskFactors";
--   -- Enum labels cannot be removed without recreating the type; leave them. An unused
--   -- label is inert; a type rebuild is a table rewrite and a needless outage.
--
-- Data loss on rollback: every value above is recording-only for Phase 4 (nobody has
-- written to these columns yet at deploy time), so rollback loses no user data. After
-- Phase 4 begins writing them, rolling back discards the provenance and the cleanup
-- ledger, and the workspace reaper must be stopped first or it will act on NULL leases.
--
-- Recovery if this file fails part-way (migrations are not atomic, see (c)):
--   prisma migrate resolve --rolled-back 20261114035043_phase4_execution_trust
-- then remove whatever objects were already created (the error names them) and
-- redeploy. Do not hand-edit the file to match a half-applied state.

-- ═══ generated by `prisma migrate diff` from here; statement text unmodified ═══

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ApprovalStatus" ADD VALUE 'EXPIRED';
ALTER TYPE "ApprovalStatus" ADD VALUE 'REVOKED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "WorkspaceState" ADD VALUE 'allocated';
ALTER TYPE "WorkspaceState" ADD VALUE 'finalizing';
ALTER TYPE "WorkspaceState" ADD VALUE 'cleanup_pending';
ALTER TYPE "WorkspaceState" ADD VALUE 'cleaned';
ALTER TYPE "WorkspaceState" ADD VALUE 'cleanup_failed';
ALTER TYPE "WorkspaceState" ADD VALUE 'quarantined';

-- AlterTable
ALTER TABLE "ApprovalRequest" ADD COLUMN     "consumedAt" TIMESTAMP(3),
ADD COLUMN     "consumedByAttemptId" TEXT,
ADD COLUMN     "executionProfile" TEXT,
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "policyVersion" TEXT,
ADD COLUMN     "revokedAt" TIMESTAMP(3),
ADD COLUMN     "revokedById" TEXT,
ADD COLUMN     "riskClassAtApproval" "RiskClass",
ADD COLUMN     "taskContentHash" TEXT;

-- AlterTable
ALTER TABLE "Artifact" ADD COLUMN     "attemptId" TEXT,
ADD COLUMN     "workspaceId" TEXT;

-- AlterTable
ALTER TABLE "ExecutionAttempt" ADD COLUMN     "cleanupState" TEXT,
ADD COLUMN     "cpuTimeMs" INTEGER,
ADD COLUMN     "executionProfile" TEXT,
ADD COLUMN     "memoryPeakBytes" BIGINT,
ADD COLUMN     "pidsPeak" INTEGER,
ADD COLUMN     "terminationReason" TEXT;

-- AlterTable
ALTER TABLE "ExecutionWorkspace" ADD COLUMN     "cleanupAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "cleanupError" JSONB,
ADD COLUMN     "lastHeartbeatAt" TIMESTAMP(3),
ADD COLUMN     "leaseExpiresAt" TIMESTAMP(3),
ADD COLUMN     "leaseOwner" TEXT;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "derivedRiskClass" "RiskClass",
ADD COLUMN     "riskFactors" JSONB,
ADD COLUMN     "riskPolicyVersion" TEXT,
ADD COLUMN     "riskSource" TEXT NOT NULL DEFAULT 'client';

-- CreateIndex
CREATE INDEX "ApprovalRequest_orgId_taskId_status_idx" ON "ApprovalRequest"("orgId", "taskId", "status");

-- CreateIndex
CREATE INDEX "ApprovalRequest_expiresAt_idx" ON "ApprovalRequest"("expiresAt");

-- CreateIndex
CREATE INDEX "ApprovalRequest_consumedByAttemptId_idx" ON "ApprovalRequest"("consumedByAttemptId");

-- CreateIndex
CREATE INDEX "Artifact_attemptId_idx" ON "Artifact"("attemptId");

-- CreateIndex
CREATE INDEX "Artifact_workspaceId_idx" ON "Artifact"("workspaceId");

-- CreateIndex
CREATE INDEX "ExecutionWorkspace_state_leaseExpiresAt_idx" ON "ExecutionWorkspace"("state", "leaseExpiresAt");

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExecutionAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "ExecutionWorkspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_consumedByAttemptId_fkey" FOREIGN KEY ("consumedByAttemptId") REFERENCES "ExecutionAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

