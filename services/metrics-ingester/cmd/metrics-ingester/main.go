package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/raibitserver/metrics-ingester/internal/ingester"
	"github.com/raibitserver/metrics-ingester/internal/kube"
	dbstore "github.com/raibitserver/metrics-ingester/internal/store"
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
		PageSize: intEnv("RAIBITSERVER_INGEST_PAGE_SIZE", 100), MaxPods: intEnv("RAIBITSERVER_INGEST_MAX_PODS", 500),
		MaxContainersPerPod: intEnv("RAIBITSERVER_INGEST_MAX_CONTAINERS", 8), MaxSamplesPerRun: intEnv("RAIBITSERVER_INGEST_MAX_SAMPLES", 10000),
		MaxRunDuration: durationEnv("RAIBITSERVER_INGEST_MAX_DURATION", 20*time.Second), Retention: durationEnv("RAIBITSERVER_METRIC_RETENTION", 30*24*time.Hour),
	}, source, state)
	interval := durationEnv("RAIBITSERVER_INGEST_INTERVAL", 30*time.Second)
	var lastSuccess time.Time
	for {
		result, runErr := worker.RunOnce(ctx, time.Now().UTC())
		if runErr != nil {
			fmt.Fprintf(os.Stderr, "metrics ingestion failed kind=metric reason=%s\n", ingester.FailureCode(runErr))
		} else {
			fmt.Printf("metrics ingestion pods=%d samples=%d inserted=%d deleted=%d\n", result.Pods, result.Samples, result.Inserted, result.Deleted)
		}
		if result.Observed {
			lastSuccess = time.Now().UTC()
		}
		age := -1.0
		if !lastSuccess.IsZero() {
			age = max(0, time.Since(lastSuccess).Seconds())
		}
		fmt.Printf("ingestion_observation kind=metric observed=%t lag_seconds=%g last_success_age_seconds=%g\n", result.Observed, result.LagSeconds, age)
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
	fmt.Fprintf(os.Stderr, "metrics ingestion startup failed reason=%s\n", ingester.FailureCode(err))
	os.Exit(1)
}
