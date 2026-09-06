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
SET "organizationId" = project."organizationId",
    "actorUserId" = 'system',
    "status" = CASE WHEN domain."verified" THEN 'READY' ELSE 'PENDING_VERIFICATION' END
FROM "Project" AS project
WHERE project."id" = domain."projectId";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Domain" AS domain
    LEFT JOIN "Project" AS project ON project."id" = domain."projectId"
    LEFT JOIN "Service" AS service ON service."id" = domain."serviceId" AND service."projectId" = domain."projectId"
    WHERE project."id" IS NULL OR service."id" IS NULL OR domain."organizationId" IS NULL
  ) THEN
    RAISE EXCEPTION 'custom domain migration requires project-bound, matching services';
  END IF;
END $$;

ALTER TABLE "Domain"
  ALTER COLUMN "organizationId" SET NOT NULL,
  ALTER COLUMN "projectId" SET NOT NULL,
  ALTER COLUMN "serviceId" SET NOT NULL,
  ALTER COLUMN "actorUserId" SET NOT NULL;

CREATE UNIQUE INDEX "Project_id_organizationId_key" ON "Project"("id", "organizationId");
CREATE UNIQUE INDEX "Service_id_projectId_key" ON "Service"("id", "projectId");
CREATE INDEX "Domain_organizationId_projectId_idx" ON "Domain"("organizationId", "projectId");
CREATE INDEX "Domain_serviceId_status_idx" ON "Domain"("serviceId", "status");
CREATE INDEX "Domain_status_nextCheckAt_idx" ON "Domain"("status", "nextCheckAt");

ALTER TABLE "Domain" ADD CONSTRAINT "Domain_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "Project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_serviceId_projectId_fkey" FOREIGN KEY ("serviceId", "projectId") REFERENCES "Service"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
