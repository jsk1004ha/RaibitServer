ALTER TABLE "Deployment"
  ADD COLUMN "reconcileAction" TEXT,
  ADD COLUMN "reconcileLockedBy" TEXT,
  ADD COLUMN "reconcileLockedAt" TIMESTAMP(3),
  ADD COLUMN "reconcileAttempts" INTEGER NOT NULL DEFAULT 0;

-- Deployments that were already being reconciled before this lease schema was
-- installed have no owner metadata. Preserve their operation as an apply and
-- use the last control-plane write as the lease clock so genuinely stale work
-- can be reclaimed without immediately stealing a recently active rollout.
UPDATE "Deployment"
SET "reconcileAction" = 'apply',
    "reconcileLockedAt" = COALESCE("updatedAt", "createdAt", CURRENT_TIMESTAMP)
WHERE status = 'DEPLOYING';

CREATE INDEX "Deployment_status_reconcileLockedAt_createdAt_idx"
  ON "Deployment"("status", "reconcileLockedAt", "createdAt");
