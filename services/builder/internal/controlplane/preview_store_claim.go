package controlplane

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

func (s *PostgresStore) ClaimNextPreviewResolution(ctx context.Context, workerID string, now time.Time) (*PreviewResolutionClaim, error) {
	if strings.TrimSpace(workerID) == "" {
		return nil, errors.New("preview resolver worker ID is required")
	}
	now = now.UTC()
	if now.IsZero() {
		now = time.Now().UTC()
	}
	var jobID, organizationID, serviceID string
	err := s.db.QueryRowContext(ctx, previewCandidateSQL, now, now.Add(-PreviewLeaseDuration)).Scan(&jobID, &organizationID, &serviceID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("find preview resolution candidate: %w", err)
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, fmt.Errorf("begin preview resolution claim: %w", err)
	}
	defer rollbackUnlessCommitted(tx)
	if err := lockPreviewTenant(ctx, tx, organizationID, serviceID); err != nil {
		return nil, err
	}
	row, err := scanPreviewClaim(tx.QueryRowContext(ctx, previewLockClaimSQL, jobID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("lock preview resolution claim: %w", err)
	}
	payload, payloadErr := parsePreviewClaimPayload(row.payload)
	firstClaimAt := payload.firstClaimAt
	deadlineAt := payload.deadlineAt
	if firstClaimAt.IsZero() {
		firstClaimAt = now
		deadlineAt = now.Add(PreviewDeadline)
	}
	if deadlineAt.After(firstClaimAt.Add(PreviewDeadline)) {
		deadlineAt = firstClaimAt.Add(PreviewDeadline)
	}
	preservedDeadline := row.attempts == 0 || (!payload.firstClaimAt.IsZero() && !payload.deadlineAt.IsZero() && !payload.deadlineAt.After(payload.firstClaimAt.Add(PreviewDeadline)))
	valid := payloadErr == nil && payload.version == 1 && payload.lineageID == row.targetID && payload.lineageVersion == row.lineageVersion && preservedDeadline &&
		row.maxAttempts == PreviewMaxAttempts && row.jobID == fmt.Sprintf("preview-resolve:%s:%d", row.targetID, row.lineageVersion) && previewBindingActive(row)
	claimable := (row.status == WorkflowQueued || (row.status == WorkflowRunning && row.lockedAt.Valid && !row.lockedAt.Time.Add(PreviewLeaseDuration).After(now))) && row.attempts < PreviewMaxAttempts
	if !valid {
		if err := cancelPreviewJob(ctx, tx, row.jobID, "PREVIEW_RESOLUTION_STALE", now); err != nil {
			return nil, err
		}
		if err := tx.Commit(); err != nil {
			return nil, fmt.Errorf("commit stale preview resolution: %w", err)
		}
		return nil, nil
	}
	if !claimable || !deadlineAt.After(now) {
		if (row.attempts >= PreviewMaxAttempts || !deadlineAt.After(now)) && (row.status == WorkflowQueued || row.status == WorkflowRunning) {
			if err := failPreviewJobTerminal(ctx, tx, row.jobID, row.targetID, PreviewErrorDeadline, now); err != nil {
				return nil, err
			}
		}
		if err := tx.Commit(); err != nil {
			return nil, fmt.Errorf("commit preview resolution terminalization: %w", err)
		}
		return nil, nil
	}
	claimToken, err := newPreviewClaimToken()
	if err != nil {
		return nil, err
	}
	result, err := tx.ExecContext(ctx, `UPDATE "WorkflowJob" SET status='running',attempts=attempts+1,"lockedBy"=$2,"lockedAt"=$3,"updatedAt"=$3,
payload=jsonb_set(jsonb_set(jsonb_set(payload,'{claimToken}',to_jsonb($4::text),true),'{firstClaimAt}',to_jsonb($5::text),true),'{deadlineAt}',to_jsonb($6::text),true)
WHERE id=$1`, row.jobID, workerID, now, claimToken, firstClaimAt.Format(time.RFC3339Nano), deadlineAt.Format(time.RFC3339Nano))
	if err != nil {
		return nil, fmt.Errorf("claim preview resolution: %w", err)
	}
	updated, err := result.RowsAffected()
	if err != nil || updated != 1 {
		return nil, ErrPreviewResolutionLeaseLost
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit preview resolution claim: %w", err)
	}
	return &PreviewResolutionClaim{
		Target: PreviewResolutionTarget{LineageID: row.targetID, LineageVersion: row.lineageVersion, InstallationID: row.installationID, RepositoryID: row.repositoryID, Repository: row.repository, PullRequestNumber: row.pullNumber},
		JobID:  row.jobID, WorkerID: workerID, Attempt: row.attempts + 1, ClaimToken: claimToken, DeadlineAt: deadlineAt,
	}, nil
}

func (s *PostgresStore) RenewPreviewResolutionLease(ctx context.Context, claim PreviewResolutionClaim, now time.Time) error {
	now = now.UTC()
	result, err := s.db.ExecContext(ctx, `UPDATE "WorkflowJob" SET "lockedAt"=$1,"updatedAt"=$1 WHERE id=$2 AND type='github.preview-resolve' AND status='running' AND "lockedBy"=$3 AND attempts=$4 AND payload->>'claimToken'=$5 AND "lockedAt">$6 AND (payload->>'deadlineAt')::timestamptz>$1`, now, claim.JobID, claim.WorkerID, claim.Attempt, claim.ClaimToken, now.Add(-PreviewLeaseDuration))
	if err != nil {
		return fmt.Errorf("renew preview resolution lease: %w", err)
	}
	updated, err := result.RowsAffected()
	if err != nil || updated != 1 {
		return ErrPreviewResolutionLeaseLost
	}
	return nil
}

func newPreviewClaimToken() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", fmt.Errorf("generate preview claim token: %w", err)
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	hexValue := hex.EncodeToString(value[:])
	return hexValue[:8] + "-" + hexValue[8:12] + "-" + hexValue[12:16] + "-" + hexValue[16:20] + "-" + hexValue[20:], nil
}
