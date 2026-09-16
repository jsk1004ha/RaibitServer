package store

import (
	"context"
	"database/sql"
	"errors"
	"sort"

	"github.com/raibitserver/log-ingester/internal/identity"
	"github.com/raibitserver/log-ingester/internal/safeerror"
)

type queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func resolve(ctx context.Context, db queryer, deploymentID string) (identity.Scope, error) {
	var input identity.Input
	err := db.QueryRowContext(ctx, `SELECT o.id,p.id,s."projectId",s.id,d.id,p.slug,p.name,s.slug,s.name,s.type,d."deploymentType",d.status,COALESCE(d."reconcileAction",''),p.status,s.status,p."deletionRequestedAt" IS NOT NULL,s."deletionRequestedAt" IS NOT NULL,COALESCE(d."imageUrl",''),COALESCE(d."imageDigest",''),COALESCE(s."imageUrl",''),COALESCE(d."snapshotVersion",0),COALESCE(d."pullRequestNumber",0),d."desiredSpecSnapshot",s."desiredSpec",d."triggerType",COALESCE(d."sourceDeploymentId",''),COALESCE(d."retryOfDeploymentId",''),COALESCE(d."commitSha",'')
 FROM "Deployment" d JOIN "Service" s ON s.id=d."serviceId" JOIN "Project" p ON p.id=d."projectId" AND p.id=s."projectId" JOIN "Organization" o ON o.id=p."organizationId" WHERE d.id=$1`, deploymentID).Scan(
		&input.OrganizationID, &input.ProjectID, &input.ServiceProjectID, &input.ServiceID, &input.DeploymentID, &input.ProjectSlug, &input.ProjectName, &input.ServiceSlug, &input.ServiceName, &input.ServiceType, &input.DeploymentType, &input.Status, &input.Action, &input.ProjectStatus, &input.ServiceStatus, &input.ProjectDeleting, &input.ServiceDeleting, &input.ImageURL, &input.ImageDigest, &input.LiveImageURL, &input.SnapshotVersion, &input.PullRequestNumber, &input.Snapshot, &input.LiveSpec, &input.TriggerType, &input.SourceDeploymentID, &input.RetryOfDeploymentID, &input.CommitSHA)
	if errors.Is(err, sql.ErrNoRows) {
		return identity.Scope{}, identity.ErrIdentity
	}
	if err != nil {
		return identity.Scope{}, &safeerror.Error{Operation: "database identity lookup", Cause: err}
	}
	return identity.Parse(input)
}

func (p *Postgres) Resolve(ctx context.Context, id string) (identity.Scope, error) {
	return resolve(ctx, p.db, id)
}

func lockScopes(ctx context.Context, tx *sql.Tx, scopes map[string]identity.Scope) error {
	// Lock ancestors before descendants, sorting each level across the whole batch.
	for _, table := range []string{"Organization", "Project", "Service", "Deployment"} {
		ids := map[string]bool{}
		for _, scope := range scopes {
			var id string
			switch table {
			case "Organization":
				id = scope.OrganizationID
			case "Project":
				id = scope.ProjectID
			case "Service":
				id = scope.ServiceID
			case "Deployment":
				id = scope.DeploymentID
			}
			ids[id] = true
		}
		ordered := make([]string, 0, len(ids))
		for id := range ids {
			ordered = append(ordered, id)
		}
		sort.Strings(ordered)
		for _, id := range ordered {
			var found string
			err := tx.QueryRowContext(ctx, `SELECT id FROM "`+table+`" WHERE id=$1 FOR UPDATE`, id).Scan(&found)
			if errors.Is(err, sql.ErrNoRows) {
				return identity.ErrIdentity
			}
			if err != nil {
				return err
			}
		}
	}
	for id, want := range scopes {
		got, err := resolve(ctx, tx, id)
		if err != nil {
			return err
		}
		if got != want {
			return identity.ErrIdentity
		}
	}
	return nil
}
