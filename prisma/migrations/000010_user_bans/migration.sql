ALTER TABLE "User"
  ADD COLUMN "bannedAt" TIMESTAMP(3),
  ADD COLUMN "banExpiresAt" TIMESTAMP(3),
  ADD COLUMN "banReason" TEXT,
  ADD COLUMN "bannedByUserId" TEXT;

CREATE INDEX "User_bannedAt_banExpiresAt_idx" ON "User"("bannedAt", "banExpiresAt");
