package store

import (
	"context"
	"database/sql"
	"errors"
)

func (s *PostgresStore) ClaimNextRecovery(ctx context.Context, worker string) (*RecoveryClaim, error) {
	if !recoveryIDPattern.MatchString(worker) {
		return nil, ErrRecoveryInput
	}
	rows, err := s.db.QueryContext(ctx, `SELECT type,"targetId" FROM "WorkflowJob"
 WHERE type IN ('resource.backup','resource.restore') AND "runAfter" <= clock_timestamp() AT TIME ZONE 'UTC'
 AND (status='queued' OR (status='running' AND "lockedAt" <= (clock_timestamp() AT TIME ZONE 'UTC')-interval '60 seconds'))
 ORDER BY "runAfter",id LIMIT 32`)
	if err != nil {
		return nil, ErrRecoveryStorage
	}
	var candidates []RecoveryClaim
	for rows.Next() {
		var c RecoveryClaim
		if err = rows.Scan(&c.kind, &c.operationID); err != nil {
			break
		}
		c.worker = worker
		candidates = append(candidates, c)
	}
	err = errors.Join(err, rows.Err(), rows.Close())
	if err != nil {
		return nil, ErrRecoveryStorage
	}
	for _, candidate := range candidates {
		c, err := s.claimRecovery(ctx, candidate)
		if errors.Is(err, ErrRecoveryFence) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if c != nil {
			return c, nil
		}
	}
	return nil, nil
}

func (s *PostgresStore) claimRecovery(ctx context.Context, c RecoveryClaim) (*RecoveryClaim, error) {
	var claimed *RecoveryClaim
	err := s.recoveryTransaction(ctx, func(tx *sql.Tx) error {
		l, err := lockRecovery(ctx, tx, c)
		if err != nil {
			return err
		}
		switch l.status {
		case "QUEUED", "RUNNING", "VERIFYING":
		default:
			return ErrRecoveryFence
		}
		switch l.jobStatus {
		case "queued":
		case "running":
			if l.jobLocked.Valid && l.jobLocked.Time.Add(RecoveryLease).After(l.now) {
				return ErrRecoveryFence
			}
		default:
			return ErrRecoveryFence
		}
		if l.jobAttempt >= RecoveryMaxAttempts || l.deadline.Valid && !l.deadline.Time.After(l.now) {
			return terminalRecovery(ctx, tx, recoveryTerminal{locked: l, status: "FAILED", jobStatus: "failed", code: "RECOVERY_EXHAUSTED"})
		}
		if err = l.active(ctx, tx); err != nil {
			return terminalRecovery(ctx, tx, recoveryTerminal{locked: l, status: "FAILED", jobStatus: "failed", code: "SOURCE_CHANGED"})
		}
		if c.kind == RecoveryRestore && (!l.expiresAt.Valid || !l.expiresAt.Time.After(l.now)) && !l.started.Valid {
			return terminalRecovery(ctx, tx, recoveryTerminal{locked: l, status: "FAILED", jobStatus: "failed", code: "BACKUP_EXPIRED"})
		}
		table, err := recoveryTable(c.kind)
		if err != nil {
			return err
		}
		err = tx.QueryRowContext(ctx, `UPDATE `+table+` SET status=CASE WHEN status='QUEUED' THEN 'RUNNING' ELSE status END,
   "startedAt"=COALESCE("startedAt",$2),"deadlineAt"=COALESCE("deadlineAt",$2+interval '30 minutes'),"updatedAt"=$2
   WHERE id=$1 RETURNING "startedAt","deadlineAt"`, c.operationID, l.now).Scan(&l.claim.startedAt, &l.claim.deadlineAt)
		if err != nil {
			return ErrRecoveryStorage
		}
		_, err = tx.ExecContext(ctx, `UPDATE "WorkflowJob" SET status='running',attempts=attempts+1,"lockedBy"=$2,"lockedAt"=$3,"updatedAt"=$3 WHERE id=$1`, recoveryJobID(c.kind, c.operationID), c.worker, l.now)
		if err != nil {
			return ErrRecoveryStorage
		}
		l.claim.worker = c.worker
		l.claim.attempt = l.jobAttempt + 1
		claimed = &l.claim
		return nil
	})
	return claimed, err
}

func (s *PostgresStore) withRecovery(ctx context.Context, c RecoveryClaim, work func(*sql.Tx, *recoveryLocked) error) error {
	return s.recoveryTransaction(ctx, func(tx *sql.Tx) error {
		l, err := lockRecovery(ctx, tx, c)
		if err != nil {
			return err
		}
		if err = l.live(c); err != nil {
			return err
		}
		if err = l.active(ctx, tx); err != nil {
			return err
		}
		return work(tx, l)
	})
}

func (s *PostgresStore) FenceRecovery(ctx context.Context, c RecoveryClaim) error {
	return s.withRecovery(ctx, c, func(*sql.Tx, *recoveryLocked) error { return nil })
}

func (s *PostgresStore) RenewRecovery(ctx context.Context, c RecoveryClaim) error {
	return s.withRecovery(ctx, c, func(tx *sql.Tx, l *recoveryLocked) error {
		_, err := tx.ExecContext(ctx, `UPDATE "WorkflowJob" SET "lockedAt"=$2,"updatedAt"=$2 WHERE id=$1`, recoveryJobID(c.kind, c.operationID), l.now)
		if err != nil {
			return ErrRecoveryStorage
		}
		return nil
	})
}

func (s *PostgresStore) RetryRecovery(ctx context.Context, c RecoveryClaim) error {
	return s.withRecovery(ctx, c, func(tx *sql.Tx, l *recoveryLocked) error {
		if l.jobAttempt >= RecoveryMaxAttempts {
			return terminalRecovery(ctx, tx, recoveryTerminal{l, "FAILED", "failed", "RECOVERY_EXHAUSTED"})
		}
		_, err := tx.ExecContext(ctx, `UPDATE "WorkflowJob" SET status='queued',"lockedAt"=NULL,"lockedBy"=NULL,"runAfter"=$2,"updatedAt"=$2 WHERE id=$1`, recoveryJobID(c.kind, c.operationID), l.now)
		if err != nil {
			return ErrRecoveryStorage
		}
		return nil
	})
}
