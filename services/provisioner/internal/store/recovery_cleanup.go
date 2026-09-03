package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
)

func (s *PostgresStore) ClaimRecoveryCleanup(ctx context.Context, identity RecoveryIdentity, worker string) (RecoveryCleanupClaim, error) {
	var result RecoveryCleanupClaim
	if !recoveryIDPattern.MatchString(worker) {
		return result, ErrRecoveryInput
	}
	c := RecoveryClaim{kind: identity.Kind, operationID: identity.OperationID}
	err := s.recoveryTransaction(ctx, func(tx *sql.Tx) error {
		l, err := lockRecovery(ctx, tx, c)
		if err != nil {
			return err
		}
		if err = cleanupEligible(ctx, tx, l); err != nil {
			return err
		}
		table, err := recoveryTable(c.kind)
		if err != nil {
			return err
		}
		var live bool
		if err = tx.QueryRowContext(ctx, `SELECT COALESCE("cleanupLeaseUntil">$2,false) FROM `+table+` WHERE id=$1`, c.operationID, l.now).Scan(&live); err != nil {
			return ErrRecoveryStorage
		}
		if live {
			return ErrRecoveryFence
		}
		token := make([]byte, 32)
		if _, err = rand.Read(token); err != nil {
			return ErrRecoveryStorage
		}
		result = RecoveryCleanupClaim{c.kind, c.operationID, worker, hex.EncodeToString(token)}
		status := l.status
		if c.kind == RecoveryBackup {
			status = "DELETING"
		}
		if _, err = tx.ExecContext(ctx, `UPDATE `+table+` SET status=$2,"cleanupWorker"=$3,"cleanupToken"=$4,"cleanupLeaseUntil"=$5::timestamp(3)+interval '60 seconds',"updatedAt"=$5::timestamp(3) WHERE id=$1`, c.operationID, status, worker, result.token, l.now); err != nil {
			return recoveryDBFailure(err)
		}
		return nil
	})
	return result, err
}

func cleanupEligible(ctx context.Context, tx *sql.Tx, l *recoveryLocked) error {
	switch l.jobStatus {
	case "succeeded", "failed", "cancelled":
	default:
		return ErrRecoveryFence
	}
	switch l.claim.kind {
	case RecoveryBackup:
		switch l.status {
		case "READY":
			if !l.expiresAt.Valid || l.expiresAt.Time.After(l.now) {
				return ErrRecoveryFence
			}
		case "FAILED", "EXPIRED", "DELETING":
		default:
			return ErrRecoveryFence
		}
		var pins bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM "ResourceRecoveryPin" WHERE "backupId"=$1 AND kind='RESTORE_TARGET') OR EXISTS(SELECT 1 FROM "ResourceRestore" WHERE "backupId"=$1 AND status IN ('QUEUED','RUNNING','VERIFYING'))`, l.claim.backupID).Scan(&pins); err != nil {
			return ErrRecoveryStorage
		}
		if pins {
			return ErrRecoveryFence
		}
	case RecoveryRestore:
		switch l.status {
		case "FAILED", "CANCELLED":
		default:
			return ErrRecoveryFence
		}
	default:
		return ErrRecoveryInput
	}
	return nil
}

func (s *PostgresStore) withRecoveryCleanup(ctx context.Context, c RecoveryCleanupClaim, work func(*sql.Tx, *recoveryLocked) error) error {
	return s.recoveryTransaction(ctx, func(tx *sql.Tx) error {
		l, err := lockRecovery(ctx, tx, RecoveryClaim{kind: c.kind, operationID: c.operationID})
		if err != nil {
			return err
		}
		if err = cleanupEligible(ctx, tx, l); err != nil {
			return err
		}
		table, err := recoveryTable(c.kind)
		if err != nil {
			return err
		}
		var live bool
		if err = tx.QueryRowContext(ctx, `SELECT COALESCE("cleanupToken"=$2 AND "cleanupWorker"=$3 AND "cleanupLeaseUntil">$4,false) FROM `+table+` WHERE id=$1`, c.operationID, c.token, c.worker, l.now).Scan(&live); err != nil {
			return ErrRecoveryStorage
		}
		if !live {
			return ErrRecoveryFence
		}
		return work(tx, l)
	})
}

func (s *PostgresStore) FenceRecoveryCleanup(ctx context.Context, c RecoveryCleanupClaim) error {
	return s.withRecoveryCleanup(ctx, c, func(*sql.Tx, *recoveryLocked) error { return nil })
}

func (s *PostgresStore) ReadRecoveryCleanup(ctx context.Context, c RecoveryCleanupClaim) ([]RecoveryAttempt, error) {
	var attempts []RecoveryAttempt
	err := s.withRecoveryCleanup(ctx, c, func(tx *sql.Tx, l *recoveryLocked) error {
		var err error
		attempts, err = readRecoveryAttempts(ctx, tx, l.claim)
		return err
	})
	return attempts, err
}

func (s *PostgresStore) MarkRecoveryAttemptCleaned(ctx context.Context, c RecoveryCleanupClaim, attempt int) error {
	if c.kind != RecoveryBackup || attempt < 1 || attempt > RecoveryMaxAttempts {
		return ErrRecoveryInput
	}
	return s.withRecoveryCleanup(ctx, c, func(tx *sql.Tx, l *recoveryLocked) error {
		result, err := tx.ExecContext(ctx, `UPDATE "ResourceRecoveryAttempt" SET state='CLEANED',"cleanupPending"=false,"updatedAt"=$3 WHERE "backupId"=$1 AND attempt=$2`, l.claim.backupID, attempt, l.now)
		return recoveryAffected(result, err)
	})
}

func (s *PostgresStore) FinishRecoveryCleanup(ctx context.Context, c RecoveryCleanupClaim) error {
	return s.withRecoveryCleanup(ctx, c, func(tx *sql.Tx, l *recoveryLocked) error {
		switch c.kind {
		case RecoveryBackup:
			var pending bool
			if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM "ResourceRecoveryAttempt" WHERE "backupId"=$1 AND "cleanupPending")`, l.claim.backupID).Scan(&pending); err != nil {
				return ErrRecoveryStorage
			}
			if pending {
				return ErrRecoveryFence
			}
			if _, err := tx.ExecContext(ctx, `UPDATE "ResourceBackup" SET status='DELETED',"cleanupToken"=NULL,"cleanupWorker"=NULL,"cleanupLeaseUntil"=NULL,"updatedAt"=$2 WHERE id=$1`, c.operationID, l.now); err != nil {
				return ErrRecoveryStorage
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM "ResourceRecoveryPin" WHERE "backupId"=$1 AND kind='ARTIFACT_SOURCE'`, l.claim.backupID); err != nil {
				return ErrRecoveryStorage
			}
		case RecoveryRestore:
			if _, err := tx.ExecContext(ctx, `UPDATE "ResourceRestore" SET "targetCleanedAt"=$2,"cleanupToken"=NULL,"cleanupWorker"=NULL,"cleanupLeaseUntil"=NULL,"updatedAt"=$2 WHERE id=$1`, c.operationID, l.now); err != nil {
				return ErrRecoveryStorage
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM "ResourceRecoveryPin" WHERE "restoreId"=$1 AND kind='RESTORE_TARGET'`, c.operationID); err != nil {
				return ErrRecoveryStorage
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM "Resource" WHERE id=$1`, l.claim.targetID); err != nil {
				return ErrRecoveryStorage
			}
		default:
			return ErrRecoveryInput
		}
		return nil
	})
}

var _ RecoveryStore = (*PostgresStore)(nil)
