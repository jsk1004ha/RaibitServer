package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

func (s *PostgresStore) ClaimNextPreviewRoute(ctx context.Context, options ClaimOptions) (*PreviewRouteWork, error) {
	at := options.Now.UTC()
	if at.IsZero() {
		at = time.Now().UTC()
	}
	duration := options.Lease
	if duration <= 0 {
		duration = 60 * time.Second
	}
	worker := strings.TrimSpace(options.WorkerID)
	if worker == "" {
		return nil, ErrPreviewContract
	}
	token, err := newPreviewToken()
	if err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, fmt.Errorf("begin preview route claim: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var lineageID, organizationID, serviceID string
	err = tx.QueryRowContext(ctx, `SELECT l.id,l."organizationId",l."serviceId" FROM "PreviewLineage" l
 WHERE (l."reconcileLeaseUntil" IS NULL OR l."reconcileLeaseUntil"<=$1) AND (
  (l.state='OPEN' AND l."candidateDeploymentId" IS NOT NULL AND EXISTS (SELECT 1 FROM "Deployment" d WHERE d.id=l."candidateDeploymentId" AND d."previewLineageId"=l.id AND d."previewGeneration"=l."candidateGeneration" AND d.status='READY' AND d."publicHealthStatus"='HEALTHY') AND COALESCE(l."routeObserved"->>'deploymentId','')<>l."candidateDeploymentId")
  OR (l.state='CLOSED' AND (COALESCE(l."routeObserved"->>'uid','')<>'' OR l."routeIntent"->>'operation'='clear')))
 ORDER BY l."updatedAt",l.id LIMIT 1`, at).Scan(&lineageID, &organizationID, &serviceID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,18))`, "preview:organization:"+organizationID); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,15))`, serviceID); err != nil {
		return nil, err
	}
	var lineageRaw, candidateRaw []byte
	if err := tx.QueryRowContext(ctx, `SELECT to_jsonb(l),COALESCE(to_jsonb(d),'null'::jsonb) FROM "PreviewLineage" l LEFT JOIN "Deployment" d ON d.id=l."candidateDeploymentId" WHERE l.id=$1 FOR UPDATE OF l`, lineageID).Scan(&lineageRaw, &candidateRaw); err != nil {
		return nil, err
	}
	lineage, err := decodePreviewRecord(lineageRaw)
	if err != nil {
		return nil, err
	}
	state := map[string]any{"deployments": []any{}}
	if string(candidateRaw) != "null" {
		candidate, err := decodePreviewRecord(candidateRaw)
		if err != nil {
			return nil, err
		}
		state["deployments"] = []any{map[string]any(candidate)}
	}
	work, ready := previewRouteWorkFromState(state, lineage)
	if !ready || parseTimestamp(stringField(lineage, "reconcileLeaseUntil")).After(at) {
		return nil, nil
	}
	result, err := tx.ExecContext(ctx, `UPDATE "PreviewLineage" SET "reconcileToken"=$2,"reconcileWorker"=$3,"reconcileLeaseUntil"=$4,"updatedAt"=$1 WHERE id=$5 AND version=$6 AND ("reconcileLeaseUntil" IS NULL OR "reconcileLeaseUntil"<=$1)`, at, token, worker, at.Add(duration), lineageID, intField(lineage, "version"))
	if err != nil {
		return nil, err
	}
	if err := requireOneAffected(result, ErrDeploymentLeaseLost); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	work.Lease = PreviewRouteLease{LineageID: lineageID, Version: intField(lineage, "version"), Token: token, WorkerID: worker}
	return &work, nil
}

func (s *PostgresStore) RenewPreviewRouteLease(ctx context.Context, lease PreviewRouteLease, at time.Time) error {
	result, err := s.db.ExecContext(ctx, `UPDATE "PreviewLineage" SET "reconcileLeaseUntil"=$1,"updatedAt"=$2 WHERE id=$3 AND version=$4 AND "reconcileToken"=$5 AND "reconcileWorker"=$6 AND "reconcileLeaseUntil">$2`, at.UTC().Add(60*time.Second), at.UTC(), lease.LineageID, lease.Version, lease.Token, lease.WorkerID)
	if err != nil {
		return err
	}
	return requireOneAffected(result, ErrDeploymentLeaseLost)
}

func (s *PostgresStore) SetPreviewRouteIntent(ctx context.Context, lease PreviewRouteLease, intent PreviewRouteIntent) error {
	raw, err := json.Marshal(intent)
	if err != nil {
		return err
	}
	if intent.Version != 1 || intent.LineageVersion != lease.Version || intent.Token != lease.Token || (intent.UID == "") != (intent.ResourceVersion == "") {
		return ErrPreviewContract
	}
	result, err := s.db.ExecContext(ctx, `UPDATE "PreviewLineage" SET "routeIntent"=$1,"updatedAt"=$2 WHERE id=$3 AND version=$4 AND "reconcileToken"=$5 AND "reconcileWorker"=$6 AND "reconcileLeaseUntil">$2 AND namespace=$7 AND "routeName"=$8 AND ((state='OPEN' AND $9='promote' AND "candidateDeploymentId"=$10 AND "candidateGeneration"=$11) OR (state='CLOSED' AND $9='clear' AND $10='' AND $11=0))`, raw, time.Now().UTC(), lease.LineageID, lease.Version, lease.Token, lease.WorkerID, intent.Namespace, intent.Name, intent.Operation, intent.DeploymentID, intent.Generation)
	if err != nil {
		return err
	}
	return requireOneAffected(result, ErrDeploymentLeaseLost)
}

func (s *PostgresStore) CompletePreviewRoute(ctx context.Context, lease PreviewRouteLease, observed PreviewRouteObserved) error {
	raw, err := json.Marshal(observed)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var state, candidateID, previousID, intentToken, intentOperation, intentDeploymentID, intentUID, namespace, routeName string
	var version, candidateGeneration, previousGeneration, intentGeneration int
	err = tx.QueryRowContext(ctx, `SELECT state,version,COALESCE("candidateDeploymentId",''),COALESCE("candidateGeneration",0),COALESCE("currentDeploymentId",''),COALESCE("currentGeneration",0),COALESCE("routeIntent"->>'token',''),COALESCE("routeIntent"->>'operation',''),COALESCE("routeIntent"->>'deploymentId',''),COALESCE(("routeIntent"->>'generation')::int,0),COALESCE("routeIntent"->>'uid',''),namespace,"routeName" FROM "PreviewLineage" WHERE id=$1 AND version=$2 AND "reconcileToken"=$3 AND "reconcileWorker"=$4 AND "reconcileLeaseUntil">$5 FOR UPDATE`, lease.LineageID, lease.Version, lease.Token, lease.WorkerID, observed.ObservedAt).Scan(&state, &version, &candidateID, &candidateGeneration, &previousID, &previousGeneration, &intentToken, &intentOperation, &intentDeploymentID, &intentGeneration, &intentUID, &namespace, &routeName)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrDeploymentLeaseLost
	}
	if err != nil || version != lease.Version || intentToken != lease.Token || observed.Version != 1 || observed.LineageVersion != lease.Version || observed.Namespace != namespace || observed.Name != routeName {
		if err != nil {
			return err
		}
		return ErrPreviewContract
	}
	if intentOperation == PreviewPromote {
		if state != PreviewStateOpen || intentDeploymentID != candidateID || intentGeneration != candidateGeneration || observed.DeploymentID != candidateID || observed.Generation != candidateGeneration || observed.UID == "" || observed.ResourceVersion == "" || (intentUID != "" && observed.UID != intentUID) {
			return ErrPreviewContract
		}
		var healthy bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM "Deployment" WHERE id=$1 AND "previewLineageId"=$2 AND "previewGeneration"=$3 AND status='READY' AND "publicHealthStatus"='HEALTHY')`, candidateID, lease.LineageID, candidateGeneration).Scan(&healthy); err != nil || !healthy {
			if err != nil {
				return err
			}
			return ErrPreviewContract
		}
		if previousID != "" && previousID != candidateID {
			if _, err := tx.ExecContext(ctx, `UPDATE "Deployment" SET status=$2,"updatedAt"=$3 WHERE id=$1 AND "previewLineageId"=$4 AND "previewGeneration"=$5 AND status='READY'`, previousID, DeploymentStatusCleanupRequested, observed.ObservedAt, lease.LineageID, previousGeneration); err != nil {
				return err
			}
		}
		_, err = tx.ExecContext(ctx, `UPDATE "PreviewLineage" SET "currentDeploymentId"=$2,"currentGeneration"=$3,"candidateDeploymentId"=NULL,"candidateGeneration"=NULL,"routeObserved"=$4,"routeIntent"=NULL,"reconcileToken"=NULL,"reconcileWorker"=NULL,"reconcileLeaseUntil"=NULL,"updatedAt"=$5 WHERE id=$1`, lease.LineageID, candidateID, candidateGeneration, raw, observed.ObservedAt)
	} else if intentOperation == PreviewClear && state == PreviewStateClosed && intentDeploymentID == "" && intentGeneration == 0 && observed.DeploymentID == "" && observed.Generation == 0 && observed.UID == "" && observed.ResourceVersion == "" {
		_, err = tx.ExecContext(ctx, `UPDATE "PreviewLineage" SET "routeObserved"=$2,"routeIntent"=NULL,"reconcileToken"=NULL,"reconcileWorker"=NULL,"reconcileLeaseUntil"=NULL,"updatedAt"=$3 WHERE id=$1`, lease.LineageID, raw, observed.ObservedAt)
	} else {
		return ErrPreviewContract
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}

func decodePreviewRecord(raw []byte) (record, error) {
	var result record
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("decode preview record: %w", err)
	}
	return result, nil
}
