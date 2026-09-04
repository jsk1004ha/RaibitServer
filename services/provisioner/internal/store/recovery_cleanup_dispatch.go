package store

import (
	"context"
	"database/sql"
	"errors"
)

// NextRecoveryCleanup returns one eligible identity without claiming it. The
// subsequent ClaimRecoveryCleanup transaction is the sole cleanup authority.
func (s *PostgresStore) NextRecoveryCleanup(ctx context.Context) (*RecoveryIdentity, error) {
	row := s.db.QueryRowContext(ctx, `SELECT kind,id FROM (
 SELECT 'resource.backup'::text AS kind,b.id,b."updatedAt" AS updated_at
 FROM "ResourceBackup" b
 JOIN "WorkflowJob" j ON j.type='resource.backup' AND j."targetId"=b.id
 WHERE b."formatVersion"=1
   AND (b.status IN ('FAILED','EXPIRED','DELETING') OR (b.status='READY' AND b."expiresAt" <= clock_timestamp() AT TIME ZONE 'UTC'))
   AND j.status IN ('succeeded','failed','cancelled')
   AND (b."cleanupLeaseUntil" IS NULL OR b."cleanupLeaseUntil" <= clock_timestamp() AT TIME ZONE 'UTC')
   AND NOT EXISTS (SELECT 1 FROM "ResourceRecoveryPin" p WHERE p."backupId"=b.id AND p.kind='RESTORE_TARGET')
   AND NOT EXISTS (SELECT 1 FROM "ResourceRestore" r WHERE r."backupId"=b.id AND r.status IN ('QUEUED','RUNNING','VERIFYING'))
 UNION ALL
 SELECT 'resource.restore'::text AS kind,r.id,r."updatedAt" AS updated_at
 FROM "ResourceRestore" r
 JOIN "WorkflowJob" j ON j.type='resource.restore' AND j."targetId"=r.id
 WHERE r.status IN ('FAILED','CANCELLED') AND r."targetCleanedAt" IS NULL
   AND j.status IN ('failed','cancelled')
   AND (r."cleanupLeaseUntil" IS NULL OR r."cleanupLeaseUntil" <= clock_timestamp() AT TIME ZONE 'UTC')
) candidates ORDER BY updated_at,id LIMIT 1`)
	var kind RecoveryKind
	var operationID string
	if err := row.Scan(&kind, &operationID); errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	} else if err != nil {
		return nil, ErrRecoveryStorage
	}
	if !recoveryIDPattern.MatchString(operationID) || kind != RecoveryBackup && kind != RecoveryRestore {
		return nil, ErrRecoveryStorage
	}
	return &RecoveryIdentity{Kind: kind, OperationID: operationID}, nil
}
