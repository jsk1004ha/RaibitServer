package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

const postgresDriverName = "pgx"

const claimDeploymentSQL = `
SELECT d.id, d."serviceId", d."projectId", d.status, d."deploymentType", d."triggerType", d.branch,
       d."commitSha", d."imageUrl", d."imageDigest", d."previewUrl", d."pullRequestNumber",
       d."reconcileAction", d."reconcileLockedBy", d."reconcileLockedAt", d."reconcileAttempts",
       d."desiredSpecSnapshot", d."snapshotVersion", d."sourceDeploymentId", d."retryOfDeploymentId",
       d."publicHealthStatus",d."healthCheckedAt",d."healthFailureCode",d."observedGeneration",
       d."previewLineageId",d."previewGeneration",d."previewRuntime",d."previewOwnedObjects"
FROM "Deployment" d
JOIN "Service" s ON s.id = d."serviceId"
JOIN "Project" p ON p.id = d."projectId"
WHERE (d.status IN ($1, $2, $3, $4)
   OR (d.status = $5 AND d."reconcileLockedAt" <= $6 AND d."reconcileAction" IN ($7, $8, $9)))
  AND UPPER(s.status) NOT IN ('DELETE_REQUESTED', 'DELETING', 'DELETED')
  AND UPPER(p.status) NOT IN ('DELETE_REQUESTED', 'DELETING', 'DELETED')
ORDER BY d."createdAt" ASC, d.id ASC
FOR UPDATE OF d SKIP LOCKED
LIMIT 1`

const claimServiceDeletionSQL = `
SELECT s.id, s."projectId", s.name, s.slug, s.type, s."imageUrl", s.port,
       s."desiredSpec", s."desiredState", s.status, s."deletionRequestedAt", s."updatedAt",
       s."healthCheckPath",s."livenessPath",s."readinessPath",s."publicHealthPath"
FROM "Service" s
WHERE s.status = 'DELETE_REQUESTED'
   OR (s.status = 'DELETING' AND s."updatedAt" <= $1)
ORDER BY s."deletionRequestedAt" ASC NULLS LAST, s."createdAt" ASC, s.id ASC
FOR UPDATE OF s SKIP LOCKED
LIMIT 1`

const claimProjectDeletionSQL = `
SELECT p.id, p."organizationId", p.name, p.slug, p.status, p."deletionRequestedAt", p."updatedAt"
FROM "Project" p
WHERE (p.status = 'DELETE_REQUESTED'
   OR (p.status = 'DELETING' AND p."updatedAt" <= $1))
  AND NOT EXISTS (SELECT 1 FROM "Service" s WHERE s."projectId" = p.id)
  AND NOT EXISTS (SELECT 1 FROM "Resource" r WHERE r."projectId" = p.id)
ORDER BY p."deletionRequestedAt" ASC NULLS LAST, p."createdAt" ASC, p.id ASC
FOR UPDATE OF p SKIP LOCKED
LIMIT 1`

const claimServiceDeletionLeaseSQL = `
UPDATE "Service"
SET status = $1, "updatedAt" = $2
WHERE id = $3 AND status = $4 AND "updatedAt" = $5
RETURNING "updatedAt"`

const claimProjectDeletionLeaseSQL = `
UPDATE "Project"
SET status = $1, "updatedAt" = $2
WHERE id = $3 AND status = $4 AND "updatedAt" = $5
  AND NOT EXISTS (SELECT 1 FROM "Service" s WHERE s."projectId" = "Project".id)
  AND NOT EXISTS (SELECT 1 FROM "Resource" r WHERE r."projectId" = "Project".id)
RETURNING "updatedAt"`

const finalizeServiceDeletionSQL = `
DELETE FROM "Service" s
WHERE s.id = $1 AND s.status = 'DELETING' AND s."updatedAt" = $2
  AND NOT EXISTS (
    SELECT 1 FROM "Deployment" d
    WHERE d."serviceId" = s.id
      AND (d."reconcileLockedBy" IS NOT NULL
        OR d.status NOT IN ('READY', 'FAILED', 'BUILD_FAILED', 'CANCELLED', 'CLEANED_UP'))
  )`

const finalizeProjectDeletionSQL = `
DELETE FROM "Project" p
WHERE p.id = $1 AND p.status = 'DELETING' AND p."updatedAt" = $2
  AND NOT EXISTS (SELECT 1 FROM "Service" s WHERE s."projectId" = p.id)
  AND NOT EXISTS (SELECT 1 FROM "Resource" r WHERE r."projectId" = p.id)`

const readyTransitionParentPredicate = `EXISTS (
  SELECT 1 FROM "Service" s
  JOIN "Project" p ON p.id = s."projectId"
  WHERE s.id = "Deployment"."serviceId"
    AND p.id = "Deployment"."projectId"
    AND UPPER(s.status) NOT IN ('DELETE_REQUESTED', 'DELETING', 'DELETED')
    AND UPPER(p.status) NOT IN ('DELETE_REQUESTED', 'DELETING', 'DELETED')
)`

const renewDeploymentLeaseSQL = `
UPDATE "Deployment"
SET "reconcileLockedAt" = $1, "updatedAt" = $1
WHERE id = $2 AND status = $3 AND "reconcileLockedBy" = $4
  AND "reconcileAttempts" = $5 AND "reconcileAction" = $6`

const transitionDeploymentLeasePredicate = `status = $%d AND "reconcileLockedBy" = $%d AND "reconcileAttempts" = $%d AND "reconcileAction" = $%d`

const getProjectSQL = `
SELECT p.id, p."organizationId", o.slug AS "organizationSlug", p.name, p.slug, p.status,
       p."deletionRequestedAt", p."updatedAt"
FROM "Project" p
JOIN "Organization" o ON o.id = p."organizationId"
WHERE p.id = $1`

type PostgresStore struct {
	db *sql.DB
}

func NewPostgresStore(db *sql.DB) *PostgresStore { return &PostgresStore{db: db} }

func OpenPostgresStore(ctx context.Context, dsn string) (*PostgresStore, func() error, error) {
	if strings.TrimSpace(dsn) == "" {
		return nil, nil, errors.New("PostgreSQL control-plane DSN is required")
	}
	db, err := sql.Open(postgresDriverName, dsn)
	if err != nil {
		return nil, nil, err
	}
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, nil, fmt.Errorf("connect PostgreSQL control-plane store: %w", err)
	}
	return NewPostgresStore(db), db.Close, nil
}

func (s *PostgresStore) ClaimNextServiceDeletion(ctx context.Context, options ClaimOptions) (*Service, error) {
	claimNow, lease := deletionClaimClock(options)
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	service, err := scanPostgresService(tx.QueryRowContext(ctx, claimServiceDeletionSQL, claimNow.Add(-lease)))
	if errors.Is(err, sql.ErrNoRows) {
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var claimedAt time.Time
	err = tx.QueryRowContext(ctx, claimServiceDeletionLeaseSQL,
		DeletionStatusDeleting, claimNow, service.ID, service.Status, service.UpdatedAt).Scan(&claimedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrDeletionLeaseLost
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	service.Status = DeletionStatusDeleting
	service.UpdatedAt = claimedAt
	return service, nil
}

func (s *PostgresStore) ClaimNextProjectDeletion(ctx context.Context, options ClaimOptions) (*Project, error) {
	claimNow, lease := deletionClaimClock(options)
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	project, err := scanPostgresProject(tx.QueryRowContext(ctx, claimProjectDeletionSQL, claimNow.Add(-lease)))
	if errors.Is(err, sql.ErrNoRows) {
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var claimedAt time.Time
	err = tx.QueryRowContext(ctx, claimProjectDeletionLeaseSQL,
		DeletionStatusDeleting, claimNow, project.ID, project.Status, project.UpdatedAt).Scan(&claimedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrDeletionLeaseLost
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	project.Status = DeletionStatusDeleting
	project.UpdatedAt = claimedAt
	return project, nil
}

func (s *PostgresStore) ReleaseServiceDeletion(ctx context.Context, lease DeletionLease) error {
	return s.releaseDeletion(ctx, "Service", lease)
}

func (s *PostgresStore) RenewServiceDeletionLease(ctx context.Context, lease DeletionLease, renewedAt time.Time) (DeletionLease, error) {
	return s.renewDeletionLease(ctx, "Service", lease, renewedAt)
}

func (s *PostgresStore) RenewProjectDeletionLease(ctx context.Context, lease DeletionLease, renewedAt time.Time) (DeletionLease, error) {
	return s.renewDeletionLease(ctx, "Project", lease, renewedAt)
}

func (s *PostgresStore) renewDeletionLease(ctx context.Context, table string, lease DeletionLease, renewedAt time.Time) (DeletionLease, error) {
	if err := ctx.Err(); err != nil {
		return lease, err
	}
	if table != "Service" && table != "Project" {
		return lease, errors.New("unsupported deletion lease table")
	}
	if renewedAt.IsZero() {
		renewedAt = time.Now().UTC()
	}
	query := `UPDATE "` + table + `" SET "updatedAt" = $1 WHERE id = $2 AND status = $3 AND "updatedAt" = $4 RETURNING "updatedAt"`
	var storedAt time.Time
	err := s.db.QueryRowContext(ctx, query, renewedAt.UTC(), lease.ID, DeletionStatusDeleting, lease.ClaimedAt).Scan(&storedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return lease, ErrDeletionLeaseLost
	}
	if err != nil {
		return lease, err
	}
	return DeletionLease{ID: lease.ID, ClaimedAt: storedAt}, nil
}

func (s *PostgresStore) ReleaseProjectDeletion(ctx context.Context, lease DeletionLease) error {
	return s.releaseDeletion(ctx, "Project", lease)
}

func (s *PostgresStore) releaseDeletion(ctx context.Context, table string, lease DeletionLease) error {
	if table != "Service" && table != "Project" {
		return errors.New("unsupported deletion lease table")
	}
	query := `UPDATE "` + table + `" SET status = $1, "updatedAt" = $2 WHERE id = $3 AND status = $4 AND "updatedAt" = $5`
	result, err := s.db.ExecContext(ctx, query, DeletionStatusDeleteRequested, time.Now().UTC(), lease.ID, DeletionStatusDeleting, lease.ClaimedAt)
	if err != nil {
		return err
	}
	return requireOneAffected(result, ErrDeletionLeaseLost)
}

func (s *PostgresStore) FinalizeServiceDeletion(ctx context.Context, lease DeletionLease) error {
	return s.finalizeHealthParent(ctx, lease, true)
}

func (s *PostgresStore) FinalizeProjectDeletion(ctx context.Context, lease DeletionLease) error {
	return s.finalizeHealthParent(ctx, lease, false)
}

func (s *PostgresStore) ParentsDeleting(ctx context.Context, projectID string, serviceID string) (bool, error) {
	var safe bool
	err := s.db.QueryRowContext(ctx, `
SELECT EXISTS (
  SELECT 1 FROM "Service" s
  JOIN "Project" p ON p.id = s."projectId"
  WHERE s.id = $1 AND p.id = $2
    AND UPPER(s.status) NOT IN ('DELETE_REQUESTED', 'DELETING', 'DELETED')
    AND UPPER(p.status) NOT IN ('DELETE_REQUESTED', 'DELETING', 'DELETED')
)`, serviceID, projectID).Scan(&safe)
	return !safe, err
}

func (s *PostgresStore) ClaimNextDeployment(ctx context.Context, options ClaimOptions) (*Deployment, error) {
	claimNow := options.Now
	if claimNow.IsZero() {
		claimNow = time.Now().UTC()
	}
	staleAfter := options.Lease
	if staleAfter <= 0 {
		staleAfter = 15 * time.Minute
	}
	workerID := strings.TrimSpace(options.WorkerID)
	if workerID == "" {
		workerID = "raibitserver-orchestrator"
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	deployment, err := scanPostgresDeployment(tx.QueryRowContext(ctx, claimDeploymentSQL,
		DeploymentStatusImageReady, DeploymentStatusRollbackRequested, DeploymentStatusCleanupRequested,
		"CLEANUP_REQUESTED", DeploymentStatusDeploying, claimNow.Add(-staleAfter),
		DeploymentActionApply, DeploymentActionRollback, DeploymentActionCleanup))
	if errors.Is(err, sql.ErrNoRows) {
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	originalStatus := deployment.Status
	if row, err := (healthTransaction{ctx: ctx, tx: tx}).deployment(deployment.ID); err != nil {
		return nil, err
	} else if row == nil {
		return nil, ErrParentDeletionRequested
	}
	originalAttempt := deployment.ReconcileAttempts
	action, ready := deploymentActionForPostgresClaim(deployment)
	if !ready {
		return nil, fmt.Errorf("deployment %s has no persisted reconcile action", deployment.ID)
	}
	result, err := tx.ExecContext(ctx, `
UPDATE "Deployment"
SET status = $1, "reconcileAction" = $2, "reconcileLockedBy" = $3,
    "reconcileLockedAt" = $4, "reconcileAttempts" = "reconcileAttempts" + 1, "updatedAt" = $4
WHERE id = $5 AND status = $6 AND "reconcileAttempts" = $7
  AND EXISTS (
    SELECT 1 FROM "Service" s JOIN "Project" p ON p.id = s."projectId"
    WHERE s.id = "Deployment"."serviceId" AND p.id = "Deployment"."projectId"
      AND UPPER(s.status) NOT IN ('DELETE_REQUESTED', 'DELETING', 'DELETED')
      AND UPPER(p.status) NOT IN ('DELETE_REQUESTED', 'DELETING', 'DELETED')
  )`,
		DeploymentStatusDeploying, action, workerID, claimNow, deployment.ID, originalStatus, originalAttempt)
	if err != nil {
		return nil, err
	}
	rows, err := result.RowsAffected()
	if err != nil || rows != 1 {
		return nil, fmt.Errorf("deployment %s claim conflict", deployment.ID)
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	deployment.Status = DeploymentStatusDeploying
	deployment.ReconcileAction = action
	deployment.ReconcileLockedBy = workerID
	deployment.ReconcileLockedAt = claimNow
	deployment.ReconcileAttempts++
	return deployment, nil
}

func (s *PostgresStore) RenewDeploymentLease(ctx context.Context, lease DeploymentLease, renewedAt time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if renewedAt.IsZero() {
		renewedAt = time.Now().UTC()
	}
	result, err := s.db.ExecContext(ctx, renewDeploymentLeaseSQL, renewedAt, lease.DeploymentID, DeploymentStatusDeploying, lease.WorkerID, lease.Attempt, lease.Action)
	if err != nil {
		return err
	}
	updated, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if updated != 1 {
		return ErrDeploymentLeaseLost
	}
	return nil
}

func (s *PostgresStore) GetProject(ctx context.Context, projectID string) (*Project, error) {
	project, err := scanPostgresProjectWithOrganization(s.db.QueryRowContext(ctx, getProjectSQL, projectID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, notFound("project", projectID)
	}
	return project, err
}

func (s *PostgresStore) GetService(ctx context.Context, serviceID string) (*Service, error) {
	service, err := scanPostgresService(s.db.QueryRowContext(ctx, `
SELECT id, "projectId", name, slug, type, "imageUrl", port, "desiredSpec", "desiredState", status, "deletionRequestedAt", "updatedAt",
 "healthCheckPath","livenessPath","readinessPath","publicHealthPath"
FROM "Service" WHERE id = $1`, serviceID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, notFound("service", serviceID)
	}
	return service, err
}

func (s *PostgresStore) TransitionDeployment(ctx context.Context, lease DeploymentLease, updates map[string]any) (*Deployment, error) {
	assignments, args, err := postgresUpdateAssignments(updates)
	if err != nil {
		return nil, err
	}
	args = append(args, time.Now().UTC(), lease.DeploymentID, DeploymentStatusDeploying, lease.WorkerID, lease.Attempt, lease.Action)
	updatedAtArg := len(args) - 5
	idArg := len(args) - 4
	statusArg := len(args) - 3
	workerArg := len(args) - 2
	attemptArg := len(args) - 1
	actionArg := len(args)
	setClauses := append(assignments,
		`"updatedAt" = $`+strconv.Itoa(updatedAtArg),
		`"reconcileAction" = NULL`, `"reconcileLockedBy" = NULL`, `"reconcileLockedAt" = NULL`)
	predicate := fmt.Sprintf(transitionDeploymentLeasePredicate, statusArg, workerArg, attemptArg, actionArg)
	if strings.EqualFold(fmt.Sprint(updates["status"]), DeploymentStatusReady) {
		predicate += " AND " + readyTransitionParentPredicate
	}
	query := `UPDATE "Deployment" SET ` + strings.Join(setClauses, ", ") +
		` WHERE id = $` + strconv.Itoa(idArg) + ` AND ` + predicate +
		` RETURNING id, "serviceId", "projectId", status, "deploymentType", "triggerType", branch,
          "commitSha", "imageUrl", "imageDigest", "previewUrl", "pullRequestNumber",
          "reconcileAction", "reconcileLockedBy", "reconcileLockedAt", "reconcileAttempts",
          "desiredSpecSnapshot", "snapshotVersion", "sourceDeploymentId", "retryOfDeploymentId",
          "publicHealthStatus","healthCheckedAt","healthFailureCode","observedGeneration",
          "previewLineageId","previewGeneration","previewRuntime","previewOwnedObjects"`
	deployment, err := scanPostgresDeployment(s.db.QueryRowContext(ctx, query, args...))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrDeploymentLeaseLost
	}
	return deployment, err
}

func (s *PostgresStore) AppendDeploymentEvent(ctx context.Context, input DeploymentEventInput) error {
	now := time.Now().UTC()
	metadata, err := json.Marshal(MaskSecrets(input.Metadata))
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO "DeploymentEvent" (id, "deploymentId", type, message, metadata, timestamp)
VALUES ($1, $2, $3, $4, $5, $6)`, stableID("devevt", input.DeploymentID, input.Type, input.Message, now.Format(time.RFC3339Nano)),
		input.DeploymentID, defaultString(input.Type, "deployment.event"), Redact(input.Message), metadata, now)
	return err
}

func (s *PostgresStore) AppendRuntimeLog(ctx context.Context, input RuntimeLogInput) error {
	if strings.TrimSpace(input.Line) == "" {
		return nil
	}
	now := time.Now().UTC()
	_, err := s.db.ExecContext(ctx, `
INSERT INTO "RuntimeLog" (id, "serviceId", "deploymentId", "podName", "containerName", line, level, timestamp)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, stableID("rlog", input.ServiceID, input.DeploymentID, input.Line, now.Format(time.RFC3339Nano)),
		input.ServiceID, nullable(input.DeploymentID), defaultString(input.PodName, "orchestrator"), defaultString(input.ContainerName, "app"), Redact(input.Line), defaultString(input.Level, "info"), now)
	return err
}

type rowScanner interface{ Scan(...any) error }

func scanPostgresProject(row rowScanner) (*Project, error) {
	var project Project
	var deletionRequestedAt sql.NullTime
	if err := row.Scan(&project.ID, &project.OrganizationID, &project.Name, &project.Slug, &project.Status, &deletionRequestedAt, &project.UpdatedAt); err != nil {
		return nil, err
	}
	if deletionRequestedAt.Valid {
		project.DeletionRequestedAt = deletionRequestedAt.Time
	}
	return &project, nil
}

func scanPostgresProjectWithOrganization(row rowScanner) (*Project, error) {
	var project Project
	var deletionRequestedAt sql.NullTime
	if err := row.Scan(&project.ID, &project.OrganizationID, &project.OrganizationSlug, &project.Name, &project.Slug, &project.Status, &deletionRequestedAt, &project.UpdatedAt); err != nil {
		return nil, err
	}
	if deletionRequestedAt.Valid {
		project.DeletionRequestedAt = deletionRequestedAt.Time
	}
	return &project, nil
}

func scanPostgresService(row rowScanner) (*Service, error) {
	var service Service
	var healthCheckPath, livenessPath, readinessPath, publicHealthPath sql.NullString
	var imageURL sql.NullString
	var port sql.NullInt64
	var desiredSpec, desiredState []byte
	var deletionRequestedAt sql.NullTime
	if err := row.Scan(
		&service.ID, &service.ProjectID, &service.Name, &service.Slug, &service.Type, &imageURL, &port,
		&desiredSpec, &desiredState, &service.Status, &deletionRequestedAt, &service.UpdatedAt,
		&healthCheckPath, &livenessPath, &readinessPath, &publicHealthPath,
	); err != nil {
		return nil, err
	}
	service.ImageURL = nullString(imageURL)
	service.HealthCheckPath = healthCheckPath.String
	service.LivenessPath = livenessPath.String
	service.ReadinessPath = readinessPath.String
	service.PublicHealthPath = publicHealthPath.String
	if port.Valid {
		service.Port = int(port.Int64)
	}
	if deletionRequestedAt.Valid {
		service.DeletionRequestedAt = deletionRequestedAt.Time
	}
	service.DesiredSpec = decodeJSONMap(desiredSpec)
	service.DesiredState = decodeJSONMap(desiredState)
	service.Replicas = intField(service.DesiredState, "replicas")
	service.BaseDomain = coalesceString(stringField(service.DesiredState, "baseDomain"), stringField(service.DesiredSpec, "baseDomain"))
	if service.Port == 0 {
		service.Port = intField(service.DesiredState, "port")
	}
	if service.Port == 0 {
		service.Port = 3000
	}
	if service.Replicas <= 0 {
		service.Replicas = 1
	}
	return &service, nil
}

func requireOneAffected(result sql.Result, missing error) error {
	rows, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if rows != 1 {
		return missing
	}
	return nil
}

func scanPostgresDeployment(row rowScanner) (*Deployment, error) {
	var deployment Deployment
	var publicHealthStatus, healthFailureCode sql.NullString
	var healthCheckedAt sql.NullTime
	var observedGeneration sql.NullInt64
	var commitSHA, imageURL, imageDigest, previewURL, reconcileAction, reconcileLockedBy sql.NullString
	var reconcileLockedAt sql.NullTime
	var pullRequestNumber sql.NullInt64
	var snapshotVersion sql.NullInt64
	var snapshot []byte
	var sourceDeploymentID, retryOfDeploymentID, previewLineageID sql.NullString
	var previewGeneration sql.NullInt64
	var previewRuntime, previewOwnedObjects []byte
	err := row.Scan(&deployment.ID, &deployment.ServiceID, &deployment.ProjectID, &deployment.Status, &deployment.DeploymentType,
		&deployment.TriggerType, &deployment.Branch, &commitSHA, &imageURL, &imageDigest, &previewURL, &pullRequestNumber,
		&reconcileAction, &reconcileLockedBy, &reconcileLockedAt, &deployment.ReconcileAttempts,
		&snapshot, &snapshotVersion, &sourceDeploymentID, &retryOfDeploymentID,
		&publicHealthStatus, &healthCheckedAt, &healthFailureCode, &observedGeneration,
		&previewLineageID, &previewGeneration, &previewRuntime, &previewOwnedObjects)
	if err != nil {
		return nil, err
	}
	deployment.CommitSHA = nullString(commitSHA)
	deployment.PublicHealthStatus = defaultString(publicHealthStatus.String, "UNKNOWN")
	deployment.HealthFailureCode = healthFailureCode.String
	if healthCheckedAt.Valid {
		deployment.HealthCheckedAt = healthCheckedAt.Time
	}
	if observedGeneration.Valid {
		deployment.ObservedGeneration = int(observedGeneration.Int64)
	}
	deployment.DesiredSpecSnapshot = snapshot
	if snapshotVersion.Valid {
		deployment.SnapshotVersion = int(snapshotVersion.Int64)
		if deployment.SnapshotVersion < 1 {
			deployment.SnapshotVersion = -1
		}
	}
	deployment.SourceDeploymentID = nullString(sourceDeploymentID)
	deployment.RetryOfDeploymentID = nullString(retryOfDeploymentID)
	deployment.PreviewLineageID = nullString(previewLineageID)
	if previewGeneration.Valid {
		deployment.PreviewGeneration = int(previewGeneration.Int64)
	}
	deployment.PreviewRuntimeJSON = previewRuntime
	deployment.PreviewOwnedJSON = previewOwnedObjects
	deployment.ImageURL = nullString(imageURL)
	deployment.ImageDigest = nullString(imageDigest)
	deployment.PreviewURL = nullString(previewURL)
	deployment.ReconcileAction = nullString(reconcileAction)
	deployment.ReconcileLockedBy = nullString(reconcileLockedBy)
	if reconcileLockedAt.Valid {
		deployment.ReconcileLockedAt = reconcileLockedAt.Time
	}
	if pullRequestNumber.Valid {
		deployment.PullRequestNumber = int(pullRequestNumber.Int64)
	}
	return &deployment, nil
}

func deploymentActionForPostgresClaim(deployment *Deployment) (string, bool) {
	if strings.EqualFold(deployment.Status, DeploymentStatusDeploying) {
		return deployment.ReconcileAction, validDeploymentAction(deployment.ReconcileAction)
	}
	switch strings.ToUpper(deployment.Status) {
	case DeploymentStatusImageReady:
		return DeploymentActionApply, true
	case DeploymentStatusRollbackRequested:
		return DeploymentActionRollback, true
	case DeploymentStatusCleanupRequested, "CLEANUP_REQUESTED":
		return DeploymentActionCleanup, true
	default:
		return "", false
	}
}

type postgresUpdateColumn struct {
	name      string
	timestamp bool
}

var postgresDeploymentColumns = map[string]postgresUpdateColumn{
	"status": {name: "status"}, "imageUrl": {name: `"imageUrl"`}, "deployedAt": {name: `"deployedAt"`, timestamp: true},
	"finishedAt": {name: `"finishedAt"`, timestamp: true}, "errorCode": {name: `"errorCode"`}, "errorMessage": {name: `"errorMessage"`},
}

func postgresUpdateAssignments(updates map[string]any) ([]string, []any, error) {
	if len(updates) == 0 {
		return nil, nil, errors.New("deployment update requires at least one field")
	}
	keys := make([]string, 0, len(updates))
	for key := range updates {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	assignments := make([]string, 0, len(keys))
	args := make([]any, 0, len(keys))
	for _, key := range keys {
		column, ok := postgresDeploymentColumns[key]
		if !ok {
			return nil, nil, fmt.Errorf("unsupported PostgreSQL deployment update field: %s", key)
		}
		value := MaskSecrets(updates[key])
		if column.timestamp && value != nil {
			if parsed, err := time.Parse(time.RFC3339Nano, fmt.Sprint(value)); err == nil {
				value = parsed
			}
		}
		args = append(args, value)
		assignments = append(assignments, column.name+" = $"+strconv.Itoa(len(args)))
	}
	return assignments, args, nil
}

func decodeJSONMap(value []byte) map[string]any {
	var result map[string]any
	if len(value) == 0 || json.Unmarshal(value, &result) != nil {
		return map[string]any{}
	}
	return result
}

func nullString(value sql.NullString) string {
	if value.Valid {
		return value.String
	}
	return ""
}
