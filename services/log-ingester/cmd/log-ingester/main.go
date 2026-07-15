package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/raibitserver/log-ingester/internal/ingester"
	"github.com/raibitserver/log-ingester/internal/kube"
	dbstore "github.com/raibitserver/log-ingester/internal/store"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	source, err := kube.NewFromEnvironment()
	if err != nil {
		fatal(err)
	}
	state, closeStore, err := dbstore.Open(ctx, os.Getenv("DATABASE_URL"), dbstore.Config{
		MaxOpenConns: intEnv("RAIBITSERVER_DB_MAX_OPEN_CONNS", 5), MaxIdleConns: intEnv("RAIBITSERVER_DB_MAX_IDLE_CONNS", 2),
		ConnMaxLifetime: durationEnv("RAIBITSERVER_DB_CONN_MAX_LIFETIME", 30*time.Minute),
	})
	if err != nil {
		fatal(err)
	}
	defer closeStore()
	worker := ingester.New(ingester.Config{
		PageSize: intEnv("RAIBITSERVER_INGEST_PAGE_SIZE", 100), MaxPods: intEnv("RAIBITSERVER_INGEST_MAX_PODS", 200),
		MaxContainersPerPod: intEnv("RAIBITSERVER_INGEST_MAX_CONTAINERS", 8), MaxLinesPerContainer: intEnv("RAIBITSERVER_INGEST_MAX_LINES", 1000),
		MaxLineBytes: intEnv("RAIBITSERVER_INGEST_MAX_LINE_BYTES", 16*1024), MaxReadBytes: int64(intEnv("RAIBITSERVER_INGEST_MAX_READ_BYTES", 1024*1024)),
		MaxRecordsPerRun: intEnv("RAIBITSERVER_INGEST_MAX_RECORDS", 10000), MaxBytesPerRun: int64(intEnv("RAIBITSERVER_INGEST_MAX_BYTES", 16*1024*1024)),
		MaxRunDuration: durationEnv("RAIBITSERVER_INGEST_MAX_DURATION", 20*time.Second),
		Retention:      durationEnv("RAIBITSERVER_LOG_RETENTION", 7*24*time.Hour),
	}, source, state)
	interval := durationEnv("RAIBITSERVER_INGEST_INTERVAL", 15*time.Second)
	for {
		result, runErr := worker.RunOnce(ctx, time.Now().UTC())
		if runErr != nil {
			fmt.Fprintf(os.Stderr, "log ingestion failed: %v\n", runErr)
		} else {
			fmt.Printf("log ingestion pods=%d containers=%d inserted=%d deleted=%d\n", result.Pods, result.Containers, result.Inserted, result.Deleted)
		}
		if os.Getenv("RAIBITSERVER_RUN_ONCE") == "1" {
			if runErr != nil {
				os.Exit(1)
			}
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
	}
}

func intEnv(key string, fallback int) int {
	value, err := strconv.Atoi(os.Getenv(key))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func durationEnv(key string, fallback time.Duration) time.Duration {
	value, err := time.ParseDuration(os.Getenv(key))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
