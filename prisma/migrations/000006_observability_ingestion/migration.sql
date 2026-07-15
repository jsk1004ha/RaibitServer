ALTER TABLE "RuntimeLog"
  ADD COLUMN "podUid" TEXT,
  ADD COLUMN "sourceKey" TEXT;

CREATE UNIQUE INDEX "RuntimeLog_sourceKey_key" ON "RuntimeLog"("sourceKey");
CREATE INDEX "RuntimeLog_timestamp_idx" ON "RuntimeLog"("timestamp");

CREATE TABLE "RuntimeMetric" (
  "id" TEXT NOT NULL,
  "serviceId" TEXT NOT NULL,
  "deploymentId" TEXT,
  "podName" TEXT NOT NULL,
  "podUid" TEXT,
  "containerName" TEXT NOT NULL,
  "metric" TEXT NOT NULL,
  "value" DOUBLE PRECISION NOT NULL,
  "unit" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RuntimeMetric_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RuntimeMetric_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RuntimeMetric_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "RuntimeMetric_sourceKey_key" ON "RuntimeMetric"("sourceKey");
CREATE INDEX "RuntimeMetric_serviceId_metric_timestamp_idx" ON "RuntimeMetric"("serviceId", "metric", "timestamp");
CREATE INDEX "RuntimeMetric_deploymentId_metric_timestamp_idx" ON "RuntimeMetric"("deploymentId", "metric", "timestamp");
CREATE INDEX "RuntimeMetric_timestamp_idx" ON "RuntimeMetric"("timestamp");

CREATE TABLE "IngestionCursor" (
  "key" TEXT NOT NULL,
  "cursor" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IngestionCursor_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "IngestionCursor_updatedAt_idx" ON "IngestionCursor"("updatedAt");
