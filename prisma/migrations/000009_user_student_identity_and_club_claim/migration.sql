-- Preserve existing users while recording the identity fields required by signup review.
ALTER TABLE "User" ADD COLUMN "studentId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "User" ADD COLUMN "clubMemberClaim" BOOLEAN NOT NULL DEFAULT false;
