ALTER TABLE "Deployment" ADD COLUMN "environmentId" TEXT;
ALTER TABLE "PreviewLineage" ADD COLUMN "environmentId" TEXT;
ALTER TABLE "WorkflowJob" ADD COLUMN "environmentId" TEXT;
ALTER TABLE "EnvironmentService" ADD COLUMN "displayName" TEXT;
ALTER TABLE "EnvironmentResource" ADD COLUMN "displayName" TEXT;

UPDATE "Deployment" d
SET "environmentId" = binding."environmentId"
FROM "EnvironmentService" binding
WHERE binding."serviceId" = d."serviceId" AND binding."projectId" = d."projectId";

UPDATE "PreviewLineage" lineage
SET "environmentId" = binding."environmentId"
FROM "EnvironmentService" binding
WHERE binding."serviceId" = lineage."serviceId" AND binding."projectId" = lineage."projectId";

UPDATE "WorkflowJob" job
SET "environmentId" = CASE
  WHEN lower(job."targetType") = 'deployment' THEN (SELECT d."environmentId" FROM "Deployment" d WHERE d.id = job."targetId")
  WHEN lower(job."targetType") IN ('preview', 'preview-lineage', 'previewlineage') THEN (SELECT lineage."environmentId" FROM "PreviewLineage" lineage WHERE lineage.id = job."targetId")
  ELSE NULL
END;

ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_environmentId_projectId_fkey"
  FOREIGN KEY ("environmentId", "projectId") REFERENCES "Environment"(id, "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PreviewLineage" ADD CONSTRAINT "PreviewLineage_environmentId_projectId_fkey"
  FOREIGN KEY ("environmentId", "projectId") REFERENCES "Environment"(id, "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "Deployment_environmentId_createdAt_id_idx" ON "Deployment"("environmentId", "createdAt", id);
CREATE INDEX "PreviewLineage_environmentId_updatedAt_idx" ON "PreviewLineage"("environmentId", "updatedAt");
CREATE INDEX "WorkflowJob_environmentId_status_runAfter_idx" ON "WorkflowJob"("environmentId", status, "runAfter");

CREATE FUNCTION raibit_deployment_runtime_environment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
DECLARE
  bound_environment_id TEXT;
  bound_kind TEXT;
  requires_protocol_2 BOOLEAN := false;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."environmentId" IS DISTINCT FROM OLD."environmentId" THEN
    RAISE EXCEPTION 'deployment environment identity is immutable';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT binding."environmentId", CASE WHEN binding."projectId" = NEW."projectId" THEN environment.kind ELSE 'invalid' END INTO bound_environment_id, bound_kind
    FROM "EnvironmentService" binding
    JOIN "Environment" environment ON environment.id = binding."environmentId" AND environment."projectId" = binding."projectId"
    WHERE binding."serviceId" = NEW."serviceId";
    IF bound_kind = 'invalid' THEN RAISE EXCEPTION 'deployment service environment binding is malformed'; END IF;
    IF bound_environment_id IS NULL THEN
      bound_kind := 'prod';
      IF NEW."environmentId" IS NOT NULL THEN RAISE EXCEPTION 'deployment environment binding mismatch'; END IF;
    ELSE
      IF NEW."environmentId" IS NULL THEN NEW."environmentId" := bound_environment_id; END IF;
      IF NEW."environmentId" <> bound_environment_id THEN RAISE EXCEPTION 'deployment environment binding mismatch'; END IF;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW."environmentId" IS DISTINCT FROM OLD."environmentId" THEN RAISE EXCEPTION 'deployment environment identity is immutable'; END IF;
    requires_protocol_2 := requires_protocol_2 OR bound_kind = 'dev';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT binding."environmentId", CASE WHEN binding."projectId" = OLD."projectId" THEN environment.kind ELSE 'invalid' END INTO bound_environment_id, bound_kind
    FROM "EnvironmentService" binding
    JOIN "Environment" environment ON environment.id = binding."environmentId" AND environment."projectId" = binding."projectId"
    WHERE binding."serviceId" = OLD."serviceId";
    IF bound_kind = 'invalid' THEN RAISE EXCEPTION 'stored deployment service environment binding is malformed'; END IF;
    IF OLD."environmentId" IS DISTINCT FROM bound_environment_id THEN RAISE EXCEPTION 'stored deployment environment binding mismatch'; END IF;
    requires_protocol_2 := requires_protocol_2 OR bound_kind = 'dev';
  END IF;
  IF requires_protocol_2 AND COALESCE(current_setting('raibitserver.operational_protocol', true), '1') <> '2' THEN
    RAISE EXCEPTION 'protocol 2 is required for dev deployment mutation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
END $$;

CREATE FUNCTION raibit_preview_lineage_runtime_environment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
DECLARE
  bound_environment_id TEXT;
  bound_kind TEXT;
  requires_protocol_2 BOOLEAN := false;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."environmentId" IS DISTINCT FROM OLD."environmentId" THEN
    RAISE EXCEPTION 'preview environment identity is immutable';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT binding."environmentId", CASE WHEN binding."projectId" = NEW."projectId" THEN environment.kind ELSE 'invalid' END INTO bound_environment_id, bound_kind
    FROM "EnvironmentService" binding
    JOIN "Environment" environment ON environment.id = binding."environmentId" AND environment."projectId" = binding."projectId"
    WHERE binding."serviceId" = NEW."serviceId";
    IF bound_kind = 'invalid' THEN RAISE EXCEPTION 'preview service environment binding is malformed'; END IF;
    IF bound_environment_id IS NULL THEN
      bound_kind := 'prod';
      IF NEW."environmentId" IS NOT NULL THEN RAISE EXCEPTION 'preview environment binding mismatch'; END IF;
    ELSE
      IF NEW."environmentId" IS NULL THEN NEW."environmentId" := bound_environment_id; END IF;
      IF NEW."environmentId" <> bound_environment_id THEN RAISE EXCEPTION 'preview environment binding mismatch'; END IF;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW."environmentId" IS DISTINCT FROM OLD."environmentId" THEN RAISE EXCEPTION 'preview environment identity is immutable'; END IF;
    requires_protocol_2 := requires_protocol_2 OR bound_kind = 'dev';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT binding."environmentId", CASE WHEN binding."projectId" = OLD."projectId" THEN environment.kind ELSE 'invalid' END INTO bound_environment_id, bound_kind
    FROM "EnvironmentService" binding
    JOIN "Environment" environment ON environment.id = binding."environmentId" AND environment."projectId" = binding."projectId"
    WHERE binding."serviceId" = OLD."serviceId";
    IF bound_kind = 'invalid' THEN RAISE EXCEPTION 'stored preview service environment binding is malformed'; END IF;
    IF OLD."environmentId" IS DISTINCT FROM bound_environment_id THEN RAISE EXCEPTION 'stored preview environment binding mismatch'; END IF;
    requires_protocol_2 := requires_protocol_2 OR bound_kind = 'dev';
  END IF;
  IF requires_protocol_2 AND COALESCE(current_setting('raibitserver.operational_protocol', true), '1') <> '2' THEN
    RAISE EXCEPTION 'protocol 2 is required for dev preview mutation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
END $$;

CREATE FUNCTION raibit_workflow_job_runtime_environment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
DECLARE
  authoritative_environment_id TEXT;
  authoritative_kind TEXT;
  requires_protocol_2 BOOLEAN := false;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."environmentId" IS DISTINCT FROM OLD."environmentId" THEN
    RAISE EXCEPTION 'workflow job environment identity is immutable';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF lower(NEW."targetType") = 'deployment' THEN
      SELECT d."environmentId", environment.kind INTO authoritative_environment_id, authoritative_kind
      FROM "Deployment" d JOIN "Environment" environment ON environment.id = d."environmentId" AND environment."projectId" = d."projectId"
      WHERE d.id = NEW."targetId";
    ELSIF lower(NEW."targetType") IN ('preview', 'preview-lineage', 'previewlineage') THEN
      SELECT lineage."environmentId", environment.kind INTO authoritative_environment_id, authoritative_kind
      FROM "PreviewLineage" lineage JOIN "Environment" environment ON environment.id = lineage."environmentId" AND environment."projectId" = lineage."projectId"
      WHERE lineage.id = NEW."targetId";
    END IF;
    IF authoritative_environment_id IS NOT NULL THEN
      IF NEW."environmentId" IS NULL THEN NEW."environmentId" := authoritative_environment_id; END IF;
      IF NEW."environmentId" <> authoritative_environment_id THEN RAISE EXCEPTION 'workflow job environment binding mismatch'; END IF;
      IF TG_OP = 'UPDATE' AND NEW."environmentId" IS DISTINCT FROM OLD."environmentId" THEN RAISE EXCEPTION 'workflow job environment identity is immutable'; END IF;
    END IF;
    IF authoritative_kind = 'dev' AND NEW."operationalProtocolVersion" <> 2 THEN
      RAISE EXCEPTION 'protocol 2 job is required for dev workflow mutation';
    END IF;
    requires_protocol_2 := requires_protocol_2 OR authoritative_kind = 'dev';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    authoritative_environment_id := NULL;
    authoritative_kind := NULL;
    IF lower(OLD."targetType") = 'deployment' THEN
      SELECT d."environmentId", environment.kind INTO authoritative_environment_id, authoritative_kind
      FROM "Deployment" d JOIN "Environment" environment ON environment.id = d."environmentId" AND environment."projectId" = d."projectId"
      WHERE d.id = OLD."targetId";
    ELSIF lower(OLD."targetType") IN ('preview', 'preview-lineage', 'previewlineage') THEN
      SELECT lineage."environmentId", environment.kind INTO authoritative_environment_id, authoritative_kind
      FROM "PreviewLineage" lineage JOIN "Environment" environment ON environment.id = lineage."environmentId" AND environment."projectId" = lineage."projectId"
      WHERE lineage.id = OLD."targetId";
    END IF;
    IF authoritative_environment_id IS NOT NULL AND OLD."environmentId" IS DISTINCT FROM authoritative_environment_id THEN
      RAISE EXCEPTION 'stored workflow job environment binding mismatch';
    END IF;
    requires_protocol_2 := requires_protocol_2 OR authoritative_kind = 'dev';
  END IF;
  IF requires_protocol_2 AND COALESCE(current_setting('raibitserver.operational_protocol', true), '1') <> '2' THEN
    RAISE EXCEPTION 'protocol 2 is required for dev workflow mutation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
END $$;

CREATE TRIGGER "Deployment_runtime_environment_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Deployment"
FOR EACH ROW EXECUTE FUNCTION raibit_deployment_runtime_environment_guard();
CREATE TRIGGER "PreviewLineage_runtime_environment_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PreviewLineage"
FOR EACH ROW EXECUTE FUNCTION raibit_preview_lineage_runtime_environment_guard();
CREATE TRIGGER "WorkflowJob_runtime_environment_guard" BEFORE INSERT OR UPDATE OR DELETE ON "WorkflowJob"
FOR EACH ROW EXECUTE FUNCTION raibit_workflow_job_runtime_environment_guard();
