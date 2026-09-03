package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/raibitserver/log-ingester/internal/safeerror"
)

type (
	Config struct {
		MaxOpenConns, MaxIdleConns int
		ConnMaxLifetime            time.Duration
	}
	Postgres struct{ db *sql.DB }
)

func Open(ctx context.Context, dsn string, config Config) (*Postgres, func() error, error) {
	if strings.TrimSpace(dsn) == "" {
		return nil, nil, errors.New("DATABASE_URL is required")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, nil, &safeerror.Error{Operation: "database configuration", Cause: err}
	}
	if config.MaxOpenConns <= 0 {
		config.MaxOpenConns = 5
	}
	if config.MaxIdleConns < 0 {
		config.MaxIdleConns = 0
	}
	config.MaxIdleConns = min(config.MaxIdleConns, config.MaxOpenConns)
	if config.ConnMaxLifetime <= 0 {
		config.ConnMaxLifetime = 30 * time.Minute
	}
	db.SetMaxOpenConns(config.MaxOpenConns)
	db.SetMaxIdleConns(config.MaxIdleConns)
	db.SetConnMaxLifetime(config.ConnMaxLifetime)
	if err := db.PingContext(ctx); err != nil {
		closeErr := db.Close()
		return nil, nil, &safeerror.Error{Operation: "database connection", Cause: errors.Join(err, closeErr)}
	}
	return &Postgres{db: db}, db.Close, nil
}

func (p *Postgres) State(ctx context.Context, key string) (string, error) {
	var raw string
	err := p.db.QueryRowContext(ctx, `SELECT cursor FROM "IngestionCursor" WHERE key=$1`, key).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", &safeerror.Error{Operation: "database cursor", Cause: err}
	}
	return raw, nil
}

func (p *Postgres) Cursor(ctx context.Context, key string) (time.Time, error) {
	raw, err := p.State(ctx, key)
	if err != nil || raw == "" {
		return time.Time{}, err
	}
	at, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return time.Time{}, &safeerror.Error{Operation: "cursor parsing", Cause: err}
	}
	return at, nil
}

func (p *Postgres) Existing(ctx context.Context, keys []string) (map[string]bool, error) {
	found := map[string]bool{}
	if len(keys) == 0 {
		return found, nil
	}
	rows, err := p.db.QueryContext(ctx, `SELECT "sourceKey" FROM "RuntimeLog" WHERE "sourceKey"=ANY($1::text[])`, keys)
	if err != nil {
		return nil, &safeerror.Error{Operation: "database deduplication", Cause: err}
	}
	defer rows.Close()
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return nil, &safeerror.Error{Operation: "database deduplication", Cause: err}
		}
		found[key] = true
	}
	if err := rows.Err(); err != nil {
		return nil, &safeerror.Error{Operation: "database deduplication", Cause: err}
	}
	return found, nil
}

func (p *Postgres) transaction(ctx context.Context, apply func(*sql.Tx) error) (err error) {
	tx, err := p.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return &safeerror.Error{Operation: "database transaction", Cause: err}
	}
	defer func() {
		if rollbackErr := tx.Rollback(); rollbackErr != nil && !errors.Is(rollbackErr, sql.ErrTxDone) {
			err = errors.Join(err, rollbackErr)
		}
		if err != nil {
			err = &safeerror.Error{Operation: "database transaction", Cause: err}
		}
	}()
	if err = apply(tx); err != nil {
		return err
	}
	return tx.Commit()
}

func (p *Postgres) DeleteOlderThan(ctx context.Context, before time.Time) (int64, error) {
	var deleted int64
	err := p.transaction(ctx, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, `WITH doomed AS (SELECT id FROM "RuntimeLog" WHERE timestamp<$1 ORDER BY timestamp LIMIT 10000) DELETE FROM "RuntimeLog" logs USING doomed WHERE logs.id=doomed.id`, before.UTC())
		if err != nil {
			return err
		}
		deleted, err = result.RowsAffected()
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `DELETE FROM "IngestionCursor" WHERE key IN (SELECT key FROM "IngestionCursor" WHERE (key LIKE 'logs:%' OR key LIKE 'logs-state:%') AND "updatedAt"<$1 ORDER BY "updatedAt" LIMIT 10000)`, before.UTC())
		return err
	})
	return deleted, err
}
