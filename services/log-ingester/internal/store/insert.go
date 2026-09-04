package store

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/raibitserver/log-ingester/internal/identity"
	"github.com/raibitserver/log-ingester/internal/ingester"
	"github.com/raibitserver/log-ingester/internal/redact"
)

func (p *Postgres) Insert(ctx context.Context, records []ingester.Record, cursors []ingester.CursorUpdate) (int, error) {
	if len(records) > 10000 || len(cursors) > 6400 {
		return 0, identity.ErrIdentity
	}
	scopes := map[string]identity.Scope{}
	sources := map[string]ingester.CursorUpdate{}
	counts := map[string]int{}
	for _, update := range cursors {
		if _, exists := sources[update.Key]; exists {
			return 0, identity.ErrIdentity
		}
		var state redact.State
		if prior, exists := scopes[update.Scope.DeploymentID]; exists && prior != update.Scope {
			return 0, identity.ErrIdentity
		}
		if !strings.HasPrefix(update.Key, "logs:") || update.Cursor.IsZero() || len(update.State) > 256 || json.Unmarshal([]byte(update.State), &state) != nil || state.Version != 1 || (state.Quote != "" && state.Quote != "'" && state.Quote != "\"") {
			return 0, identity.ErrIdentity
		}
		scopes[update.Scope.DeploymentID] = update.Scope
		sources[update.Key] = update
	}
	bytes := 0
	for _, row := range records {
		key := "logs:" + row.PodUID + ":" + row.ContainerName
		update, ok := sources[key]
		hash, err := hex.DecodeString(row.SourceKey)
		if !ok || row.Scope != update.Scope || row.ServiceID != row.Scope.ServiceID || row.DeploymentID != row.Scope.DeploymentID || row.ContainerName != row.Scope.Container || row.PodUID == "" || row.PodName == "" || len(hash) != 32 || err != nil || row.Timestamp.IsZero() || row.Timestamp.After(update.Cursor) || len(row.Line) > 16384 {
			return 0, identity.ErrIdentity
		}
		bytes += len(row.Line)
		counts[key]++
	}
	for key := range sources {
		if counts[key] == 0 {
			return 0, identity.ErrIdentity
		}
	}
	if bytes > 16777216 {
		return 0, identity.ErrIdentity
	}
	inserted := 0
	err := p.transaction(ctx, func(tx *sql.Tx) error {
		if err := lockScopes(ctx, tx, scopes); err != nil {
			return err
		}
		keys := make([]string, 0, len(sources))
		for key := range sources {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			update := sources[key]
			stateKey := "logs-state:" + strings.TrimPrefix(key, "logs:")
			if _, err := tx.ExecContext(ctx, `INSERT INTO "IngestionCursor" (key,cursor,"updatedAt") VALUES ($1,'',CURRENT_TIMESTAMP) ON CONFLICT (key) DO NOTHING`, stateKey); err != nil {
				return err
			}
			var current string
			if err := tx.QueryRowContext(ctx, `SELECT cursor FROM "IngestionCursor" WHERE key=$1 FOR UPDATE`, stateKey).Scan(&current); err != nil {
				return err
			}
			if current != update.ExpectedState {
				return ingester.ErrCursorConflict
			}
		}
		for _, row := range records {
			result, err := tx.ExecContext(ctx, `INSERT INTO "RuntimeLog" (id,"serviceId","deploymentId","podName","podUid","containerName",line,level,"sourceKey",timestamp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT ("sourceKey") DO NOTHING`, "rlog_"+row.SourceKey[:24], row.ServiceID, row.DeploymentID, row.PodName, row.PodUID, row.ContainerName, redact.Text(row.Line), row.Level, row.SourceKey, row.Timestamp.UTC())
			if err != nil {
				return err
			}
			rows, err := result.RowsAffected()
			if err != nil {
				return err
			}
			inserted += int(rows)
		}
		for _, key := range keys {
			update := sources[key]
			// Timestamp cursors stay byte-compatible RFC3339Nano; compare in Go to retain ns.
			var prior string
			err := tx.QueryRowContext(ctx, `SELECT cursor FROM "IngestionCursor" WHERE key=$1`, key).Scan(&prior)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if prior != "" {
				at, err := time.Parse(time.RFC3339Nano, prior)
				if err != nil {
					return err
				}
				if at.After(update.Cursor) {
					return ingester.ErrCursorConflict
				}
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO "IngestionCursor" (key,cursor,"updatedAt") VALUES ($1,$2,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET cursor=EXCLUDED.cursor,"updatedAt"=EXCLUDED."updatedAt"`, key, update.Cursor.UTC().Format(time.RFC3339Nano)); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE "IngestionCursor" SET cursor=$2,"updatedAt"=CURRENT_TIMESTAMP WHERE key=$1`, "logs-state:"+strings.TrimPrefix(key, "logs:"), update.State); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return inserted, nil
}
