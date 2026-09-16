ALTER TABLE "GitHubIntegration"
ADD COLUMN "status" TEXT NOT NULL DEFAULT 'DISCONNECTED',
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "disconnectedAt" TIMESTAMP(3);

UPDATE "GitHubIntegration"
SET "status" = CASE WHEN "verifiedAt" IS NULL THEN 'DISCONNECTED' ELSE 'ACTIVE' END,
    "disconnectedAt" = CASE WHEN "verifiedAt" IS NULL THEN "updatedAt" ELSE NULL END;

ALTER TABLE "GitHubIntegration"
ADD CONSTRAINT "GitHubIntegration_lifecycle_status_check"
CHECK ("status" IN ('ACTIVE', 'SUSPENDED', 'DISCONNECTED', 'DELETED'));

ALTER TABLE "GitHubIntegration"
ADD CONSTRAINT "GitHubIntegration_lifecycle_version_check"
CHECK ("version" > 0);

CREATE INDEX "GitHubIntegration_organizationId_status_idx"
ON "GitHubIntegration" ("organizationId", "status");
