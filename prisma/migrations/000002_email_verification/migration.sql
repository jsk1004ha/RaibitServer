-- Add email verification state to users. Existing users are treated as verified
-- so this migration does not lock out already-created local/beta accounts.
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
UPDATE "User" SET "emailVerifiedAt" = "createdAt" WHERE "emailVerifiedAt" IS NULL;

-- Store short-lived signup verification challenges. The plaintext code is never
-- stored; verification compares against a salted server-secret HMAC hash. Signup
-- payloads are temporary pending-registration inputs; no User/Organization row is
-- created until the code is verified.
CREATE TABLE "EmailVerificationCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "email" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'signup',
    "payload" JSONB,
    "codeHash" TEXT NOT NULL,
    "codeSalt" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailVerificationCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmailVerificationCode_email_purpose_consumedAt_createdAt_idx" ON "EmailVerificationCode"("email", "purpose", "consumedAt", "createdAt");
CREATE INDEX "EmailVerificationCode_userId_consumedAt_idx" ON "EmailVerificationCode"("userId", "consumedAt");
CREATE INDEX "EmailVerificationCode_expiresAt_idx" ON "EmailVerificationCode"("expiresAt");

ALTER TABLE "EmailVerificationCode" ADD CONSTRAINT "EmailVerificationCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
