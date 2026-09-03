package controlplane

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

const postgresDriverName = "pgx"

const claimWorkflowJobSQL = `
WITH exhausted AS (
  SELECT wj.id,
    CASE
      WHEN BTRIM(COALESCE(wj.payload ->> 'deploymentId', '')) <> ''
        AND LOWER(BTRIM(wj."targetType")) = 'deployment'
        AND BTRIM(wj."targetId") <> ''
        AND BTRIM(wj.payload ->> 'deploymentId') <> BTRIM(wj."targetId")
      THEN NULL
      ELSE COALESCE(
        NULLIF(BTRIM(wj.payload ->> 'deploymentId'), ''),
        CASE WHEN LOWER(BTRIM(wj."targetType")) = 'deployment' THEN NULLIF(BTRIM(wj."targetId"), '') END
      )
    END AS deployment_id
  FROM "WorkflowJob" AS wj
  WHERE wj.type IN ('build-and-deploy', 'preview-deploy', 'build', 'builder')
    AND wj.status = $4
    AND wj."lockedAt" IS NOT NULL
    AND wj."lockedAt" <= $3
    AND wj.attempts >= CASE WHEN wj."maxAttempts" > 0 THEN wj."maxAttempts" ELSE 3 END
  ORDER BY wj."lockedAt" ASC, wj."createdAt" ASC, wj.id ASC
  FOR UPDATE SKIP LOCKED
  LIMIT $5
), failed_jobs AS (
  UPDATE "WorkflowJob" AS wj
  SET status = 'failed',
    payload = jsonb_set(
      jsonb_set(
        jsonb_set(COALESCE(wj.payload, '{}'::jsonb), '{lastError}', to_jsonb($6::text), true),
        '{lastErrorSpec}', $7::jsonb, true
      ),
      '{failedAt}', to_jsonb($8::text), true
    ),
    "lockedBy" = NULL,
    "lockedAt" = NULL,
    "updatedAt" = $2
  FROM exhausted
  WHERE wj.id = exhausted.id
    AND wj.status = $4
    AND wj."lockedAt" <= $3
    AND wj.attempts >= CASE WHEN wj."maxAttempts" > 0 THEN wj."maxAttempts" ELSE 3 END
  RETURNING wj.id, exhausted.deployment_id
), failed_deployments AS (
  UPDATE "Deployment" AS d
  SET status = 'BUILD_FAILED',
    "buildFinishedAt" = $2,
    "errorCode" = 'BUILD_FAILED',
    "errorMessage" = $6,
    "updatedAt" = $2
  FROM failed_jobs
  WHERE d.id = failed_jobs.deployment_id
    AND UPPER(d.status) IN ('QUEUED', 'BUILDING')
  RETURNING d.id
), candidate AS (
  SELECT wj.id
  FROM "WorkflowJob" AS wj
  WHERE wj.type IN ('build-and-deploy', 'preview-deploy', 'build', 'builder')
    AND (
      (
        wj.status = $1
        AND wj."runAfter" <= $2
        AND (wj."lockedAt" IS NULL OR wj."lockedAt" <= $3)
      )
      OR (
        wj.status = $4
        AND wj."lockedAt" <= $3
        AND wj.attempts < CASE WHEN wj."maxAttempts" > 0 THEN wj."maxAttempts" ELSE 3 END
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "Deployment" AS d
      JOIN "Service" AS s ON s.id = d."serviceId"
      JOIN "Project" AS p ON p.id = d."projectId"
      WHERE d.id = CASE
        WHEN BTRIM(COALESCE(wj.payload ->> 'deploymentId', '')) <> ''
          AND LOWER(BTRIM(wj."targetType")) = 'deployment'
          AND BTRIM(wj."targetId") <> ''
          AND BTRIM(wj.payload ->> 'deploymentId') <> BTRIM(wj."targetId")
        THEN NULL
        ELSE COALESCE(
          NULLIF(BTRIM(wj.payload ->> 'deploymentId'), ''),
          CASE WHEN LOWER(BTRIM(wj."targetType")) = 'deployment' THEN NULLIF(BTRIM(wj."targetId"), '') END
        )
      END
        AND (
          UPPER(COALESCE(s.status, '')) IN ('DELETE_REQUESTED', 'DELETING', 'DELETE_FAILED')
          OR UPPER(COALESCE(p.status, '')) IN ('DELETE_REQUESTED', 'DELETING', 'DELETE_FAILED')
        )
    )
  ORDER BY wj."runAfter" ASC, wj."createdAt" ASC, wj.id ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
), claimed AS (
  UPDATE "WorkflowJob" AS wj
  SET status = $4,
    attempts = wj.attempts + 1,
    "lockedBy" = $9,
    "lockedAt" = $2,
    "updatedAt" = $2
  FROM candidate
  WHERE wj.id = candidate.id
  RETURNING wj.id, wj.type, wj.status, wj."targetType", wj."targetId", wj.payload, wj.attempts, wj."maxAttempts"
)
SELECT id, type, status, "targetType", "targetId", payload, attempts, "maxAttempts"
FROM claimed`

const updateWorkflowJobSQL = `
UPDATE "WorkflowJob"
SET status = $1, payload = $2, "runAfter" = COALESCE($3, "runAfter"), "lockedBy" = NULL, "lockedAt" = NULL, "updatedAt" = $4
WHERE id = $5 AND status = 'running' AND "lockedBy" = $6 AND attempts = $7`

const renewWorkflowLeaseSQL = `
UPDATE "WorkflowJob"
SET "lockedAt" = $1, "updatedAt" = $1
WHERE id = $2 AND status = 'running' AND "lockedBy" = $3 AND attempts = $4`

const lockWorkflowLeaseSQL = `
SELECT status, "lockedBy", attempts
FROM "WorkflowJob"
WHERE id = $1
FOR UPDATE`

const lockBuildWorkflowLeaseSQL = `
SELECT id, status, payload, attempts, "maxAttempts", "lockedBy"
FROM "WorkflowJob" AS wj
WHERE wj.id = $1
  AND wj.type IN ('build-and-deploy', 'preview-deploy', 'build', 'builder')
  AND (
    CASE
      WHEN BTRIM(COALESCE(wj.payload ->> 'deploymentId', '')) <> ''
        AND LOWER(BTRIM(wj."targetType")) = 'deployment'
        AND BTRIM(wj."targetId") <> ''
        AND BTRIM(wj.payload ->> 'deploymentId') <> BTRIM(wj."targetId")
      THEN NULL
      ELSE COALESCE(
        NULLIF(BTRIM(wj.payload ->> 'deploymentId'), ''),
        CASE WHEN LOWER(BTRIM(wj."targetType")) = 'deployment' THEN NULLIF(BTRIM(wj."targetId"), '') END
      )
    END
  ) = $2
FOR UPDATE`

const lockImagePublicationTargetSQL = `
SELECT d.status, s.status, p.status
FROM "Deployment" AS d
JOIN "Service" AS s ON s.id = d."serviceId"
JOIN "Project" AS p ON p.id = d."projectId"
WHERE d.id = $1 AND s.id = $2 AND p.id = $3 AND s."projectId" = p.id
FOR UPDATE OF d, s, p`

const lockBuildStartTargetSQL = lockImagePublicationTargetSQL

const startBuildSQL = `
UPDATE "Deployment"
SET status = 'BUILDING', "buildStartedAt" = $1, "updatedAt" = $1
WHERE id = $2 AND UPPER(BTRIM(status)) = 'QUEUED'`

type PostgresStore struct {
	db *sql.DB
}

func NewPostgresStore(db *sql.DB) *PostgresStore {
	return &PostgresStore{db: db}
}

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

func PostgresDSNFromEnv(env map[string]string) string {
	if value := env["RAIBITSERVER_CONTROL_PLANE_DATABASE_URL"]; strings.TrimSpace(value) != "" {
		return value
	}
	storeMode := strings.ToLower(strings.TrimSpace(env["RAIBITSERVER_CONTROL_PLANE_STORE"]))
	if storeMode == "postgres" || storeMode == "postgresql" || storeMode == "prisma-postgres" {
		return env["DATABASE_URL"]
	}
	return ""
}

func RedactDSN(dsn string) string {
	parsed, err := url.Parse(dsn)
	if err != nil || parsed.User == nil {
		return Redact(dsn)
	}
	username := parsed.User.Username()
	if _, ok := parsed.User.Password(); ok {
		parsed.User = url.UserPassword(username, "redacted")
	} else {
		parsed.User = url.User(username)
	}
	return parsed.String()
}

func (s *PostgresStore) ClaimNextWorkflowJob(ctx context.Context, options ClaimOptions) (*WorkflowJob, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, err
	}
	defer rollbackUnlessCommitted(tx)

	now := options.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	leaseSeconds := options.LeaseSeconds
	if leaseSeconds <= 0 {
		leaseSeconds = 300
	}
	workerID := options.WorkerID
	if workerID == "" {
		workerID = "raibitserver-builder"
	}
	lockCutoff := now.Add(-time.Duration(leaseSeconds) * time.Second)
	errorSpec, err := json.Marshal(ErrorSpecForFailure(errors.New(exhaustedWorkflowFailureMessage), ErrorCodeBuildFailed))
	if err != nil {
		return nil, err
	}

	job, err := scanWorkflowJob(tx.QueryRowContext(
		ctx,
		claimWorkflowJobSQL,
		WorkflowQueued,
		now,
		lockCutoff,
		WorkflowRunning,
		exhaustedWorkflowReapLimit,
		exhaustedWorkflowFailureMessage,
		string(errorSpec),
		now.Format(time.RFC3339Nano),
		workerID,
	))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			if err := tx.Commit(); err != nil {
				return nil, err
			}
			return nil, nil
		}
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	job.LockedBy = workerID
	return job, nil
}

func (s *PostgresStore) CompleteWorkflowJob(ctx context.Context, lease WorkflowLease, result map[string]any) error {
	return s.updateWorkflowJob(ctx, lease, func(job *workflowJobUpdate, now time.Time) {
		job.Payload["lastResult"] = MaskSecrets(result)
		job.Payload["completedAt"] = now.Format(time.RFC3339Nano)
		job.Status = WorkflowSucceeded
		job.RunAfter = nil
	})
}

func (s *PostgresStore) FailWorkflowJob(ctx context.Context, lease WorkflowLease, failure error) error {
	return s.updateWorkflowJob(ctx, lease, func(job *workflowJobUpdate, now time.Time) {
		job.Payload["lastError"] = Redact(failureMessage(failure))
		job.Payload["lastErrorSpec"] = ErrorSpecForFailure(failure, ErrorCodeUnknownInfra)
		job.Payload["failedAt"] = now.Format(time.RFC3339Nano)
		maxAttempts := job.MaxAttempts
		if maxAttempts <= 0 {
			maxAttempts = 3
		}
		if job.Attempts < maxAttempts {
			job.Status = WorkflowQueued
			next := now.Add(retryDelay(job.Attempts))
			job.RunAfter = &next
		} else {
			job.Status = WorkflowFailed
			job.RunAfter = nil
		}
	})
}

func (s *PostgresStore) CancelWorkflowJob(ctx context.Context, lease WorkflowLease, reason error) error {
	return s.updateWorkflowJob(ctx, lease, func(job *workflowJobUpdate, now time.Time) {
		job.Payload["lastError"] = Redact(failureMessage(reason))
		job.Payload["lastErrorSpec"] = ErrorSpecForFailure(reason, ErrorCodeDeploymentCancelled)
		job.Payload["cancelledAt"] = now.Format(time.RFC3339Nano)
		job.Status = WorkflowFailed
		job.RunAfter = nil
	})
}

func (s *PostgresStore) RenewWorkflowJobLease(ctx context.Context, lease WorkflowLease, now time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	result, err := s.db.ExecContext(ctx, renewWorkflowLeaseSQL, now, lease.JobID, lease.WorkerID, lease.Attempt)
	if err != nil {
		return err
	}
	updated, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if updated != 1 {
		return ErrWorkflowLeaseLost
	}
	return nil
}

func (s *PostgresStore) GetProject(ctx context.Context, projectID string) (*Project, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var project Project
	err := s.db.QueryRowContext(ctx, `SELECT id, "organizationId", name, slug, status FROM "Project" WHERE id = $1`, projectID).
		Scan(&project.ID, &project.OrganizationID, &project.Name, &project.Slug, &project.Status)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, notFound("project", projectID)
	}
	if err != nil {
		return nil, err
	}
	return &project, nil
}

func (s *PostgresStore) GetService(ctx context.Context, serviceID string) (*Service, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	service, err := scanService(s.db.QueryRowContext(ctx, `
SELECT id, "projectId", name, slug, type, "runtimeType", "sourceType", "buildMode", "repoUrl", branch,
       "rootDirectory", "buildContext", "dockerfilePath", "installCommand", "buildCommand", "startCommand",
       "outputDirectory", image, "imageUrl", port, status, "desiredSpec", "desiredState"
FROM "Service"
WHERE id = $1`, serviceID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, notFound("service", serviceID)
	}
	if err != nil {
		return nil, err
	}
	return service, nil
}

func (s *PostgresStore) GetDeployment(ctx context.Context, deploymentID string) (*Deployment, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	deployment, err := scanDeployment(s.db.QueryRowContext(ctx, deploymentSelectSQL()+` WHERE id = $1`, deploymentID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, notFound("deployment", deploymentID)
	}
	if err != nil {
		return nil, err
	}
	return deployment, nil
}

func (s *PostgresStore) UpdateDeployment(ctx context.Context, deploymentID string, updates map[string]any) (*Deployment, error) {
	return updateDeploymentRow(ctx, s.db, deploymentID, updates)
}

func (s *PostgresStore) updateDeploymentForLease(ctx context.Context, lease WorkflowLease, deploymentID string, updates map[string]any) (*Deployment, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, err
	}
	defer rollbackUnlessCommitted(tx)
	if err := assertWorkflowLeaseLocked(ctx, tx, lease); err != nil {
		return nil, err
	}
	if _, requested, validationErr := normalizedDeploymentCommitUpdate(updates); requested {
		if validationErr != nil {
			return nil, validationErr
		}
		current, currentErr := scanDeployment(tx.QueryRowContext(ctx, deploymentSelectSQL()+` WHERE id = $1 FOR UPDATE`, deploymentID))
		if errors.Is(currentErr, sql.ErrNoRows) {
			return nil, notFound("deployment", deploymentID)
		}
		if currentErr != nil {
			return nil, currentErr
		}
		updates, validationErr = leaseFencedDeploymentUpdates(current, updates)
		if validationErr != nil {
			return nil, validationErr
		}
	}
	deployment, err := updateDeploymentRow(ctx, tx, deploymentID, updates)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return deployment, nil
}

func (s *PostgresStore) UpdateDeploymentForLease(ctx context.Context, lease WorkflowLease, deploymentID string, updates map[string]any) (*Deployment, error) {
	return s.updateDeploymentForLease(ctx, lease, deploymentID, updates)
}

func updateDeploymentRow(ctx context.Context, queryer rowQueryer, deploymentID string, updates map[string]any) (*Deployment, error) {
	assignments, args, err := updateAssignments(updates, deploymentUpdateColumns)
	if err != nil {
		return nil, err
	}
	args = append(args, time.Now().UTC(), deploymentID)
	sqlText := `
UPDATE "Deployment"
SET ` + strings.Join(append(assignments, `"updatedAt" = $`+strconv.Itoa(len(args)-1)), ", ") + `
WHERE id = $` + strconv.Itoa(len(args)) + `
RETURNING id, "serviceId", "projectId", status, "deploymentType", "triggerType", branch, "commitSha", "commitHash",
          "pullRequestNumber", "previewUrl", "imageUrl", "imageDigest", "desiredSpecSnapshot", "snapshotVersion", "sourceDeploymentId", "retryOfDeploymentId"`
	deployment, err := scanDeployment(queryer.QueryRowContext(ctx, sqlText, args...))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, notFound("deployment", deploymentID)
	}
	if err != nil {
		return nil, err
	}
	return deployment, nil
}

func (s *PostgresStore) UpdateService(ctx context.Context, serviceID string, updates map[string]any) (*Service, error) {
	return updateServiceRow(ctx, s.db, serviceID, updates)
}

func (s *PostgresStore) updateServiceForLease(ctx context.Context, lease WorkflowLease, serviceID string, updates map[string]any) (*Service, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, err
	}
	defer rollbackUnlessCommitted(tx)
	if err := assertWorkflowLeaseLocked(ctx, tx, lease); err != nil {
		return nil, err
	}
	service, err := updateServiceRow(ctx, tx, serviceID, updates)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return service, nil
}

func updateServiceRow(ctx context.Context, queryer rowQueryer, serviceID string, updates map[string]any) (*Service, error) {
	assignments, args, err := updateAssignments(updates, serviceUpdateColumns)
	if err != nil {
		return nil, err
	}
	args = append(args, time.Now().UTC(), serviceID)
	sqlText := `
UPDATE "Service"
SET ` + strings.Join(append(assignments, `"updatedAt" = $`+strconv.Itoa(len(args)-1)), ", ") + `
WHERE id = $` + strconv.Itoa(len(args)) + `
RETURNING id, "projectId", name, slug, type, "runtimeType", "sourceType", "buildMode", "repoUrl", branch,
          "rootDirectory", "buildContext", "dockerfilePath", "installCommand", "buildCommand", "startCommand",
          "outputDirectory", image, "imageUrl", port, status, "desiredSpec", "desiredState"`
	service, err := scanService(queryer.QueryRowContext(ctx, sqlText, args...))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, notFound("service", serviceID)
	}
	if err != nil {
		return nil, err
	}
	return service, nil
}

type rowQueryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

type sqlExecer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func assertWorkflowLeaseLocked(ctx context.Context, tx *sql.Tx, lease WorkflowLease) error {
	var jobStatus string
	var lockedBy sql.NullString
	var attempts int
	err := tx.QueryRowContext(ctx, lockWorkflowLeaseSQL, lease.JobID).Scan(&jobStatus, &lockedBy, &attempts)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrWorkflowLeaseLost
	}
	if err != nil {
		return err
	}
	if jobStatus != WorkflowRunning || nullString(lockedBy) != lease.WorkerID || attempts != lease.Attempt {
		return ErrWorkflowLeaseLost
	}
	return nil
}

func (s *PostgresStore) StartBuild(ctx context.Context, input BuildStartInput) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return err
	}
	defer rollbackUnlessCommitted(tx)

	job, err := scanWorkflowJobUpdate(tx.QueryRowContext(ctx, lockBuildWorkflowLeaseSQL, input.Lease.JobID, input.DeploymentID))
	if errors.Is(err, sql.ErrNoRows) {
		return ErrWorkflowLeaseLost
	}
	if err != nil {
		return err
	}
	if job.Status != WorkflowRunning || job.LockedBy != input.Lease.WorkerID || job.Attempts != input.Lease.Attempt {
		return ErrWorkflowLeaseLost
	}

	var deploymentStatus, serviceStatus, projectStatus string
	err = tx.QueryRowContext(ctx, lockBuildStartTargetSQL, input.DeploymentID, input.ServiceID, input.ProjectID).Scan(&deploymentStatus, &serviceStatus, &projectStatus)
	if errors.Is(err, sql.ErrNoRows) {
		return notFound("build start target", input.DeploymentID)
	}
	if err != nil {
		return err
	}
	if err := deletingTargetError(serviceStatus, projectStatus); err != nil {
		return err
	}
	if !strings.EqualFold(strings.TrimSpace(deploymentStatus), "QUEUED") {
		return ErrWorkflowLeaseLost
	}

	startedAt := input.StartedAt
	if startedAt.IsZero() {
		startedAt = time.Now().UTC()
	}
	result, err := tx.ExecContext(ctx, startBuildSQL, startedAt, input.DeploymentID)
	if err != nil {
		return err
	}
	updated, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if updated != 1 {
		return ErrWorkflowLeaseLost
	}
	return tx.Commit()
}

func (s *PostgresStore) PublishImageReady(ctx context.Context, input ImagePublicationInput) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return err
	}
	defer rollbackUnlessCommitted(tx)

	job, err := scanWorkflowJobUpdate(tx.QueryRowContext(ctx, lockBuildWorkflowLeaseSQL, input.Lease.JobID, input.DeploymentID))
	if errors.Is(err, sql.ErrNoRows) {
		return ErrWorkflowLeaseLost
	}
	if err != nil {
		return err
	}
	if job.Status != WorkflowRunning || job.LockedBy != input.Lease.WorkerID || job.Attempts != input.Lease.Attempt {
		return ErrWorkflowLeaseLost
	}

	var deploymentStatus, serviceStatus, projectStatus string
	err = tx.QueryRowContext(ctx, lockImagePublicationTargetSQL, input.DeploymentID, input.ServiceID, input.ProjectID).Scan(&deploymentStatus, &serviceStatus, &projectStatus)
	if errors.Is(err, sql.ErrNoRows) {
		return notFound("image publication target", input.DeploymentID)
	}
	if err != nil {
		return err
	}
	if err := deletingTargetError(serviceStatus, projectStatus); err != nil {
		return err
	}
	if !strings.EqualFold(strings.TrimSpace(deploymentStatus), "BUILDING") {
		return ErrWorkflowLeaseLost
	}

	finishedAt := input.BuildFinishedAt
	if finishedAt.IsZero() {
		finishedAt = time.Now().UTC()
	}
	deploymentResult, err := tx.ExecContext(ctx, `
UPDATE "Deployment"
SET status = $1, "imageUrl" = $2, "imageDigest" = $3, "buildFinishedAt" = $4,
    "errorCode" = NULL, "errorMessage" = NULL, "updatedAt" = $4
WHERE id = $5 AND UPPER(BTRIM(status)) = 'BUILDING'`, "IMAGE_READY", input.ImageURL, input.ImageDigest, finishedAt, input.DeploymentID)
	if err != nil {
		return err
	}
	updatedDeployment, err := deploymentResult.RowsAffected()
	if err != nil {
		return err
	}
	if updatedDeployment != 1 {
		return ErrWorkflowLeaseLost
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE "Service"
SET image = $1, "imageUrl" = $1, status = 'image-ready', "updatedAt" = $2
WHERE id = $3`, input.ImageURL, finishedAt, input.ServiceID); err != nil {
		return err
	}
	if job.Payload == nil {
		job.Payload = map[string]any{}
	}
	job.Payload["lastResult"] = MaskSecrets(imagePublicationResult(input))
	job.Payload["completedAt"] = finishedAt.Format(time.RFC3339Nano)
	payload, err := json.Marshal(MaskSecrets(job.Payload))
	if err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `
UPDATE "WorkflowJob"
SET status = $1, payload = $2, "lockedBy" = NULL, "lockedAt" = NULL, "updatedAt" = $3
WHERE id = $4 AND status = 'running' AND "lockedBy" = $5 AND attempts = $6`,
		WorkflowSucceeded, payload, finishedAt, input.Lease.JobID, input.Lease.WorkerID, input.Lease.Attempt)
	if err != nil {
		return err
	}
	updated, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if updated != 1 {
		return ErrWorkflowLeaseLost
	}
	if err := appendDeploymentEventRow(ctx, tx, imagePublicationEvent(input)); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *PostgresStore) AppendBuildLog(ctx context.Context, input BuildLogInput) error {
	return appendBuildLogRow(ctx, s.db, input)
}

func (s *PostgresStore) appendBuildLogForLease(ctx context.Context, lease WorkflowLease, input BuildLogInput) error {
	if strings.TrimSpace(input.Line) == "" {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return err
	}
	defer rollbackUnlessCommitted(tx)
	if err := assertWorkflowLeaseLocked(ctx, tx, lease); err != nil {
		return err
	}
	if err := appendBuildLogRow(ctx, tx, input); err != nil {
		return err
	}
	return tx.Commit()
}

func appendBuildLogRow(ctx context.Context, execer sqlExecer, input BuildLogInput) error {
	if strings.TrimSpace(input.Line) == "" {
		return nil
	}
	now := time.Now().UTC()
	_, err := execer.ExecContext(ctx, `
INSERT INTO "BuildLog" (id, "deploymentId", step, line, level, timestamp)
VALUES ($1, $2, $3, $4, $5, $6)`,
		stableID("blog", input.DeploymentID, input.Step, input.Line, now.Format(time.RFC3339Nano)),
		input.DeploymentID,
		defaultString(input.Step, "build"),
		Redact(input.Line),
		defaultString(input.Level, "info"),
		now)
	return err
}

func (s *PostgresStore) AppendDeploymentEvent(ctx context.Context, input DeploymentEventInput) error {
	return appendDeploymentEventRow(ctx, s.db, input)
}

func (s *PostgresStore) appendDeploymentEventForLease(ctx context.Context, lease WorkflowLease, input DeploymentEventInput) error {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return err
	}
	defer rollbackUnlessCommitted(tx)
	if err := assertWorkflowLeaseLocked(ctx, tx, lease); err != nil {
		return err
	}
	if err := appendDeploymentEventRow(ctx, tx, input); err != nil {
		return err
	}
	return tx.Commit()
}

func appendDeploymentEventRow(ctx context.Context, execer sqlExecer, input DeploymentEventInput) error {
	now := time.Now().UTC()
	metadata, err := json.Marshal(MaskSecrets(input.Metadata))
	if err != nil {
		return err
	}
	_, err = execer.ExecContext(ctx, `
INSERT INTO "DeploymentEvent" (id, "deploymentId", type, message, metadata, timestamp)
VALUES ($1, $2, $3, $4, $5, $6)`,
		stableID("devevt", input.DeploymentID, input.Type, input.Message, now.Format(time.RFC3339Nano)),
		input.DeploymentID,
		defaultString(input.Type, "deployment.event"),
		Redact(input.Message),
		metadata,
		now)
	return err
}

func (s *PostgresStore) updateWorkflowJob(ctx context.Context, lease WorkflowLease, mutate func(job *workflowJobUpdate, now time.Time)) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return err
	}
	defer rollbackUnlessCommitted(tx)

	job, err := scanWorkflowJobUpdate(tx.QueryRowContext(ctx, `
SELECT id, status, payload, attempts, "maxAttempts", "lockedBy"
FROM "WorkflowJob"
WHERE id = $1
FOR UPDATE`, lease.JobID))
	if errors.Is(err, sql.ErrNoRows) {
		return notFound("workflow job", lease.JobID)
	}
	if err != nil {
		return err
	}
	if job.Status != WorkflowRunning || job.LockedBy != lease.WorkerID || job.Attempts != lease.Attempt {
		return ErrWorkflowLeaseLost
	}
	now := time.Now().UTC()
	mutate(job, now)
	payload, err := json.Marshal(MaskSecrets(job.Payload))
	if err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, updateWorkflowJobSQL, job.Status, payload, job.RunAfter, now, lease.JobID, lease.WorkerID, lease.Attempt)
	if err != nil {
		return err
	}
	updated, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if updated != 1 {
		return ErrWorkflowLeaseLost
	}
	return tx.Commit()
}

type workflowJobUpdate struct {
	ID          string
	Status      string
	Payload     map[string]any
	Attempts    int
	MaxAttempts int
	RunAfter    *time.Time
	LockedBy    string
}

type scanner interface {
	Scan(dest ...any) error
}

func scanWorkflowJob(row scanner) (*WorkflowJob, error) {
	var job WorkflowJob
	var payload []byte
	if err := row.Scan(&job.ID, &job.Type, &job.Status, &job.TargetType, &job.TargetID, &payload, &job.Attempts, &job.MaxAttempts); err != nil {
		return nil, err
	}
	job.Payload = jsonMap(payload)
	return &job, nil
}

func scanWorkflowJobUpdate(row scanner) (*workflowJobUpdate, error) {
	var job workflowJobUpdate
	var payload []byte
	var lockedBy sql.NullString
	if err := row.Scan(&job.ID, &job.Status, &payload, &job.Attempts, &job.MaxAttempts, &lockedBy); err != nil {
		return nil, err
	}
	job.Payload = jsonMap(payload)
	job.LockedBy = nullString(lockedBy)
	return &job, nil
}

func scanService(row scanner) (*Service, error) {
	var service Service
	var repoURL, branch, rootDirectory, buildContext, dockerfilePath sql.NullString
	var installCommand, buildCommand, startCommand, outputDirectory sql.NullString
	var image, imageURL sql.NullString
	var port sql.NullInt64
	var desiredSpec, desiredState []byte
	err := row.Scan(
		&service.ID, &service.ProjectID, &service.Name, &service.Slug, &service.Type, &service.RuntimeType, &service.SourceType, &service.BuildMode,
		&repoURL, &branch, &rootDirectory, &buildContext, &dockerfilePath, &installCommand, &buildCommand, &startCommand,
		&outputDirectory, &image, &imageURL, &port, &service.Status, &desiredSpec, &desiredState,
	)
	if err != nil {
		return nil, err
	}
	service.RepoURL = nullString(repoURL)
	service.Branch = nullString(branch)
	service.RootDirectory = nullString(rootDirectory)
	service.BuildContext = nullString(buildContext)
	service.DockerfilePath = nullString(dockerfilePath)
	service.InstallCommand = nullString(installCommand)
	service.BuildCommand = nullString(buildCommand)
	service.StartCommand = nullString(startCommand)
	service.OutputDirectory = nullString(outputDirectory)
	service.Image = nullString(image)
	service.ImageURL = nullString(imageURL)
	if port.Valid {
		service.Port = int(port.Int64)
	}
	service.DesiredSpec = jsonMap(desiredSpec)
	service.DesiredState = jsonMap(desiredState)
	github := mapField(service.DesiredState, "github")
	service.GitHubIntegrationID = coalesceString(stringField(service.DesiredState, "githubIntegrationId"), stringField(github, "integrationId"))
	service.GitHubInstallationID = coalesceString(stringField(service.DesiredState, "githubInstallationId"), stringField(github, "installationId"))
	service.GitHubRepositoryID = coalesceString(stringField(service.DesiredState, "githubRepositoryId"), stringField(github, "repositoryId"))
	service.GitHubRepository = coalesceString(stringField(service.DesiredState, "githubRepository"), stringField(github, "repository"))
	service.GitHubRepositoryVisibility = coalesceString(stringField(service.DesiredState, "githubRepositoryVisibility"), stringField(github, "visibility"))
	service.SourceAccess = stringField(service.DesiredState, "sourceAccess")
	service.Registry = coalesceString(stringField(service.DesiredState, "registry"), stringField(service.DesiredSpec, "registry"))
	service.LocalPath = coalesceString(stringField(service.DesiredState, "localPath"), stringField(service.DesiredSpec, "localPath"))
	if service.Port == 0 {
		service.Port = intField(service.DesiredState, "port")
	}
	return &service, nil
}

func scanDeployment(row scanner) (*Deployment, error) {
	var deployment Deployment
	var commitSha, commitHash, previewURL, imageURL, imageDigest sql.NullString
	var pr sql.NullInt64
	var snapshotVersion sql.NullInt64
	var desiredSpecSnapshot []byte
	var sourceDeploymentID, retryOfDeploymentID sql.NullString
	err := row.Scan(
		&deployment.ID, &deployment.ServiceID, &deployment.ProjectID, &deployment.Status, &deployment.DeploymentType, &deployment.TriggerType,
		&deployment.Branch, &commitSha, &commitHash, &pr, &previewURL, &imageURL, &imageDigest,
		&desiredSpecSnapshot, &snapshotVersion, &sourceDeploymentID, &retryOfDeploymentID,
	)
	if err != nil {
		return nil, err
	}
	deployment.CommitSHA = nullString(commitSha)
	deployment.CommitHash = nullString(commitHash)
	if pr.Valid {
		deployment.PullRequestNumber = int(pr.Int64)
	}
	deployment.PreviewURL = nullString(previewURL)
	deployment.ImageURL = nullString(imageURL)
	deployment.ImageDigest = nullString(imageDigest)
	deployment.DesiredSpecSnapshot = desiredSpecSnapshot
	if snapshotVersion.Valid {
		version := int(snapshotVersion.Int64)
		deployment.SnapshotVersion = &version
	}
	deployment.SourceDeploymentID = nullString(sourceDeploymentID)
	deployment.RetryOfDeploymentID = nullString(retryOfDeploymentID)
	_, err = deployment.BuildSpec()
	return &deployment, err
}

func deploymentSelectSQL() string {
	return `SELECT id, "serviceId", "projectId", status, "deploymentType", "triggerType", branch, "commitSha", "commitHash",
       "pullRequestNumber", "previewUrl", "imageUrl", "imageDigest", "desiredSpecSnapshot", "snapshotVersion", "sourceDeploymentId", "retryOfDeploymentId"
FROM "Deployment"`
}

var deploymentUpdateColumns = map[string]updateColumn{
	"status":          {Name: "status"},
	"commitSha":       {Name: `"commitSha"`},
	"commitHash":      {Name: `"commitHash"`},
	"imageUrl":        {Name: `"imageUrl"`},
	"imageDigest":     {Name: `"imageDigest"`},
	"buildStartedAt":  {Name: `"buildStartedAt"`, Timestamp: true},
	"buildFinishedAt": {Name: `"buildFinishedAt"`, Timestamp: true},
	"errorCode":       {Name: `"errorCode"`},
	"errorMessage":    {Name: `"errorMessage"`},
}

var serviceUpdateColumns = map[string]updateColumn{
	"status":   {Name: "status"},
	"image":    {Name: "image"},
	"imageUrl": {Name: `"imageUrl"`},
	"repoUrl":  {Name: `"repoUrl"`},
}

type updateColumn struct {
	Name      string
	Timestamp bool
}

func updateAssignments(updates map[string]any, allowed map[string]updateColumn) ([]string, []any, error) {
	if len(updates) == 0 {
		return nil, nil, errors.New("update requires at least one field")
	}
	assignments := make([]string, 0, len(updates))
	args := make([]any, 0, len(updates))
	keys := make([]string, 0, len(updates))
	for key := range updates {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		value := updates[key]
		column, ok := allowed[key]
		if !ok {
			return nil, nil, fmt.Errorf("unsupported PostgreSQL store update field: %s", key)
		}
		args = append(args, postgresValue(MaskSecrets(value), column))
		assignments = append(assignments, column.Name+" = $"+strconv.Itoa(len(args)))
	}
	return assignments, args, nil
}

func postgresValue(value any, column updateColumn) any {
	if value == nil {
		return nil
	}
	if column.Timestamp {
		if typed, ok := value.(time.Time); ok {
			return typed
		}
		parsed := parseTime(fmt.Sprintf("%v", value), time.Time{})
		if !parsed.IsZero() {
			return parsed
		}
	}
	return value
}

func jsonMap(input []byte) map[string]any {
	if len(input) == 0 {
		return map[string]any{}
	}
	var out map[string]any
	if err := json.Unmarshal(input, &out); err != nil {
		return map[string]any{}
	}
	return out
}

func nullString(value sql.NullString) string {
	if value.Valid {
		return value.String
	}
	return ""
}

func rollbackUnlessCommitted(tx *sql.Tx) {
	_ = tx.Rollback()
}
