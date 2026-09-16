package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

const claimHealthJobSQL = `SELECT j.id,j.payload,j.attempts,j."lockedBy",j."lockedAt",j."targetType",j."targetId"
 FROM "WorkflowJob" j WHERE j.type=$1 AND j.status IN ('queued','running') AND (
 (j.status='queued' AND j."runAfter"<=$2) OR (j.status='running' AND (j."lockedAt" IS NULL OR j."lockedAt"<=$3))
 OR NOT EXISTS (SELECT 1 FROM "Deployment" d JOIN "Service" s ON s.id=d."serviceId" AND s."projectId"=d."projectId"
 JOIN "Project" p ON p.id=d."projectId" WHERE d.id=j."targetId" AND d.status='READY'
 AND UPPER(s.status) NOT IN ('DELETE_REQUESTED','DELETING','DELETED') AND UPPER(p.status) NOT IN ('DELETE_REQUESTED','DELETING','DELETED')))
 ORDER BY j."runAfter",j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`

func (s *PostgresStore) ClaimNextHealth(ctx context.Context, options ClaimOptions) (*HealthJob, error) {
	at := healthClock(options.Now)
	worker := strings.TrimSpace(options.WorkerID)
	if worker == "" {
		return nil, ErrHealthLeaseLost
	}
	var claimed *HealthJob
	err := s.healthTransaction(ctx, func(tx *sql.Tx) error {
		h := healthTransaction{ctx: ctx, tx: tx}
		for range 100 {
			job, err := scanHealthJob(tx.QueryRowContext(ctx, claimHealthJobSQL, PublicHealthObserve, at, at.Add(-HealthLeaseDuration)))
			if errors.Is(err, sql.ErrNoRows) {
				return nil
			}
			if err != nil && !errors.Is(err, ErrHealthObservation) {
				return err
			}
			if errors.Is(err, ErrHealthObservation) {
				if err := h.cancel(job, at); err != nil {
					return err
				}
				continue
			}
			d, current, err := h.current(job.Payload)
			if err != nil {
				return err
			}
			if !current {
				if err := h.cancel(job, at); err != nil {
					return err
				}
				continue
			}
			if job.Attempts >= 3 {
				if err := h.cancel(job, at); err != nil {
					return err
				}
				continue
			}
			if _, err := tx.ExecContext(ctx, `UPDATE "WorkflowJob" SET status='running',attempts=attempts+1,"lockedBy"=$2,"lockedAt"=$3,"updatedAt"=$3 WHERE id=$1`, job.ID, worker, at); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE "Deployment" SET "publicHealthStatus"='CHECKING' WHERE id=$1`, job.Payload.DeploymentID); err != nil {
				return err
			}
			job.Attempts++
			job.DeploymentType = stringField(d, "deploymentType")
			job.PullRequestNumber = intField(d, "pullRequestNumber")
			job.PreviewLineageID = stringField(d, "previewLineageId")
			job.PreviewGeneration = intField(d, "previewGeneration")
			job.PreviewRuntime = rawJSONFromRecord(d, "previewRuntime")
			job.LockedBy = worker
			job.LeaseExpiresAt = at.Add(HealthLeaseDuration)
			claimed = &job
			return nil
		}
		return nil
	})
	return claimed, err
}

func (s *PostgresStore) RenewHealthLease(ctx context.Context, lease HealthLease, at time.Time) error {
	return s.mutateHealth(ctx, HealthCompletion{Lease: lease, Now: at}, "renew")
}

func (s *PostgresStore) FinishHealth(ctx context.Context, result HealthCompletion) error {
	if !validHealthResult(result) {
		return ErrHealthObservation
	}
	return s.mutateHealth(ctx, result, "finish")
}

func (s *PostgresStore) CancelHealth(ctx context.Context, lease HealthLease, at time.Time) error {
	return s.mutateHealth(ctx, HealthCompletion{Lease: lease, Now: at}, "cancel")
}

func (s *PostgresStore) mutateHealth(ctx context.Context, result HealthCompletion, operation string) error {
	result.Now = healthClock(result.Now)
	stale := false
	err := s.healthTransaction(ctx, func(tx *sql.Tx) error {
		h := healthTransaction{ctx: ctx, tx: tx}
		job, err := scanHealthJob(tx.QueryRowContext(ctx, `SELECT id,payload,attempts,"lockedBy","lockedAt","targetType","targetId" FROM "WorkflowJob"
 WHERE id=$1 AND type=$2 AND status='running' AND "lockedBy"=$3 AND attempts=$4 AND "lockedAt">$5 FOR UPDATE`, result.Lease.JobID, PublicHealthObserve, result.Lease.WorkerID, result.Lease.Attempt, result.Now.Add(-HealthLeaseDuration)))
		if errors.Is(err, sql.ErrNoRows) || errors.Is(err, ErrHealthObservation) {
			return ErrHealthLeaseLost
		}
		if err != nil {
			return err
		}
		if operation == "cancel" {
			return h.cancel(job, result.Now)
		}
		_, current, err := h.current(job.Payload)
		if err != nil {
			return err
		}
		if !current {
			stale = true
			return h.cancel(job, result.Now)
		}
		if operation == "renew" {
			_, err := tx.ExecContext(ctx, `UPDATE "WorkflowJob" SET "lockedAt"=$2,"updatedAt"=$2 WHERE id=$1`, job.ID, result.Now)
			return err
		}
		status, health, code, due := healthOutcome(job, result)
		if status == "queued" {
			_, err := tx.ExecContext(ctx, `UPDATE "WorkflowJob" SET status='queued',"runAfter"=$2,"lockedBy"=NULL,"lockedAt"=NULL,"updatedAt"=$3 WHERE id=$1`, job.ID, due, result.Now)
			return err
		}
		result.Status = health
		result.FailureCode = code
		return h.terminal(job, result, status)
	})
	if err == nil && stale {
		return ErrHealthLeaseLost
	}
	return err
}
