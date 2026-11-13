-- CreateIndex
CREATE UNIQUE INDEX "Artifact_orgId_taskId_kind_checksum_key" ON "Artifact"("orgId", "taskId", "kind", "checksum");
-- CreateIndex
CREATE UNIQUE INDEX "Evidence_orgId_taskId_kind_uri_key" ON "Evidence"("orgId", "taskId", "kind", "uri");
