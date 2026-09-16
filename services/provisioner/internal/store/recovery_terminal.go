package store

import (
	"context"
	"database/sql"
)

type recoveryTerminal struct {
	locked                  *recoveryLocked
	status, jobStatus, code string
}

func terminalRecovery(ctx context.Context, tx *sql.Tx, terminal recoveryTerminal) error {
	l := terminal.locked
	table, err := recoveryTable(l.claim.kind)
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE `+table+` SET status=$2,"errorCode"=$3,"updatedAt"=$4 WHERE id=$1`, l.claim.operationID, terminal.status, terminal.code, l.now); err != nil {
		return ErrRecoveryStorage
	}
	if _, err = tx.ExecContext(ctx, `UPDATE "WorkflowJob" SET status=$2,"lockedAt"=NULL,"lockedBy"=NULL,"updatedAt"=$3 WHERE id=$1`, recoveryJobID(l.claim.kind, l.claim.operationID), terminal.jobStatus, l.now); err != nil {
		return ErrRecoveryStorage
	}
	return nil
}

func (s *PostgresStore) FailRecovery(ctx context.Context, c RecoveryClaim) error {
	return s.stopRecovery(ctx, c, false)
}

func (s *PostgresStore) CancelRestore(ctx context.Context, c RecoveryClaim) error {
	if c.kind != RecoveryRestore {
		return ErrRecoveryInput
	}
	return s.stopRecovery(ctx, c, true)
}

func (s *PostgresStore) stopRecovery(ctx context.Context, c RecoveryClaim, cancel bool) error {
	return s.recoveryTransaction(ctx, func(tx *sql.Tx) error {
		l, err := lockRecovery(ctx, tx, c)
		if err != nil {
			return err
		}
		if err = l.live(c); err != nil {
			return err
		}
		terminal := recoveryTerminal{l, "FAILED", "failed", "RECOVERY_FAILED"}
		if err = l.active(ctx, tx); err != nil {
			terminal.code = "SOURCE_CHANGED"
		}
		if cancel {
			terminal.status = "CANCELLED"
			terminal.jobStatus = "cancelled"
			terminal.code = "RECOVERY_CANCELLED"
		}
		return terminalRecovery(ctx, tx, terminal)
	})
}

func (s *PostgresStore) StartRestoreVerification(ctx context.Context, c RecoveryClaim) error {
	if c.kind != RecoveryRestore {
		return ErrRecoveryInput
	}
	return s.withRecovery(ctx, c, func(tx *sql.Tx, l *recoveryLocked) error {
		if l.target.DesiredState["recoveryPrepared"] != true || l.target.ConnectionSecretName == "" {
			return ErrRecoveryFence
		}
		result, err := tx.ExecContext(ctx, `UPDATE "ResourceRestore" SET status='VERIFYING',"updatedAt"=$2 WHERE id=$1 AND status='RUNNING'`, c.operationID, l.now)
		return recoveryAffected(result, err)
	})
}

func (s *PostgresStore) FinishRecovery(ctx context.Context, c RecoveryClaim) error {
	return s.withRecovery(ctx, c, func(tx *sql.Tx, l *recoveryLocked) error {
		if l.status != "VERIFYING" {
			return ErrRecoveryFence
		}
		switch c.kind {
		case RecoveryBackup:
			result, err := tx.ExecContext(ctx, `UPDATE "ResourceBackup" b SET status='READY',"artifactKey"=a."objectKey","artifactChecksum"=a."candidateChecksum","artifactSize"=a."candidateStoredBytes",
    "encryptionKeyVersion"=a."keyVersion","winningAttempt"=a.attempt,"readyAt"=$3::timestamp(3),"expiresAt"=$3::timestamp(3)+interval '30 days',"updatedAt"=$3::timestamp(3)
    FROM "ResourceRecoveryAttempt" a WHERE b.id=$1 AND a."backupId"=b.id AND a.attempt=$2 AND a.state='VERIFIED'`, c.backupID, c.attempt, l.now)
			if err = recoveryAffected(result, err); err != nil {
				return err
			}
		case RecoveryRestore:
			if l.target.DesiredState["recoveryPrepared"] != true || l.target.ConnectionSecretName == "" || l.target.Status != StatusProvisioning {
				return ErrRecoveryFence
			}
			if _, err := tx.ExecContext(ctx, `UPDATE "ResourceRestore" SET status='READY',"readyAt"=$2,"updatedAt"=$2 WHERE id=$1`, c.operationID, l.now); err != nil {
				return ErrRecoveryStorage
			}
			if _, err := tx.ExecContext(ctx, `UPDATE "Resource" SET status='READY',"desiredState"="desiredState"-'recoveryPrepared'-'recoveryRestoreId'-'recoveryPublicationBlocked',"updatedAt"=$2 WHERE id=$1`, c.targetID, l.now); err != nil {
				return ErrRecoveryStorage
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM "ResourceRecoveryPin" WHERE "restoreId"=$1 AND kind='RESTORE_TARGET'`, c.operationID); err != nil {
				return ErrRecoveryStorage
			}
		default:
			return ErrRecoveryInput
		}
		if _, err := tx.ExecContext(ctx, `UPDATE "WorkflowJob" SET status='succeeded',"lockedAt"=NULL,"lockedBy"=NULL,"updatedAt"=$2 WHERE id=$1`, recoveryJobID(c.kind, c.operationID), l.now); err != nil {
			return ErrRecoveryStorage
		}
		return nil
	})
}
