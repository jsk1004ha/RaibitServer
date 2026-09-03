package store

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"time"
)

type recoveryLocked struct {
	claim                            RecoveryClaim
	status, generation, backupStatus string
	expiresAt                        sql.NullTime
	source, target                   *Resource
	jobStatus, jobWorker             string
	jobAttempt, jobMaximum           int
	jobLocked, started, deadline     sql.NullTime
	now                              time.Time
	pinSource, pinTarget             bool
}

func (s *PostgresStore) recoveryTransaction(ctx context.Context, work func(*sql.Tx) error) (err error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return ErrRecoveryStorage
	}
	defer func() {
		e := tx.Rollback()
		if e != nil && !errors.Is(e, sql.ErrTxDone) {
			err = errors.Join(err, ErrRecoveryStorage)
		}
	}()
	if err = work(tx); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return ErrRecoveryStorage
	}
	return nil
}

func lockRecovery(ctx context.Context, tx *sql.Tx, c RecoveryClaim) (*recoveryLocked, error) {
	table, err := recoveryTable(c.kind)
	if err != nil {
		return nil, err
	}
	var ids RecoveryClaim
	ids.kind = c.kind
	ids.operationID = c.operationID
	query := `SELECT "organizationId","projectId","resourceId",id,'' FROM "ResourceBackup" WHERE id=$1 AND "formatVersion"=1`
	if c.kind == RecoveryRestore {
		query = `SELECT "organizationId","projectId","sourceResourceId","backupId","targetResourceId" FROM "ResourceRestore" WHERE id=$1`
	}
	err = tx.QueryRowContext(ctx, query, c.operationID).Scan(&ids.organizationID, &ids.projectID, &ids.sourceID, &ids.backupID, &ids.targetID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrRecoveryFence
	}
	if err != nil {
		return nil, ErrRecoveryStorage
	}
	for _, id := range []string{ids.organizationID, ids.projectID, ids.sourceID, ids.backupID, ids.operationID} {
		if !recoveryIDPattern.MatchString(id) {
			return nil, ErrRecoveryInput
		}
	}
	var id string
	if err = tx.QueryRowContext(ctx, `SELECT id FROM "Organization" WHERE id=$1 FOR UPDATE`, ids.organizationID).Scan(&id); err != nil {
		return nil, ErrRecoveryFence
	}
	if err = tx.QueryRowContext(ctx, `SELECT id FROM "Project" WHERE id=$1 AND "organizationId"=$2 FOR UPDATE`, ids.projectID, ids.organizationID).Scan(&id); err != nil {
		return nil, ErrRecoveryFence
	}
	resources := []string{ids.sourceID}
	if ids.targetID != "" {
		resources = append(resources, ids.targetID)
	}
	sort.Strings(resources)
	l := &recoveryLocked{claim: ids}
	for _, rid := range resources {
		resource, e := scanResource(tx.QueryRowContext(ctx, `SELECT r.id,r."projectId",p."organizationId",p.slug,r.name,r.slug,r.type,r.engine,r.provider,r.plan,r.region,r.version,r.status,r."connectionSecretName",r."desiredSpec",r."desiredState"
   FROM "Resource" r JOIN "Project" p ON p.id=r."projectId" WHERE r.id=$1 AND p.id=$2 FOR UPDATE OF r`, rid, ids.projectID))
		if e != nil {
			return nil, ErrRecoveryFence
		}
		if rid == ids.sourceID {
			l.source = resource
		} else {
			l.target = resource
		}
	}
	var backupSource, backupOrg, backupProject string
	err = tx.QueryRowContext(ctx, `SELECT status,"expiresAt","resourceId","organizationId","projectId","sourceGeneration" FROM "ResourceBackup" WHERE id=$1 AND "formatVersion"=1 FOR UPDATE`, ids.backupID).
		Scan(&l.backupStatus, &l.expiresAt, &backupSource, &backupOrg, &backupProject, &l.generation)
	if err != nil || backupSource != ids.sourceID || backupOrg != ids.organizationID || backupProject != ids.projectID {
		return nil, ErrRecoveryFence
	}
	var operationGeneration string
	err = tx.QueryRowContext(ctx, `SELECT status,"startedAt","deadlineAt","sourceGeneration" FROM `+table+` WHERE id=$1 FOR UPDATE`, c.operationID).
		Scan(&l.status, &l.started, &l.deadline, &operationGeneration)
	if err != nil || operationGeneration != l.generation {
		return nil, ErrRecoveryFence
	}
	rows, err := tx.QueryContext(ctx, `SELECT kind,"resourceId",COALESCE("restoreId",'') FROM "ResourceRecoveryPin" WHERE "backupId"=$1 ORDER BY id FOR UPDATE`, ids.backupID)
	if err != nil {
		return nil, ErrRecoveryStorage
	}
	for rows.Next() {
		var kind, rid, restore string
		if err = rows.Scan(&kind, &rid, &restore); err != nil {
			break
		}
		if kind == "ARTIFACT_SOURCE" && rid == ids.sourceID {
			l.pinSource = true
		}
		if kind == "RESTORE_TARGET" && rid == ids.targetID && restore == ids.operationID {
			l.pinTarget = true
		}
	}
	err = errors.Join(err, rows.Err(), rows.Close())
	if err != nil {
		return nil, ErrRecoveryStorage
	}
	rows, err = tx.QueryContext(ctx, `SELECT attempt FROM "ResourceRecoveryAttempt" WHERE "backupId"=$1 ORDER BY attempt FOR UPDATE`, ids.backupID)
	if err != nil {
		return nil, ErrRecoveryStorage
	}
	for rows.Next() {
		var n int
		if err = rows.Scan(&n); err != nil {
			break
		}
	}
	err = errors.Join(err, rows.Err(), rows.Close())
	if err != nil {
		return nil, ErrRecoveryStorage
	}
	var jobType, targetType, targetID string
	var payloadOK bool
	err = tx.QueryRowContext(ctx, `SELECT type,"targetType","targetId",status,attempts,"maxAttempts",COALESCE("lockedBy",''),"lockedAt",
  payload=jsonb_build_object('version',1,'operationId',$2::text) FROM "WorkflowJob" WHERE id=$1 FOR UPDATE`, recoveryJobID(c.kind, c.operationID), c.operationID).
		Scan(&jobType, &targetType, &targetID, &l.jobStatus, &l.jobAttempt, &l.jobMaximum, &l.jobWorker, &l.jobLocked, &payloadOK)
	expectedTarget := "resource-backup"
	if c.kind == RecoveryRestore {
		expectedTarget = "resource-restore"
	}
	if err != nil || jobType != string(c.kind) || targetType != expectedTarget || targetID != c.operationID || !payloadOK || l.jobMaximum != RecoveryMaxAttempts {
		return nil, ErrRecoveryFence
	}
	if err = tx.QueryRowContext(ctx, `SELECT clock_timestamp() AT TIME ZONE 'UTC'`).Scan(&l.now); err != nil {
		return nil, ErrRecoveryStorage
	}
	return l, nil
}

func (l *recoveryLocked) live(c RecoveryClaim) error {
	if l.jobStatus != "running" || l.jobWorker != c.worker || l.jobAttempt != c.attempt || !l.jobLocked.Valid || !l.jobLocked.Time.Add(RecoveryLease).After(l.now) ||
		!l.started.Valid || !l.deadline.Valid || !l.deadline.Time.After(l.now) || !l.deadline.Time.Equal(l.started.Time.Add(RecoveryDeadline)) {
		return ErrRecoveryFence
	}
	switch l.status {
	case "RUNNING", "VERIFYING":
	default:
		return ErrRecoveryFence
	}
	return nil
}

func (l *recoveryLocked) active(ctx context.Context, tx *sql.Tx) error {
	var active bool
	err := tx.QueryRowContext(ctx, `SELECT p."deletionRequestedAt" IS NULL AND UPPER(p.status) NOT IN ('DELETE_REQUESTED','DELETING')
 AND NOT EXISTS(SELECT 1 FROM "Resource" r WHERE r.id=ANY($2::text[]) AND (r."deletionRequestedAt" IS NOT NULL OR UPPER(r.status) IN ('DELETE_REQUESTED','DELETING')))
 FROM "Project" p WHERE p.id=$1`, l.claim.projectID, []string{l.claim.sourceID, l.claim.targetID}).Scan(&active)
	if err != nil || !active || !l.pinSource {
		return ErrRecoveryFence
	}
	if l.source.Status != StatusReady {
		return ErrRecoverySource
	}
	generation, err := recoverySourceGeneration(l.source)
	if err != nil || generation != l.generation {
		return ErrRecoverySource
	}
	if l.claim.kind == RecoveryRestore {
		if !l.pinTarget || l.backupStatus != "READY" || l.target == nil {
			return ErrRecoveryFence
		}
		if l.target.DesiredState["recoveryRestoreId"] != l.claim.operationID || l.target.DesiredState["recoveryPublicationBlocked"] != true {
			return ErrRecoveryFence
		}
	}
	return nil
}
