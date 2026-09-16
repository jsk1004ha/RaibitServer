CREATE TABLE "PreviewLineage" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL REFERENCES "Organization"("id") ON DELETE RESTRICT,
  "projectId" TEXT NOT NULL REFERENCES "Project"("id") ON DELETE RESTRICT,
  "serviceId" TEXT NOT NULL REFERENCES "Service"("id") ON DELETE RESTRICT,
  "integrationId" TEXT NOT NULL REFERENCES "GitHubIntegration"("id") ON DELETE RESTRICT,
  "installationId" TEXT NOT NULL,
  "repositoryId" TEXT NOT NULL,
  "repository" TEXT NOT NULL,
  "pullRequestNumber" INTEGER NOT NULL CHECK ("pullRequestNumber" > 0),
  "stableHost" TEXT NOT NULL UNIQUE,
  "namespace" TEXT NOT NULL,
  "routeName" TEXT NOT NULL,
  "state" TEXT NOT NULL CHECK ("state" IN ('OPEN','CLOSED','AMBIGUOUS')),
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
  "generation" INTEGER NOT NULL DEFAULT 0 CHECK ("generation" >= 0),
  "eventUpdatedAt" TIMESTAMP(3) NOT NULL,
  "eventAction" TEXT NOT NULL CHECK ("eventAction" IN ('opened','synchronize','reopened','closed','resolved')),
  "headSha" TEXT NOT NULL CHECK ("headSha" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  "headRef" TEXT NOT NULL,
  "baseRef" TEXT NOT NULL,
  "beforeSha" TEXT,
  "candidateDeploymentId" TEXT,
  "candidateGeneration" INTEGER,
  "currentDeploymentId" TEXT,
  "currentGeneration" INTEGER,
  "resolutionObservation" JSONB,
  "resolutionErrorCode" TEXT,
  "routeIntent" JSONB,
  "routeObserved" JSONB,
  "reconcileToken" TEXT,
  "reconcileWorker" TEXT,
  "reconcileLeaseUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PreviewLineage_identity" UNIQUE ("organizationId","projectId","serviceId","installationId","repositoryId","pullRequestNumber"),
  UNIQUE ("id","projectId","serviceId"),
  CHECK (("candidateDeploymentId" IS NULL) = ("candidateGeneration" IS NULL)),
  CHECK (("currentDeploymentId" IS NULL) = ("currentGeneration" IS NULL)),
  CHECK ("candidateGeneration" <= "generation" AND "currentGeneration" <= "generation"),
  CHECK ("installationId" ~ '^[1-9][0-9]{0,15}$' AND "repositoryId" ~ '^[1-9][0-9]{0,15}$'),
  CHECK (("reconcileToken" IS NULL) = ("reconcileWorker" IS NULL) AND ("reconcileToken" IS NULL) = ("reconcileLeaseUntil" IS NULL))
);
CREATE INDEX "PreviewLineage_state_updatedAt_idx" ON "PreviewLineage"("state","updatedAt");
ALTER TABLE "Deployment"
  ADD COLUMN "previewLineageId" TEXT,
  ADD COLUMN "previewGeneration" INTEGER,
  ADD COLUMN "previewRuntime" JSONB,
  ADD COLUMN "previewOwnedObjects" JSONB,
  ADD CONSTRAINT "Deployment_previewLineage_generation_key" UNIQUE ("previewLineageId","previewGeneration"),
  ADD CONSTRAINT "Deployment_preview_pointer_key" UNIQUE ("id","previewLineageId","previewGeneration"),
  ADD CONSTRAINT "Deployment_preview_tenant_fk" FOREIGN KEY ("previewLineageId","projectId","serviceId") REFERENCES "PreviewLineage"("id","projectId","serviceId") ON DELETE RESTRICT,
  ADD CONSTRAINT "Deployment_preview_identity_check" CHECK (
    ("previewLineageId" IS NULL AND "previewGeneration" IS NULL AND "previewRuntime" IS NULL AND "previewOwnedObjects" IS NULL)
    OR ("previewLineageId" IS NOT NULL AND "previewGeneration" > 0 AND LOWER("deploymentType") = 'preview'
      AND "previewRuntime" IS NOT NULL AND jsonb_typeof("previewRuntime") = 'object'
      AND "previewRuntime"->>'version' = '1' AND "previewRuntime"->>'lineageId' = "previewLineageId"
      AND "previewRuntime"->>'deploymentId' = "id" AND "previewRuntime"->>'generation' = "previewGeneration"::text) IS TRUE),
  ADD CONSTRAINT "Deployment_preview_inventory_check" CHECK ("previewOwnedObjects" IS NULL OR
    CASE WHEN jsonb_typeof("previewOwnedObjects") = 'array' THEN jsonb_array_length("previewOwnedObjects") <= 32 ELSE FALSE END);
ALTER TABLE "PreviewLineage"
  ADD CONSTRAINT "PreviewLineage_candidate_fk" FOREIGN KEY ("candidateDeploymentId","id","candidateGeneration") REFERENCES "Deployment"("id","previewLineageId","previewGeneration") ON DELETE RESTRICT,
  ADD CONSTRAINT "PreviewLineage_current_fk" FOREIGN KEY ("currentDeploymentId","id","currentGeneration") REFERENCES "Deployment"("id","previewLineageId","previewGeneration") ON DELETE RESTRICT;

CREATE FUNCTION raibit_preview_lineage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    ROW(NEW."id",NEW."organizationId",NEW."projectId",NEW."serviceId",NEW."integrationId",NEW."installationId",NEW."repositoryId",NEW."repository",NEW."pullRequestNumber",NEW."stableHost",NEW."namespace",NEW."routeName") IS DISTINCT FROM
    ROW(OLD."id",OLD."organizationId",OLD."projectId",OLD."serviceId",OLD."integrationId",OLD."installationId",OLD."repositoryId",OLD."repository",OLD."pullRequestNumber",OLD."stableHost",OLD."namespace",OLD."routeName")
    OR NEW."version" < OLD."version" OR NEW."generation" < OLD."generation" OR NEW."eventUpdatedAt" < OLD."eventUpdatedAt") THEN
    RAISE EXCEPTION 'PREVIEW_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Service" s JOIN "Project" p ON p."id" = s."projectId"
      JOIN "GitHubIntegration" i ON i."id" = NEW."integrationId"
      WHERE s."id" = NEW."serviceId" AND p."id" = NEW."projectId" AND p."organizationId" = NEW."organizationId"
      AND i."organizationId" = NEW."organizationId" AND i."installationId" = NEW."installationId") THEN
    RAISE EXCEPTION 'PREVIEW_TENANT_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PreviewLineage_guard" BEFORE INSERT OR UPDATE ON "PreviewLineage" FOR EACH ROW EXECUTE FUNCTION raibit_preview_lineage_guard();

CREATE FUNCTION raibit_preview_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."previewLineageId",NEW."previewGeneration",NEW."previewRuntime") IS DISTINCT FROM ROW(OLD."previewLineageId",OLD."previewGeneration",OLD."previewRuntime") THEN
    RAISE EXCEPTION 'PREVIEW_ATTEMPT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Deployment_preview_guard" BEFORE UPDATE ON "Deployment" FOR EACH ROW EXECUTE FUNCTION raibit_preview_attempt_guard();
