ALTER TABLE "GitHubInstallation"
ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "refreshStatus" TEXT NOT NULL DEFAULT 'IDLE',
ADD COLUMN "lastSuccessfulSyncAt" TIMESTAMP(3),
ADD COLUMN "staleAt" TIMESTAMP(3);

ALTER TABLE "GitHubRepository"
ADD COLUMN "normalizedIdentity" TEXT NOT NULL DEFAULT '',
ADD COLUMN "accessState" TEXT NOT NULL DEFAULT 'ACCESSIBLE',
ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 0;

UPDATE "GitHubRepository" SET "normalizedIdentity" = LOWER("fullName");

ALTER TABLE "GitHubInstallation" ADD CONSTRAINT "GitHubInstallation_refresh_status_check" CHECK ("refreshStatus" IN ('IDLE','REFRESHING','STALE'));
ALTER TABLE "GitHubInstallation" ADD CONSTRAINT "GitHubInstallation_generation_check" CHECK ("generation" >= 0);
ALTER TABLE "GitHubRepository" ADD CONSTRAINT "GitHubRepository_access_state_check" CHECK ("accessState" IN ('ACCESSIBLE','REVOKED'));
ALTER TABLE "GitHubRepository" ADD CONSTRAINT "GitHubRepository_generation_check" CHECK ("generation" >= 0);

CREATE INDEX "GitHubRepository_installationId_generation_normalizedIdentity_githubRepoId_idx"
ON "GitHubRepository" ("installationId", "generation", "normalizedIdentity", "githubRepoId");
