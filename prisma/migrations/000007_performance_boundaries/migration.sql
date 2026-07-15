CREATE INDEX IF NOT EXISTS "Project_organizationId_createdAt_id_idx" ON "Project"("organizationId", "createdAt", "id");
CREATE INDEX IF NOT EXISTS "Service_projectId_createdAt_id_idx" ON "Service"("projectId", "createdAt", "id");
CREATE INDEX IF NOT EXISTS "Resource_projectId_createdAt_id_idx" ON "Resource"("projectId", "createdAt", "id");
-- Resource writers historically emitted both lowercase and uppercase lifecycle
-- values. Keep case-insensitive worker claims indexable until that public
-- compatibility surface can be migrated deliberately.
CREATE INDEX IF NOT EXISTS "Resource_upper_status_updatedAt_createdAt_idx" ON "Resource"(UPPER(status), "updatedAt", "createdAt");
CREATE INDEX IF NOT EXISTS "Deployment_serviceId_createdAt_id_idx" ON "Deployment"("serviceId", "createdAt", "id");
CREATE INDEX IF NOT EXISTS "Deployment_projectId_createdAt_id_idx" ON "Deployment"("projectId", "createdAt", "id");
CREATE INDEX IF NOT EXISTS "BuildLog_deploymentId_timestamp_id_idx" ON "BuildLog"("deploymentId", "timestamp", "id");
CREATE INDEX IF NOT EXISTS "RuntimeLog_serviceId_timestamp_id_idx" ON "RuntimeLog"("serviceId", "timestamp", "id");
CREATE INDEX IF NOT EXISTS "RuntimeLog_deploymentId_timestamp_id_idx" ON "RuntimeLog"("deploymentId", "timestamp", "id");
CREATE INDEX IF NOT EXISTS "RuntimeMetric_serviceId_timestamp_id_idx" ON "RuntimeMetric"("serviceId", "timestamp", "id");
CREATE INDEX IF NOT EXISTS "RuntimeMetric_deploymentId_timestamp_id_idx" ON "RuntimeMetric"("deploymentId", "timestamp", "id");
CREATE INDEX IF NOT EXISTS "DeploymentEvent_deploymentId_timestamp_id_idx" ON "DeploymentEvent"("deploymentId", "timestamp", "id");
