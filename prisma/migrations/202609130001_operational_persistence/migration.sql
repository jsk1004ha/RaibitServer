ALTER TABLE "Resource"
  ADD CONSTRAINT "Resource_id_projectId_key" UNIQUE ("id", "projectId");

ALTER TABLE "WorkflowJob"
  ADD COLUMN "operationalProtocolVersion" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "ResourceBackup"
  ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN "policyId" TEXT,
  ADD COLUMN "policyRunId" TEXT,
  ADD COLUMN "policyVersion" INTEGER,
  ADD COLUMN "scheduledAtUtc" TIMESTAMP(3),
  ADD COLUMN "policySnapshot" JSONB,
  ADD COLUMN "environmentId" TEXT;

CREATE TABLE "Environment" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Environment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Environment_kind_check" CHECK ("kind" IN ('prod', 'dev')),
  CONSTRAINT "Environment_status_check" CHECK ("status" IN ('active', 'disabled', 'deleting')),
  CONSTRAINT "Environment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Environment_projectId_kind_key" ON "Environment"("projectId", "kind");
CREATE UNIQUE INDEX "Environment_id_projectId_key" ON "Environment"("id", "projectId");
CREATE INDEX "Environment_projectId_status_createdAt_idx" ON "Environment"("projectId", "status", "createdAt");

INSERT INTO "Environment" ("id", "projectId", "kind", "status", "createdAt", "updatedAt")
SELECT 'env_prod_' || project."id", project."id", 'prod', 'active', project."createdAt", project."updatedAt"
FROM "Project" AS project
ON CONFLICT ("projectId", "kind") DO NOTHING;

CREATE TABLE "EnvironmentService" (
  "serviceId" TEXT NOT NULL,
  "environmentId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "logicalSlug" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EnvironmentService_pkey" PRIMARY KEY ("serviceId"),
  CONSTRAINT "EnvironmentService_environment_fkey" FOREIGN KEY ("environmentId", "projectId") REFERENCES "Environment"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "EnvironmentService_service_fkey" FOREIGN KEY ("serviceId", "projectId") REFERENCES "Service"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "EnvironmentService_environmentId_logicalSlug_key" ON "EnvironmentService"("environmentId", "logicalSlug");
CREATE UNIQUE INDEX "EnvironmentService_serviceId_projectId_key" ON "EnvironmentService"("serviceId", "projectId");
CREATE INDEX "EnvironmentService_projectId_environmentId_idx" ON "EnvironmentService"("projectId", "environmentId");

INSERT INTO "EnvironmentService" ("serviceId", "environmentId", "projectId", "logicalSlug", "createdAt", "updatedAt")
SELECT service."id", environment."id", service."projectId", service."slug", service."createdAt", service."updatedAt"
FROM "Service" AS service
JOIN "Environment" AS environment ON environment."projectId" = service."projectId" AND environment."kind" = 'prod'
ON CONFLICT ("serviceId") DO NOTHING;

CREATE TABLE "EnvironmentResource" (
  "resourceId" TEXT NOT NULL,
  "environmentId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "logicalSlug" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EnvironmentResource_pkey" PRIMARY KEY ("resourceId"),
  CONSTRAINT "EnvironmentResource_environment_fkey" FOREIGN KEY ("environmentId", "projectId") REFERENCES "Environment"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "EnvironmentResource_resource_fkey" FOREIGN KEY ("resourceId", "projectId") REFERENCES "Resource"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "EnvironmentResource_environmentId_logicalSlug_key" ON "EnvironmentResource"("environmentId", "logicalSlug");
CREATE UNIQUE INDEX "EnvironmentResource_resourceId_projectId_key" ON "EnvironmentResource"("resourceId", "projectId");
CREATE INDEX "EnvironmentResource_projectId_environmentId_idx" ON "EnvironmentResource"("projectId", "environmentId");

INSERT INTO "EnvironmentResource" ("resourceId", "environmentId", "projectId", "logicalSlug", "createdAt", "updatedAt")
SELECT resource."id", environment."id", resource."projectId", resource."slug", resource."createdAt", resource."updatedAt"
FROM "Resource" AS resource
JOIN "Environment" AS environment ON environment."projectId" = resource."projectId" AND environment."kind" = 'prod'
ON CONFLICT ("resourceId") DO NOTHING;

CREATE TABLE "TemplateInstallation" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "environmentId" TEXT NOT NULL,
  "catalogId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "version" INTEGER NOT NULL DEFAULT 1,
  "requestIdempotencyKey" TEXT NOT NULL,
  "idempotencyFingerprint" TEXT NOT NULL,
  "deletionRequestedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TemplateInstallation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TemplateInstallation_version_check" CHECK ("version" > 0),
  CONSTRAINT "TemplateInstallation_project_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TemplateInstallation_environment_fkey" FOREIGN KEY ("environmentId", "projectId") REFERENCES "Environment"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TemplateInstallation_projectId_requestIdempotencyKey_key" ON "TemplateInstallation"("projectId", "requestIdempotencyKey");
CREATE UNIQUE INDEX "TemplateInstallation_environmentId_catalogId_key" ON "TemplateInstallation"("environmentId", "catalogId");
CREATE UNIQUE INDEX "TemplateInstallation_id_projectId_environmentId_key" ON "TemplateInstallation"("id", "projectId", "environmentId");
CREATE INDEX "TemplateInstallation_projectId_environmentId_status_idx" ON "TemplateInstallation"("projectId", "environmentId", "status");

CREATE TABLE "TemplateInstallationVersion" (
  "id" TEXT NOT NULL,
  "installationId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "environmentId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "catalogVersion" TEXT NOT NULL,
  "catalogDigest" TEXT NOT NULL,
  "sourceDigest" TEXT NOT NULL,
  "graphDigest" TEXT NOT NULL,
  "provenance" JSONB NOT NULL,
  "idempotencyFingerprint" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TemplateInstallationVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TemplateInstallationVersion_version_check" CHECK ("version" > 0),
  CONSTRAINT "TemplateInstallationVersion_installation_fkey" FOREIGN KEY ("installationId", "projectId", "environmentId") REFERENCES "TemplateInstallation"("id", "projectId", "environmentId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TemplateInstallationVersion_installationId_version_key" ON "TemplateInstallationVersion"("installationId", "version");
CREATE UNIQUE INDEX "TemplateInstallationVersion_projectId_idempotencyFingerprint_key" ON "TemplateInstallationVersion"("projectId", "idempotencyFingerprint");
CREATE INDEX "TemplateInstallationVersion_projectId_environmentId_createdAt_idx" ON "TemplateInstallationVersion"("projectId", "environmentId", "createdAt");

CREATE TABLE "PromotionPreview" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "sourceEnvironmentId" TEXT NOT NULL,
  "targetEnvironmentId" TEXT NOT NULL,
  "sourceImageDigest" TEXT NOT NULL,
  "diffHash" TEXT NOT NULL,
  "previewDigest" TEXT NOT NULL,
  "graphSnapshot" JSONB NOT NULL,
  "expectedVersion" INTEGER NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PromotionPreview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PromotionPreview_distinct_environments" CHECK ("sourceEnvironmentId" <> "targetEnvironmentId"),
  CONSTRAINT "PromotionPreview_version_check" CHECK ("expectedVersion" > 0),
  CONSTRAINT "PromotionPreview_project_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PromotionPreview_source_environment_fkey" FOREIGN KEY ("sourceEnvironmentId", "projectId") REFERENCES "Environment"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PromotionPreview_target_environment_fkey" FOREIGN KEY ("targetEnvironmentId", "projectId") REFERENCES "Environment"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PromotionPreview_id_projectId_key" ON "PromotionPreview"("id", "projectId");
CREATE UNIQUE INDEX "PromotionPreview_projectId_previewDigest_key" ON "PromotionPreview"("projectId", "previewDigest");
CREATE INDEX "PromotionPreview_projectId_expiresAt_idx" ON "PromotionPreview"("projectId", "expiresAt");

CREATE TABLE "PromotionOperation" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "previewId" TEXT NOT NULL,
  "sourceEnvironmentId" TEXT NOT NULL,
  "targetEnvironmentId" TEXT NOT NULL,
  "sourceImageDigest" TEXT NOT NULL,
  "diffHash" TEXT NOT NULL,
  "requestIdempotencyKey" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "protocolVersion" INTEGER NOT NULL DEFAULT 2,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "fenceToken" TEXT,
  "workerId" TEXT,
  "leaseGeneration" INTEGER NOT NULL DEFAULT 0,
  "leaseUntil" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "PromotionOperation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PromotionOperation_protocol_check" CHECK ("protocolVersion" = 2),
  CONSTRAINT "PromotionOperation_attempt_check" CHECK ("attempts" >= 0 AND "leaseGeneration" >= 0),
  CONSTRAINT "PromotionOperation_project_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PromotionOperation_preview_fkey" FOREIGN KEY ("previewId", "projectId") REFERENCES "PromotionPreview"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PromotionOperation_source_environment_fkey" FOREIGN KEY ("sourceEnvironmentId", "projectId") REFERENCES "Environment"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PromotionOperation_target_environment_fkey" FOREIGN KEY ("targetEnvironmentId", "projectId") REFERENCES "Environment"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PromotionOperation_projectId_requestIdempotencyKey_key" ON "PromotionOperation"("projectId", "requestIdempotencyKey");
CREATE INDEX "PromotionOperation_status_leaseUntil_createdAt_idx" ON "PromotionOperation"("status", "leaseUntil", "createdAt");
CREATE INDEX "PromotionOperation_projectId_targetEnvironmentId_createdAt_idx" ON "PromotionOperation"("projectId", "targetEnvironmentId", "createdAt");

CREATE TABLE "NotificationDestination" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "sealedWebhookUrl" TEXT NOT NULL,
  "encryptionKeyVersion" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "deletionRequestedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationDestination_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NotificationDestination_kind_check" CHECK ("kind" = 'discord'),
  CONSTRAINT "NotificationDestination_version_check" CHECK ("version" > 0),
  CONSTRAINT "NotificationDestination_project_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "NotificationDestination_id_projectId_key" ON "NotificationDestination"("id", "projectId");
CREATE UNIQUE INDEX "NotificationDestination_projectId_kind_key" ON "NotificationDestination"("projectId", "kind");
CREATE INDEX "NotificationDestination_projectId_kind_enabled_idx" ON "NotificationDestination"("projectId", "kind", "enabled");

CREATE TABLE "NotificationSubscription" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "destinationId" TEXT NOT NULL,
  "environmentId" TEXT NOT NULL,
  "environmentKind" TEXT NOT NULL DEFAULT 'prod',
  "eventCode" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationSubscription_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NotificationSubscription_environment_kind_check" CHECK ("environmentKind" IN ('prod', 'dev')),
  CONSTRAINT "NotificationSubscription_event_check" CHECK ("eventCode" IN ('deployment.failed','deployment.ready','runtime.unhealthy','runtime.recovered','backup.failed','backup.ready','promotion.failed','promotion.ready')),
  CONSTRAINT "NotificationSubscription_destination_fkey" FOREIGN KEY ("destinationId", "projectId") REFERENCES "NotificationDestination"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "NotificationSubscription_environment_fkey" FOREIGN KEY ("environmentId", "projectId") REFERENCES "Environment"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "NotificationSubscription_destinationId_environmentId_eventCode_key" ON "NotificationSubscription"("destinationId", "environmentId", "eventCode");
CREATE INDEX "NotificationSubscription_projectId_environmentId_enabled_idx" ON "NotificationSubscription"("projectId", "environmentId", "enabled");

CREATE TABLE "NotificationIntent" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "environmentId" TEXT NOT NULL,
  "destinationId" TEXT NOT NULL,
  "destinationVersion" INTEGER NOT NULL,
  "environmentKind" TEXT NOT NULL,
  "eventCode" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "subjectGenerationOrIncidentSequence" INTEGER NOT NULL,
  "dedupKey" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "protocolVersion" INTEGER NOT NULL DEFAULT 2,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NotificationIntent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NotificationIntent_protocol_check" CHECK ("protocolVersion" = 2),
  CONSTRAINT "NotificationIntent_environment_kind_check" CHECK ("environmentKind" IN ('prod', 'dev')),
  CONSTRAINT "NotificationIntent_event_check" CHECK ("eventCode" IN ('deployment.failed','deployment.ready','runtime.unhealthy','runtime.recovered','backup.failed','backup.ready','promotion.failed','promotion.ready')),
  CONSTRAINT "NotificationIntent_status_check" CHECK ("status" IN ('pending','sending','succeeded','failed','unknown','cancelled')),
  CONSTRAINT "NotificationIntent_destination_version_check" CHECK ("destinationVersion" > 0 AND "subjectGenerationOrIncidentSequence" >= 0),
  CONSTRAINT "NotificationIntent_project_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "NotificationIntent_environment_fkey" FOREIGN KEY ("environmentId", "projectId") REFERENCES "Environment"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "NotificationIntent_destination_fkey" FOREIGN KEY ("destinationId", "projectId") REFERENCES "NotificationDestination"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "NotificationIntent_dedupKey_key" ON "NotificationIntent"("dedupKey");
CREATE UNIQUE INDEX "NotificationIntent_semantic_identity" ON "NotificationIntent"("destinationId", "destinationVersion", "eventCode", "subjectId", "subjectGenerationOrIncidentSequence");
CREATE INDEX "NotificationIntent_projectId_environmentId_status_createdAt_idx" ON "NotificationIntent"("projectId", "environmentId", "status", "createdAt");
CREATE INDEX "NotificationIntent_destinationId_destinationVersion_createdAt_idx" ON "NotificationIntent"("destinationId", "destinationVersion", "createdAt");

CREATE TABLE "NotificationDeliveryAttempt" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "intentId" TEXT NOT NULL,
  "destinationId" TEXT NOT NULL,
  "destinationVersion" INTEGER NOT NULL,
  "attempt" INTEGER NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "workerId" TEXT,
  "leaseToken" TEXT,
  "leaseGeneration" INTEGER NOT NULL DEFAULT 0,
  "leaseUntil" TIMESTAMP(3),
  "deadlineAt" TIMESTAMP(3),
  "responseMessageId" TEXT,
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "NotificationDeliveryAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NotificationDeliveryAttempt_state_check" CHECK ("state" IN ('pending','sending','succeeded','failed','unknown','cancelled')),
  CONSTRAINT "NotificationDeliveryAttempt_attempt_check" CHECK ("attempt" > 0 AND "leaseGeneration" >= 0),
  CONSTRAINT "NotificationDeliveryAttempt_intent_fkey" FOREIGN KEY ("intentId") REFERENCES "NotificationIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "NotificationDeliveryAttempt_destination_fkey" FOREIGN KEY ("destinationId", "projectId") REFERENCES "NotificationDestination"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "NotificationDeliveryAttempt_intentId_attempt_key" ON "NotificationDeliveryAttempt"("intentId", "attempt");
CREATE INDEX "NotificationDeliveryAttempt_state_runAfter_leaseUntil_idx" ON "NotificationDeliveryAttempt"("state", "runAfter", "leaseUntil");
CREATE INDEX "NotificationDeliveryAttempt_destinationId_destinationVersion_createdAt_idx" ON "NotificationDeliveryAttempt"("destinationId", "destinationVersion", "createdAt");

CREATE TABLE "BackupPolicy" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "environmentId" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "version" INTEGER NOT NULL DEFAULT 1,
  "timezone" TEXT NOT NULL DEFAULT 'Asia/Seoul',
  "localMinute" INTEGER NOT NULL DEFAULT 180,
  "nextRunAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BackupPolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BackupPolicy_schedule_check" CHECK ("version" > 0 AND "timezone" = 'Asia/Seoul' AND "localMinute" BETWEEN 0 AND 1439),
  CONSTRAINT "BackupPolicy_project_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "Project"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BackupPolicy_environment_fkey" FOREIGN KEY ("environmentId", "projectId") REFERENCES "Environment"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BackupPolicy_resource_fkey" FOREIGN KEY ("resourceId", "projectId") REFERENCES "Resource"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BackupPolicy_resourceId_environmentId_key" ON "BackupPolicy"("resourceId", "environmentId");
CREATE UNIQUE INDEX "BackupPolicy_resourceId_projectId_key" ON "BackupPolicy"("resourceId", "projectId");
CREATE UNIQUE INDEX "BackupPolicy_id_organizationId_projectId_environmentId_resourceId_key" ON "BackupPolicy"("id", "organizationId", "projectId", "environmentId", "resourceId");
CREATE INDEX "BackupPolicy_enabled_nextRunAt_idx" ON "BackupPolicy"("enabled", "nextRunAt");
CREATE INDEX "BackupPolicy_projectId_environmentId_idx" ON "BackupPolicy"("projectId", "environmentId");

CREATE TABLE "BackupPolicyRun" (
  "id" TEXT NOT NULL,
  "policyId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "environmentId" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "scheduledAtUtc" TIMESTAMP(3) NOT NULL,
  "policyVersion" INTEGER NOT NULL,
  "policySnapshot" JSONB NOT NULL,
  "protocolVersion" INTEGER NOT NULL DEFAULT 2,
  "status" TEXT NOT NULL DEFAULT 'DUE',
  "skipReason" TEXT,
  "workerId" TEXT,
  "leaseToken" TEXT,
  "leaseGeneration" INTEGER NOT NULL DEFAULT 0,
  "leaseUntil" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "deadlineAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "backupId" TEXT,
  CONSTRAINT "BackupPolicyRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BackupPolicyRun_protocol_check" CHECK ("protocolVersion" = 2),
  CONSTRAINT "BackupPolicyRun_snapshot_check" CHECK (
    "policySnapshot"->>'requiredProtocolVersion' = '2'
    AND "policySnapshot"->>'enabled' = 'true'
    AND "policySnapshot"->>'timezone' = 'Asia/Seoul'
    AND "policySnapshot"->>'origin' = 'scheduled'
    AND "policySnapshot"->'retention'->>'mode' = 'success-count'
    AND "policySnapshot"->'retention'->>'count' = '7'
  ),
  CONSTRAINT "BackupPolicyRun_status_check" CHECK ("status" IN ('DUE','SKIPPED','RUNNING','READY','FAILED')),
  CONSTRAINT "BackupPolicyRun_skip_reason_check" CHECK ("skipReason" IS NULL OR "skipReason" IN ('MISSED_WINDOW','OVERLAPPING_BACKUP','POLICY_DISABLED','SOURCE_NOT_READY','ENGINE_UNSUPPORTED','CAPABILITY_UNAVAILABLE','QUOTA_EXCEEDED','OPERATOR_RECOVERY_NOT_READY')),
  CONSTRAINT "BackupPolicyRun_attempt_check" CHECK ("policyVersion" > 0 AND "attempts" >= 0 AND "leaseGeneration" >= 0),
  CONSTRAINT "BackupPolicyRun_project_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "Project"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BackupPolicyRun_environment_fkey" FOREIGN KEY ("environmentId", "projectId") REFERENCES "Environment"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BackupPolicyRun_resource_fkey" FOREIGN KEY ("resourceId", "projectId") REFERENCES "Resource"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BackupPolicyRun_policy_fkey" FOREIGN KEY ("policyId", "organizationId", "projectId", "environmentId", "resourceId") REFERENCES "BackupPolicy"("id", "organizationId", "projectId", "environmentId", "resourceId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BackupPolicyRun_backup_fkey" FOREIGN KEY ("backupId") REFERENCES "ResourceBackup"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BackupPolicyRun_policyId_scheduledAtUtc_key" ON "BackupPolicyRun"("policyId", "scheduledAtUtc");
CREATE UNIQUE INDEX "BackupPolicyRun_backupId_key" ON "BackupPolicyRun"("backupId");
CREATE INDEX "BackupPolicyRun_status_scheduledAtUtc_leaseUntil_idx" ON "BackupPolicyRun"("status", "scheduledAtUtc", "leaseUntil");
CREATE INDEX "BackupPolicyRun_resourceId_status_finishedAt_idx" ON "BackupPolicyRun"("resourceId", "status", "finishedAt");

CREATE TABLE "ObjectUploadReservation" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "environmentId" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "providerEndpointRef" TEXT NOT NULL,
  "operationKind" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "objectGeneration" INTEGER NOT NULL,
  "credentialGeneration" INTEGER NOT NULL,
  "multipartUploadId" TEXT,
  "partNumber" INTEGER,
  "checksumSha256" TEXT NOT NULL,
  "expectedBytes" BIGINT NOT NULL,
  "reservedBytes" BIGINT NOT NULL,
  "committedBytes" BIGINT NOT NULL DEFAULT 0,
  "accountingState" TEXT NOT NULL DEFAULT 'reserved',
  "requestIdempotencyKey" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "protocolVersion" INTEGER NOT NULL DEFAULT 2,
  "version" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "workerId" TEXT,
  "leaseToken" TEXT,
  "leaseGeneration" INTEGER NOT NULL DEFAULT 0,
  "leaseUntil" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ObjectUploadReservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ObjectUploadReservation_protocol_check" CHECK ("protocolVersion" = 2),
  CONSTRAINT "ObjectUploadReservation_accounting_check" CHECK ("accountingState" IN ('reserved','forwarding','verifying','committed','abort_requested','cleanup_pending','released','failed') AND "expectedBytes" > 0 AND "reservedBytes" >= 0 AND "committedBytes" >= 0 AND "committedBytes" <= "reservedBytes"),
  CONSTRAINT "ObjectUploadReservation_operation_check" CHECK ("operationKind" IN ('put','copy','multipart_part') AND "objectGeneration" > 0 AND "credentialGeneration" > 0 AND (("operationKind" = 'multipart_part' AND "multipartUploadId" IS NOT NULL AND "partNumber" BETWEEN 1 AND 10000) OR ("operationKind" <> 'multipart_part' AND "multipartUploadId" IS NULL AND "partNumber" IS NULL))),
  CONSTRAINT "ObjectUploadReservation_version_check" CHECK ("version" > 0 AND "leaseGeneration" >= 0),
  CONSTRAINT "ObjectUploadReservation_project_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ObjectUploadReservation_environment_fkey" FOREIGN KEY ("environmentId", "projectId") REFERENCES "Environment"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ObjectUploadReservation_resource_fkey" FOREIGN KEY ("resourceId", "projectId") REFERENCES "Resource"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ObjectUploadReservation_projectId_requestIdempotencyKey_key" ON "ObjectUploadReservation"("projectId", "requestIdempotencyKey");
CREATE UNIQUE INDEX "ObjectUploadReservation_multipartUploadId_partNumber_key" ON "ObjectUploadReservation"("multipartUploadId", "partNumber");
CREATE INDEX "ObjectUploadReservation_resourceId_objectKey_objectGeneration_idx" ON "ObjectUploadReservation"("resourceId", "objectKey", "objectGeneration");
CREATE INDEX "ObjectUploadReservation_accountingState_expiresAt_idx" ON "ObjectUploadReservation"("accountingState", "expiresAt");
CREATE INDEX "ObjectUploadReservation_status_leaseUntil_createdAt_idx" ON "ObjectUploadReservation"("status", "leaseUntil", "createdAt");

CREATE TABLE "ObjectStorageObject" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "environmentId" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "committedBytes" BIGINT NOT NULL,
  "checksumSha256" TEXT,
  "etag" TEXT NOT NULL,
  "providerVersion" TEXT,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "credentialGeneration" INTEGER NOT NULL,
  "reconciliationState" TEXT NOT NULL DEFAULT 'verified',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ObjectStorageObject_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ObjectStorageObject_accounting_check" CHECK ("committedBytes" >= 0 AND "generation" > 0 AND "credentialGeneration" > 0 AND "reconciliationState" IN ('verified','unknown','missing','cleanup_pending')),
  CONSTRAINT "ObjectStorageObject_project_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ObjectStorageObject_environment_fkey" FOREIGN KEY ("environmentId", "projectId") REFERENCES "Environment"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ObjectStorageObject_resource_fkey" FOREIGN KEY ("resourceId", "projectId") REFERENCES "Resource"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ObjectStorageObject_resourceId_objectKey_key" ON "ObjectStorageObject"("resourceId", "objectKey");
CREATE INDEX "ObjectStorageObject_projectId_environmentId_reconciliationState_idx" ON "ObjectStorageObject"("projectId", "environmentId", "reconciliationState");

CREATE TABLE "ObjectMultipartUpload" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "environmentId" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "providerUploadId" TEXT NOT NULL,
  "destinationGeneration" INTEGER NOT NULL,
  "credentialGeneration" INTEGER NOT NULL,
  "requestIdempotencyKey" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'open',
  "workerId" TEXT,
  "leaseToken" TEXT,
  "leaseGeneration" INTEGER NOT NULL DEFAULT 0,
  "leaseUntil" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ObjectMultipartUpload_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ObjectMultipartUpload_state_check" CHECK ("state" IN ('open','completing','completed','abort_requested','cleanup_pending','aborted','unknown')),
  CONSTRAINT "ObjectMultipartUpload_fence_check" CHECK ("destinationGeneration" > 0 AND "credentialGeneration" > 0 AND "leaseGeneration" >= 0),
  CONSTRAINT "ObjectMultipartUpload_project_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ObjectMultipartUpload_environment_fkey" FOREIGN KEY ("environmentId", "projectId") REFERENCES "Environment"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ObjectMultipartUpload_resource_fkey" FOREIGN KEY ("resourceId", "projectId") REFERENCES "Resource"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ObjectMultipartUpload_resourceId_providerUploadId_key" ON "ObjectMultipartUpload"("resourceId", "providerUploadId");
CREATE UNIQUE INDEX "ObjectMultipartUpload_projectId_requestIdempotencyKey_key" ON "ObjectMultipartUpload"("projectId", "requestIdempotencyKey");
CREATE INDEX "ObjectMultipartUpload_resourceId_objectKey_destinationGeneration_idx" ON "ObjectMultipartUpload"("resourceId", "objectKey", "destinationGeneration");
CREATE INDEX "ObjectMultipartUpload_state_leaseUntil_expiresAt_idx" ON "ObjectMultipartUpload"("state", "leaseUntil", "expiresAt");

ALTER TABLE "ObjectUploadReservation"
  ADD CONSTRAINT "ObjectUploadReservation_multipartUpload_fkey" FOREIGN KEY ("multipartUploadId") REFERENCES "ObjectMultipartUpload"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ObjectMultipartPart" (
  "uploadId" TEXT NOT NULL,
  "providerUploadId" TEXT NOT NULL,
  "partNumber" INTEGER NOT NULL,
  "reservationId" TEXT NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "checksumSha256" TEXT NOT NULL,
  "etag" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'verified',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ObjectMultipartPart_pkey" PRIMARY KEY ("providerUploadId", "partNumber"),
  CONSTRAINT "ObjectMultipartPart_part_check" CHECK ("partNumber" BETWEEN 1 AND 10000 AND "sizeBytes" > 0 AND "state" IN ('reserved','forwarding','verified','cleanup_pending','released')),
  CONSTRAINT "ObjectMultipartPart_upload_fkey" FOREIGN KEY ("uploadId") REFERENCES "ObjectMultipartUpload"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ObjectMultipartPart_reservation_fkey" FOREIGN KEY ("reservationId") REFERENCES "ObjectUploadReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ObjectMultipartPart_reservationId_key" ON "ObjectMultipartPart"("reservationId");
CREATE UNIQUE INDEX "ObjectMultipartPart_uploadId_partNumber_key" ON "ObjectMultipartPart"("uploadId", "partNumber");
CREATE INDEX "ObjectMultipartPart_uploadId_state_idx" ON "ObjectMultipartPart"("uploadId", "state");

ALTER TABLE "ResourceBackup"
  ADD CONSTRAINT "ResourceBackup_origin_check" CHECK ("origin" IN ('manual', 'scheduled')),
  ADD CONSTRAINT "ResourceBackup_scheduled_policy_check" CHECK (
    ("origin" = 'manual' AND "policyId" IS NULL AND "policyRunId" IS NULL AND "policyVersion" IS NULL AND "scheduledAtUtc" IS NULL AND "policySnapshot" IS NULL AND "environmentId" IS NULL)
    OR ("origin" = 'scheduled' AND "formatVersion" = 1 AND "formatVersion" IS NOT NULL AND "policyId" IS NOT NULL AND "policyRunId" IS NOT NULL AND "policyVersion" IS NOT NULL AND "scheduledAtUtc" IS NOT NULL AND "policySnapshot" IS NOT NULL AND "environmentId" IS NOT NULL AND "expiresAt" IS NULL)
  ),
  ADD CONSTRAINT "ResourceBackup_policy_fkey" FOREIGN KEY ("policyId") REFERENCES "BackupPolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ResourceBackup_policyRun_fkey" FOREIGN KEY ("policyRunId") REFERENCES "BackupPolicyRun"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "ResourceBackup_environment_fkey" FOREIGN KEY ("environmentId", "projectId") REFERENCES "Environment"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "ResourceBackup_policyRunId_key" ON "ResourceBackup"("policyRunId");

-- Amend only v1 age expiry. Completeness, provenance, transitions, artifact
-- immutability, tenant, cleanup, restore and pin guards remain format-1 guards.
ALTER TABLE "ResourceBackup"
  DROP CONSTRAINT "ResourceBackup_ready_complete",
  ADD CONSTRAINT "ResourceBackup_ready_complete" CHECK (
  "formatVersion" IS NULL OR status NOT IN ('READY','EXPIRED') OR (
    "artifactKey" IS NOT NULL AND "artifactChecksum" ~ '^[0-9a-f]{64}$' AND "artifactChecksum" IS NOT NULL
    AND "artifactSize" BETWEEN 1 AND 10737418240 AND "artifactSize" IS NOT NULL
    AND "encryptionKeyVersion" IS NOT NULL AND "winningAttempt" BETWEEN 1 AND 3 AND "winningAttempt" IS NOT NULL
    AND "readyAt" IS NOT NULL AND (("origin" = 'manual' AND "expiresAt" = "readyAt" + INTERVAL '30 days' AND "expiresAt" IS NOT NULL) OR ("origin" = 'scheduled' AND "expiresAt" IS NULL))));

CREATE FUNCTION raibit_operational_protocol_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'Environment' THEN
    IF TG_OP = 'UPDATE' AND ROW(NEW."id", NEW."projectId", NEW."kind") IS DISTINCT FROM ROW(OLD."id", OLD."projectId", OLD."kind") THEN
      RAISE EXCEPTION 'ENVIRONMENT_IDENTITY_IMMUTABLE';
    END IF;
    IF COALESCE(current_setting('raibitserver.operational_protocol', true), '1') <> '2' THEN
      IF TG_OP <> 'INSERT' AND OLD."kind" <> 'prod' THEN RAISE EXCEPTION 'OPERATIONAL_PROTOCOL_2_REQUIRED'; END IF;
      IF TG_OP <> 'DELETE' AND (NEW."kind" <> 'prod' OR NEW."id" <> 'env_prod_' || NEW."projectId") THEN RAISE EXCEPTION 'OPERATIONAL_PROTOCOL_2_REQUIRED'; END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'EnvironmentService' THEN
    IF COALESCE(current_setting('raibitserver.operational_protocol', true), '1') <> '2' THEN
      IF TG_OP <> 'INSERT' AND EXISTS (SELECT 1 FROM "Environment" WHERE "id" = OLD."environmentId" AND "kind" <> 'prod') THEN RAISE EXCEPTION 'OPERATIONAL_PROTOCOL_2_REQUIRED'; END IF;
      IF TG_OP <> 'DELETE' AND NOT EXISTS (SELECT 1 FROM "Environment" environment JOIN "Service" service ON service."id" = NEW."serviceId" AND service."projectId" = environment."projectId" WHERE environment."id" = NEW."environmentId" AND environment."projectId" = NEW."projectId" AND environment."kind" = 'prod' AND service."slug" = NEW."logicalSlug") THEN RAISE EXCEPTION 'OPERATIONAL_PROTOCOL_2_REQUIRED'; END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'EnvironmentResource' THEN
    IF COALESCE(current_setting('raibitserver.operational_protocol', true), '1') <> '2' THEN
      IF TG_OP <> 'INSERT' AND EXISTS (SELECT 1 FROM "Environment" WHERE "id" = OLD."environmentId" AND "kind" <> 'prod') THEN RAISE EXCEPTION 'OPERATIONAL_PROTOCOL_2_REQUIRED'; END IF;
      IF TG_OP <> 'DELETE' AND NOT EXISTS (SELECT 1 FROM "Environment" environment JOIN "Resource" resource ON resource."id" = NEW."resourceId" AND resource."projectId" = environment."projectId" WHERE environment."id" = NEW."environmentId" AND environment."projectId" = NEW."projectId" AND environment."kind" = 'prod' AND resource."slug" = NEW."logicalSlug") THEN RAISE EXCEPTION 'OPERATIONAL_PROTOCOL_2_REQUIRED'; END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'Service' THEN
    IF EXISTS (SELECT 1 FROM "EnvironmentService" binding JOIN "Environment" environment ON environment."id" = binding."environmentId" WHERE binding."serviceId" IN (NEW."id", OLD."id") AND environment."kind" <> 'prod')
      AND COALESCE(current_setting('raibitserver.operational_protocol', true), '1') <> '2' THEN RAISE EXCEPTION 'OPERATIONAL_PROTOCOL_2_REQUIRED'; END IF;
  ELSIF TG_TABLE_NAME = 'Resource' THEN
    IF EXISTS (SELECT 1 FROM "EnvironmentResource" binding JOIN "Environment" environment ON environment."id" = binding."environmentId" WHERE binding."resourceId" IN (NEW."id", OLD."id") AND environment."kind" <> 'prod')
      AND COALESCE(current_setting('raibitserver.operational_protocol', true), '1') <> '2' THEN RAISE EXCEPTION 'OPERATIONAL_PROTOCOL_2_REQUIRED'; END IF;
  ELSIF TG_TABLE_NAME = 'ResourceBackup' THEN
    IF (NEW."origin" = 'scheduled' OR OLD."origin" = 'scheduled')
      AND COALESCE(current_setting('raibitserver.operational_protocol', true), '1') <> '2' THEN RAISE EXCEPTION 'OPERATIONAL_PROTOCOL_2_REQUIRED'; END IF;
  ELSIF TG_TABLE_NAME = 'WorkflowJob' THEN
    IF NEW."type" LIKE 'operational.%' OR OLD."type" LIKE 'operational.%' OR NEW."operationalProtocolVersion" = 2 OR OLD."operationalProtocolVersion" = 2 THEN
      IF TG_OP <> 'DELETE' AND NEW."operationalProtocolVersion" = 2 IS NOT TRUE THEN RAISE EXCEPTION 'OPERATIONAL_PROTOCOL_2_REQUIRED'; END IF;
      IF COALESCE(current_setting('raibitserver.operational_protocol', true), '1') <> '2' THEN RAISE EXCEPTION 'OPERATIONAL_PROTOCOL_2_REQUIRED'; END IF;
    END IF;
  ELSE
    IF COALESCE(current_setting('raibitserver.operational_protocol', true), '1') <> '2' THEN
      RAISE EXCEPTION 'OPERATIONAL_PROTOCOL_2_REQUIRED';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Environment_protocol_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Environment" FOR EACH ROW EXECUTE FUNCTION raibit_operational_protocol_guard();
CREATE TRIGGER "EnvironmentService_protocol_guard" BEFORE INSERT OR UPDATE OR DELETE ON "EnvironmentService" FOR EACH ROW EXECUTE FUNCTION raibit_operational_protocol_guard();
CREATE TRIGGER "EnvironmentResource_protocol_guard" BEFORE INSERT OR UPDATE OR DELETE ON "EnvironmentResource" FOR EACH ROW EXECUTE FUNCTION raibit_operational_protocol_guard();
CREATE TRIGGER "Service_environment_protocol_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Service" FOR EACH ROW EXECUTE FUNCTION raibit_operational_protocol_guard();
CREATE TRIGGER "Resource_environment_protocol_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Resource" FOR EACH ROW EXECUTE FUNCTION raibit_operational_protocol_guard();
CREATE TRIGGER "ResourceBackup_operational_protocol_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ResourceBackup" FOR EACH ROW EXECUTE FUNCTION raibit_operational_protocol_guard();
CREATE TRIGGER "WorkflowJob_operational_protocol_guard" BEFORE INSERT OR UPDATE OR DELETE ON "WorkflowJob" FOR EACH ROW EXECUTE FUNCTION raibit_operational_protocol_guard();
CREATE TRIGGER "TemplateInstallation_protocol_guard" BEFORE INSERT OR UPDATE OR DELETE ON "TemplateInstallation" FOR EACH ROW EXECUTE FUNCTION raibit_operational_protocol_guard();
CREATE TRIGGER "TemplateInstallationVersion_protocol_guard" BEFORE INSERT OR UPDATE OR DELETE ON "TemplateInstallationVersion" FOR EACH ROW EXECUTE FUNCTION raibit_operational_protocol_guard();
CREATE TRIGGER "PromotionPreview_protocol_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PromotionPreview" FOR EACH ROW EXECUTE FUNCTION raibit_operational_protocol_guard();
CREATE TRIGGER "PromotionOperation_protocol_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PromotionOperation" FOR EACH ROW EXECUTE FUNCTION raibit_operational_protocol_guard();
CREATE TRIGGER "NotificationDestination_protocol_guard" BEFORE INSERT OR UPDATE OR DELETE ON "NotificationDestination" FOR EACH ROW EXECUTE FUNCTION raibit_operational_protocol_guard();
CREATE TRIGGER "NotificationSubscription_protocol_guard" BEFORE INSERT OR UPDATE OR DELETE ON "NotificationSubscription" FOR EACH ROW EXECUTE FUNCTION raibit_operational_protocol_guard();
CREATE TRIGGER "NotificationIntent_protocol_guard" BEFORE INSERT OR UPDATE OR DELETE ON "NotificationIntent" FOR EACH ROW EXECUTE FUNCTION raibit_operational_protocol_guard();
CREATE TRIGGER "NotificationDeliveryAttempt_protocol_guard" BEFORE INSERT OR UPDATE OR DELETE ON "NotificationDeliveryAttempt" FOR EACH ROW EXECUTE FUNCTION raibit_operational_protocol_guard();
CREATE TRIGGER "BackupPolicy_protocol_guard" BEFORE INSERT OR UPDATE OR DELETE ON "BackupPolicy" FOR EACH ROW EXECUTE FUNCTION raibit_operational_protocol_guard();
CREATE TRIGGER "BackupPolicyRun_protocol_guard" BEFORE INSERT OR UPDATE OR DELETE ON "BackupPolicyRun" FOR EACH ROW EXECUTE FUNCTION raibit_operational_protocol_guard();
CREATE TRIGGER "ObjectUploadReservation_protocol_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ObjectUploadReservation" FOR EACH ROW EXECUTE FUNCTION raibit_operational_protocol_guard();
CREATE TRIGGER "ObjectStorageObject_protocol_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ObjectStorageObject" FOR EACH ROW EXECUTE FUNCTION raibit_operational_protocol_guard();
CREATE TRIGGER "ObjectMultipartUpload_protocol_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ObjectMultipartUpload" FOR EACH ROW EXECUTE FUNCTION raibit_operational_protocol_guard();
CREATE TRIGGER "ObjectMultipartPart_protocol_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ObjectMultipartPart" FOR EACH ROW EXECUTE FUNCTION raibit_operational_protocol_guard();

CREATE FUNCTION raibit_operational_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'TemplateInstallationVersion' AND TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'OPERATIONAL_PROVENANCE_IMMUTABLE';
  ELSIF TG_TABLE_NAME = 'PromotionPreview' AND TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'PROMOTION_PREVIEW_IMMUTABLE';
  ELSIF TG_TABLE_NAME = 'NotificationDestination' AND TG_OP = 'UPDATE' THEN
    IF NEW."version" < OLD."version" OR (ROW(NEW."sealedWebhookUrl", NEW."encryptionKeyVersion") IS DISTINCT FROM ROW(OLD."sealedWebhookUrl", OLD."encryptionKeyVersion") AND NEW."version" <> OLD."version" + 1) THEN
      RAISE EXCEPTION 'NOTIFICATION_DESTINATION_VERSION_INVALID';
    END IF;
  ELSIF TG_TABLE_NAME = 'NotificationSubscription' AND TG_OP <> 'DELETE' AND NOT EXISTS (SELECT 1 FROM "Environment" environment WHERE environment."id" = NEW."environmentId" AND environment."projectId" = NEW."projectId" AND environment."kind" = NEW."environmentKind") THEN
    RAISE EXCEPTION 'NOTIFICATION_ENVIRONMENT_INVALID';
  ELSIF TG_TABLE_NAME = 'NotificationIntent' THEN
    IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND ROW(NEW."projectId", NEW."environmentId", NEW."destinationId", NEW."destinationVersion", NEW."environmentKind", NEW."eventCode", NEW."subjectId", NEW."subjectGenerationOrIncidentSequence", NEW."dedupKey", NEW."payload", NEW."protocolVersion", NEW."createdAt") IS DISTINCT FROM ROW(OLD."projectId", OLD."environmentId", OLD."destinationId", OLD."destinationVersion", OLD."environmentKind", OLD."eventCode", OLD."subjectId", OLD."subjectGenerationOrIncidentSequence", OLD."dedupKey", OLD."payload", OLD."protocolVersion", OLD."createdAt")) THEN
      RAISE EXCEPTION 'NOTIFICATION_INTENT_IMMUTABLE';
    END IF;
    IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM "NotificationDestination" destination WHERE destination."id" = NEW."destinationId" AND destination."projectId" = NEW."projectId" AND destination."version" = NEW."destinationVersion") THEN
      RAISE EXCEPTION 'NOTIFICATION_DESTINATION_VERSION_STALE';
    END IF;
    IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM "Environment" environment WHERE environment."id" = NEW."environmentId" AND environment."projectId" = NEW."projectId" AND environment."kind" = NEW."environmentKind") THEN
      RAISE EXCEPTION 'NOTIFICATION_ENVIRONMENT_INVALID';
    END IF;
  ELSIF TG_TABLE_NAME = 'NotificationDeliveryAttempt' AND TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM "NotificationIntent" intent WHERE intent."id" = NEW."intentId" AND intent."projectId" = NEW."projectId" AND intent."destinationId" = NEW."destinationId" AND intent."destinationVersion" = NEW."destinationVersion") THEN
    RAISE EXCEPTION 'NOTIFICATION_DESTINATION_VERSION_STALE';
  ELSIF TG_TABLE_NAME = 'NotificationDeliveryAttempt' AND TG_OP = 'UPDATE' AND (ROW(NEW."projectId", NEW."intentId", NEW."destinationId", NEW."destinationVersion", NEW."attempt", NEW."createdAt") IS DISTINCT FROM ROW(OLD."projectId", OLD."intentId", OLD."destinationId", OLD."destinationVersion", OLD."attempt", OLD."createdAt") OR NEW."leaseGeneration" < OLD."leaseGeneration" OR (ROW(NEW."workerId", NEW."leaseToken") IS DISTINCT FROM ROW(OLD."workerId", OLD."leaseToken") AND NEW."leaseGeneration" <> OLD."leaseGeneration" + 1)) THEN
    RAISE EXCEPTION 'NOTIFICATION_ATTEMPT_IMMUTABLE';
  ELSIF TG_TABLE_NAME = 'BackupPolicy' AND TG_OP = 'UPDATE' AND (NEW."version" <= OLD."version" OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId") THEN
    RAISE EXCEPTION 'BACKUP_POLICY_VERSION_INVALID';
  ELSIF TG_TABLE_NAME = 'BackupPolicyRun' AND TG_OP = 'UPDATE' AND (ROW(NEW."policyId", NEW."organizationId", NEW."projectId", NEW."environmentId", NEW."resourceId", NEW."scheduledAtUtc", NEW."policyVersion", NEW."policySnapshot", NEW."protocolVersion", NEW."createdAt") IS DISTINCT FROM ROW(OLD."policyId", OLD."organizationId", OLD."projectId", OLD."environmentId", OLD."resourceId", OLD."scheduledAtUtc", OLD."policyVersion", OLD."policySnapshot", OLD."protocolVersion", OLD."createdAt") OR NEW."leaseGeneration" < OLD."leaseGeneration" OR (ROW(NEW."workerId", NEW."leaseToken") IS DISTINCT FROM ROW(OLD."workerId", OLD."leaseToken") AND NEW."leaseGeneration" <> OLD."leaseGeneration" + 1)) THEN
    RAISE EXCEPTION 'BACKUP_POLICY_OCCURRENCE_IMMUTABLE';
  ELSIF TG_TABLE_NAME = 'ResourceBackup' AND TG_OP = 'UPDATE' AND ROW(NEW."origin", NEW."policyId", NEW."policyRunId", NEW."policyVersion", NEW."scheduledAtUtc", NEW."policySnapshot", NEW."environmentId") IS DISTINCT FROM ROW(OLD."origin", OLD."policyId", OLD."policyRunId", OLD."policyVersion", OLD."scheduledAtUtc", OLD."policySnapshot", OLD."environmentId") THEN
    RAISE EXCEPTION 'BACKUP_ORIGIN_IMMUTABLE';
  ELSIF TG_TABLE_NAME = 'ResourceBackup' AND TG_OP <> 'DELETE' AND NEW."origin" = 'scheduled' AND NOT EXISTS (SELECT 1 FROM "BackupPolicyRun" run WHERE run."id" = NEW."policyRunId" AND run."policyId" = NEW."policyId" AND run."policyVersion" = NEW."policyVersion" AND run."projectId" = NEW."projectId" AND run."environmentId" = NEW."environmentId" AND run."resourceId" = NEW."resourceId" AND run."scheduledAtUtc" = NEW."scheduledAtUtc" AND run."policySnapshot" = NEW."policySnapshot") THEN
    RAISE EXCEPTION 'BACKUP_POLICY_OCCURRENCE_INVALID';
  ELSIF TG_TABLE_NAME = 'ObjectUploadReservation' AND TG_OP = 'UPDATE' AND (ROW(NEW."projectId", NEW."environmentId", NEW."resourceId", NEW."providerEndpointRef", NEW."operationKind", NEW."objectKey", NEW."objectGeneration", NEW."credentialGeneration", NEW."multipartUploadId", NEW."partNumber", NEW."checksumSha256", NEW."expectedBytes", NEW."requestIdempotencyKey", NEW."requestFingerprint", NEW."protocolVersion", NEW."createdAt") IS DISTINCT FROM ROW(OLD."projectId", OLD."environmentId", OLD."resourceId", OLD."providerEndpointRef", OLD."operationKind", OLD."objectKey", OLD."objectGeneration", OLD."credentialGeneration", OLD."multipartUploadId", OLD."partNumber", OLD."checksumSha256", OLD."expectedBytes", OLD."requestIdempotencyKey", OLD."requestFingerprint", OLD."protocolVersion", OLD."createdAt") OR NEW."leaseGeneration" < OLD."leaseGeneration" OR (ROW(NEW."workerId", NEW."leaseToken") IS DISTINCT FROM ROW(OLD."workerId", OLD."leaseToken") AND NEW."leaseGeneration" <> OLD."leaseGeneration" + 1)) THEN
    RAISE EXCEPTION 'OBJECT_UPLOAD_RESERVATION_IMMUTABLE';
  ELSIF TG_TABLE_NAME = 'ObjectStorageObject' AND TG_OP = 'UPDATE' AND (ROW(NEW."projectId", NEW."environmentId", NEW."resourceId", NEW."objectKey", NEW."createdAt") IS DISTINCT FROM ROW(OLD."projectId", OLD."environmentId", OLD."resourceId", OLD."objectKey", OLD."createdAt") OR NEW."generation" < OLD."generation") THEN
    RAISE EXCEPTION 'OBJECT_LEDGER_FENCE_INVALID';
  ELSIF TG_TABLE_NAME = 'ObjectMultipartUpload' AND TG_OP = 'UPDATE' AND (ROW(NEW."projectId", NEW."environmentId", NEW."resourceId", NEW."objectKey", NEW."providerUploadId", NEW."destinationGeneration", NEW."credentialGeneration", NEW."requestIdempotencyKey", NEW."requestFingerprint", NEW."createdAt") IS DISTINCT FROM ROW(OLD."projectId", OLD."environmentId", OLD."resourceId", OLD."objectKey", OLD."providerUploadId", OLD."destinationGeneration", OLD."credentialGeneration", OLD."requestIdempotencyKey", OLD."requestFingerprint", OLD."createdAt") OR NEW."leaseGeneration" < OLD."leaseGeneration") THEN
    RAISE EXCEPTION 'OBJECT_MULTIPART_FENCE_INVALID';
  ELSIF TG_TABLE_NAME = 'ObjectMultipartPart' AND TG_OP = 'UPDATE' AND ROW(NEW."uploadId", NEW."providerUploadId", NEW."partNumber", NEW."reservationId", NEW."sizeBytes", NEW."checksumSha256", NEW."etag", NEW."createdAt") IS DISTINCT FROM ROW(OLD."uploadId", OLD."providerUploadId", OLD."partNumber", OLD."reservationId", OLD."sizeBytes", OLD."checksumSha256", OLD."etag", OLD."createdAt") THEN
    RAISE EXCEPTION 'OBJECT_MULTIPART_PART_IMMUTABLE';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "TemplateInstallationVersion_state_guard" BEFORE INSERT OR UPDATE OR DELETE ON "TemplateInstallationVersion" FOR EACH ROW EXECUTE FUNCTION raibit_operational_state_guard();
CREATE TRIGGER "PromotionPreview_state_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PromotionPreview" FOR EACH ROW EXECUTE FUNCTION raibit_operational_state_guard();
CREATE TRIGGER "NotificationDestination_state_guard" BEFORE INSERT OR UPDATE OR DELETE ON "NotificationDestination" FOR EACH ROW EXECUTE FUNCTION raibit_operational_state_guard();
CREATE TRIGGER "NotificationSubscription_state_guard" BEFORE INSERT OR UPDATE OR DELETE ON "NotificationSubscription" FOR EACH ROW EXECUTE FUNCTION raibit_operational_state_guard();
CREATE TRIGGER "NotificationIntent_state_guard" BEFORE INSERT OR UPDATE OR DELETE ON "NotificationIntent" FOR EACH ROW EXECUTE FUNCTION raibit_operational_state_guard();
CREATE TRIGGER "NotificationDeliveryAttempt_state_guard" BEFORE INSERT OR UPDATE OR DELETE ON "NotificationDeliveryAttempt" FOR EACH ROW EXECUTE FUNCTION raibit_operational_state_guard();
CREATE TRIGGER "BackupPolicy_state_guard" BEFORE INSERT OR UPDATE OR DELETE ON "BackupPolicy" FOR EACH ROW EXECUTE FUNCTION raibit_operational_state_guard();
CREATE TRIGGER "BackupPolicyRun_state_guard" BEFORE INSERT OR UPDATE OR DELETE ON "BackupPolicyRun" FOR EACH ROW EXECUTE FUNCTION raibit_operational_state_guard();
CREATE TRIGGER "ResourceBackup_operational_state_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ResourceBackup" FOR EACH ROW EXECUTE FUNCTION raibit_operational_state_guard();
CREATE TRIGGER "ObjectUploadReservation_state_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ObjectUploadReservation" FOR EACH ROW EXECUTE FUNCTION raibit_operational_state_guard();
CREATE TRIGGER "ObjectStorageObject_state_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ObjectStorageObject" FOR EACH ROW EXECUTE FUNCTION raibit_operational_state_guard();
CREATE TRIGGER "ObjectMultipartUpload_state_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ObjectMultipartUpload" FOR EACH ROW EXECUTE FUNCTION raibit_operational_state_guard();
CREATE TRIGGER "ObjectMultipartPart_state_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ObjectMultipartPart" FOR EACH ROW EXECUTE FUNCTION raibit_operational_state_guard();

CREATE FUNCTION raibit_service_binding_required() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'Service' THEN
    IF NOT EXISTS (SELECT 1 FROM "Service" service WHERE service."id" = NEW."id") THEN RETURN NEW; END IF;
    IF TG_OP = 'INSERT' AND COALESCE(current_setting('raibitserver.operational_protocol', true), '1') = '1'
      AND NOT EXISTS (SELECT 1 FROM "EnvironmentService" WHERE "serviceId" = NEW."id") THEN
      INSERT INTO "Environment" ("id", "projectId", "kind", "status", "createdAt", "updatedAt")
      SELECT 'env_prod_' || project."id", project."id", 'prod', 'active', project."createdAt", project."updatedAt"
      FROM "Project" project JOIN "Service" service ON service."projectId" = project."id" WHERE service."id" = NEW."id"
      ON CONFLICT ("projectId", "kind") DO NOTHING;
      INSERT INTO "EnvironmentService" ("serviceId", "environmentId", "projectId", "logicalSlug", "createdAt", "updatedAt")
      SELECT service."id", environment."id", service."projectId", service."slug", service."createdAt", service."updatedAt"
      FROM "Service" service JOIN "Environment" environment ON environment."projectId" = service."projectId" AND environment."kind" = 'prod'
      WHERE service."id" = NEW."id" ON CONFLICT ("serviceId") DO NOTHING;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "EnvironmentService" binding WHERE binding."serviceId" = NEW."id" AND binding."projectId" = NEW."projectId") THEN
      RAISE EXCEPTION 'ENVIRONMENT_SERVICE_BINDING_REQUIRED';
    END IF;
  ELSE
    IF TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM "Service" service WHERE service."id" = OLD."serviceId") AND NOT EXISTS (SELECT 1 FROM "EnvironmentService" binding WHERE binding."serviceId" = OLD."serviceId") THEN
      RAISE EXCEPTION 'ENVIRONMENT_SERVICE_BINDING_REQUIRED';
    END IF;
    IF EXISTS (SELECT 1 FROM "Service" service WHERE service."id" = COALESCE(NEW."serviceId", OLD."serviceId")) AND NOT EXISTS (SELECT 1 FROM "EnvironmentService" binding WHERE binding."serviceId" = COALESCE(NEW."serviceId", OLD."serviceId")) THEN
      RAISE EXCEPTION 'ENVIRONMENT_SERVICE_BINDING_REQUIRED';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER "Service_binding_required" AFTER INSERT OR UPDATE ON "Service" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raibit_service_binding_required();
CREATE CONSTRAINT TRIGGER "EnvironmentService_binding_required" AFTER UPDATE OR DELETE ON "EnvironmentService" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raibit_service_binding_required();

CREATE FUNCTION raibit_resource_binding_required() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'Resource' THEN
    IF NOT EXISTS (SELECT 1 FROM "Resource" resource WHERE resource."id" = NEW."id") THEN RETURN NEW; END IF;
    IF TG_OP = 'INSERT' AND COALESCE(current_setting('raibitserver.operational_protocol', true), '1') = '1'
      AND NOT EXISTS (SELECT 1 FROM "EnvironmentResource" WHERE "resourceId" = NEW."id") THEN
      INSERT INTO "Environment" ("id", "projectId", "kind", "status", "createdAt", "updatedAt")
      SELECT 'env_prod_' || project."id", project."id", 'prod', 'active', project."createdAt", project."updatedAt"
      FROM "Project" project JOIN "Resource" resource ON resource."projectId" = project."id" WHERE resource."id" = NEW."id"
      ON CONFLICT ("projectId", "kind") DO NOTHING;
      INSERT INTO "EnvironmentResource" ("resourceId", "environmentId", "projectId", "logicalSlug", "createdAt", "updatedAt")
      SELECT resource."id", environment."id", resource."projectId", resource."slug", resource."createdAt", resource."updatedAt"
      FROM "Resource" resource JOIN "Environment" environment ON environment."projectId" = resource."projectId" AND environment."kind" = 'prod'
      WHERE resource."id" = NEW."id" ON CONFLICT ("resourceId") DO NOTHING;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "EnvironmentResource" binding WHERE binding."resourceId" = NEW."id" AND binding."projectId" = NEW."projectId") THEN
      RAISE EXCEPTION 'ENVIRONMENT_RESOURCE_BINDING_REQUIRED';
    END IF;
  ELSE
    IF TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM "Resource" resource WHERE resource."id" = OLD."resourceId") AND NOT EXISTS (SELECT 1 FROM "EnvironmentResource" binding WHERE binding."resourceId" = OLD."resourceId") THEN
      RAISE EXCEPTION 'ENVIRONMENT_RESOURCE_BINDING_REQUIRED';
    END IF;
    IF EXISTS (SELECT 1 FROM "Resource" resource WHERE resource."id" = COALESCE(NEW."resourceId", OLD."resourceId")) AND NOT EXISTS (SELECT 1 FROM "EnvironmentResource" binding WHERE binding."resourceId" = COALESCE(NEW."resourceId", OLD."resourceId")) THEN
      RAISE EXCEPTION 'ENVIRONMENT_RESOURCE_BINDING_REQUIRED';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER "Resource_binding_required" AFTER INSERT OR UPDATE ON "Resource" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raibit_resource_binding_required();
CREATE CONSTRAINT TRIGGER "EnvironmentResource_binding_required" AFTER UPDATE OR DELETE ON "EnvironmentResource" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raibit_resource_binding_required();
