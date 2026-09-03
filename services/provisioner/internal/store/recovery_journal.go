package store

import (
	"context"
	"database/sql"
	"encoding/hex"
	"errors"
)

func (s *PostgresStore) RecordRecoveryIntent(ctx context.Context, c RecoveryClaim, keyVersion string) (RecoveryAttempt, error) {
	var result RecoveryAttempt
	if c.kind != RecoveryBackup || !recoveryKeyVersionPattern.MatchString(keyVersion) {
		return result, ErrRecoveryInput
	}
	err := s.withRecovery(ctx, c, func(tx *sql.Tx, l *recoveryLocked) error {
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM "ResourceRecoveryAttempt" WHERE "backupId"=$1 AND attempt=$2`, c.backupID, c.attempt).Scan(&count); err != nil {
			return ErrRecoveryStorage
		}
		if count != 0 {
			return ErrRecoveryFence
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO "ResourceRecoveryAttempt" ("backupId",attempt,"objectKey","keyVersion","firstClaimAt",state,"updatedAt") VALUES ($1,$2,$3,$4,$5,'INTENT',$6)`, c.backupID, c.attempt, recoveryObjectKey(c), keyVersion, l.started.Time, l.now)
		if err != nil {
			return ErrRecoveryStorage
		}
		result = RecoveryAttempt{Artifact: RecoveryArtifact{OrganizationID: c.organizationID, ResourceID: c.sourceID, BackupID: c.backupID, KeyVersion: keyVersion, Attempt: c.attempt, FirstClaimAt: l.started.Time}, ObjectKey: recoveryObjectKey(c), State: "INTENT", CleanupPending: true}
		return nil
	})
	return result, err
}

func (s *PostgresStore) RecordRecoveryUpload(ctx context.Context, c RecoveryClaim, uploadID string) error {
	if c.kind != RecoveryBackup || len(uploadID) < 1 || len(uploadID) > 2048 {
		return ErrRecoveryInput
	}
	return s.withRecovery(ctx, c, func(tx *sql.Tx, l *recoveryLocked) error {
		result, err := tx.ExecContext(ctx, `UPDATE "ResourceRecoveryAttempt" SET "uploadId"=$3,state='UPLOADING',"updatedAt"=$4 WHERE "backupId"=$1 AND attempt=$2 AND state='INTENT' AND "uploadId" IS NULL`, c.backupID, c.attempt, uploadID, l.now)
		return recoveryAffected(result, err)
	})
}

func (s *PostgresStore) RecordRecoveryCandidate(ctx context.Context, c RecoveryClaim, a RecoveryArtifact) error {
	if c.kind != RecoveryBackup || a.BackupID != c.backupID || a.OrganizationID != c.organizationID || a.ResourceID != c.sourceID || a.Attempt != c.attempt ||
		!a.FirstClaimAt.Equal(c.startedAt) || a.StoredBytes < 1 || a.StoredBytes > 10737418240 || a.PlaintextBytes < 0 || a.PlaintextBytes > 10737418240 {
		return ErrRecoveryInput
	}
	return s.withRecovery(ctx, c, func(tx *sql.Tx, l *recoveryLocked) error {
		result, err := tx.ExecContext(ctx, `UPDATE "ResourceRecoveryAttempt" SET state='PREPARED',"candidateStoredBytes"=$3,"candidatePlaintextBytes"=$4,"candidateChecksum"=$5,"updatedAt"=$6
  WHERE "backupId"=$1 AND attempt=$2 AND "keyVersion"=$7 AND state='UPLOADING' AND "uploadId" IS NOT NULL AND "candidateStoredBytes" IS NULL`, c.backupID, c.attempt, a.StoredBytes, a.PlaintextBytes, hex.EncodeToString(a.SHA256[:]), l.now, a.KeyVersion)
		return recoveryAffected(result, err)
	})
}

func (s *PostgresStore) RecordRecoveryComplete(ctx context.Context, c RecoveryClaim) error {
	return s.advanceRecoveryAttempt(ctx, c, "COMPLETE")
}

func (s *PostgresStore) RecordRecoveryVerified(ctx context.Context, c RecoveryClaim) error {
	return s.advanceRecoveryAttempt(ctx, c, "VERIFIED")
}

func (s *PostgresStore) advanceRecoveryAttempt(ctx context.Context, c RecoveryClaim, next string) error {
	if c.kind != RecoveryBackup {
		return ErrRecoveryInput
	}
	previous := "PREPARED"
	if next == "VERIFIED" {
		previous = "COMPLETE"
	}
	return s.withRecovery(ctx, c, func(tx *sql.Tx, l *recoveryLocked) error {
		result, err := tx.ExecContext(ctx, `UPDATE "ResourceRecoveryAttempt" SET state=$3,"updatedAt"=$4 WHERE "backupId"=$1 AND attempt=$2 AND state=$5 AND "candidateStoredBytes" IS NOT NULL`, c.backupID, c.attempt, next, l.now, previous)
		if err = recoveryAffected(result, err); err != nil {
			return err
		}
		if next == "COMPLETE" {
			_, err = tx.ExecContext(ctx, `UPDATE "ResourceBackup" SET status='VERIFYING',"updatedAt"=$2 WHERE id=$1 AND status='RUNNING'`, c.backupID, l.now)
			if err != nil {
				return ErrRecoveryStorage
			}
		}
		return nil
	})
}

func recoveryAffected(result sql.Result, err error) error {
	if err != nil {
		return ErrRecoveryStorage
	}
	n, err := result.RowsAffected()
	if err != nil {
		return ErrRecoveryStorage
	}
	if n != 1 {
		return ErrRecoveryFence
	}
	return nil
}

func (s *PostgresStore) ReadRecoveryAttempts(ctx context.Context, c RecoveryClaim) ([]RecoveryAttempt, error) {
	var attempts []RecoveryAttempt
	err := s.withRecovery(ctx, c, func(tx *sql.Tx, l *recoveryLocked) error {
		var err error
		attempts, err = readRecoveryAttempts(ctx, tx, l.claim)
		return err
	})
	return attempts, err
}

func readRecoveryAttempts(ctx context.Context, tx *sql.Tx, c RecoveryClaim) ([]RecoveryAttempt, error) {
	rows, err := tx.QueryContext(ctx, `SELECT attempt,"objectKey",COALESCE("uploadId",''),"keyVersion","firstClaimAt",state,"cleanupPending",COALESCE("candidateStoredBytes",0),COALESCE("candidatePlaintextBytes",0),COALESCE("candidateChecksum",'') FROM "ResourceRecoveryAttempt" WHERE "backupId"=$1 ORDER BY attempt`, c.backupID)
	if err != nil {
		return nil, ErrRecoveryStorage
	}
	var attempts []RecoveryAttempt
	for rows.Next() {
		a := RecoveryAttempt{Artifact: RecoveryArtifact{OrganizationID: c.organizationID, ResourceID: c.sourceID, BackupID: c.backupID}}
		var checksum string
		if err = rows.Scan(&a.Artifact.Attempt, &a.ObjectKey, &a.UploadID, &a.Artifact.KeyVersion, &a.Artifact.FirstClaimAt, &a.State, &a.CleanupPending, &a.Artifact.StoredBytes, &a.Artifact.PlaintextBytes, &checksum); err != nil {
			break
		}
		if checksum != "" {
			var raw []byte
			raw, err = hex.DecodeString(checksum)
			if err != nil || len(raw) != 32 {
				err = ErrRecoveryStorage
				break
			}
			copy(a.Artifact.SHA256[:], raw)
		}
		attempts = append(attempts, a)
	}
	if err = errors.Join(err, rows.Err(), rows.Close()); err != nil {
		return nil, ErrRecoveryStorage
	}
	return attempts, nil
}
