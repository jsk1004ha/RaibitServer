package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

const claimResourceSQL = `
SELECT r.id, r."projectId", p."organizationId", p.slug, r.name, r.slug, r.type, r.engine,
       r.provider, r.plan, r.region, r.version, r.status, r."connectionSecretName", r."desiredSpec", r."desiredState"
FROM "Resource" r
JOIN "Project" p ON p.id = r."projectId"
WHERE UPPER(p.status) NOT IN ('DELETE_REQUESTED', 'DELETING')
	AND p."deletionRequestedAt" IS NULL
	AND r."deletionRequestedAt" IS NULL
  AND r."desiredState"->>'recoveryPrepared' IS DISTINCT FROM 'true'
  AND r."desiredState"->'resourceExecution'->>'intent' = 'live-provision'
  AND r."desiredState"->'resourceExecution'->>'environment' = $5
  AND ($6::jsonb ->> LOWER(r.engine)) IS NOT NULL
  AND r."desiredState"->'resourceExecution'->>'image' = ($6::jsonb ->> LOWER(r.engine))
  AND ((UPPER(r.status) = $1 AND (
        $4::numeric <= 0
        OR NOT (COALESCE(r."desiredState", '{}'::jsonb) ? 'lastDryRunAt')
        OR EXTRACT(EPOCH FROM r."updatedAt") * 1000 <= EXTRACT(EPOCH FROM clock_timestamp()) * 1000 - $4::numeric
      ))
   OR (UPPER(r.status) = $2 AND COALESCE(
        CASE WHEN jsonb_typeof(r."desiredState"->'claimHeartbeatUnixMs') = 'number'
             THEN (r."desiredState"->>'claimHeartbeatUnixMs')::numeric END,
        EXTRACT(EPOCH FROM r."updatedAt") * 1000
      ) <= EXTRACT(EPOCH FROM clock_timestamp()) * 1000 - $3::numeric))
ORDER BY r."updatedAt" ASC, r."createdAt" ASC, r.id ASC
FOR UPDATE OF r SKIP LOCKED
LIMIT 1`

const claimReadyResourceSQL = `
SELECT r.id, r."projectId", p."organizationId", p.slug, r.name, r.slug, r.type, r.engine,
       r.provider, r.plan, r.region, r.version, r.status, r."connectionSecretName", r."desiredSpec", r."desiredState"
FROM "Resource" r
JOIN "Project" p ON p.id = r."projectId"
WHERE (UPPER(r.status) = 'READY'
   OR (UPPER(r.status) = 'FAILED'
       AND r."desiredState"->>'healthManaged' = 'true'
       AND r."connectionSecretName" IS NOT NULL))
  AND r."updatedAt" <= (clock_timestamp() AT TIME ZONE 'UTC') - ($1::bigint * interval '1 millisecond')
  AND UPPER(p.status) NOT IN ('DELETE_REQUESTED', 'DELETING')
  AND p."deletionRequestedAt" IS NULL
  AND r."deletionRequestedAt" IS NULL
  AND r."desiredState"->>'recoveryPublicationBlocked' IS DISTINCT FROM 'true'
  AND NOT EXISTS (SELECT 1 FROM "ResourceRecoveryPin" pin WHERE pin."resourceId"=r.id AND pin.kind='RESTORE_TARGET')
ORDER BY r."updatedAt" ASC, r.id ASC
FOR UPDATE OF r SKIP LOCKED
LIMIT 1`

const claimResourceDeletionSQL = `
SELECT r.id, r."projectId", p."organizationId", p.slug, r.name, r.slug, r.type, r.engine,
       r.provider, r.plan, r.region, r.version, r.status, r."connectionSecretName", r."desiredSpec", r."desiredState"
FROM "Resource" r
JOIN "Project" p ON p.id = r."projectId"
WHERE NOT EXISTS (SELECT 1 FROM "ResourceRecoveryPin" pin WHERE pin."resourceId"=r.id)
 AND ((UPPER(r.status) = $1 AND (
        $4::numeric <= 0
        OR NOT (COALESCE(r."desiredState", '{}'::jsonb) ? 'lastDryRunDeletionAt')
        OR EXTRACT(EPOCH FROM r."updatedAt") * 1000 <= EXTRACT(EPOCH FROM clock_timestamp()) * 1000 - $4::numeric
      ))
   OR (UPPER(r.status) = $2 AND COALESCE(
        CASE WHEN jsonb_typeof(r."desiredState"->'claimHeartbeatUnixMs') = 'number'
             THEN (r."desiredState"->>'claimHeartbeatUnixMs')::numeric END,
        EXTRACT(EPOCH FROM r."updatedAt") * 1000
      ) <= EXTRACT(EPOCH FROM clock_timestamp()) * 1000 - $3::numeric))
ORDER BY r."updatedAt" ASC, r."createdAt" ASC, r.id ASC
FOR UPDATE OF r SKIP LOCKED
LIMIT 1`

const claimResourceDeletionUpdateSQL = `
UPDATE "Resource"
SET status = $1,
    "updatedAt" = clock_timestamp() AT TIME ZONE 'UTC',
    "desiredState" = COALESCE("desiredState", '{}'::jsonb) - 'claimHeartbeatUnixMs'
WHERE id = $2 AND UPPER(status) = $3
  AND NOT EXISTS (SELECT 1 FROM "ResourceRecoveryPin" pin WHERE pin."resourceId"=$2)
RETURNING "updatedAt"`

const claimResourceUpdateSQL = `
UPDATE "Resource"
SET status = $1,
    "updatedAt" = clock_timestamp() AT TIME ZONE 'UTC',
    "desiredState" = COALESCE("desiredState", '{}'::jsonb) - 'claimHeartbeatUnixMs'
WHERE id = $2
  AND UPPER(status) = $3
  AND "deletionRequestedAt" IS NULL
RETURNING "updatedAt"`

const finalizeResourceDeletionSQL = `
WITH locked AS (
  SELECT id FROM "Resource"
  WHERE id = $1 AND status = 'DELETING' AND "updatedAt" = $2
    AND NOT EXISTS (SELECT 1 FROM "ResourceRecoveryPin" pin WHERE pin."resourceId"=$1)
  FOR UPDATE
), removed_attachments AS (
  DELETE FROM "ResourceAttachment" WHERE "resourceId" IN (SELECT id FROM locked)
), removed_provider_secrets AS (
  DELETE FROM "SecretValue"
  WHERE "scopeType" = 'resource-provider-connection' AND "scopeId" IN (SELECT id FROM locked)
)
DELETE FROM "Resource"
WHERE id IN (SELECT id FROM locked)
RETURNING id`

const markResourceReadySQL = `
UPDATE "Resource" r
SET status = 'READY', provider = $1, "connectionSecretName" = $2,
    "desiredState" = $3, "updatedAt" = clock_timestamp() AT TIME ZONE 'UTC'
FROM "Project" p
WHERE r.id = $4
  AND r."projectId" = p.id
  AND r.status = 'RECONCILING'
  AND r."updatedAt" = $5
  AND r."deletionRequestedAt" IS NULL
  AND p."deletionRequestedAt" IS NULL
  AND UPPER(p.status) NOT IN ('DELETE_REQUESTED', 'DELETING')
RETURNING r.id`

const transitionResourceSQL = `
UPDATE "Resource"
SET status = $1, "desiredState" = $2,
    "updatedAt" = clock_timestamp() AT TIME ZONE 'UTC'
WHERE id = $3
  AND status = $4
  AND "updatedAt" = $5`

const renewResourceClaimSQL = `
UPDATE "Resource"
SET "desiredState" = jsonb_set(
      COALESCE("desiredState", '{}'::jsonb),
      '{claimHeartbeatUnixMs}',
      to_jsonb(floor(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint),
      true
    )
WHERE id = $1
  AND status = $2
  AND "updatedAt" = $3
  AND ($2 <> 'DELETING' OR NOT EXISTS (SELECT 1 FROM "ResourceRecoveryPin" pin WHERE pin."resourceId"=$1))
RETURNING id`

const persistProviderIdentitySQL = `
UPDATE "Resource"
SET "desiredState" = jsonb_set(
      jsonb_set(
        COALESCE("desiredState", '{}'::jsonb),
        '{providerIdentity}',
        $1::jsonb,
        true
      ),
      '{claimHeartbeatUnixMs}',
      to_jsonb(floor(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint),
      true
    )
WHERE id = $2
  AND status = $3
  AND "updatedAt" = $4
  AND (
    NOT (COALESCE("desiredState", '{}'::jsonb) ? 'providerIdentity')
    OR "desiredState"->'providerIdentity' = $1::jsonb
  )
RETURNING id`

const reserveCredentialSecretGenerationSQL = `
UPDATE "Resource"
SET "desiredState" = jsonb_set(
      jsonb_set(
        COALESCE("desiredState", '{}'::jsonb),
        '{credentialSecretGeneration}',
        to_jsonb($1::text),
        true
      ),
      '{claimHeartbeatUnixMs}',
      to_jsonb(floor(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint),
      true
    )
WHERE id = $2
  AND status = $3
  AND "updatedAt" = $4
  AND (
    NOT (COALESCE("desiredState", '{}'::jsonb) ? 'credentialSecretGeneration')
    OR "desiredState"->>'credentialSecretGeneration' = $1
  )
RETURNING id`

const persistCredentialSecretUIDSQL = `
UPDATE "Resource"
SET "desiredState" = jsonb_set(
      jsonb_set(
        COALESCE("desiredState", '{}'::jsonb),
        '{credentialSecretUID}',
        to_jsonb($1::text),
        true
      ),
      '{claimHeartbeatUnixMs}',
      to_jsonb(floor(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint),
      true
    )
WHERE id = $2
  AND status = $3
  AND "updatedAt" = $4
  AND (
    NOT (COALESCE("desiredState", '{}'::jsonb) ? 'credentialSecretUID')
    OR "desiredState"->>'credentialSecretUID' = $1
  )
RETURNING id`

type PostgresStore struct {
	db                  *sql.DB
	resourceEnvironment string
	resourceImages      map[string]string
}

func (s *PostgresStore) ConfigureResourceClaims(environment string, images map[string]string) {
	s.resourceEnvironment = environment
	s.resourceImages = make(map[string]string, len(images))
	for engine, image := range images {
		s.resourceImages[engine] = image
	}
}

func OpenPostgresStore(ctx context.Context, dsn string) (*PostgresStore, func() error, error) {
	if strings.TrimSpace(dsn) == "" {
		return nil, nil, errors.New("PostgreSQL control-plane DSN is required")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, nil, err
	}
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, nil, fmt.Errorf("connect PostgreSQL control-plane store: %w", err)
	}
	return &PostgresStore{db: db}, db.Close, nil
}

func (s *PostgresStore) ClaimNextResourceDeletion(ctx context.Context, staleAfter, dryRunRecheck time.Duration) (*Resource, error) {
	if staleAfter <= 0 {
		staleAfter = 15 * time.Minute
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	resource, err := scanResource(tx.QueryRowContext(ctx, claimResourceDeletionSQL, StatusDeleteRequested, StatusDeleting, staleAfter.Milliseconds(), dryRunRecheck.Milliseconds()))
	if errors.Is(err, sql.ErrNoRows) {
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var claimTime time.Time
	err = tx.QueryRowContext(ctx, claimResourceDeletionUpdateSQL,
		StatusDeleting, resource.ID, strings.ToUpper(resource.Status)).Scan(&claimTime)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("resource %s deletion claim conflict", resource.ID)
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	resource.Status = StatusDeleting
	resource.ClaimToken = claimTime.Format(time.RFC3339Nano)
	delete(resource.DesiredState, "claimHeartbeatUnixMs")
	return resource, nil
}

func (s *PostgresStore) ClaimNextResource(ctx context.Context, staleAfter, dryRunRecheck time.Duration) (*Resource, error) {
	if s.resourceEnvironment != "local" && s.resourceEnvironment != "release" {
		return nil, errors.New("RESOURCE_CAPABILITY_UNAVAILABLE: RESOURCE_ENVIRONMENT_UNAVAILABLE")
	}
	images, err := json.Marshal(s.resourceImages)
	if err != nil {
		return nil, fmt.Errorf("encode resource claim images: %w", err)
	}
	if staleAfter <= 0 {
		staleAfter = 15 * time.Minute
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	resource, err := scanResource(tx.QueryRowContext(ctx, claimResourceSQL, StatusProvisioning, StatusReconciling, staleAfter.Milliseconds(), dryRunRecheck.Milliseconds(), s.resourceEnvironment, images))
	if errors.Is(err, sql.ErrNoRows) {
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var claimTime time.Time
	err = tx.QueryRowContext(ctx, claimResourceUpdateSQL,
		StatusReconciling, resource.ID, strings.ToUpper(resource.Status)).Scan(&claimTime)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("resource %s claim conflict", resource.ID)
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	resource.Status = StatusReconciling
	resource.ClaimToken = claimTime.Format(time.RFC3339Nano)
	delete(resource.DesiredState, "claimHeartbeatUnixMs")
	return resource, nil
}

func (s *PostgresStore) ClaimNextReadyResource(ctx context.Context, revalidateAfter time.Duration) (*Resource, error) {
	if revalidateAfter <= 0 {
		revalidateAfter = 5 * time.Minute
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	resource, err := scanResource(tx.QueryRowContext(ctx, claimReadyResourceSQL, revalidateAfter.Milliseconds()))
	if errors.Is(err, sql.ErrNoRows) {
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var claimTime time.Time
	err = tx.QueryRowContext(ctx, claimResourceUpdateSQL,
		StatusReconciling, resource.ID, strings.ToUpper(resource.Status)).Scan(&claimTime)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("resource %s health claim conflict", resource.ID)
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	resource.Status = StatusReconciling
	resource.ClaimToken = claimTime.Format(time.RFC3339Nano)
	delete(resource.DesiredState, "claimHeartbeatUnixMs")
	return resource, nil
}

func (s *PostgresStore) RenewResourceClaim(ctx context.Context, resource *Resource) error {
	claimedAt, status, err := activeClaim(resource)
	if err != nil {
		return err
	}
	var updatedID string
	err = s.db.QueryRowContext(ctx, renewResourceClaimSQL, resource.ID, status, claimedAt).Scan(&updatedID)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("resource %s claim renewal conflict", resource.ID)
	}
	return err
}

func (s *PostgresStore) PersistProviderIdentity(ctx context.Context, resource *Resource, namespace, name string) error {
	claimedAt, status, err := activeClaim(resource)
	if err != nil {
		return err
	}
	if status != StatusReconciling {
		return fmt.Errorf("provider object identity can only be persisted while %s", StatusReconciling)
	}
	namespace = strings.TrimSpace(namespace)
	name = strings.TrimSpace(name)
	if !kubernetesDNSLabelPattern.MatchString(namespace) || !kubernetesDNSLabelPattern.MatchString(name) {
		return errors.New("provider object identity is invalid")
	}
	identity := map[string]any{"namespace": namespace, "name": name}
	payload, err := json.Marshal(identity)
	if err != nil {
		return err
	}
	var updatedID string
	err = s.db.QueryRowContext(ctx, persistProviderIdentitySQL, string(payload), resource.ID, status, claimedAt).Scan(&updatedID)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("resource %s provider object identity persistence conflict", resource.ID)
	}
	if err == nil {
		resource.DesiredState = mergeMap(resource.DesiredState, map[string]any{"providerIdentity": identity})
	}
	return err
}

func (s *PostgresStore) PersistCredentialSecretUID(ctx context.Context, resource *Resource, uid string) error {
	claimedAt, status, err := activeClaim(resource)
	if err != nil {
		return err
	}
	if status != StatusReconciling {
		return fmt.Errorf("credential Secret identity can only be persisted while %s", StatusReconciling)
	}
	uid = strings.TrimSpace(uid)
	if !kubernetesUIDPattern.MatchString(uid) {
		return errors.New("credential Secret UID is invalid")
	}
	var updatedID string
	err = s.db.QueryRowContext(ctx, persistCredentialSecretUIDSQL, uid, resource.ID, status, claimedAt).Scan(&updatedID)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("resource %s credential identity persistence conflict", resource.ID)
	}
	if err == nil {
		resource.DesiredState = mergeMap(resource.DesiredState, map[string]any{"credentialSecretUID": uid})
	}
	return err
}

func (s *PostgresStore) ReserveCredentialSecretGeneration(ctx context.Context, resource *Resource, generation string) error {
	claimedAt, status, err := activeClaim(resource)
	if err != nil {
		return err
	}
	if status != StatusReconciling {
		return fmt.Errorf("credential Secret generation can only be reserved while %s", StatusReconciling)
	}
	generation = strings.TrimSpace(generation)
	if !credentialGenerationPattern.MatchString(generation) {
		return errors.New("credential Secret generation is invalid")
	}
	var updatedID string
	err = s.db.QueryRowContext(ctx, reserveCredentialSecretGenerationSQL, generation, resource.ID, status, claimedAt).Scan(&updatedID)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("resource %s credential generation reservation conflict", resource.ID)
	}
	if err == nil {
		resource.DesiredState = mergeMap(resource.DesiredState, map[string]any{"credentialSecretGeneration": generation})
	}
	return err
}

func activeClaim(resource *Resource) (time.Time, string, error) {
	if resource == nil || strings.TrimSpace(resource.ClaimToken) == "" {
		return time.Time{}, "", errors.New("resource operation requires a claim token")
	}
	claimedAt, err := time.Parse(time.RFC3339Nano, resource.ClaimToken)
	if err != nil {
		return time.Time{}, "", fmt.Errorf("invalid resource claim token: %w", err)
	}
	status := strings.ToUpper(strings.TrimSpace(resource.Status))
	if status != StatusReconciling && status != StatusDeleting {
		return time.Time{}, "", fmt.Errorf("resource claim status %q is not active", resource.Status)
	}
	return claimedAt, status, nil
}

func (s *PostgresStore) TransitionResource(ctx context.Context, resource *Resource, expectedStatus, nextStatus string, desiredState map[string]any) error {
	if resource == nil || strings.TrimSpace(resource.ClaimToken) == "" {
		return errors.New("resource status transition requires a claim token")
	}
	claimedAt, err := time.Parse(time.RFC3339Nano, resource.ClaimToken)
	if err != nil {
		return fmt.Errorf("invalid resource claim token: %w", err)
	}
	payload, err := json.Marshal(maskSecrets(desiredState))
	if err != nil {
		return err
	}
	result, err := s.db.ExecContext(ctx, transitionResourceSQL, nextStatus, payload, resource.ID, strings.ToUpper(expectedStatus), claimedAt)
	if err != nil {
		return err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if rows != 1 {
		return fmt.Errorf("resource %s status transition conflict: expected %s with active claim", resource.ID, expectedStatus)
	}
	return nil
}

func (s *PostgresStore) MarkResourceReady(ctx context.Context, resource *Resource, provider, secretName, endpoint string, secretKeys []string, desiredState map[string]any) error {
	if resource == nil || strings.TrimSpace(resource.ClaimToken) == "" {
		return errors.New("resource READY transition requires a claim token")
	}
	claimedAt, err := time.Parse(time.RFC3339Nano, resource.ClaimToken)
	if err != nil {
		return fmt.Errorf("invalid resource claim token: %w", err)
	}
	publicState := mergeMap(desiredState, map[string]any{
		"providerConnection": map[string]any{"secretName": secretName, "environmentKeys": secretKeys, "endpoint": endpoint},
	})
	payload, err := json.Marshal(maskSecrets(publicState))
	if err != nil {
		return err
	}
	prepared, err := s.publishOrdinaryResource(ctx, ordinaryPublication{resource.ID, claimedAt, provider, secretName, payload})
	if prepared && err == nil {
		return ErrRecoveryPrepared
	}
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("resource %s READY transition conflict: claim expired or deletion requested", resource.ID)
	}
	return err
}

func (s *PostgresStore) FinalizeResourceDeletion(ctx context.Context, resource *Resource) error {
	if resource == nil || strings.TrimSpace(resource.ClaimToken) == "" {
		return errors.New("resource deletion finalization requires a claim token")
	}
	claimedAt, err := time.Parse(time.RFC3339Nano, resource.ClaimToken)
	if err != nil {
		return fmt.Errorf("invalid resource deletion claim token: %w", err)
	}
	var deletedID string
	err = s.db.QueryRowContext(ctx, finalizeResourceDeletionSQL, resource.ID, claimedAt).Scan(&deletedID)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("resource %s deletion finalization conflict: claim expired or status is not %s", resource.ID, StatusDeleting)
	}
	return err
}

type scanner interface{ Scan(...any) error }

func scanResource(row scanner) (*Resource, error) {
	var resource Resource
	var version, connectionSecretName sql.NullString
	var desiredSpec, desiredState []byte
	err := row.Scan(&resource.ID, &resource.ProjectID, &resource.OrganizationID, &resource.ProjectSlug, &resource.Name, &resource.Slug,
		&resource.Type, &resource.Engine, &resource.Provider, &resource.Plan, &resource.Region, &version, &resource.Status, &connectionSecretName, &desiredSpec, &desiredState)
	if err != nil {
		return nil, err
	}
	if version.Valid {
		resource.Version = version.String
		resource.VersionPresent = true
	}
	if connectionSecretName.Valid {
		resource.ConnectionSecretName = connectionSecretName.String
	}
	resource.DesiredSpec = decodeMap(desiredSpec)
	resource.DesiredState = decodeMap(desiredState)
	return &resource, nil
}

func decodeMap(value []byte) map[string]any {
	var result map[string]any
	if len(value) == 0 || json.Unmarshal(value, &result) != nil {
		return map[string]any{}
	}
	return result
}

func maskSecrets(input any) any {
	switch typed := input.(type) {
	case string:
		redacted := secretAssignmentPattern.ReplaceAllString(typed, `$1****`)
		return knownTokenPattern.ReplaceAllString(redacted, `$1****`)
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, value := range typed {
			upper := strings.ToUpper(key)
			if safeSecretMetadataKey(key) {
				result[key] = maskSecrets(value)
			} else if strings.Contains(upper, "SECRET") || strings.Contains(upper, "PASSWORD") || strings.Contains(upper, "TOKEN") || strings.Contains(upper, "KEY") || strings.Contains(upper, "URL") || strings.Contains(upper, "URI") {
				result[key] = "****"
			} else {
				result[key] = maskSecrets(value)
			}
		}
		return result
	case []any:
		result := make([]any, len(typed))
		for i, value := range typed {
			result[i] = maskSecrets(value)
		}
		return result
	default:
		return typed
	}
}

func safeSecretMetadataKey(key string) bool {
	switch strings.ToLower(strings.TrimSpace(key)) {
	case "secretname", "connectionsecretname", "environmentkeys", "secretkeys", "credentialsecretuid", "credentialsecretgeneration":
		return true
	default:
		return false
	}
}

func mergeMap(current, updates map[string]any) map[string]any {
	result := make(map[string]any, len(current)+len(updates))
	for key, value := range current {
		result[key] = value
	}
	for key, value := range updates {
		result[key] = value
	}
	return result
}

var (
	secretAssignmentPattern     = regexp.MustCompile(`(?i)([A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|KEY|DATABASE_URL|MONGODB_URI|REDIS_URL)[A-Z0-9_]*=)([^\s]+)`)
	knownTokenPattern           = regexp.MustCompile(`(?i)(ghp_|github_pat_|glpat-|sk-[A-Za-z0-9_-]*|xox[baprs]-)[A-Za-z0-9_\-]+`)
	kubernetesUIDPattern        = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	credentialGenerationPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	kubernetesDNSLabelPattern   = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
)
