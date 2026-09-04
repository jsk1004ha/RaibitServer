package controlplane

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

const (
	PreviewResolveJobType = "github.preview-resolve"
	PreviewApplyJobType   = "github.preview-apply"
	PreviewTargetType     = "preview-lineage"
	PreviewLeaseDuration  = 60 * time.Second
	PreviewHeartbeat      = 20 * time.Second
	PreviewMaxAttempts    = 3
	PreviewDeadline       = 5 * time.Minute

	PreviewErrorAuth     = "GITHUB_PREVIEW_AUTH"
	PreviewErrorFetch    = "GITHUB_PREVIEW_FETCH"
	PreviewErrorInvalid  = "GITHUB_PREVIEW_INVALID"
	PreviewErrorDeadline = "GITHUB_PREVIEW_DEADLINE"
)

var ErrPreviewResolutionLeaseLost = errors.New("preview resolution lease ownership lost")

type PreviewResolutionClaim struct {
	Target     PreviewResolutionTarget
	JobID      string
	WorkerID   string
	Attempt    int
	ClaimToken string
	DeadlineAt time.Time
}

type PreviewResolverStore interface {
	ClaimNextPreviewResolution(context.Context, string, time.Time) (*PreviewResolutionClaim, error)
	RenewPreviewResolutionLease(context.Context, PreviewResolutionClaim, time.Time) error
	CommitPreviewResolution(context.Context, PreviewResolutionClaim, PreviewResolutionObservation, time.Time) (bool, error)
	FailPreviewResolution(context.Context, PreviewResolutionClaim, string, time.Time) error
}

type previewClaimRow struct {
	jobID, jobType, status, targetType, targetID, workerID string
	payload, desiredState                                  []byte
	attempts, maxAttempts, lineageVersion, pullNumber      int
	organizationID, projectID, serviceID, integrationID    string
	installationID, repositoryID, repository               string
	repositoryOwner, repositoryName                        string
	projectStatus, serviceStatus                           string
	verified                                               bool
	lockedAt                                               sql.NullTime
}

const previewCandidateSQL = `
SELECT w.id,l."organizationId",l."serviceId"
FROM "WorkflowJob" w
JOIN "PreviewLineage" l ON l.id=w."targetId"
WHERE w.type='github.preview-resolve' AND w."targetType"='preview-lineage'
  AND ((w.status='queued' AND w."runAfter" <= $1) OR (w.status='running' AND w."lockedAt" <= $2))
ORDER BY w."runAfter",w."createdAt",w.id
LIMIT 1`

const previewLockClaimSQL = `
SELECT w.id,w.type,w.status,w."targetType",w."targetId",w.payload,w.attempts,w."maxAttempts",COALESCE(w."lockedBy",''),w."lockedAt",
 l.version,l."organizationId",l."projectId",l."serviceId",l."integrationId",l."installationId",l."repositoryId",l.repository,l."pullRequestNumber",
 p.status,s.status,s."desiredState",(i."verifiedAt" IS NOT NULL),r.owner,r.name
FROM "WorkflowJob" w
JOIN "PreviewLineage" l ON l.id=w."targetId"
JOIN "Project" p ON p.id=l."projectId" AND p."organizationId"=l."organizationId"
JOIN "Service" s ON s.id=l."serviceId" AND s."projectId"=p.id
JOIN "GitHubIntegration" i ON i.id=l."integrationId" AND i."organizationId"=l."organizationId" AND i."installationId"=l."installationId"
JOIN "GitHubRepository" r ON r."installationId"=l."installationId" AND r."githubRepoId"=l."repositoryId" AND r."fullName"=l.repository
WHERE w.id=$1
FOR UPDATE OF w,l,p,s,i,r`

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

func lockPreviewTenant(ctx context.Context, tx *sql.Tx, organizationID, serviceID string) error {
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('preview:organization:' || $1,18))`, organizationID); err != nil {
		return fmt.Errorf("lock preview organization: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,15))`, serviceID); err != nil {
		return fmt.Errorf("lock preview service: %w", err)
	}
	return nil
}

func scanPreviewClaim(row scanner) (*previewClaimRow, error) {
	var result previewClaimRow
	err := row.Scan(&result.jobID, &result.jobType, &result.status, &result.targetType, &result.targetID, &result.payload, &result.attempts, &result.maxAttempts, &result.workerID, &result.lockedAt,
		&result.lineageVersion, &result.organizationID, &result.projectID, &result.serviceID, &result.integrationID, &result.installationID, &result.repositoryID, &result.repository, &result.pullNumber,
		&result.projectStatus, &result.serviceStatus, &result.desiredState, &result.verified, &result.repositoryOwner, &result.repositoryName)
	return &result, err
}

type previewClaimPayload struct {
	version, lineageVersion  int
	lineageID                string
	claimToken               string
	firstClaimAt, deadlineAt time.Time
}

func parsePreviewClaimPayload(raw []byte) (previewClaimPayload, error) {
	var wire struct {
		Version        int    `json:"version"`
		LineageID      string `json:"lineageId"`
		LineageVersion int    `json:"lineageVersion"`
		ClaimToken     string `json:"claimToken"`
		FirstClaimAt   string `json:"firstClaimAt"`
		DeadlineAt     string `json:"deadlineAt"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		return previewClaimPayload{}, err
	}
	first, _ := time.Parse(time.RFC3339Nano, wire.FirstClaimAt)
	deadline, _ := time.Parse(time.RFC3339Nano, wire.DeadlineAt)
	return previewClaimPayload{version: wire.Version, lineageID: wire.LineageID, lineageVersion: wire.LineageVersion, claimToken: wire.ClaimToken, firstClaimAt: first, deadlineAt: deadline}, nil
}

func previewBindingActive(row *previewClaimRow) bool {
	if !row.verified || deletingStatus(row.projectStatus) || deletingStatus(row.serviceStatus) || row.repository != row.repositoryOwner+"/"+row.repositoryName {
		return false
	}
	var desired struct {
		GitHub struct {
			IntegrationID  string `json:"integrationId"`
			InstallationID string `json:"installationId"`
			RepositoryID   string `json:"repositoryId"`
			Repository     string `json:"repository"`
		} `json:"github"`
	}
	if json.Unmarshal(row.desiredState, &desired) != nil {
		return false
	}
	return desired.GitHub.IntegrationID == row.integrationID && desired.GitHub.InstallationID == row.installationID && desired.GitHub.RepositoryID == row.repositoryID && desired.GitHub.Repository == row.repository
}

func deletingStatus(status string) bool {
	status = strings.ToUpper(strings.TrimSpace(status))
	return status == "DELETE_REQUESTED" || status == "DELETING" || status == "DELETE_FAILED" || status == "DELETED"
}

func previewClaimLeaseMatches(row *previewClaimRow, claim PreviewResolutionClaim, now time.Time) bool {
	payload, err := parsePreviewClaimPayload(row.payload)
	return err == nil && row.jobID == claim.JobID && row.jobType == PreviewResolveJobType && row.targetType == PreviewTargetType && row.targetID == claim.Target.LineageID && row.status == WorkflowRunning && row.workerID == claim.WorkerID && row.attempts == claim.Attempt && payload.claimToken == claim.ClaimToken && row.lockedAt.Valid && row.lockedAt.Time.After(now.Add(-PreviewLeaseDuration)) && payload.deadlineAt.After(now)
}

func previewClaimMatchesRow(row *previewClaimRow, claim PreviewResolutionClaim) bool {
	return row.lineageVersion == claim.Target.LineageVersion && row.installationID == claim.Target.InstallationID && row.repositoryID == claim.Target.RepositoryID && row.repository == claim.Target.Repository && row.pullNumber == claim.Target.PullRequestNumber
}

func validPreviewObservation(observation PreviewResolutionObservation) bool {
	installationID, installationErr := strconv.ParseInt(observation.InstallationID, 10, 64)
	repositoryID, repositoryErr := strconv.ParseInt(observation.RepositoryID, 10, 64)
	return observation.Version == 1 && observation.LineageID != "" && observation.LineageVersion > 0 &&
		installationErr == nil && installationID > 0 && installationID <= 9007199254740991 && repositoryErr == nil && repositoryID > 0 && repositoryID <= 9007199254740991 &&
		observation.PullRequestNumber > 0 && (observation.State == "open" || observation.State == "closed") && previewSHA.MatchString(observation.HeadSHA) &&
		validPreviewRef(observation.HeadRef) && validPreviewRef(observation.BaseRef) && !observation.UpdatedAt.IsZero() && !observation.ObservedAt.IsZero() &&
		observation.UpdatedAt.Location() == time.UTC && observation.ObservedAt.Location() == time.UTC && observation.UpdatedAt.Equal(observation.UpdatedAt.Truncate(time.Millisecond)) && observation.ObservedAt.Equal(observation.ObservedAt.Truncate(time.Millisecond))
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
