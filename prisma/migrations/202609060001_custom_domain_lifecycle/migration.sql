ALTER TABLE "Domain"
  ADD COLUMN "organizationId" TEXT,
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION',
  ADD COLUMN "verificationTokenHash" TEXT,
  ADD COLUMN "verificationVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "issuedAt" TIMESTAMP(3),
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "verifiedAt" TIMESTAMP(3),
  ADD COLUMN "verificationRequestedAt" TIMESTAMP(3),
  ADD COLUMN "lastCheckedAt" TIMESTAMP(3),
  ADD COLUMN "nextCheckAt" TIMESTAMP(3),
  ADD COLUMN "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "desiredGeneration" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "controllerLeaseGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "certificateObservedGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "routeObservedGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cleanupRequiredForVersion" INTEGER,
  ADD COLUMN "certificateAbsentObservedVersion" INTEGER,
  ADD COLUMN "routeAbsentObservedVersion" INTEGER,
  ADD COLUMN "deletionRequestedAt" TIMESTAMP(3),
  ADD COLUMN "actorUserId" TEXT,
  ADD COLUMN "lastErrorCode" TEXT,
  ADD COLUMN "lastErrorMessage" TEXT;

UPDATE "Domain" AS domain
SET "organizationId" = project."organizationId"
FROM "Project" AS project
WHERE project."id" = domain."projectId";

CREATE UNIQUE INDEX "Project_id_organizationId_key" ON "Project"("id", "organizationId");
CREATE UNIQUE INDEX "Service_id_projectId_key" ON "Service"("id", "projectId");
CREATE INDEX "Domain_organizationId_projectId_idx" ON "Domain"("organizationId", "projectId");
CREATE INDEX "Domain_serviceId_status_idx" ON "Domain"("serviceId", "status");
CREATE INDEX "Domain_status_nextCheckAt_idx" ON "Domain"("status", "nextCheckAt");

ALTER TABLE "Domain" ADD CONSTRAINT "Domain_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "Project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_serviceId_projectId_fkey" FOREIGN KEY ("serviceId", "projectId") REFERENCES "Service"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
