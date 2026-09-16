CREATE TABLE "GitHubSourceMutation" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "response" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GitHubSourceMutation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GitHubSourceMutation_organizationId_operation_idempotencyKey_key"
ON "GitHubSourceMutation" ("organizationId", "operation", "idempotencyKey");

CREATE INDEX "GitHubSourceMutation_organizationId_createdAt_idx"
ON "GitHubSourceMutation" ("organizationId", "createdAt");
