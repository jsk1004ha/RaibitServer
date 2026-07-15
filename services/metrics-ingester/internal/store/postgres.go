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
		return nil, nil, fmt.Errorf("connect metrics-ingester database: %w", err)
	}
	return &Postgres{db: db}, db.Close, nil
}

func (p *Postgres) Insert(ctx context.Context, records []ingester.Record) (int, error) {
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
		arguments := make([]any, 0, (end-start)*11)
		for _, record := range records[start:end] {
			if len(record.SourceKey) < 24 {
				return 0, errors.New("runtime-metric source key is invalid")
			}
			var deploymentID any
			if record.DeploymentID != "" {
				deploymentID = record.DeploymentID
			}
			base := len(arguments)
			placeholders := make([]string, 11)
			for index := range placeholders {
				placeholders[index] = "$" + strconv.Itoa(base+index+1)
			}
			values = append(values, "("+strings.Join(placeholders, ",")+")")
			arguments = append(arguments, "rmet_"+record.SourceKey[:24], record.ServiceID, deploymentID, record.PodName, record.PodUID, record.ContainerName, record.Metric, record.Value, record.Unit, record.SourceKey, record.Timestamp.UTC())
		}
		result, err := tx.ExecContext(ctx, `
INSERT INTO "RuntimeMetric" (id, "serviceId", "deploymentId", "podName", "podUid", "containerName", metric, value, unit, "sourceKey", timestamp)
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
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return inserted, nil
}

func (p *Postgres) DeleteOlderThan(ctx context.Context, before time.Time) (int64, error) {
	const batchSize = 10000
	result, err := p.db.ExecContext(ctx, `
WITH doomed AS (
  SELECT id FROM "RuntimeMetric" WHERE timestamp < $1 ORDER BY timestamp LIMIT $2
)
DELETE FROM "RuntimeMetric" AS metrics USING doomed WHERE metrics.id = doomed.id`, before.UTC(), batchSize)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}
