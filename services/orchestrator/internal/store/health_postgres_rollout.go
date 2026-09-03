package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"
)

func (s *PostgresStore) CompleteRollout(ctx context.Context, input RolloutCompletion) (*Deployment, error) {
	input.Now = healthClock(input.Now)
	observation, err := rolloutObservation(input)
	if err != nil {
		return nil, err
	}
	var result *Deployment
	err = s.healthTransaction(ctx, func(tx *sql.Tx) error {
		h := healthTransaction{ctx: ctx, tx: tx}
		d, err := h.deployment(input.Lease.DeploymentID)
		if err != nil {
			return err
		}
		if d == nil {
			return ErrDeploymentLeaseLost
		}
		if observation != nil && observation.Public && stringField(d, "status") == "READY" && sameFileObservation(d, *observation) {
			var exists bool
			if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM "WorkflowJob" WHERE id=$1 AND type=$2)`, healthJobID(*observation), PublicHealthObserve).Scan(&exists); err != nil {
				return err
			}
			if exists {
				result = deploymentFromRecord(d)
				return nil
			}
		}
		duration := input.LeaseDuration
		if duration <= 0 {
			duration = 15 * time.Minute
		}
		lockedAt := parseTimestamp(stringField(d, "reconcileLockedAt"))
		if !recordOwnsDeploymentLease(d, input.Lease) || lockedAt.IsZero() || !lockedAt.Add(duration).After(input.Now) {
			return ErrDeploymentLeaseLost
		}
		var generation sql.NullInt64
		if observation != nil {
			if observation.ProjectID != stringField(d, "projectId") || observation.ServiceID != stringField(d, "serviceId") {
				return ErrHealthObservation
			}
			generation = sql.NullInt64{Int64: int64(observation.ObservedGeneration), Valid: true}
		}
		image := input.ImageURL
		if image == "" {
			image = stringField(d, "imageUrl")
		}
		_, err = tx.ExecContext(ctx, `UPDATE "Deployment" SET status='READY',"deployedAt"=$2,"finishedAt"=$2,"updatedAt"=$2,
 "errorCode"=NULL,"errorMessage"=NULL,"reconcileAction"=NULL,"reconcileLockedBy"=NULL,"reconcileLockedAt"=NULL,
 "publicHealthStatus"='UNKNOWN',"healthCheckedAt"=NULL,"healthFailureCode"=NULL,"observedGeneration"=$3,"imageUrl"=$4 WHERE id=$1`, input.Lease.DeploymentID, input.Now, generation, nullable(image))
		if err != nil {
			return err
		}
		if observation != nil && observation.Public {
			raw, err := json.Marshal(observation)
			if err != nil {
				return err
			}
			_, err = tx.ExecContext(ctx, `INSERT INTO "WorkflowJob" (id,type,status,"targetType","targetId",payload,attempts,"maxAttempts","runAfter","createdAt","updatedAt") VALUES($1,$2,'queued','deployment',$3,$4,0,3,$5,$5,$5) ON CONFLICT(id) DO NOTHING`, healthJobID(*observation), PublicHealthObserve, observation.DeploymentID, raw, input.Now)
			if err != nil {
				return err
			}
		}
		d["status"] = "READY"
		d["imageUrl"] = image
		d["reconcileLockedBy"] = nil
		d["reconcileLockedAt"] = nil
		d["reconcileAction"] = nil
		d["publicHealthStatus"] = "UNKNOWN"
		d["healthCheckedAt"] = nil
		d["healthFailureCode"] = nil
		d["observedGeneration"] = nil
		if observation != nil {
			d["observedGeneration"] = observation.ObservedGeneration
		}
		result = deploymentFromRecord(d)
		return nil
	})
	return result, err
}
