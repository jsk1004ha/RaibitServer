package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/raibitserver/log-ingester/internal/ingester"
)

type Config struct {
	MaxOpenConns    int
	MaxIdleConns    int
	ConnMaxLifetime time.Duration
}

type Postgres struct{ db *sql.DB }

func Open(ctx context.Context, dsn string, config Config) (*Postgres, func() error, error) {
	if strings.TrimSpace(dsn) == "" {
		return nil, nil, errors.New("DATABASE_URL is required")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, nil, err
	}
	if config.MaxOpenConns <= 0 {
		config.MaxOpenConns = 5
	}
	if config.MaxIdleConns < 0 {
		config.MaxIdleConns = 0
	}
	if config.MaxIdleConns > config.MaxOpenConns {
		config.MaxIdleConns = config.MaxOpenConns
	}
	if config.ConnMaxLifetime <= 0 {
		config.ConnMaxLifetime = 30 * time.Minute
	}
	db.SetMaxOpenConns(config.MaxOpenConns)
	db.SetMaxIdleConns(config.MaxIdleConns)
	db.SetConnMaxLifetime(config.ConnMaxLifetime)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, nil, fmt.Errorf("connect log-ingester database: %w", err)
	}
	return &Postgres{db: db}, db.Close, nil
}

func (p *Postgres) Cursor(ctx context.Context, key string) (time.Time, error) {
	var value string
	err := p.db.QueryRowContext(ctx, `SELECT cursor FROM "IngestionCursor" WHERE key = $1`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return time.Time{}, nil
	}
	if err != nil {
		return time.Time{}, err
	}
	at, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid ingestion cursor %q: %w", key, err)
	}
	return at, nil
}

func (p *Postgres) Insert(ctx context.Context, records []ingester.Record, cursors []ingester.CursorUpdate) (int, error) {
	tx, err := p.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	inserted := 0
	const batchSize = 100
	for start := 0; start < len(records); start += batchSize {
		end := min(start+batchSize, len(records))
		values := make([]string, 0, end-start)
		arguments := make([]any, 0, (end-start)*10)
		for _, record := range records[start:end] {
			if len(record.SourceKey) < 24 {
				return 0, errors.New("runtime-log source key is invalid")
			}
			var deploymentID any
			if record.DeploymentID != "" {
				deploymentID = record.DeploymentID
			}
			base := len(arguments)
			placeholders := make([]string, 10)
			for index := range placeholders {
				placeholders[index] = "$" + strconv.Itoa(base+index+1)
			}
			values = append(values, "("+strings.Join(placeholders, ",")+")")
			arguments = append(arguments, "rlog_"+record.SourceKey[:24], record.ServiceID, deploymentID, record.PodName, record.PodUID, record.ContainerName, record.Line, record.Level, record.SourceKey, record.Timestamp.UTC())
		}
		result, err := tx.ExecContext(ctx, `
INSERT INTO "RuntimeLog" (id, "serviceId", "deploymentId", "podName", "podUid", "containerName", line, level, "sourceKey", timestamp)
VALUES `+strings.Join(values, ",")+`
ON CONFLICT ("sourceKey") DO NOTHING`, arguments...)
		if err != nil {
			return 0, err
		}
		rows, err := result.RowsAffected()
		if err != nil {
			return 0, err
		}
		inserted += int(rows)
	}
	const cursorBatchSize = 100
	updatedAt := time.Now().UTC()
	for start := 0; start < len(cursors); start += cursorBatchSize {
		end := min(start+cursorBatchSize, len(cursors))
		values := make([]string, 0, end-start)
		arguments := make([]any, 0, (end-start)*3)
		for _, update := range cursors[start:end] {
			if strings.TrimSpace(update.Key) == "" || update.Cursor.IsZero() {
				return 0, errors.New("runtime-log cursor update is invalid")
			}
			base := len(arguments)
			values = append(values, fmt.Sprintf("($%d,$%d,$%d)", base+1, base+2, base+3))
			arguments = append(arguments, update.Key, update.Cursor.UTC().Format(time.RFC3339Nano), updatedAt)
		}
		_, err = tx.ExecContext(ctx, `
INSERT INTO "IngestionCursor" (key, cursor, "updatedAt") VALUES `+strings.Join(values, ",")+`
ON CONFLICT (key) DO UPDATE SET cursor = EXCLUDED.cursor, "updatedAt" = EXCLUDED."updatedAt"
WHERE "IngestionCursor".cursor::timestamptz <= EXCLUDED.cursor::timestamptz`, arguments...)
		if err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return inserted, nil
}

func (p *Postgres) DeleteOlderThan(ctx context.Context, before time.Time) (int64, error) {
	tx, err := p.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	const batchSize = 10000
	result, err := tx.ExecContext(ctx, `
WITH doomed AS (
  SELECT id FROM "RuntimeLog" WHERE timestamp < $1 ORDER BY timestamp LIMIT $2
)
DELETE FROM "RuntimeLog" AS logs USING doomed WHERE logs.id = doomed.id`, before.UTC(), batchSize)
	if err != nil {
		return 0, err
	}
	deleted, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, `
DELETE FROM "IngestionCursor" WHERE key IN (
  SELECT key FROM "IngestionCursor" WHERE "updatedAt" < $1 ORDER BY "updatedAt" LIMIT $2
)`, before.UTC(), batchSize); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return deleted, nil
}
