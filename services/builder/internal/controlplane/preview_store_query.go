package controlplane

import (
	"context"
	"database/sql"
	"fmt"
)

type previewClaimRow struct {
	jobID, jobType, status, targetType, targetID, workerID string
	payload, desiredState                                  []byte
	attempts, maxAttempts, lineageVersion, pullNumber      int
	organizationID, projectID, serviceID, integrationID    string
	installationID, repositoryID, repository               string
	repositoryOwner, repositoryName                        string
	projectStatus, serviceStatus                           string
	environmentID, environmentKind, logicalSlug            string
	verified                                               bool
	lockedAt                                               sql.NullTime
}

const previewCandidateSQL = `
SELECT w.id,l."organizationId",l."serviceId"
FROM "WorkflowJob" w
JOIN "PreviewLineage" l ON l.id=w."targetId"
LEFT JOIN "EnvironmentService" binding ON binding."serviceId"=l."serviceId" AND binding."projectId"=l."projectId"
LEFT JOIN "Environment" environment ON environment.id=binding."environmentId" AND environment."projectId"=binding."projectId"
WHERE w.type='github.preview-resolve' AND w."targetType"='preview-lineage'
  AND ((w.status='queued' AND w."runAfter" <= $1) OR (w.status='running' AND w."lockedAt" <= $2))
  AND (l."environmentId" IS NULL OR l."environmentId"=binding."environmentId")
  AND (COALESCE(environment.kind,'prod')='prod' OR ($3=2 AND w."operationalProtocolVersion"=2))
  AND ($3=1 OR binding."serviceId" IS NOT NULL)
ORDER BY w."runAfter",w."createdAt",w.id
LIMIT 1`

const previewLockClaimSQL = `
SELECT w.id,w.type,w.status,w."targetType",w."targetId",w.payload,w.attempts,w."maxAttempts",COALESCE(w."lockedBy",''),w."lockedAt",
 l.version,l."organizationId",l."projectId",l."serviceId",l."integrationId",l."installationId",l."repositoryId",l.repository,l."pullRequestNumber",
 COALESCE(l."environmentId",binding."environmentId",''),COALESCE(environment.kind,'prod'),COALESCE(binding."logicalSlug",s.slug),
 p.status,s.status,s."desiredState",(i."verifiedAt" IS NOT NULL),r.owner,r.name
FROM "WorkflowJob" w
JOIN "PreviewLineage" l ON l.id=w."targetId"
JOIN "Project" p ON p.id=l."projectId" AND p."organizationId"=l."organizationId"
JOIN "Service" s ON s.id=l."serviceId" AND s."projectId"=p.id
JOIN "EnvironmentService" binding ON binding."serviceId"=s.id AND binding."projectId"=s."projectId"
JOIN "Environment" environment ON environment.id=binding."environmentId" AND environment."projectId"=binding."projectId"
JOIN "GitHubIntegration" i ON i.id=l."integrationId" AND i."organizationId"=l."organizationId" AND i."installationId"=l."installationId"
JOIN "GitHubRepository" r ON r."installationId"=l."installationId" AND r."githubRepoId"=l."repositoryId" AND r."fullName"=l.repository
WHERE w.id=$1 AND (l."environmentId" IS NULL OR l."environmentId"=binding."environmentId")
FOR UPDATE OF w,l,p,s,i,r`

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
		&result.environmentID, &result.environmentKind, &result.logicalSlug,
		&result.projectStatus, &result.serviceStatus, &result.desiredState, &result.verified, &result.repositoryOwner, &result.repositoryName)
	return &result, err
}
