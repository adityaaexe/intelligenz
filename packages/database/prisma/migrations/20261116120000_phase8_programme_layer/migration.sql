-- Phase 8.6: the programme layer. Three tables, two enums, nothing touched.
--
-- The gap this closes, measured: `grep -cE "^model (Programme|Program|TaskDependency|
-- Checkpoint)"` returned 0, `POST /run` started `task-<id>` and the workflow ended, and
-- no row in the database said which tasks were one objective or which one waited for
-- which. "Autonomous operation: not yet proven" was an accurate description of the code,
-- not a reporting gap.
--
-- Additive only, and back-fill-free by construction: every existing `Task` remains valid
-- and unparented. A programme is always created together with its graph in one
-- transaction, so there is no legacy programme row that would need an invented graph. No
-- column on an existing table is added, narrowed, or reinterpreted.
--
-- Two deliberate choices recorded here because they are not visible from the DDL:
--
--   * `ProgrammeTask.dependsOn` holds **task ids**, not `ProgrammeTask` ids. The graph is
--     authored against tasks that already exist, so the author knows task ids;
--     `(programmeId, taskId)` unique is what makes the reference unambiguous.
--   * `ProgrammeTask.taskId` and `ProgrammeCheckpoint.taskId` are ON DELETE RESTRICT. The
--     node and the checkpoint are the programme's record of a task it scheduled; deleting
--     the task underneath them would leave a graph with an unresolved reference. Tenant
--     teardown deletes programme rows first, exactly as it already does for approvals.

-- CreateEnum
CREATE TYPE "ProgrammeStatus" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'blocked', 'cancelled', 'timed_out');

-- CreateEnum
CREATE TYPE "ProgrammeTaskStatus" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'blocked', 'waiting_for_approval', 'cancelled');

-- CreateTable
CREATE TABLE "Programme" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "status" "ProgrammeStatus" NOT NULL DEFAULT 'pending',
    "idempotencyKey" TEXT NOT NULL,
    "failureReason" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Programme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgrammeTask" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "programmeId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "dependsOn" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "ProgrammeTaskStatus" NOT NULL DEFAULT 'pending',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgrammeTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgrammeCheckpoint" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "programmeId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "taskId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProgrammeCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Programme_orgId_createdAt_idx" ON "Programme"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "Programme_projectId_status_idx" ON "Programme"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Programme_orgId_idempotencyKey_key" ON "Programme"("orgId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ProgrammeTask_programmeId_status_idx" ON "ProgrammeTask"("programmeId", "status");

-- CreateIndex
CREATE INDEX "ProgrammeTask_taskId_idx" ON "ProgrammeTask"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "ProgrammeTask_programmeId_taskId_key" ON "ProgrammeTask"("programmeId", "taskId");

-- CreateIndex
CREATE INDEX "ProgrammeCheckpoint_programmeId_taskId_idx" ON "ProgrammeCheckpoint"("programmeId", "taskId");

-- CreateIndex
CREATE INDEX "ProgrammeCheckpoint_taskId_idx" ON "ProgrammeCheckpoint"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "ProgrammeCheckpoint_programmeId_sequence_key" ON "ProgrammeCheckpoint"("programmeId", "sequence");

-- AddForeignKey
ALTER TABLE "Programme" ADD CONSTRAINT "Programme_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Programme" ADD CONSTRAINT "Programme_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeTask" ADD CONSTRAINT "ProgrammeTask_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeTask" ADD CONSTRAINT "ProgrammeTask_programmeId_fkey" FOREIGN KEY ("programmeId") REFERENCES "Programme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeTask" ADD CONSTRAINT "ProgrammeTask_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeCheckpoint" ADD CONSTRAINT "ProgrammeCheckpoint_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeCheckpoint" ADD CONSTRAINT "ProgrammeCheckpoint_programmeId_fkey" FOREIGN KEY ("programmeId") REFERENCES "Programme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeCheckpoint" ADD CONSTRAINT "ProgrammeCheckpoint_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
