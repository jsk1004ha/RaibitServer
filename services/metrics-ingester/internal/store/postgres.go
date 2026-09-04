package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/raibitserver/metrics-ingester/internal/ingester"
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
		return nil, nil, &ingester.Failure{Code: "database"}
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
		return nil, nil, &ingester.Failure{Code: "database"}
	}
	return &Postgres{db: db}, db.Close, nil
}

func (p *Postgres) DeleteOlderThan(ctx context.Context, before time.Time) (int64, error) {
	const batchSize = 10000
	result, err := p.db.ExecContext(ctx, `
WITH doomed AS (
  SELECT id FROM "RuntimeMetric" WHERE timestamp < $1 ORDER BY timestamp,id LIMIT $2 FOR UPDATE SKIP LOCKED
)
DELETE FROM "RuntimeMetric" AS metrics USING doomed WHERE metrics.id = doomed.id`, before.UTC(), batchSize)
	if err != nil {
		return 0, &ingester.Failure{Code: "database"}
	}
	if _, err := p.db.ExecContext(ctx, `WITH doomed AS (SELECT key FROM "IngestionCursor" WHERE key LIKE 'metrics:%' AND "updatedAt" < $1 ORDER BY "updatedAt",key LIMIT 10000 FOR UPDATE SKIP LOCKED) DELETE FROM "IngestionCursor" c USING doomed WHERE c.key=doomed.key`, before.UTC()); err != nil {
		return 0, &ingester.Failure{Code: "database"}
	}
	return result.RowsAffected()
}
