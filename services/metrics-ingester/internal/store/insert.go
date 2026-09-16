package store

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"sort"
	"time"

	"github.com/raibitserver/metrics-ingester/internal/identity"
	"github.com/raibitserver/metrics-ingester/internal/ingester"
)

func (p *Postgres) Insert(ctx context.Context, batch ingester.Batch) (out ingester.Persisted, err error) {
	if batch.Limit < 1 || batch.Limit > 50000 || len(batch.Records) > 320000 {
		return out, &ingester.Failure{Code: "field_limit"}
	}
	for _, r := range batch.Records {
		if !validRecord(r, batch) || math.IsNaN(r.Value) || math.IsInf(r.Value, 0) || r.Value < 0 || !((r.Metric == "cpu" && r.Unit == "cores") || (r.Metric == "memory" && r.Unit == "bytes")) {
			return out, identity.ErrIdentity
		}
	}
	tx, err := p.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return out, &ingester.Failure{Code: "database"}
	}
	defer func() {
		if e := tx.Rollback(); e != nil && !errors.Is(e, sql.ErrTxDone) {
			err = &ingester.Failure{Code: "database"}
		}
		if err != nil {
			out = ingester.Persisted{}
		}
	}()
	if err = lockScopes(ctx, tx, batch.Records); err != nil {
		return out, err
	}
	records := append([]ingester.Record(nil), batch.Records...)
	sort.Slice(records, func(a, b int) bool {
		ka, kb := cursorKey(records[a]), cursorKey(records[b])
		if ka == kb {
			return records[a].Timestamp.Before(records[b].Timestamp)
		}
		return ka < kb
	})
	for _, r := range records {
		key := cursorKey(r)
		if _, err = tx.ExecContext(ctx, `INSERT INTO "IngestionCursor"(key,cursor,"updatedAt") VALUES($1,'',$2) ON CONFLICT(key) DO NOTHING`, key, batch.Now); err != nil {
			return out, &ingester.Failure{Code: "database"}
		}
		var cursor string
		if err = tx.QueryRowContext(ctx, `SELECT cursor FROM "IngestionCursor" WHERE key=$1 FOR UPDATE`, key).Scan(&cursor); err != nil {
			return out, &ingester.Failure{Code: "database"}
		}
		if cursor != "" {
			at, e := time.Parse(time.RFC3339Nano, cursor)
			if e != nil {
				return out, &ingester.Failure{Code: "database"}
			}
			if !r.Timestamp.After(at) {
				continue
			}
		}
		var exists bool
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM "RuntimeMetric" WHERE "sourceKey"=$1)`, r.SourceKey).Scan(&exists); err != nil {
			return out, &ingester.Failure{Code: "database"}
		}
		if !exists && out.Inserted >= batch.Limit {
			if _, err = tx.ExecContext(ctx, `DELETE FROM "IngestionCursor" WHERE key=$1 AND cursor=''`, key); err != nil {
				return out, &ingester.Failure{Code: "database"}
			}
			continue
		}
		result, e := tx.ExecContext(ctx, `INSERT INTO "RuntimeMetric"(id,"serviceId","deploymentId","podName","podUid","containerName",metric,value,unit,"sourceKey",timestamp) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT("sourceKey") DO NOTHING`, "rmet_"+r.SourceKey[:24], r.ServiceID, r.DeploymentID, r.PodName, r.PodUID, r.ContainerName, r.Metric, r.Value, r.Unit, r.SourceKey, r.Timestamp.UTC())
		if e != nil {
			return out, &ingester.Failure{Code: "database"}
		}
		count, e := result.RowsAffected()
		if e != nil {
			return out, &ingester.Failure{Code: "database"}
		}
		out.Inserted += int(count)
		if count > 0 && r.Timestamp.After(out.Newest) {
			out.Newest = r.Timestamp
		}
		if _, err = tx.ExecContext(ctx, `UPDATE "IngestionCursor" SET cursor=$2,"updatedAt"=$3 WHERE key=$1`, key, r.Timestamp.UTC().Format(time.RFC3339Nano), batch.Now); err != nil {
			return out, &ingester.Failure{Code: "database"}
		}
	}
	if err = tx.Commit(); err != nil {
		return out, &ingester.Failure{Code: "database"}
	}
	return out, nil
}

func cursorKey(r ingester.Record) string {
	return "metrics:" + r.PodUID + ":" + r.ContainerName + ":" + r.Metric
}
