package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

var (
	ErrRecoveryPrepared = errors.New("RECOVERY_TARGET_PREPARED")
	ErrRecoveryFence    = errors.New("RECOVERY_FENCE_REJECTED")
	ErrRecoveryInput    = errors.New("RECOVERY_INPUT_INVALID")
	ErrRecoveryStorage  = errors.New("RECOVERY_STORAGE_FAILURE")
	ErrRecoverySource   = errors.New("SOURCE_CHANGED")
)

type ordinaryPublication struct {
	id       string
	claimed  time.Time
	provider string
	secret   string
	state    []byte
}

func (s *PostgresStore) publishOrdinaryResource(ctx context.Context, p ordinaryPublication) (prepared bool, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, ErrRecoveryStorage
	}
	defer func() {
		rollback := tx.Rollback()
		if rollback != nil && !errors.Is(rollback, sql.ErrTxDone) {
			err = errors.Join(err, ErrRecoveryStorage)
		}
	}()
	var marker, pin string
	var blocked bool
	err = tx.QueryRowContext(ctx, `SELECT COALESCE("desiredState"->>'recoveryRestoreId',''),
 COALESCE("desiredState"->>'recoveryPublicationBlocked','false')='true'
 FROM "Resource" WHERE id=$1 AND status='RECONCILING' AND "updatedAt"=$2 FOR UPDATE`, p.id, p.claimed).Scan(&marker, &blocked)
	if errors.Is(err, sql.ErrNoRows) {
		return false, ErrRecoveryFence
	}
	if err != nil {
		return false, ErrRecoveryStorage
	}
	err = tx.QueryRowContext(ctx, `SELECT "restoreId" FROM "ResourceRecoveryPin" WHERE "resourceId"=$1 AND kind='RESTORE_TARGET'`, p.id).Scan(&pin)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, ErrRecoveryStorage
	}
	if marker != "" || pin != "" || blocked {
		if marker == "" || marker != pin || !blocked {
			return false, ErrRecoveryFence
		}
		var id string
		err = tx.QueryRowContext(ctx, `UPDATE "Resource" r SET status='PROVISIONING',provider=$1,"connectionSecretName"=$2,
   "desiredState"=$3::jsonb || jsonb_build_object('recoveryPrepared',true,'recoveryRestoreId',$6::text,'recoveryPublicationBlocked',true),
   "updatedAt"=clock_timestamp() AT TIME ZONE 'UTC'
   FROM "Project" p,"Organization" o WHERE r.id=$4 AND r."updatedAt"=$5 AND p.id=r."projectId" AND o.id=p."organizationId"
   AND r."deletionRequestedAt" IS NULL AND p."deletionRequestedAt" IS NULL
   AND UPPER(p.status) NOT IN ('DELETE_REQUESTED','DELETING')
   AND EXISTS(SELECT 1 FROM "ResourceRestore" rr WHERE rr.id=$6 AND rr.status IN ('QUEUED','RUNNING','VERIFYING'))
   RETURNING r.id`, p.provider, p.secret, p.state, p.id, p.claimed, marker).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			return false, ErrRecoveryFence
		}
		if err != nil {
			return false, ErrRecoveryStorage
		}
		if err = tx.Commit(); err != nil {
			return false, ErrRecoveryStorage
		}
		return true, nil
	}
	var id string
	if err = tx.QueryRowContext(ctx, markResourceReadySQL, p.provider, p.secret, p.state, p.id, p.claimed).Scan(&id); err != nil {
		return false, err
	}
	return false, tx.Commit()
}
