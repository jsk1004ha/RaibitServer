ALTER TABLE "Service"
  ADD COLUMN "healthCheckPath" TEXT,
  ADD COLUMN "livenessPath" TEXT,
  ADD COLUMN "readinessPath" TEXT,
  ADD COLUMN "publicHealthPath" TEXT;

ALTER TABLE "Deployment"
  ADD COLUMN "publicHealthStatus" TEXT DEFAULT 'UNKNOWN',
  ADD COLUMN "healthCheckedAt" TIMESTAMP(3),
  ADD COLUMN "healthFailureCode" TEXT,
  ADD COLUMN "observedGeneration" INTEGER;
