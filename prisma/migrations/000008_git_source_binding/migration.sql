-- GitHub installation claims are not usable for repository attachment until a
-- trusted GitHub App callback or synchronization path marks them verified.
ALTER TABLE "GitHubIntegration" ADD COLUMN "verifiedAt" TIMESTAMP(3);

-- A trusted GitHub App installation authorizes exactly one organization.
CREATE UNIQUE INDEX "GitHubIntegration_verified_installation_key"
ON "GitHubIntegration" ("installationId")
WHERE "verifiedAt" IS NOT NULL AND "installationId" IS NOT NULL;
