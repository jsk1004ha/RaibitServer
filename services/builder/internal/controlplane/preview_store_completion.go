package controlplane

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

func (s *PostgresStore) CommitPreviewResolution(ctx context.Context, claim PreviewResolutionClaim, observation PreviewResolutionObservation, now time.Time) (bool, error) {
	now = now.UTC()
	tx, row, err := s.lockPreviewClaimForCompletion(ctx, claim)
	if err != nil {
		return false, err
	}
	defer rollbackUnlessCommitted(tx)
	if !previewClaimMatchesRow(row, claim) || !previewBindingActive(row) {
		if err := cancelPreviewJob(ctx, tx, claim.JobID, "PREVIEW_RESOLUTION_STALE", now); err != nil {
			return false, err
		}
		if err := tx.Commit(); err != nil {
			return false, fmt.Errorf("commit stale preview resolution: %w", err)
		}
		return false, nil
	}
	if !previewClaimLeaseMatches(row, claim, now) {
		return false, ErrPreviewResolutionLeaseLost
	}
	if !validPreviewObservation(observation) || observation.LineageID != claim.Target.LineageID || observation.LineageVersion != claim.Target.LineageVersion || observation.InstallationID != claim.Target.InstallationID || observation.RepositoryID != claim.Target.RepositoryID || observation.PullRequestNumber != claim.Target.PullRequestNumber {
		return false, errors.New("preview resolution observation identity mismatch")
	}
	observationJSON, err := json.Marshal(observation)
	if err != nil {
		return false, fmt.Errorf("encode preview resolution observation: %w", err)
	}
	lineageResult, err := tx.ExecContext(ctx, `UPDATE "PreviewLineage" SET "resolutionObservation"=$1::jsonb,"resolutionErrorCode"=NULL,"updatedAt"=$2 WHERE id=$3 AND version=$4`, observationJSON, now, claim.Target.LineageID, claim.Target.LineageVersion)
	if err != nil {
		return false, fmt.Errorf("persist preview resolution observation: %w", err)
	}
	if updated, rowsErr := lineageResult.RowsAffected(); rowsErr != nil || updated != 1 {
		return false, ErrPreviewResolutionLeaseLost
	}
	applyID := fmt.Sprintf("preview-apply:%s:%d", claim.Target.LineageID, claim.Target.LineageVersion)
	result, err := tx.ExecContext(ctx, `INSERT INTO "WorkflowJob" (id,type,status,"targetType","targetId",payload,attempts,"maxAttempts","runAfter","updatedAt")
VALUES ($1,'github.preview-apply','queued','preview-lineage',$2,jsonb_build_object('version',1,'lineageId',$2::text,'lineageVersion',$3::int),0,3,$4,$4)
ON CONFLICT (id) DO UPDATE SET id=EXCLUDED.id WHERE "WorkflowJob".type=EXCLUDED.type AND "WorkflowJob"."targetType"=EXCLUDED."targetType" AND "WorkflowJob"."targetId"=EXCLUDED."targetId" AND "WorkflowJob".payload=EXCLUDED.payload`, applyID, claim.Target.LineageID, claim.Target.LineageVersion, now)
	if err != nil {
		return false, fmt.Errorf("enqueue preview apply: %w", err)
	}
	updated, err := result.RowsAffected()
	if err != nil || updated != 1 {
		return false, errors.New("preview apply job identity collision")
	}
	if _, err := tx.ExecContext(ctx, `UPDATE "WorkflowJob" SET status='succeeded',"lockedBy"=NULL,"lockedAt"=NULL,"updatedAt"=$2 WHERE id=$1`, claim.JobID, now); err != nil {
		return false, fmt.Errorf("complete preview resolution: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("commit preview resolution: %w", err)
	}
	return true, nil
}

func (s *PostgresStore) FailPreviewResolution(ctx context.Context, claim PreviewResolutionClaim, code string, now time.Time) error {
	if code != PreviewErrorAuth && code != PreviewErrorFetch && code != PreviewErrorInvalid && code != PreviewErrorDeadline {
		code = PreviewErrorInvalid
	}
	tx, row, err := s.lockPreviewClaimForCompletion(ctx, claim)
	if err != nil {
		return err
	}
	defer rollbackUnlessCommitted(tx)
	if !previewClaimMatchesRow(row, claim) || !previewBindingActive(row) {
		if err := cancelPreviewJob(ctx, tx, claim.JobID, "PREVIEW_RESOLUTION_STALE", now); err != nil {
			return err
		}
		return tx.Commit()
	}
	if !previewClaimLeaseMatches(row, claim, now.UTC()) {
		return ErrPreviewResolutionLeaseLost
	}
	terminal := claim.Attempt >= PreviewMaxAttempts || !claim.DeadlineAt.After(now)
	status := WorkflowQueued
	runAfter := now.Add(time.Duration(claim.Attempt) * time.Second)
	if terminal {
		status = WorkflowFailed
		runAfter = now
		if _, err := tx.ExecContext(ctx, `UPDATE "PreviewLineage" SET "resolutionErrorCode"=$1,"updatedAt"=$2 WHERE id=$3 AND version=$4`, code, now, claim.Target.LineageID, claim.Target.LineageVersion); err != nil {
			return fmt.Errorf("persist preview resolution failure: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE "WorkflowJob" SET status=$1,"runAfter"=$2,"lockedBy"=NULL,"lockedAt"=NULL,"updatedAt"=$3,payload=jsonb_set(payload,'{terminalReason}',to_jsonb($4::text),true) WHERE id=$5`, status, runAfter, now, code, claim.JobID); err != nil {
		return fmt.Errorf("fail preview resolution: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit preview resolution failure: %w", err)
	}
	return nil
}

func (s *PostgresStore) lockPreviewClaimForCompletion(ctx context.Context, claim PreviewResolutionClaim) (*sql.Tx, *previewClaimRow, error) {
	var organizationID, serviceID string
	if err := s.db.QueryRowContext(ctx, `SELECT "organizationId","serviceId" FROM "PreviewLineage" WHERE id=$1`, claim.Target.LineageID).Scan(&organizationID, &serviceID); err != nil {
		return nil, nil, ErrPreviewResolutionLeaseLost
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, nil, fmt.Errorf("begin preview resolution completion: %w", err)
	}
	if err := lockPreviewTenant(ctx, tx, organizationID, serviceID); err != nil {
		_ = tx.Rollback()
		return nil, nil, err
	}
	row, err := scanPreviewClaim(tx.QueryRowContext(ctx, previewLockClaimSQL, claim.JobID))
	if err != nil {
		_ = tx.Rollback()
		return nil, nil, ErrPreviewResolutionLeaseLost
	}
	return tx, row, nil
}

func cancelPreviewJob(ctx context.Context, tx *sql.Tx, jobID, reason string, now time.Time) error {
	_, err := tx.ExecContext(ctx, `UPDATE "WorkflowJob" SET status='cancelled',"lockedBy"=NULL,"lockedAt"=NULL,"updatedAt"=$2,payload=jsonb_set(payload,'{terminalReason}',to_jsonb($3::text),true) WHERE id=$1`, jobID, now, reason)
	return err
}

func failPreviewJobTerminal(ctx context.Context, tx *sql.Tx, jobID, lineageID, code string, now time.Time) error {
	if _, err := tx.ExecContext(ctx, `UPDATE "WorkflowJob" SET status='failed',"lockedBy"=NULL,"lockedAt"=NULL,"updatedAt"=$2,payload=jsonb_set(payload,'{terminalReason}',to_jsonb($3::text),true) WHERE id=$1`, jobID, now, code); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `UPDATE "PreviewLineage" SET "resolutionErrorCode"=$1,"updatedAt"=$2 WHERE id=$3`, code, now, lineageID)
	return err
}
