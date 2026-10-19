-- Select the table before planning any NEW/OLD field expression. Boolean
-- short-circuit inside a shared IF does not isolate PostgreSQL record shapes.
CREATE OR REPLACE FUNCTION raibit_operational_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'TemplateInstallationVersion' THEN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'OPERATIONAL_PROVENANCE_IMMUTABLE';
      END IF;
    WHEN 'PromotionPreview' THEN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'PROMOTION_PREVIEW_IMMUTABLE';
      END IF;
    WHEN 'NotificationDestination' THEN
      IF TG_OP = 'UPDATE' THEN
        IF NEW."version" < OLD."version" OR (ROW(NEW."sealedWebhookUrl", NEW."encryptionKeyVersion") IS DISTINCT FROM ROW(OLD."sealedWebhookUrl", OLD."encryptionKeyVersion") AND NEW."version" <> OLD."version" + 1) THEN
          RAISE EXCEPTION 'NOTIFICATION_DESTINATION_VERSION_INVALID';
        END IF;
      END IF;
    WHEN 'NotificationSubscription' THEN
      IF TG_OP <> 'DELETE' THEN
        IF NOT EXISTS (SELECT 1 FROM "Environment" environment WHERE environment."id" = NEW."environmentId" AND environment."projectId" = NEW."projectId" AND environment."kind" = NEW."environmentKind") THEN
          RAISE EXCEPTION 'NOTIFICATION_ENVIRONMENT_INVALID';
        END IF;
      END IF;
    WHEN 'NotificationIntent' THEN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'NOTIFICATION_INTENT_IMMUTABLE';
      ELSIF TG_OP = 'UPDATE' THEN
        IF ROW(NEW."projectId", NEW."environmentId", NEW."destinationId", NEW."destinationVersion", NEW."environmentKind", NEW."eventCode", NEW."subjectId", NEW."subjectGenerationOrIncidentSequence", NEW."dedupKey", NEW."payload", NEW."protocolVersion", NEW."createdAt") IS DISTINCT FROM ROW(OLD."projectId", OLD."environmentId", OLD."destinationId", OLD."destinationVersion", OLD."environmentKind", OLD."eventCode", OLD."subjectId", OLD."subjectGenerationOrIncidentSequence", OLD."dedupKey", OLD."payload", OLD."protocolVersion", OLD."createdAt") THEN
          RAISE EXCEPTION 'NOTIFICATION_INTENT_IMMUTABLE';
        END IF;
      ELSIF TG_OP = 'INSERT' THEN
        IF NOT EXISTS (SELECT 1 FROM "NotificationDestination" destination WHERE destination."id" = NEW."destinationId" AND destination."projectId" = NEW."projectId" AND destination."version" = NEW."destinationVersion") THEN
          RAISE EXCEPTION 'NOTIFICATION_DESTINATION_VERSION_STALE';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM "Environment" environment WHERE environment."id" = NEW."environmentId" AND environment."projectId" = NEW."projectId" AND environment."kind" = NEW."environmentKind") THEN
          RAISE EXCEPTION 'NOTIFICATION_ENVIRONMENT_INVALID';
        END IF;
      END IF;
    WHEN 'NotificationDeliveryAttempt' THEN
      IF TG_OP = 'INSERT' THEN
        IF NOT EXISTS (SELECT 1 FROM "NotificationIntent" intent WHERE intent."id" = NEW."intentId" AND intent."projectId" = NEW."projectId" AND intent."destinationId" = NEW."destinationId" AND intent."destinationVersion" = NEW."destinationVersion") THEN
          RAISE EXCEPTION 'NOTIFICATION_DESTINATION_VERSION_STALE';
        END IF;
      ELSIF TG_OP = 'UPDATE' THEN
        IF (ROW(NEW."projectId", NEW."intentId", NEW."destinationId", NEW."destinationVersion", NEW."attempt", NEW."createdAt") IS DISTINCT FROM ROW(OLD."projectId", OLD."intentId", OLD."destinationId", OLD."destinationVersion", OLD."attempt", OLD."createdAt") OR NEW."leaseGeneration" < OLD."leaseGeneration" OR (ROW(NEW."workerId", NEW."leaseToken") IS DISTINCT FROM ROW(OLD."workerId", OLD."leaseToken") AND NEW."leaseGeneration" <> OLD."leaseGeneration" + 1)) THEN
          RAISE EXCEPTION 'NOTIFICATION_ATTEMPT_IMMUTABLE';
        END IF;
      END IF;
    WHEN 'BackupPolicy' THEN
      IF TG_OP = 'UPDATE' THEN
        IF (NEW."version" <= OLD."version" OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId") THEN
          RAISE EXCEPTION 'BACKUP_POLICY_VERSION_INVALID';
        END IF;
      END IF;
    WHEN 'BackupPolicyRun' THEN
      IF TG_OP = 'UPDATE' THEN
        IF (ROW(NEW."policyId", NEW."organizationId", NEW."projectId", NEW."environmentId", NEW."resourceId", NEW."scheduledAtUtc", NEW."policyVersion", NEW."policySnapshot", NEW."protocolVersion", NEW."createdAt") IS DISTINCT FROM ROW(OLD."policyId", OLD."organizationId", OLD."projectId", OLD."environmentId", OLD."resourceId", OLD."scheduledAtUtc", OLD."policyVersion", OLD."policySnapshot", OLD."protocolVersion", OLD."createdAt") OR NEW."leaseGeneration" < OLD."leaseGeneration" OR (ROW(NEW."workerId", NEW."leaseToken") IS DISTINCT FROM ROW(OLD."workerId", OLD."leaseToken") AND NEW."leaseGeneration" <> OLD."leaseGeneration" + 1)) THEN
          RAISE EXCEPTION 'BACKUP_POLICY_OCCURRENCE_IMMUTABLE';
        END IF;
      END IF;
    WHEN 'ResourceBackup' THEN
      IF TG_OP = 'UPDATE' THEN
        IF ROW(NEW."origin", NEW."policyId", NEW."policyRunId", NEW."policyVersion", NEW."scheduledAtUtc", NEW."policySnapshot", NEW."environmentId") IS DISTINCT FROM ROW(OLD."origin", OLD."policyId", OLD."policyRunId", OLD."policyVersion", OLD."scheduledAtUtc", OLD."policySnapshot", OLD."environmentId") THEN
          RAISE EXCEPTION 'BACKUP_ORIGIN_IMMUTABLE';
        END IF;
      END IF;
      IF TG_OP <> 'DELETE' THEN
        IF NEW."origin" = 'scheduled' AND NOT EXISTS (SELECT 1 FROM "BackupPolicyRun" run WHERE run."id" = NEW."policyRunId" AND run."policyId" = NEW."policyId" AND run."policyVersion" = NEW."policyVersion" AND run."projectId" = NEW."projectId" AND run."environmentId" = NEW."environmentId" AND run."resourceId" = NEW."resourceId" AND run."scheduledAtUtc" = NEW."scheduledAtUtc" AND run."policySnapshot" = NEW."policySnapshot") THEN
          RAISE EXCEPTION 'BACKUP_POLICY_OCCURRENCE_INVALID';
        END IF;
      END IF;
    WHEN 'ObjectUploadReservation' THEN
      IF TG_OP = 'UPDATE' THEN
        IF (ROW(NEW."projectId", NEW."environmentId", NEW."resourceId", NEW."providerEndpointRef", NEW."operationKind", NEW."objectKey", NEW."objectGeneration", NEW."credentialGeneration", NEW."multipartUploadId", NEW."partNumber", NEW."checksumSha256", NEW."expectedBytes", NEW."requestIdempotencyKey", NEW."requestFingerprint", NEW."protocolVersion", NEW."createdAt") IS DISTINCT FROM ROW(OLD."projectId", OLD."environmentId", OLD."resourceId", OLD."providerEndpointRef", OLD."operationKind", OLD."objectKey", OLD."objectGeneration", OLD."credentialGeneration", OLD."multipartUploadId", OLD."partNumber", OLD."checksumSha256", OLD."expectedBytes", OLD."requestIdempotencyKey", OLD."requestFingerprint", OLD."protocolVersion", OLD."createdAt") OR NEW."leaseGeneration" < OLD."leaseGeneration" OR (ROW(NEW."workerId", NEW."leaseToken") IS DISTINCT FROM ROW(OLD."workerId", OLD."leaseToken") AND NEW."leaseGeneration" <> OLD."leaseGeneration" + 1)) THEN
          RAISE EXCEPTION 'OBJECT_UPLOAD_RESERVATION_IMMUTABLE';
        END IF;
      END IF;
    WHEN 'ObjectStorageObject' THEN
      IF TG_OP = 'UPDATE' THEN
        IF (ROW(NEW."projectId", NEW."environmentId", NEW."resourceId", NEW."objectKey", NEW."createdAt") IS DISTINCT FROM ROW(OLD."projectId", OLD."environmentId", OLD."resourceId", OLD."objectKey", OLD."createdAt") OR NEW."generation" < OLD."generation") THEN
          RAISE EXCEPTION 'OBJECT_LEDGER_FENCE_INVALID';
        END IF;
      END IF;
    WHEN 'ObjectMultipartUpload' THEN
      IF TG_OP = 'UPDATE' THEN
        IF (ROW(NEW."projectId", NEW."environmentId", NEW."resourceId", NEW."objectKey", NEW."providerUploadId", NEW."destinationGeneration", NEW."credentialGeneration", NEW."requestIdempotencyKey", NEW."requestFingerprint", NEW."createdAt") IS DISTINCT FROM ROW(OLD."projectId", OLD."environmentId", OLD."resourceId", OLD."objectKey", OLD."providerUploadId", OLD."destinationGeneration", OLD."credentialGeneration", OLD."requestIdempotencyKey", OLD."requestFingerprint", OLD."createdAt") OR NEW."leaseGeneration" < OLD."leaseGeneration") THEN
          RAISE EXCEPTION 'OBJECT_MULTIPART_FENCE_INVALID';
        END IF;
      END IF;
    WHEN 'ObjectMultipartPart' THEN
      IF TG_OP = 'UPDATE' THEN
        IF ROW(NEW."uploadId", NEW."providerUploadId", NEW."partNumber", NEW."reservationId", NEW."sizeBytes", NEW."checksumSha256", NEW."etag", NEW."createdAt") IS DISTINCT FROM ROW(OLD."uploadId", OLD."providerUploadId", OLD."partNumber", OLD."reservationId", OLD."sizeBytes", OLD."checksumSha256", OLD."etag", OLD."createdAt") THEN
          RAISE EXCEPTION 'OBJECT_MULTIPART_PART_IMMUTABLE';
        END IF;
      END IF;
    ELSE
      NULL;
  END CASE;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
