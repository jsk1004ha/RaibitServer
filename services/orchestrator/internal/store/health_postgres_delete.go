package store

import (
	"context"
	"database/sql"
	"errors"
)

func (s *PostgresStore) finalizeHealthParent(ctx context.Context, lease DeletionLease, service bool) error {
	query, key := finalizeProjectDeletionSQL, "projectId"
	if service {
		query, key = finalizeServiceDeletionSQL, "serviceId"
	}
	return s.healthTransaction(ctx, func(tx *sql.Tx) error {
		// Health completion locks its job before its parents; deletion uses the same order.
		rows, err := tx.QueryContext(ctx, `SELECT id FROM "WorkflowJob" WHERE type=$1 AND status IN ('queued','running') AND payload->>$2=$3 ORDER BY id FOR UPDATE`, PublicHealthObserve, key, lease.ID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				return errors.Join(err, rows.Close())
			}
		}
		if err := errors.Join(rows.Err(), rows.Close()); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, query, lease.ID, lease.ClaimedAt)
		if err != nil {
			return err
		}
		if err := requireOneAffected(result, ErrDeletionLeaseLost); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE "WorkflowJob" SET status='cancelled',"lockedBy"=NULL,"lockedAt"=NULL,"updatedAt"=CURRENT_TIMESTAMP
 WHERE type=$1 AND status IN ('queued','running') AND payload->>$2=$3`, PublicHealthObserve, key, lease.ID)
		return err
	})
}
