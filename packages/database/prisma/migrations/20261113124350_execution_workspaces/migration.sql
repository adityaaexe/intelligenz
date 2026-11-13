-- Phase 3, unit A: execution workspace, attempt identity, tool trace.
--
-- Additive only. Nothing is dropped, renamed or narrowed; every column added to an
-- existing table is nullable or carries a default, so the 15 Task / 10 WorkflowRun /
-- 6 AgentRun rows written in Phase 2 migrate without being rewritten.
--
-- Generated with:
--   pnpm exec prisma migrate diff --from-config-datasource \
--     --to-schema prisma/schema.prisma --script
-- Hand-edited in exactly one place: the DATA section at the end. A data statement
-- changes no schema object, so `prisma migrate diff` still reports no drift.
--
-- ROLLBACK (no down migrations in Prisma; run by hand, in this order):
--   ALTER TABLE "AgentRun" DROP CONSTRAINT "AgentRun_workspaceId_fkey";
--   DROP INDEX "AgentRun_workspaceId_idx";
--   ALTER TABLE "AgentRun" DROP COLUMN "workspaceId", DROP COLUMN "simulated",
--     DROP COLUMN "attemptNumber", DROP COLUMN "runtimeVersion",
--     DROP COLUMN "providerMeta";
--   DROP TABLE "ToolInvocation";
--   DROP TABLE "ExecutionAttempt";
--   DROP TABLE "ExecutionWorkspace";
--   DROP TYPE "WorkspaceState";
-- The backfill in the DATA section is reversible by recomputing it from
-- `runtimeId`; it is derived data, not user data.

-- CreateEnum
CREATE TYPE "WorkspaceState" AS ENUM ('requested', 'provisioning', 'ready', 'executing', 'preserving', 'completed', 'failed', 'cancelled');

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "attemptNumber" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "providerMeta" JSONB,
ADD COLUMN     "runtimeVersion" TEXT,
ADD COLUMN     "simulated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "workspaceId" TEXT;

-- CreateTable
CREATE TABLE "ExecutionWorkspace" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "agentRunId" TEXT,
    "state" "WorkspaceState" NOT NULL DEFAULT 'requested',
    "rootPath" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceRef" TEXT,
    "baseCommit" TEXT,
    "branch" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "readyAt" TIMESTAMP(3),
    "cleanedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "error" JSONB,

    CONSTRAINT "ExecutionWorkspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionAttempt" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "workflowRunId" TEXT NOT NULL,
    "agentRunId" TEXT,
    "attemptNumber" INTEGER NOT NULL,
    "runtimeId" TEXT NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "status" "RunStatus" NOT NULL DEFAULT 'queued',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "error" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolInvocation" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentRunId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "tool" TEXT NOT NULL,
    "summary" VARCHAR(500) NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ToolInvocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionWorkspace_rootPath_key" ON "ExecutionWorkspace"("rootPath");

-- CreateIndex
CREATE INDEX "ExecutionWorkspace_orgId_state_idx" ON "ExecutionWorkspace"("orgId", "state");

-- CreateIndex
CREATE INDEX "ExecutionWorkspace_taskId_idx" ON "ExecutionWorkspace"("taskId");

-- CreateIndex
CREATE INDEX "ExecutionWorkspace_orgId_createdAt_idx" ON "ExecutionWorkspace"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "ExecutionWorkspace_agentRunId_idx" ON "ExecutionWorkspace"("agentRunId");

-- CreateIndex
CREATE INDEX "ExecutionAttempt_orgId_createdAt_idx" ON "ExecutionAttempt"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "ExecutionAttempt_agentRunId_idx" ON "ExecutionAttempt"("agentRunId");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionAttempt_workflowRunId_attemptNumber_key" ON "ExecutionAttempt"("workflowRunId", "attemptNumber");

-- CreateIndex
CREATE INDEX "ToolInvocation_orgId_occurredAt_idx" ON "ToolInvocation"("orgId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ToolInvocation_agentRunId_sequence_key" ON "ToolInvocation"("agentRunId", "sequence");

-- CreateIndex
CREATE INDEX "AgentRun_workspaceId_idx" ON "AgentRun"("workspaceId");

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "ExecutionWorkspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionWorkspace" ADD CONSTRAINT "ExecutionWorkspace_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionWorkspace" ADD CONSTRAINT "ExecutionWorkspace_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionWorkspace" ADD CONSTRAINT "ExecutionWorkspace_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionAttempt" ADD CONSTRAINT "ExecutionAttempt_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionAttempt" ADD CONSTRAINT "ExecutionAttempt_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionAttempt" ADD CONSTRAINT "ExecutionAttempt_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionAttempt" ADD CONSTRAINT "ExecutionAttempt_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolInvocation" ADD CONSTRAINT "ToolInvocation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolInvocation" ADD CONSTRAINT "ToolInvocation_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── DATA ────────────────────────────────────────────────────────────────────
-- The one statement in this migration that touches existing rows.
--
-- `simulated` defaults to false so that future inserts cannot forget it and
-- silently claim a real runtime. Applied to history, that default is a lie: every
-- AgentRun written in Phase 2 came from `LocalSimulatedRuntime`, and ADR-006 §
-- ("Every ExecutionResult carries runtimeId: 'local-simulated' and simulated:
-- true") already required those results to declare themselves simulated.
--
-- The predicate is the adapter id, which is the only durable evidence of how the
-- row was produced. If this is ever reverted, drop these two lines; the values are
-- derivable from `runtimeId` at any time.
UPDATE "AgentRun" SET "simulated" = true WHERE "runtimeId" = 'local-simulated';
