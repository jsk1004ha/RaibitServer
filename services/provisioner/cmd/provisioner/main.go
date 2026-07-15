package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/raibitserver/provisioner/internal/reconciler"
	"github.com/raibitserver/provisioner/internal/store"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	databaseURL := firstNonEmpty(os.Getenv("RAIBITSERVER_CONTROL_PLANE_DATABASE_URL"), os.Getenv("DATABASE_URL"))
	state, closeStore, err := store.OpenPostgresStore(ctx, databaseURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "provisioner control-plane connection failed: %v\n", err)
		os.Exit(1)
	}
	defer closeStore()
	dryRun := os.Getenv("RAIBITSERVER_DRY_RUN") != "0" && os.Getenv("RAIBITSERVER_EXECUTE") != "1"
	interval := secondsEnv("RAIBITSERVER_RECONCILE_INTERVAL_SECONDS", 5*time.Second)
	worker := reconciler.New(reconciler.Config{
		DryRun:                  dryRun,
		OutputDir:               firstNonEmpty(os.Getenv("RAIBITSERVER_PROVISIONER_OUTPUT_DIR"), "/tmp/raibitserver-provisioner"),
		Timeout:                 secondsEnv("RAIBITSERVER_PROVISION_TIMEOUT_SECONDS", 10*time.Minute),
		ClaimLease:              secondsEnv("RAIBITSERVER_CLAIM_LEASE_SECONDS", 15*time.Minute),
		HealthInterval:          secondsEnv("RAIBITSERVER_PROVIDER_HEALTH_INTERVAL_SECONDS", 5*time.Minute),
		DryRunRecheck:           interval,
		Images:                  providerImages(),
		ServiceAccountName:      os.Getenv("RAIBITSERVER_PROVISIONER_SERVICE_ACCOUNT_NAME"),
		ServiceAccountNamespace: os.Getenv("RAIBITSERVER_PROVISIONER_SERVICE_ACCOUNT_NAMESPACE"),
		TenantRoleName:          os.Getenv("RAIBITSERVER_PROVISIONER_TENANT_ROLE_NAME"),
	}, state, nil)
	for {
		result, err := worker.RunOnce(ctx)
		if err != nil {
			fmt.Fprintf(os.Stderr, "provisioner reconcile failed: %v\n", err)
		} else {
			_ = json.NewEncoder(os.Stdout).Encode(result)
		}
		if !shouldWait(result, err) {
			continue
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func shouldWait(result *reconciler.Result, reconcileErr error) bool {
	return reconcileErr != nil || result == nil || result.Processed == 0
}

func providerImages() map[string]string {
	return map[string]string{
		"postgresql":     os.Getenv("RAIBITSERVER_PROVIDER_POSTGRESQL_IMAGE"),
		"mysql":          os.Getenv("RAIBITSERVER_PROVIDER_MYSQL_IMAGE"),
		"mariadb":        os.Getenv("RAIBITSERVER_PROVIDER_MARIADB_IMAGE"),
		"mongodb":        os.Getenv("RAIBITSERVER_PROVIDER_MONGODB_IMAGE"),
		"redis":          os.Getenv("RAIBITSERVER_PROVIDER_REDIS_IMAGE"),
		"valkey":         os.Getenv("RAIBITSERVER_PROVIDER_VALKEY_IMAGE"),
		"object-storage": os.Getenv("RAIBITSERVER_PROVIDER_MINIO_IMAGE"),
		"qdrant":         os.Getenv("RAIBITSERVER_PROVIDER_QDRANT_IMAGE"),
		"nats":           os.Getenv("RAIBITSERVER_PROVIDER_NATS_IMAGE"),
	}
}

func secondsEnv(name string, fallback time.Duration) time.Duration {
	seconds, err := strconv.Atoi(os.Getenv(name))
	if err != nil || seconds <= 0 {
		return fallback
	}
	return time.Duration(seconds) * time.Second
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
