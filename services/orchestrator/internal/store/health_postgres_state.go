package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

func (s *PostgresStore) healthTransaction(ctx context.Context, apply func(*sql.Tx) error) (err error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return fmt.Errorf("begin health transaction: %w", err)
	}
	defer func() {
		if rollbackErr := tx.Rollback(); rollbackErr != nil && !errors.Is(rollbackErr, sql.ErrTxDone) {
			err = errors.Join(err, rollbackErr)
		}
	}()
	if err = apply(tx); err != nil {
		return err
	}
	return tx.Commit()
}

type healthTransaction struct {
	ctx context.Context
	tx  *sql.Tx
}

func (h healthTransaction) deployment(id string) (record, error) {
	var raw []byte
	err := h.tx.QueryRowContext(h.ctx, `SELECT to_jsonb(d) FROM "Deployment" d
 JOIN "Service" s ON s.id=d."serviceId" AND s."projectId"=d."projectId"
 JOIN "Project" p ON p.id=d."projectId"
 WHERE d.id=$1 AND UPPER(s.status) NOT IN ('DELETE_REQUESTED','DELETING','DELETED')
 AND UPPER(p.status) NOT IN ('DELETE_REQUESTED','DELETING','DELETED')
 FOR UPDATE OF d,s,p`, id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var d record
	if err := json.Unmarshal(raw, &d); err != nil {
		return nil, err
	}
	// PostgreSQL timestamp JSON has no timezone; normalize at this adapter.
	for _, key := range []string{"createdAt", "reconcileLockedAt", "deployedAt", "finishedAt", "healthCheckedAt"} {
		text := stringField(d, key)
		if text != "" {
			if at, err := time.Parse("2006-01-02T15:04:05.999999", text); err == nil {
				d[key] = at.UTC().Format(time.RFC3339Nano)
			}
		}
	}
	return d, nil
}

func (h healthTransaction) current(p HealthObservation) (record, bool, error) {
	d, err := h.deployment(p.DeploymentID)
	if err != nil {
		return nil, false, err
	}
	if !sameFileObservation(d, p) || stringField(d, "status") != "READY" {
		return d, false, nil
	}
	var newer bool
	err = h.tx.QueryRowContext(h.ctx, `SELECT EXISTS (SELECT 1 FROM "Deployment" n JOIN "Deployment" d ON d.id=$1
 WHERE n."serviceId"=d."serviceId" AND n.id<>d.id AND n."deploymentType"=d."deploymentType"
 AND COALESCE(n."pullRequestNumber",0)=COALESCE(d."pullRequestNumber",0)
 AND n.status IN ('DEPLOYING','READY') AND (n."createdAt",n.id)>(d."createdAt",d.id))`, p.DeploymentID).Scan(&newer)
	return d, !newer, err
}

func (h healthTransaction) cancel(job HealthJob, at time.Time) error {
	if _, err := h.tx.ExecContext(h.ctx, `UPDATE "WorkflowJob" SET status='cancelled',"lockedBy"=NULL,"lockedAt"=NULL,"updatedAt"=$2 WHERE id=$1`, job.ID, at); err != nil {
		return err
	}
	_, err := h.tx.ExecContext(h.ctx, `UPDATE "Deployment" SET "publicHealthStatus"='UNKNOWN' WHERE id=$1 AND "serviceId"=$2 AND "projectId"=$3 AND "reconcileAttempts"=$4 AND "observedGeneration"=$5 AND "publicHealthStatus"='CHECKING'`, job.Payload.DeploymentID, job.Payload.ServiceID, job.Payload.ProjectID, job.Payload.RolloutAttempt, job.Payload.ObservedGeneration)
	return err
}

func (h healthTransaction) terminal(job HealthJob, result HealthCompletion, status string) error {
	if _, err := h.tx.ExecContext(h.ctx, `UPDATE "WorkflowJob" SET status=$2,"lockedBy"=NULL,"lockedAt"=NULL,"updatedAt"=$3 WHERE id=$1`, job.ID, status, result.Now); err != nil {
		return err
	}
	_, err := h.tx.ExecContext(h.ctx, `UPDATE "Deployment" SET "publicHealthStatus"=$2,"healthFailureCode"=$3,"healthCheckedAt"=$4 WHERE id=$1`, job.Payload.DeploymentID, result.Status, nullable(result.FailureCode), result.Now)
	return err
}

func scanHealthJob(row rowScanner) (HealthJob, error) {
	var job HealthJob
	var raw []byte
	var lockedBy sql.NullString
	var lockedAt sql.NullTime
	var targetType, targetID string
	if err := row.Scan(&job.ID, &raw, &job.Attempts, &lockedBy, &lockedAt, &targetType, &targetID); err != nil {
		return job, err
	}
	job.LockedBy = lockedBy.String
	if lockedAt.Valid {
		job.LeaseExpiresAt = lockedAt.Time.Add(HealthLeaseDuration)
	}
	payload, err := parseHealthObservation(raw)
	if err != nil {
		return job, err
	}
	job.Payload = payload
	if !payload.Public || job.ID != healthJobID(payload) || targetType != "deployment" || targetID != payload.DeploymentID {
		job.Payload = HealthObservation{}
		return job, ErrHealthObservation
	}
	return job, nil
}
