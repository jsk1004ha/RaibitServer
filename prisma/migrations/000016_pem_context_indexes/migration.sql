CREATE INDEX "BuildLog_deploymentId_step_timestamp_id_idx"
  ON "BuildLog"("deploymentId", "step", "timestamp", "id");

CREATE INDEX "RuntimeLog_serviceId_deploymentId_podUid_containerName_timestamp_id_idx"
  ON "RuntimeLog"("serviceId", "deploymentId", "podUid", "containerName", "timestamp", "id");
