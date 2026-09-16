ALTER TABLE "Deployment"
  ADD COLUMN "sourceDeploymentId" TEXT,
  ADD COLUMN "retryOfDeploymentId" TEXT,
  ADD COLUMN "requestIdempotencyKey" TEXT,
  ADD COLUMN "desiredSpecSnapshot" JSONB,
  ADD COLUMN "requestedByUserId" TEXT,
  ADD COLUMN "snapshotVersion" INTEGER;
CREATE UNIQUE INDEX "Deployment_serviceId_requestIdempotencyKey_key" ON "Deployment"("serviceId", "requestIdempotencyKey");
CREATE INDEX "Deployment_sourceDeploymentId_idx" ON "Deployment"("sourceDeploymentId");
