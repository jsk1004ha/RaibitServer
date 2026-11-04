-- PostgreSQL resets a transaction-local custom setting to an empty string on
-- reused connections. Treat that value like an unset legacy protocol setting.
CREATE OR REPLACE FUNCTION raibit_service_binding_required() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'Service' THEN
    IF NOT EXISTS (SELECT 1 FROM "Service" service WHERE service."id" = NEW."id") THEN RETURN NEW; END IF;
    IF TG_OP = 'INSERT' AND COALESCE(NULLIF(current_setting('raibitserver.operational_protocol', true), ''), '1') = '1'
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

CREATE OR REPLACE FUNCTION raibit_resource_binding_required() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'Resource' THEN
    IF NOT EXISTS (SELECT 1 FROM "Resource" resource WHERE resource."id" = NEW."id") THEN RETURN NEW; END IF;
    IF TG_OP = 'INSERT' AND COALESCE(NULLIF(current_setting('raibitserver.operational_protocol', true), ''), '1') = '1'
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
