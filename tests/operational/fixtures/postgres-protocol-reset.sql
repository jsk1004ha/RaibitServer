-- Run once with psql ON_ERROR_STOP on a fully migrated, empty database and a
-- fresh connection. Keep this entire file in one session: SET LOCAL leaves an
-- empty custom setting behind after the surrounding transaction ends.
DO $$ BEGIN
  IF current_setting('raibitserver.operational_protocol', true) IS NOT NULL THEN
    RAISE EXCEPTION 'fixture requires a fresh session with an unset protocol';
  END IF;
END $$;

INSERT INTO "Organization" ("id", "name", "slug", "updatedAt")
VALUES ('org_reset', 'Protocol reset', 'protocol-reset', CURRENT_TIMESTAMP);

-- Given an untouched connection, legacy writers supply neither bindings nor a protocol.
INSERT INTO "Project" ("id", "organizationId", "name", "slug", "updatedAt")
VALUES ('project_reset_fresh', 'org_reset', 'Fresh', 'fresh', CURRENT_TIMESTAMP);
INSERT INTO "Service" ("id", "projectId", "name", "slug", "type", "sourceType", "updatedAt")
VALUES ('service_reset_fresh', 'project_reset_fresh', 'API', 'api', 'web', 'image', CURRENT_TIMESTAMP);
INSERT INTO "Resource" ("id", "projectId", "name", "slug", "type", "engine", "provider", "plan", "region", "updatedAt")
VALUES ('resource_reset_fresh', 'project_reset_fresh', 'DB', 'db', 'database', 'postgres', 'local', 'starter', 'local', CURRENT_TIMESTAMP);
DO $$ BEGIN
  IF current_setting('raibitserver.operational_protocol', true) IS NOT NULL THEN
    RAISE EXCEPTION 'legacy bridge changed the unset protocol';
  END IF;
END $$;

BEGIN;
SET LOCAL raibitserver.operational_protocol = '2';
COMMIT;
DO $$ BEGIN
  IF current_setting('raibitserver.operational_protocol', true) IS DISTINCT FROM '' THEN
    RAISE EXCEPTION 'SET LOCAL commit did not restore the empty protocol';
  END IF;
END $$;
INSERT INTO "Project" ("id", "organizationId", "name", "slug", "updatedAt")
VALUES ('project_reset_commit', 'org_reset', 'Commit', 'commit', CURRENT_TIMESTAMP);
INSERT INTO "Service" ("id", "projectId", "name", "slug", "type", "sourceType", "updatedAt")
VALUES ('service_reset_commit', 'project_reset_commit', 'API', 'api', 'web', 'image', CURRENT_TIMESTAMP);
INSERT INTO "Resource" ("id", "projectId", "name", "slug", "type", "engine", "provider", "plan", "region", "updatedAt")
VALUES ('resource_reset_commit', 'project_reset_commit', 'DB', 'db', 'database', 'postgres', 'local', 'starter', 'local', CURRENT_TIMESTAMP);

BEGIN;
SET LOCAL raibitserver.operational_protocol = '2';
ROLLBACK;
DO $$ BEGIN
  IF current_setting('raibitserver.operational_protocol', true) IS DISTINCT FROM '' THEN
    RAISE EXCEPTION 'SET LOCAL rollback did not restore the empty protocol';
  END IF;
END $$;
INSERT INTO "Project" ("id", "organizationId", "name", "slug", "updatedAt")
VALUES ('project_reset_rollback', 'org_reset', 'Rollback', 'rollback', CURRENT_TIMESTAMP);
INSERT INTO "Service" ("id", "projectId", "name", "slug", "type", "sourceType", "updatedAt")
VALUES ('service_reset_rollback', 'project_reset_rollback', 'API', 'api', 'web', 'image', CURRENT_TIMESTAMP);
INSERT INTO "Resource" ("id", "projectId", "name", "slug", "type", "engine", "provider", "plan", "region", "updatedAt")
VALUES ('resource_reset_rollback', 'project_reset_rollback', 'DB', 'db', 'database', 'postgres', 'local', 'starter', 'local', CURRENT_TIMESTAMP);

BEGIN;
SET LOCAL raibitserver.operational_protocol = '1';
INSERT INTO "Project" ("id", "organizationId", "name", "slug", "updatedAt")
VALUES ('project_reset_explicit', 'org_reset', 'Explicit', 'explicit', CURRENT_TIMESTAMP);
INSERT INTO "Service" ("id", "projectId", "name", "slug", "type", "sourceType", "updatedAt")
VALUES ('service_reset_explicit', 'project_reset_explicit', 'API', 'api', 'web', 'image', CURRENT_TIMESTAMP);
INSERT INTO "Resource" ("id", "projectId", "name", "slug", "type", "engine", "provider", "plan", "region", "updatedAt")
VALUES ('resource_reset_explicit', 'project_reset_explicit', 'DB', 'db', 'database', 'postgres', 'local', 'starter', 'local', CURRENT_TIMESTAMP);
SET CONSTRAINTS ALL IMMEDIATE;
DO $$ BEGIN
  IF current_setting('raibitserver.operational_protocol', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'legacy bridge changed explicit protocol 1';
  END IF;
END $$;
COMMIT;

-- Every positive case must create exactly the canonical prod binding and copy
-- the stored physical slug, without elevating the session.
DO $$
DECLARE scenario TEXT;
BEGIN
  FOREACH scenario IN ARRAY ARRAY['fresh', 'commit', 'rollback', 'explicit'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM "Environment" environment
      JOIN "EnvironmentService" binding ON binding."environmentId" = environment.id
      JOIN "Service" service ON service.id = binding."serviceId"
      WHERE environment.id = 'env_prod_project_reset_' || scenario
        AND environment."projectId" = 'project_reset_' || scenario AND environment.kind = 'prod'
        AND service.id = 'service_reset_' || scenario AND service."projectId" = environment."projectId"
        AND binding."projectId" = environment."projectId" AND binding."logicalSlug" = service.slug
    ) OR NOT EXISTS (
      SELECT 1 FROM "Environment" environment
      JOIN "EnvironmentResource" binding ON binding."environmentId" = environment.id
      JOIN "Resource" resource ON resource.id = binding."resourceId"
      WHERE environment.id = 'env_prod_project_reset_' || scenario
        AND environment."projectId" = 'project_reset_' || scenario AND environment.kind = 'prod'
        AND resource.id = 'resource_reset_' || scenario AND resource."projectId" = environment."projectId"
        AND binding."projectId" = environment."projectId" AND binding."logicalSlug" = resource.slug
    ) THEN
      RAISE EXCEPTION 'canonical legacy binding missing for %', scenario;
    END IF;
  END LOOP;
  IF current_setting('raibitserver.operational_protocol', true) IS DISTINCT FROM '' THEN
    RAISE EXCEPTION 'legacy writes leaked a protocol setting';
  END IF;
END $$;

-- Protocol 2 requires explicit bindings; unrecognized protocol 3 must not gain
-- the legacy bridge. Force deferred checks inside each rollbackable subtransaction.
DO $test$
DECLARE protocol TEXT; scenario RECORD; rejected_state TEXT; rejected_message TEXT;
BEGIN
  FOREACH protocol IN ARRAY ARRAY['2', '3'] LOOP
    PERFORM set_config('raibitserver.operational_protocol', protocol, true);
    FOR scenario IN SELECT * FROM (VALUES
      ('service', $sql$INSERT INTO "Service" ("id","projectId","name","slug","type","sourceType","updatedAt") VALUES ('service_reset_missing','project_reset_fresh','Missing','missing','web','image',CURRENT_TIMESTAMP)$sql$, 'ENVIRONMENT_SERVICE_BINDING_REQUIRED'),
      ('resource', $sql$INSERT INTO "Resource" ("id","projectId","name","slug","type","engine","provider","plan","region","updatedAt") VALUES ('resource_reset_missing','project_reset_fresh','Missing','missing','database','postgres','local','starter','local',CURRENT_TIMESTAMP)$sql$, 'ENVIRONMENT_RESOURCE_BINDING_REQUIRED')
    ) AS cases(label, command, expected) LOOP
      rejected_state := NULL;
      rejected_message := NULL;
      BEGIN
        EXECUTE scenario.command;
        SET CONSTRAINTS ALL IMMEDIATE;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS rejected_state = RETURNED_SQLSTATE, rejected_message = MESSAGE_TEXT;
      END;
      IF rejected_state IS DISTINCT FROM 'P0001' OR rejected_message IS DISTINCT FROM scenario.expected THEN
        RAISE EXCEPTION 'protocol % missing % binding: expected %, got % / %', protocol, scenario.label, scenario.expected, rejected_state, rejected_message;
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM "Service" WHERE id = 'service_reset_missing')
    OR EXISTS (SELECT 1 FROM "Resource" WHERE id = 'resource_reset_missing') THEN
    RAISE EXCEPTION 'rejected missing-binding insert persisted';
  END IF;
END $test$;

-- Valid protocol-2 dev rows are the source for the empty-session negative cases.
BEGIN;
SET LOCAL raibitserver.operational_protocol = '2';
INSERT INTO "Environment" ("id", "projectId", "kind", "updatedAt")
VALUES ('env_dev_reset', 'project_reset_fresh', 'dev', CURRENT_TIMESTAMP);
INSERT INTO "Service" ("id", "projectId", "name", "slug", "type", "sourceType", "updatedAt")
VALUES ('service_reset_dev', 'project_reset_fresh', 'Dev API', 'dev-api', 'web', 'image', CURRENT_TIMESTAMP);
INSERT INTO "Resource" ("id", "projectId", "name", "slug", "type", "engine", "provider", "plan", "region", "updatedAt")
VALUES ('resource_reset_dev', 'project_reset_fresh', 'Dev DB', 'dev-db', 'database', 'postgres', 'local', 'starter', 'local', CURRENT_TIMESTAMP);
INSERT INTO "EnvironmentService" ("serviceId", "environmentId", "projectId", "logicalSlug", "updatedAt")
VALUES ('service_reset_dev', 'env_dev_reset', 'project_reset_fresh', 'api', CURRENT_TIMESTAMP);
INSERT INTO "EnvironmentResource" ("resourceId", "environmentId", "projectId", "logicalSlug", "updatedAt")
VALUES ('resource_reset_dev', 'env_dev_reset', 'project_reset_fresh', 'db', CURRENT_TIMESTAMP);
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;

DO $test$
DECLARE scenario RECORD; rejected_state TEXT; rejected_message TEXT;
BEGIN
  IF current_setting('raibitserver.operational_protocol', true) IS DISTINCT FROM '' THEN
    RAISE EXCEPTION 'dev negative cases require the reset empty protocol';
  END IF;
  FOR scenario IN SELECT * FROM (VALUES
    ('dev service update', $sql$UPDATE "Service" SET "status"='READY' WHERE id='service_reset_dev'$sql$, 'OPERATIONAL_PROTOCOL_2_REQUIRED'),
    ('dev service delete', $sql$DELETE FROM "Service" WHERE id='service_reset_dev'$sql$, 'OPERATIONAL_PROTOCOL_2_REQUIRED'),
    ('dev resource update', $sql$UPDATE "Resource" SET "status"='READY' WHERE id='resource_reset_dev'$sql$, 'OPERATIONAL_PROTOCOL_2_REQUIRED'),
    ('dev resource delete', $sql$DELETE FROM "Resource" WHERE id='resource_reset_dev'$sql$, 'OPERATIONAL_PROTOCOL_2_REQUIRED'),
    ('dev service binding to prod', $sql$UPDATE "EnvironmentService" SET "environmentId"='env_prod_project_reset_fresh',"logicalSlug"='dev-api' WHERE "serviceId"='service_reset_dev'$sql$, 'OPERATIONAL_PROTOCOL_2_REQUIRED'),
    ('dev resource binding to prod', $sql$UPDATE "EnvironmentResource" SET "environmentId"='env_prod_project_reset_fresh',"logicalSlug"='dev-db' WHERE "resourceId"='resource_reset_dev'$sql$, 'OPERATIONAL_PROTOCOL_2_REQUIRED'),
    ('dev service binding delete', $sql$DELETE FROM "EnvironmentService" WHERE "serviceId"='service_reset_dev'$sql$, 'OPERATIONAL_PROTOCOL_2_REQUIRED'),
    ('dev resource binding delete', $sql$DELETE FROM "EnvironmentResource" WHERE "resourceId"='resource_reset_dev'$sql$, 'OPERATIONAL_PROTOCOL_2_REQUIRED'),
    ('existing prod service binding delete', $sql$DELETE FROM "EnvironmentService" WHERE "serviceId"='service_reset_fresh'$sql$, 'ENVIRONMENT_SERVICE_BINDING_REQUIRED'),
    ('existing prod resource binding delete', $sql$DELETE FROM "EnvironmentResource" WHERE "resourceId"='resource_reset_fresh'$sql$, 'ENVIRONMENT_RESOURCE_BINDING_REQUIRED')
  ) AS cases(label, command, expected) LOOP
    rejected_state := NULL;
    rejected_message := NULL;
    BEGIN
      EXECUTE scenario.command;
      SET CONSTRAINTS ALL IMMEDIATE;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS rejected_state = RETURNED_SQLSTATE, rejected_message = MESSAGE_TEXT;
    END;
    IF rejected_state IS DISTINCT FROM 'P0001' OR rejected_message IS DISTINCT FROM scenario.expected THEN
      RAISE EXCEPTION '%: expected %, got % / %', scenario.label, scenario.expected, rejected_state, rejected_message;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM "Service") <> 5 OR (SELECT count(*) FROM "Resource") <> 5
    OR (SELECT count(*) FROM "EnvironmentService") <> 5 OR (SELECT count(*) FROM "EnvironmentResource") <> 5
    OR (SELECT count(*) FROM "Environment") <> 5
    OR NOT EXISTS (SELECT 1 FROM "Service" WHERE id='service_reset_dev' AND status='CREATED')
    OR NOT EXISTS (SELECT 1 FROM "Resource" WHERE id='resource_reset_dev' AND status='PROVISIONING')
    OR NOT EXISTS (SELECT 1 FROM "EnvironmentService" WHERE "serviceId"='service_reset_dev' AND "environmentId"='env_dev_reset' AND "logicalSlug"='api')
    OR NOT EXISTS (SELECT 1 FROM "EnvironmentResource" WHERE "resourceId"='resource_reset_dev' AND "environmentId"='env_dev_reset' AND "logicalSlug"='db')
    OR NOT EXISTS (SELECT 1 FROM "EnvironmentService" WHERE "serviceId"='service_reset_fresh' AND "environmentId"='env_prod_project_reset_fresh' AND "logicalSlug"='api')
    OR NOT EXISTS (SELECT 1 FROM "EnvironmentResource" WHERE "resourceId"='resource_reset_fresh' AND "environmentId"='env_prod_project_reset_fresh' AND "logicalSlug"='db') THEN
    RAISE EXCEPTION 'negative cases changed the committed fixture rows';
  END IF;
  IF current_setting('raibitserver.operational_protocol', true) IS DISTINCT FROM '' THEN
    RAISE EXCEPTION 'negative cases changed the empty protocol';
  END IF;
END $test$;

SELECT 'PASS: fresh, committed-reset, rolled-back-reset, explicit-1 legacy bindings; 14 rejected mutations; dev bindings preserved' AS protocol_reset_regression;
