-- preflight: baseline
INSERT INTO "Organization" ("id", "name", "slug", "createdAt", "updatedAt")
VALUES ('org_preflight', 'Preflight', 'preflight', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT INTO "Project" ("id", "organizationId", "name", "slug", "createdAt", "updatedAt")
VALUES
  ('project_existing', 'org_preflight', 'Existing', 'existing', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('project_other', 'org_preflight', 'Other', 'other', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT INTO "Service" ("id", "projectId", "name", "slug", "type", "sourceType", "createdAt", "updatedAt")
VALUES ('service_existing', 'project_existing', 'Existing API', 'existing-api', 'web', 'image', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT INTO "Resource" ("id", "projectId", "name", "slug", "type", "engine", "provider", "plan", "region", "createdAt", "updatedAt")
VALUES
  ('resource_existing', 'project_existing', 'Existing DB', 'existing-db', 'database', 'postgres', 'local', 'starter', 'local', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('resource_restore_target', 'project_existing', 'Restore target', 'restore-target', 'database', 'postgres', 'local', 'starter', 'local', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT INTO "ResourceBackup" (
  "id", "resourceId", "status", "path", "createdAt", "expiresAt"
) VALUES (
  'backup_legacy_manual', 'resource_existing', 'CREATED', 'legacy/path', CURRENT_TIMESTAMP, TIMESTAMP '2040-01-02 03:04:05'
);

INSERT INTO "ResourceBackup" (
  "id", "resourceId", "status", "createdAt", "formatVersion", "organizationId", "projectId", "engine", "provider",
  "sourceGeneration", "sourceProvenance", "sourceSpec", "requestedByUserId", "requestIdempotencyKey", "requestFingerprint",
  "artifactKey", "artifactChecksum", "artifactSize", "encryptionKeyVersion", "winningAttempt", "readyAt", "expiresAt", "updatedAt"
) VALUES (
  'backup_v1_manual', 'resource_existing', 'READY', CURRENT_TIMESTAMP, 1, 'org_preflight', 'project_existing', 'postgres', 'local',
  'resource-incarnation/v1:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '{"source":"baseline"}'::jsonb, '{"engine":"postgres"}'::jsonb, 'user_preflight', 'manual-replay', 'manual-fingerprint',
  'manual/artifact.v1', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 128, 'key-v1', 1,
  TIMESTAMP '2030-01-01 00:00:00', TIMESTAMP '2030-01-31 00:00:00', CURRENT_TIMESTAMP
);

-- preflight: typed-positive
INSERT INTO "TemplateInstallation" ("id","projectId","environmentId","catalogId","requestIdempotencyKey","idempotencyFingerprint","updatedAt")
VALUES ('installation_dispatch','project_existing','env_prod_project_existing','fixture-catalog','installation-dispatch','installation-fingerprint',CURRENT_TIMESTAMP);
INSERT INTO "TemplateInstallationVersion" ("id","installationId","projectId","environmentId","version","catalogVersion","catalogDigest","sourceDigest","graphDigest","provenance","idempotencyFingerprint")
VALUES ('version_dispatch','installation_dispatch','project_existing','env_prod_project_existing',1,'1','catalog-digest','source-digest','graph-digest','{}','version-fingerprint');
INSERT INTO "PromotionPreview" ("id","projectId","sourceEnvironmentId","targetEnvironmentId","sourceImageDigest","diffHash","previewDigest","graphSnapshot","expectedVersion","expiresAt")
VALUES ('preview_dispatch','project_existing','env_dev_project_existing','env_prod_project_existing','image-digest','diff-hash','preview-digest','{}',1,TIMESTAMP '2040-01-01');
INSERT INTO "NotificationIntent" ("id","projectId","environmentId","destinationId","destinationVersion","environmentKind","eventCode","subjectId","subjectGenerationOrIncidentSequence","dedupKey","payload")
VALUES ('intent_dispatch','project_existing','env_prod_project_existing','destination_main',2,'prod','backup.failed','scheduled_1',1,'intent-dispatch','{}');
UPDATE "NotificationIntent" SET "status"='sending' WHERE "id"='intent_dispatch';
INSERT INTO "NotificationDeliveryAttempt" ("id","projectId","intentId","destinationId","destinationVersion","attempt","updatedAt")
VALUES ('attempt_dispatch','project_existing','intent_dispatch','destination_main',2,1,CURRENT_TIMESTAMP);
UPDATE "NotificationDeliveryAttempt" SET "state"='sending',"workerId"='worker-dispatch',"leaseToken"='lease-dispatch',"leaseGeneration"=1 WHERE "id"='attempt_dispatch';
UPDATE "BackupPolicy" SET "version"=2,"enabled"=true WHERE "id"='policy_main';
UPDATE "BackupPolicyRun" SET "status"='RUNNING',"workerId"='worker-dispatch',"leaseToken"='lease-dispatch',"leaseGeneration"=1 WHERE "id"='run_1';
INSERT INTO "Resource" ("id","projectId","name","slug","type","engine","provider","plan","region","createdAt","updatedAt")
VALUES ('resource_objects','project_existing','Objects','objects','object-storage','minio','local','starter','local',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
INSERT INTO "EnvironmentResource" ("resourceId","environmentId","projectId","logicalSlug","createdAt","updatedAt")
VALUES ('resource_objects','env_prod_project_existing','project_existing','objects',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
INSERT INTO "ObjectMultipartUpload" ("id","projectId","environmentId","resourceId","objectKey","providerUploadId","destinationGeneration","credentialGeneration","requestIdempotencyKey","requestFingerprint","expiresAt","updatedAt")
VALUES ('upload_dispatch','project_existing','env_prod_project_existing','resource_objects','dispatch-object','provider-upload',1,1,'upload-dispatch','upload-fingerprint',TIMESTAMP '2040-01-01',CURRENT_TIMESTAMP);
UPDATE "ObjectMultipartUpload" SET "state"='completing',"leaseGeneration"=1 WHERE "id"='upload_dispatch';
INSERT INTO "ObjectUploadReservation" ("id","projectId","environmentId","resourceId","providerEndpointRef","operationKind","objectKey","objectGeneration","credentialGeneration","multipartUploadId","partNumber","checksumSha256","expectedBytes","reservedBytes","requestIdempotencyKey","requestFingerprint","expiresAt","updatedAt")
VALUES ('reservation_dispatch','project_existing','env_prod_project_existing','resource_objects','fixture-endpoint','multipart_part','dispatch-object',1,1,'upload_dispatch',1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',128,128,'reservation-dispatch','reservation-fingerprint',TIMESTAMP '2040-01-01',CURRENT_TIMESTAMP);
UPDATE "ObjectUploadReservation" SET "accountingState"='forwarding',"workerId"='worker-dispatch',"leaseToken"='lease-dispatch',"leaseGeneration"=1 WHERE "id"='reservation_dispatch';
INSERT INTO "ObjectStorageObject" ("id","projectId","environmentId","resourceId","objectKey","committedBytes","etag","credentialGeneration","updatedAt")
VALUES ('object_dispatch','project_existing','env_prod_project_existing','resource_objects','dispatch-object',128,'fixture-etag',1,CURRENT_TIMESTAMP);
UPDATE "ObjectStorageObject" SET "generation"=2,"reconciliationState"='unknown' WHERE "id"='object_dispatch';
INSERT INTO "ObjectMultipartPart" ("uploadId","providerUploadId","partNumber","reservationId","sizeBytes","checksumSha256","etag","updatedAt")
VALUES ('upload_dispatch','provider-upload',1,'reservation_dispatch',128,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','fixture-etag',CURRENT_TIMESTAMP);
UPDATE "ObjectMultipartPart" SET "state"='cleanup_pending' WHERE "uploadId"='upload_dispatch' AND "partNumber"=1;

-- preflight: reject version-update OPERATIONAL_PROVENANCE_IMMUTABLE
UPDATE "TemplateInstallationVersion" SET "catalogVersion"='2' WHERE "id"='version_dispatch';
-- preflight: reject version-delete OPERATIONAL_PROVENANCE_IMMUTABLE
DELETE FROM "TemplateInstallationVersion" WHERE "id"='version_dispatch';
-- preflight: reject preview-update PROMOTION_PREVIEW_IMMUTABLE
UPDATE "PromotionPreview" SET "expectedVersion"=2 WHERE "id"='preview_dispatch';
-- preflight: reject preview-delete PROMOTION_PREVIEW_IMMUTABLE
DELETE FROM "PromotionPreview" WHERE "id"='preview_dispatch';
-- preflight: reject intent-version NOTIFICATION_DESTINATION_VERSION_STALE
INSERT INTO "NotificationIntent" ("id","projectId","environmentId","destinationId","destinationVersion","environmentKind","eventCode","subjectId","subjectGenerationOrIncidentSequence","dedupKey","payload")
VALUES ('intent_wrong_version','project_existing','env_prod_project_existing','destination_main',1,'prod','backup.failed','scheduled_1',2,'intent-wrong-version','{}');
-- preflight: reject intent-environment NOTIFICATION_ENVIRONMENT_INVALID
INSERT INTO "NotificationIntent" ("id","projectId","environmentId","destinationId","destinationVersion","environmentKind","eventCode","subjectId","subjectGenerationOrIncidentSequence","dedupKey","payload")
VALUES ('intent_wrong_environment','project_existing','env_prod_project_existing','destination_main',2,'dev','backup.failed','scheduled_1',2,'intent-wrong-environment','{}');
-- preflight: reject intent-update NOTIFICATION_INTENT_IMMUTABLE
UPDATE "NotificationIntent" SET "payload"='{"changed":true}' WHERE "id"='intent_dispatch';
-- preflight: reject intent-delete NOTIFICATION_INTENT_IMMUTABLE
DELETE FROM "NotificationIntent" WHERE "id"='intent_dispatch';
-- preflight: reject attempt-version NOTIFICATION_DESTINATION_VERSION_STALE
INSERT INTO "NotificationDeliveryAttempt" ("id","projectId","intentId","destinationId","destinationVersion","attempt","updatedAt")
VALUES ('attempt_wrong_version','project_existing','intent_dispatch','destination_main',1,2,CURRENT_TIMESTAMP);
-- preflight: reject attempt-identity NOTIFICATION_ATTEMPT_IMMUTABLE
UPDATE "NotificationDeliveryAttempt" SET "attempt"=2 WHERE "id"='attempt_dispatch';
-- preflight: reject attempt-generation NOTIFICATION_ATTEMPT_IMMUTABLE
UPDATE "NotificationDeliveryAttempt" SET "leaseGeneration"=0 WHERE "id"='attempt_dispatch';
-- preflight: reject attempt-token NOTIFICATION_ATTEMPT_IMMUTABLE
UPDATE "NotificationDeliveryAttempt" SET "leaseToken"='changed' WHERE "id"='attempt_dispatch';
-- preflight: reject policy-version BACKUP_POLICY_VERSION_INVALID
UPDATE "BackupPolicy" SET "version"=2 WHERE "id"='policy_main';
-- preflight: reject policy-creator BACKUP_POLICY_VERSION_INVALID
UPDATE "BackupPolicy" SET "version"=3,"createdByUserId"='changed' WHERE "id"='policy_main';
-- preflight: reject run-identity BACKUP_POLICY_OCCURRENCE_IMMUTABLE
UPDATE "BackupPolicyRun" SET "policyVersion"=2 WHERE "id"='run_1';
-- preflight: reject run-generation BACKUP_POLICY_OCCURRENCE_IMMUTABLE
UPDATE "BackupPolicyRun" SET "leaseGeneration"=0 WHERE "id"='run_1';
-- preflight: reject run-token BACKUP_POLICY_OCCURRENCE_IMMUTABLE
UPDATE "BackupPolicyRun" SET "leaseToken"='changed' WHERE "id"='run_1';
-- preflight: reject backup-origin BACKUP_ORIGIN_IMMUTABLE
UPDATE "ResourceBackup" SET "policyVersion"=2 WHERE "id"='scheduled_1';
-- preflight: reject reservation-identity OBJECT_UPLOAD_RESERVATION_IMMUTABLE
UPDATE "ObjectUploadReservation" SET "objectKey"='changed' WHERE "id"='reservation_dispatch';
-- preflight: reject reservation-generation OBJECT_UPLOAD_RESERVATION_IMMUTABLE
UPDATE "ObjectUploadReservation" SET "leaseGeneration"=0 WHERE "id"='reservation_dispatch';
-- preflight: reject reservation-token OBJECT_UPLOAD_RESERVATION_IMMUTABLE
UPDATE "ObjectUploadReservation" SET "leaseToken"='changed' WHERE "id"='reservation_dispatch';
-- preflight: reject object-identity OBJECT_LEDGER_FENCE_INVALID
UPDATE "ObjectStorageObject" SET "objectKey"='changed' WHERE "id"='object_dispatch';
-- preflight: reject object-generation OBJECT_LEDGER_FENCE_INVALID
UPDATE "ObjectStorageObject" SET "generation"=1 WHERE "id"='object_dispatch';
-- preflight: reject upload-identity OBJECT_MULTIPART_FENCE_INVALID
UPDATE "ObjectMultipartUpload" SET "objectKey"='changed' WHERE "id"='upload_dispatch';
-- preflight: reject upload-generation OBJECT_MULTIPART_FENCE_INVALID
UPDATE "ObjectMultipartUpload" SET "leaseGeneration"=0 WHERE "id"='upload_dispatch';
-- preflight: reject part-identity OBJECT_MULTIPART_PART_IMMUTABLE
UPDATE "ObjectMultipartPart" SET "etag"='changed' WHERE "uploadId"='upload_dispatch' AND "partNumber"=1;
