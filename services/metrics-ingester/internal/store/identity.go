package store

import (
	"context"
	"database/sql"
	"errors"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/raibitserver/metrics-ingester/internal/identity"
	"github.com/raibitserver/metrics-ingester/internal/ingester"
)

type querier interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func (p *Postgres) Resolve(ctx context.Context, id string) (identity.Scope, error) {
	return resolve(ctx, p.db, id)
}

func resolve(ctx context.Context, db querier, id string) (identity.Scope, error) {
	if id == "" || len(id) > 256 {
		return identity.Scope{}, identity.ErrIdentity
	}
	var state identity.State
	err := db.QueryRowContext(ctx, `SELECT o.id,p.id,s.id,d.id,p.slug,s.slug,d."deploymentType",COALESCE(d."pullRequestNumber",0),COALESCE(d."imageUrl",''),COALESCE(d."imageDigest",''),COALESCE(d."snapshotVersion",0),COALESCE(d."desiredSpecSnapshot",'null'::jsonb),COALESCE(d."commitSha",'')
FROM "Deployment" d JOIN "Service" s ON s.id=d."serviceId" AND s."projectId"=d."projectId"
JOIN "Project" p ON p.id=s."projectId" JOIN "Organization" o ON o.id=p."organizationId"
WHERE d.id=$1 AND d.status IN ('DEPLOYING','READY','FAILED')
AND COALESCE(d."reconcileAction",'') NOT ILIKE '%cleanup%'
AND UPPER(s.status) NOT IN ('DELETE_REQUESTED','DELETING','DELETED') AND s."deletionRequestedAt" IS NULL
AND UPPER(p.status) NOT IN ('DELETE_REQUESTED','DELETING','DELETED') AND p."deletionRequestedAt" IS NULL`, id).Scan(&state.OrganizationID, &state.ProjectID, &state.ServiceID, &state.DeploymentID, &state.ProjectSlug, &state.ServiceSlug, &state.DeploymentType, &state.PullRequestNumber, &state.ImageURL, &state.ImageDigest, &state.SnapshotVersion, &state.Snapshot, &state.CommitSHA)
	if errors.Is(err, sql.ErrNoRows) {
		return identity.Scope{}, identity.ErrIdentity
	}
	if err != nil {
		return identity.Scope{}, &ingester.Failure{Code: "database"}
	}
	return identity.Parse(state)
}

func lockScopes(ctx context.Context, tx *sql.Tx, records []ingester.Record) error {
	parents := map[string]map[string]bool{"Organization": {}, "Project": {}, "Service": {}, "Deployment": {}}
	scopes := map[string]identity.Scope{}
	for _, r := range records {
		if existing, ok := scopes[r.Scope.DeploymentID]; ok && existing.Fingerprint != r.Scope.Fingerprint {
			return identity.ErrIdentity
		}
		scopes[r.Scope.DeploymentID] = r.Scope
		parents["Organization"][r.Scope.OrganizationID] = true
		parents["Project"][r.Scope.ProjectID] = true
		parents["Service"][r.Scope.ServiceID] = true
		parents["Deployment"][r.Scope.DeploymentID] = true
	}
	for _, table := range []string{"Organization", "Project", "Service", "Deployment"} {
		ids := make([]string, 0, len(parents[table]))
		for id := range parents[table] {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			var locked string
			if err := tx.QueryRowContext(ctx, `SELECT id FROM "`+table+`" WHERE id=$1 FOR UPDATE`, id).Scan(&locked); err != nil {
				if errors.Is(err, sql.ErrNoRows) {
					return identity.ErrIdentity
				}
				return &ingester.Failure{Code: "database"}
			}
		}
	}
	for id, expected := range scopes {
		current, err := resolve(ctx, tx, id)
		if err != nil {
			return err
		}
		if current.Fingerprint != expected.Fingerprint || current.EnvironmentHash != expected.EnvironmentHash || current.OrganizationID != expected.OrganizationID || current.ProjectID != expected.ProjectID || current.ServiceID != expected.ServiceID || current.DeploymentID != expected.DeploymentID || current.Namespace != expected.Namespace || current.WorkloadName != expected.WorkloadName || current.Kind != expected.Kind || current.ContainerName != expected.ContainerName || current.Image != expected.Image || !slices.Equal(current.Command, expected.Command) || !slices.Equal(current.Args, expected.Args) {
			return identity.ErrIdentity
		}
	}
	return nil
}

func validRecord(r ingester.Record, now ingester.Batch) bool {
	if len(r.SourceKey) != 64 || strings.Trim(r.SourceKey, "0123456789abcdef") != "" || r.Scope.Fingerprint == "" || r.ServiceID != r.Scope.ServiceID || r.DeploymentID != r.Scope.DeploymentID || r.Namespace != r.Scope.Namespace || r.ContainerName != r.Scope.ContainerName || r.PodUID == "" || len(r.PodUID) > 128 || len(r.PodName) > 253 {
		return false
	}
	return !r.Timestamp.IsZero() && !r.Timestamp.After(now.Now.Add(30*time.Second)) && !r.Timestamp.Before(now.Now.Add(-30*24*time.Hour))
}
