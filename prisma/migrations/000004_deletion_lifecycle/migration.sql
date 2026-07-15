ALTER TABLE "Project" ADD COLUMN "deletionRequestedAt" TIMESTAMP(3);
ALTER TABLE "Service" ADD COLUMN "deletionRequestedAt" TIMESTAMP(3);
ALTER TABLE "Resource" ADD COLUMN "deletionRequestedAt" TIMESTAMP(3);

CREATE INDEX "Project_status_updatedAt_createdAt_idx"
ON "Project"("status", "updatedAt", "createdAt");
CREATE INDEX "Service_status_updatedAt_createdAt_idx"
ON "Service"("status", "updatedAt", "createdAt");
CREATE INDEX "Resource_status_updatedAt_createdAt_idx"
ON "Resource"("status", "updatedAt", "createdAt");

CREATE INDEX "Project_deletion_claim_idx"
ON "Project"("updatedAt", "createdAt", "id")
WHERE UPPER(status) IN ('DELETE_REQUESTED', 'DELETING');
CREATE INDEX "Service_deletion_claim_idx"
ON "Service"("updatedAt", "createdAt", "id")
WHERE UPPER(status) IN ('DELETE_REQUESTED', 'DELETING');
CREATE INDEX "Resource_deletion_claim_idx"
ON "Resource"("updatedAt", "createdAt", "id")
WHERE UPPER(status) IN ('DELETE_REQUESTED', 'DELETING');
