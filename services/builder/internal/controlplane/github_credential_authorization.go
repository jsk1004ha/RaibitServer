package controlplane

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

var errGitHubCredentialScope = errors.New("GitHub clone credential authorization denied")

type githubCredentialBinding struct {
	Lease                                                   WorkflowLease
	OrganizationID, ProjectID, ServiceID, DeploymentID      string
	IntegrationID, InstallationID, RepositoryID, Repository string
}

type githubCredentialAuthorizer interface {
	authorizeGitHubCredential(context.Context, githubCredentialBinding, bool) error
}

// The existing workflow payload holds only a non-secret attempt reservation.
// All ownership rows are locked together; an issuer call never occurs in this transaction.
const authorizeGitHubCredentialSQL = `
SELECT COALESCE(w.payload -> '_githubCloneAttempt' ->> 'attempt', '')
FROM "WorkflowJob" w
JOIN "Deployment" d ON d.id = $6
JOIN "Service" s ON s.id = d."serviceId" AND s.id = $5
JOIN "Project" p ON p.id = d."projectId" AND p.id = s."projectId" AND p.id = $4
JOIN "GitHubIntegration" i ON i.id = $7 AND i."organizationId" = p."organizationId"
JOIN "GitHubInstallation" a ON a."installationId" = i."installationId"
JOIN "GitHubRepository" r ON r."installationId" = a."installationId" AND r.generation = a.generation AND r."accessState" = 'ACCESSIBLE'
WHERE w.id = $1 AND w.status = 'running' AND w."lockedBy" = $2 AND w.attempts = $3
AND w.type IN ('build-and-deploy', 'preview-deploy', 'build', 'builder')
AND w."lockedAt" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '300 seconds'
AND w."lockedAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '5 seconds'
AND (NULLIF(BTRIM(w.payload ->> 'deploymentId'), '') = d.id
 OR (LOWER(w."targetType") = 'deployment' AND w."targetId" = d.id))
AND (NULLIF(BTRIM(w.payload ->> 'deploymentId'), '') IS NULL OR w.payload ->> 'deploymentId' = d.id)
AND (LOWER(w."targetType") <> 'deployment' OR w."targetId" = d.id)
AND (NULLIF(w.payload ->> 'serviceId', '') IS NULL OR w.payload ->> 'serviceId' = s.id)
AND (NULLIF(w.payload ->> 'projectId', '') IS NULL OR w.payload ->> 'projectId' = p.id)
AND (NULLIF(w.payload ->> 'organizationId', '') IS NULL OR w.payload ->> 'organizationId' = p."organizationId")
AND p."organizationId" = $8 AND i."verifiedAt" IS NOT NULL AND i.status = 'ACTIVE'
AND i."installationId" = $9 AND r."githubRepoId" = $10 AND r.private = TRUE
AND LOWER(r."fullName") = $11 AND s."githubRepositoryId" = r."githubRepoId"
AND LOWER(s."repoUrl") = 'https://github.com/' || $11 || '.git'
AND COALESCE(s."desiredState" ->> 'githubIntegrationId', s."desiredState" -> 'github' ->> 'integrationId') = i.id
AND COALESCE(s."desiredState" ->> 'githubInstallationId', s."desiredState" -> 'github' ->> 'installationId') = i."installationId"
AND COALESCE(s."desiredState" ->> 'githubRepositoryId', s."desiredState" -> 'github' ->> 'repositoryId') = r."githubRepoId"
AND LOWER(COALESCE(s."desiredState" ->> 'githubRepository', s."desiredState" -> 'github' ->> 'repository')) = $11
AND COALESCE(s."desiredState" ->> 'githubRepositoryVisibility', s."desiredState" -> 'github' ->> 'visibility') = 'private'
AND COALESCE(s."desiredState" ->> 'sourceAccess', s."desiredState" -> 'github' ->> 'sourceAccess') IN ('github-app-private','github-app-public')
AND UPPER(p.status) NOT IN ('DELETE_REQUESTED', 'DELETING', 'DELETE_FAILED', 'DELETED')
AND UPPER(s.status) NOT IN ('DELETE_REQUESTED', 'DELETING', 'DELETE_FAILED', 'DELETED')
AND d.status IN ('BUILDING', 'QUEUED')
FOR UPDATE OF w, d, s, p, i, a, r`

func (s *PostgresStore) authorizeGitHubCredential(ctx context.Context, binding githubCredentialBinding, reserve bool) (err error) {
	if binding.OrganizationID == "" || binding.Repository == "" || strings.ContainsAny(binding.Repository, "\r\n\x00") {
		return errGitHubCredentialScope
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return errGitHubCredentialScope
	}
	defer func() {
		if rollbackErr := tx.Rollback(); rollbackErr != nil && !errors.Is(rollbackErr, sql.ErrTxDone) {
			err = errors.Join(err, errGitHubCredentialScope)
		}
	}()
	var previousAttempt string
	err = tx.QueryRowContext(ctx, authorizeGitHubCredentialSQL,
		binding.Lease.JobID, binding.Lease.WorkerID, binding.Lease.Attempt,
		binding.ProjectID, binding.ServiceID, binding.DeploymentID, binding.IntegrationID,
		binding.OrganizationID, binding.InstallationID, binding.RepositoryID, strings.ToLower(binding.Repository)).Scan(&previousAttempt)
	if err != nil {
		return errGitHubCredentialScope
	}
	if reserve {
		result, updateErr := tx.ExecContext(ctx, `UPDATE "WorkflowJob" SET payload = jsonb_set(COALESCE(payload, '{}'), '{_githubCloneAttempt}', jsonb_build_object('attempt', attempts, 'workerId', "lockedBy")) WHERE id = $1 AND COALESCE(payload -> '_githubCloneAttempt' ->> 'attempt', '') <> attempts::text`, binding.Lease.JobID)
		if updateErr != nil {
			return errGitHubCredentialScope
		}
		count, countErr := result.RowsAffected()
		if countErr != nil || count != 1 {
			return errGitHubCredentialScope
		}
	} else {
		var matches bool
		if err := tx.QueryRowContext(ctx, `SELECT payload -> '_githubCloneAttempt' ->> 'attempt' = attempts::text AND payload -> '_githubCloneAttempt' ->> 'workerId' = "lockedBy" FROM "WorkflowJob" WHERE id = $1`, binding.Lease.JobID).Scan(&matches); err != nil || !matches {
			return errGitHubCredentialScope
		}
	}
	if err := tx.Commit(); err != nil {
		return errGitHubCredentialScope
	}
	return nil
}
