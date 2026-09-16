ALTER TABLE "ResourceBackup"
  ADD COLUMN "formatVersion" INTEGER,
  ADD COLUMN "organizationId" TEXT,
  ADD COLUMN "projectId" TEXT,
  ADD COLUMN "engine" TEXT,
  ADD COLUMN "provider" TEXT,
  ADD COLUMN "sourceGeneration" TEXT,
  ADD COLUMN "sourceProvenance" JSONB,
  ADD COLUMN "sourceSpec" JSONB,
  ADD COLUMN "requestedByUserId" TEXT,
  ADD COLUMN "requestIdempotencyKey" TEXT,
  ADD COLUMN "requestFingerprint" TEXT,
  ADD COLUMN "artifactKey" TEXT,
  ADD COLUMN "artifactChecksum" TEXT,
  ADD COLUMN "artifactSize" BIGINT,
  ADD COLUMN "encryptionKeyVersion" TEXT,
  ADD COLUMN "winningAttempt" INTEGER,
  ADD COLUMN "startedAt" TIMESTAMP(3),
  ADD COLUMN "deadlineAt" TIMESTAMP(3),
  ADD COLUMN "readyAt" TIMESTAMP(3),
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3),
  ADD COLUMN "errorCode" TEXT,
  ADD COLUMN "cleanupToken" TEXT,
  ADD COLUMN "cleanupWorker" TEXT,
  ADD COLUMN "cleanupLeaseUntil" TIMESTAMP(3);

ALTER TABLE "ResourceBackup" ADD CONSTRAINT "ResourceBackup_format_complete" CHECK (
  "formatVersion" IS NULL OR (
    "formatVersion" = 1 AND "organizationId" IS NOT NULL AND "projectId" IS NOT NULL
    AND "engine" IS NOT NULL AND "provider" IS NOT NULL AND "sourceGeneration" ~ '^resource-incarnation/v1:sha256:[0-9a-f]{64}$'
    AND "sourceGeneration" IS NOT NULL AND "sourceProvenance" IS NOT NULL AND "sourceSpec" IS NOT NULL
    AND "requestedByUserId" IS NOT NULL AND "requestIdempotencyKey" IS NOT NULL
    AND "requestFingerprint" IS NOT NULL AND "updatedAt" IS NOT NULL
    AND status IN ('QUEUED','RUNNING','VERIFYING','READY','FAILED','EXPIRED','DELETING','DELETED')));
ALTER TABLE "ResourceBackup" ADD CONSTRAINT "ResourceBackup_ready_complete" CHECK (
  "formatVersion" IS NULL OR status NOT IN ('READY','EXPIRED') OR (
    "artifactKey" IS NOT NULL AND "artifactChecksum" ~ '^[0-9a-f]{64}$' AND "artifactChecksum" IS NOT NULL
    AND "artifactSize" BETWEEN 1 AND 10737418240 AND "artifactSize" IS NOT NULL
    AND "encryptionKeyVersion" IS NOT NULL AND "winningAttempt" BETWEEN 1 AND 3 AND "winningAttempt" IS NOT NULL
    AND "readyAt" IS NOT NULL AND "expiresAt" = "readyAt" + INTERVAL '30 days' AND "expiresAt" IS NOT NULL));
CREATE UNIQUE INDEX "ResourceBackup_replay_key" ON "ResourceBackup" ("organizationId","resourceId","requestIdempotencyKey");

CREATE TABLE "ResourceRestore" (
  id TEXT PRIMARY KEY,
  "formatVersion" INTEGER NOT NULL DEFAULT 1 CHECK ("formatVersion" = 1),
  "organizationId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "backupId" TEXT NOT NULL REFERENCES "ResourceBackup"(id) ON DELETE CASCADE,
  "sourceResourceId" TEXT NOT NULL,
  "targetResourceId" TEXT NOT NULL UNIQUE,
  engine TEXT NOT NULL,
  provider TEXT NOT NULL,
  "sourceGeneration" TEXT NOT NULL,
  "requestedByUserId" TEXT NOT NULL,
  "requestIdempotencyKey" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','VERIFYING','READY','FAILED','CANCELLED')),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "startedAt" TIMESTAMP(3),
  "deadlineAt" TIMESTAMP(3),
  "readyAt" TIMESTAMP(3),
  "errorCode" TEXT,
  "targetCleanedAt" TIMESTAMP(3),
  "cleanupToken" TEXT,
  "cleanupWorker" TEXT,
  "cleanupLeaseUntil" TIMESTAMP(3),
  UNIQUE ("organizationId","backupId","requestIdempotencyKey"),
  CHECK ("sourceResourceId" <> "targetResourceId")
);

CREATE TABLE "ResourceRecoveryPin" (
  id TEXT PRIMARY KEY,
  "resourceId" TEXT NOT NULL,
  "backupId" TEXT NOT NULL,
  "restoreId" TEXT UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('ARTIFACT_SOURCE','RESTORE_TARGET')),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("resourceId") REFERENCES "Resource"(id) ON DELETE RESTRICT,
  FOREIGN KEY ("backupId") REFERENCES "ResourceBackup"(id) ON DELETE RESTRICT,
  FOREIGN KEY ("restoreId") REFERENCES "ResourceRestore"(id) ON DELETE RESTRICT,
  CHECK ((kind = 'ARTIFACT_SOURCE' AND "restoreId" IS NULL) OR (kind = 'RESTORE_TARGET' AND "restoreId" IS NOT NULL))
);
CREATE UNIQUE INDEX "ResourceRecoveryPin_source" ON "ResourceRecoveryPin"("backupId") WHERE kind = 'ARTIFACT_SOURCE';
CREATE INDEX "ResourceRecoveryPin_resource" ON "ResourceRecoveryPin"("resourceId");

CREATE TABLE "ResourceRecoveryAttempt" (
  "backupId" TEXT NOT NULL REFERENCES "ResourceBackup"(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 3),
  "objectKey" TEXT NOT NULL UNIQUE,
  "uploadId" TEXT,
  "keyVersion" TEXT NOT NULL CHECK ("keyVersion" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  "firstClaimAt" TIMESTAMP(3) NOT NULL,
  "candidateStoredBytes" BIGINT,
  "candidatePlaintextBytes" BIGINT,
  "candidateChecksum" TEXT,
  state TEXT NOT NULL CHECK (state IN ('INTENT','UPLOADING','PREPARED','COMPLETE','VERIFIED','CLEANED')),
  "cleanupPending" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("backupId",attempt),
  CHECK (length("objectKey") <= 1024 AND ("uploadId" IS NULL OR length("uploadId") BETWEEN 1 AND 2048)),
  CHECK ((state = 'CLEANED') = NOT "cleanupPending")
  ,CHECK (("candidateStoredBytes" IS NULL AND "candidatePlaintextBytes" IS NULL AND "candidateChecksum" IS NULL) OR
    ("candidateStoredBytes" IS NOT NULL AND "candidateStoredBytes" BETWEEN 1 AND 10737418240 AND
     "candidatePlaintextBytes" IS NOT NULL AND "candidatePlaintextBytes" BETWEEN 0 AND 10737418240 AND
     "candidateChecksum" IS NOT NULL AND "candidateChecksum" ~ '^[0-9a-f]{64}$'))
  ,CHECK (state NOT IN ('PREPARED','COMPLETE','VERIFIED') OR "candidateStoredBytes" IS NOT NULL)
);

CREATE FUNCTION recovery_backup_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD."formatVersion" IS NOT NULL AND (OLD.status <> 'DELETED'
      OR EXISTS (SELECT 1 FROM "ResourceRecoveryAttempt" WHERE "backupId"=OLD.id AND ("cleanupPending" OR state<>'CLEANED'))
      OR EXISTS (SELECT 1 FROM "ResourceRecoveryPin" WHERE "backupId"=OLD.id)
      OR EXISTS (SELECT 1 FROM "WorkflowJob" WHERE "targetId"=OLD.id AND type='resource.backup' AND status IN ('queued','running'))) THEN RAISE EXCEPTION 'RECOVERY_CLEANUP_PENDING'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."formatVersion" IS NOT NULL THEN
    IF ROW(NEW."formatVersion",NEW."organizationId",NEW."projectId",NEW."resourceId",NEW.engine,NEW.provider,NEW."sourceGeneration",NEW."sourceProvenance",NEW."sourceSpec",NEW."requestedByUserId",NEW."requestIdempotencyKey",NEW."requestFingerprint") IS DISTINCT FROM
       ROW(OLD."formatVersion",OLD."organizationId",OLD."projectId",OLD."resourceId",OLD.engine,OLD.provider,OLD."sourceGeneration",OLD."sourceProvenance",OLD."sourceSpec",OLD."requestedByUserId",OLD."requestIdempotencyKey",OLD."requestFingerprint") THEN RAISE EXCEPTION 'RECOVERY_PROVENANCE_IMMUTABLE'; END IF;
    IF OLD."readyAt" IS NOT NULL AND ROW(NEW."artifactKey",NEW."artifactChecksum",NEW."artifactSize",NEW."encryptionKeyVersion",NEW."winningAttempt",NEW."readyAt",NEW."expiresAt") IS DISTINCT FROM ROW(OLD."artifactKey",OLD."artifactChecksum",OLD."artifactSize",OLD."encryptionKeyVersion",OLD."winningAttempt",OLD."readyAt",OLD."expiresAt") THEN RAISE EXCEPTION 'RECOVERY_ARTIFACT_IMMUTABLE'; END IF;
    IF OLD.status <> NEW.status AND NOT (
      (OLD.status = 'QUEUED' AND NEW.status IN ('RUNNING','FAILED')) OR
      (OLD.status = 'RUNNING' AND NEW.status IN ('VERIFYING','FAILED')) OR
      (OLD.status = 'VERIFYING' AND NEW.status IN ('READY','FAILED')) OR
      (OLD.status = 'READY' AND NEW.status IN ('EXPIRED','DELETING')) OR
      (OLD.status = 'FAILED' AND NEW.status = 'DELETING') OR
      (OLD.status = 'EXPIRED' AND NEW.status = 'DELETING') OR
      (OLD.status = 'DELETING' AND NEW.status IN ('DELETED','FAILED'))) THEN RAISE EXCEPTION 'RECOVERY_TRANSITION_INVALID'; END IF;
  END IF;
  IF NEW."formatVersion" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Resource" r JOIN "Project" p ON p.id=r."projectId" WHERE r.id=NEW."resourceId" AND p.id=NEW."projectId" AND p."organizationId"=NEW."organizationId" AND r.engine=NEW.engine AND r.provider=NEW.provider) THEN RAISE EXCEPTION 'RECOVERY_TENANT_INVALID'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ResourceBackup_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ResourceBackup" FOR EACH ROW EXECUTE FUNCTION recovery_backup_guard();

CREATE FUNCTION recovery_restore_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF NOT (OLD.status='READY' OR (OLD.status IN ('FAILED','CANCELLED') AND OLD."targetCleanedAt" IS NOT NULL))
      OR EXISTS (SELECT 1 FROM "WorkflowJob" WHERE "targetId"=OLD.id AND type='resource.restore' AND status IN ('queued','running')) THEN RAISE EXCEPTION 'RECOVERY_CLEANUP_PENDING'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW."formatVersion",NEW."organizationId",NEW."projectId",NEW."backupId",NEW."sourceResourceId",NEW."targetResourceId",NEW.engine,NEW.provider,NEW."sourceGeneration",NEW."requestedByUserId",NEW."requestIdempotencyKey",NEW."requestFingerprint") IS DISTINCT FROM ROW(OLD."formatVersion",OLD."organizationId",OLD."projectId",OLD."backupId",OLD."sourceResourceId",OLD."targetResourceId",OLD.engine,OLD.provider,OLD."sourceGeneration",OLD."requestedByUserId",OLD."requestIdempotencyKey",OLD."requestFingerprint") THEN RAISE EXCEPTION 'RECOVERY_PROVENANCE_IMMUTABLE'; END IF;
    IF OLD.status <> NEW.status AND NOT (
      (OLD.status = 'QUEUED' AND NEW.status IN ('RUNNING','FAILED','CANCELLED')) OR
      (OLD.status = 'RUNNING' AND NEW.status IN ('VERIFYING','FAILED','CANCELLED')) OR
      (OLD.status = 'VERIFYING' AND NEW.status IN ('READY','FAILED','CANCELLED'))) THEN RAISE EXCEPTION 'RECOVERY_TRANSITION_INVALID'; END IF;
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM "ResourceBackup" b JOIN "Resource" t ON t.id=NEW."targetResourceId" WHERE b.id=NEW."backupId" AND b."formatVersion"=1 AND b."organizationId"=NEW."organizationId" AND b."projectId"=NEW."projectId" AND b."resourceId"=NEW."sourceResourceId" AND b.engine=NEW.engine AND b.provider=NEW.provider AND b."sourceGeneration"=NEW."sourceGeneration" AND t."projectId"=b."projectId" AND t.engine=b.engine AND t.provider=b.provider) THEN RAISE EXCEPTION 'RECOVERY_TENANT_INVALID'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ResourceRestore_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ResourceRestore" FOR EACH ROW EXECUTE FUNCTION recovery_restore_guard();

CREATE FUNCTION recovery_pin_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind='ARTIFACT_SOURCE' AND NOT EXISTS (SELECT 1 FROM "ResourceBackup" WHERE id=NEW."backupId" AND "resourceId"=NEW."resourceId" AND "formatVersion"=1) THEN RAISE EXCEPTION 'RECOVERY_PIN_INVALID'; END IF;
  IF NEW.kind='RESTORE_TARGET' AND NOT EXISTS (SELECT 1 FROM "ResourceRestore" WHERE id=NEW."restoreId" AND "backupId"=NEW."backupId" AND "targetResourceId"=NEW."resourceId") THEN RAISE EXCEPTION 'RECOVERY_PIN_INVALID'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ResourceRecoveryPin_guard" BEFORE INSERT OR UPDATE ON "ResourceRecoveryPin" FOR EACH ROW EXECUTE FUNCTION recovery_pin_guard();

CREATE FUNCTION recovery_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND OLD."cleanupPending" THEN RAISE EXCEPTION 'RECOVERY_CLEANUP_PENDING'; END IF;
  IF TG_OP='UPDATE' AND (ROW(NEW."backupId",NEW.attempt,NEW."objectKey") IS DISTINCT FROM ROW(OLD."backupId",OLD.attempt,OLD."objectKey") OR (OLD."uploadId" IS NOT NULL AND NEW."uploadId" IS DISTINCT FROM OLD."uploadId")) THEN RAISE EXCEPTION 'RECOVERY_ATTEMPT_IMMUTABLE'; END IF;
  IF TG_OP='UPDATE' AND ROW(NEW."keyVersion",NEW."firstClaimAt") IS DISTINCT FROM ROW(OLD."keyVersion",OLD."firstClaimAt") THEN RAISE EXCEPTION 'RECOVERY_ATTEMPT_IMMUTABLE'; END IF;
  IF TG_OP='UPDATE' AND OLD."candidateStoredBytes" IS NOT NULL AND ROW(NEW."candidateStoredBytes",NEW."candidatePlaintextBytes",NEW."candidateChecksum") IS DISTINCT FROM ROW(OLD."candidateStoredBytes",OLD."candidatePlaintextBytes",OLD."candidateChecksum") THEN RAISE EXCEPTION 'RECOVERY_CANDIDATE_IMMUTABLE'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ResourceBackup" b WHERE b.id=NEW."backupId" AND b."startedAt"=NEW."firstClaimAt" AND NEW."objectKey"='organizations/'||b."organizationId"||'/resources/'||b."resourceId"||'/backups/'||b.id||'/attempts/'||NEW.attempt||'/artifact.v1') THEN RAISE EXCEPTION 'RECOVERY_OBJECT_KEY_INVALID'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ResourceRecoveryAttempt_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ResourceRecoveryAttempt" FOR EACH ROW EXECUTE FUNCTION recovery_attempt_guard();
