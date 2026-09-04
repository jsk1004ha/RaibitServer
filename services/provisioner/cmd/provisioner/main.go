package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/raibitserver/provisioner/internal/backup"
	"github.com/raibitserver/provisioner/internal/command"
	"github.com/raibitserver/provisioner/internal/provider"
	"github.com/raibitserver/provisioner/internal/reconciler"
	"github.com/raibitserver/provisioner/internal/store"
)

func main() {
	resourceEnvironment := os.Getenv("RAIBITSERVER_RESOURCE_ENVIRONMENT")
	eligibleImages, err := provider.EligibleResourceImages(resourceEnvironment, providerImages())
	if err != nil {
		fmt.Fprintf(os.Stderr, "provisioner resource configuration failed: %v\n", err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	databaseURL := firstNonEmpty(os.Getenv("RAIBITSERVER_CONTROL_PLANE_DATABASE_URL"), os.Getenv("DATABASE_URL"))
	state, closeStore, err := store.OpenPostgresStore(ctx, databaseURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "provisioner control-plane connection failed: %v\n", err)
		os.Exit(1)
	}
	defer closeStore()
	state.ConfigureResourceClaims(resourceEnvironment, eligibleImages)
	commandRunner := &command.OSRunner{}
	recovery, err := configureRecovery(state, commandRunner, processEnvironment())
	if err != nil {
		fmt.Fprintf(os.Stderr, "provisioner recovery configuration failed: %v\n", err)
		os.Exit(1)
	}
	if recovery != nil {
		defer recovery.Close()
	}
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
	}, state, commandRunner)
	for {
		if recovery != nil {
			processed, recoveryErr := recovery.RunOnce(ctx)
			if recoveryErr != nil {
				fmt.Fprintf(os.Stderr, "provisioner recovery dispatch failed: %v\n", recoveryErr)
			}
			if processed {
				continue
			}
		}
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

func configureRecovery(state *store.PostgresStore, runner *command.OSRunner, env map[string]string) (*backup.RecoveryDispatcher, error) {
	operator, err := backup.ParseOperator(env)
	if err != nil || !operator.Enabled() {
		return nil, err
	}
	policy, err := backup.ParseRecoveryToolPolicy(env)
	if err != nil {
		return nil, err
	}
	bundleFile, err := os.Open(operator.BundleFile())
	if err != nil {
		return nil, errors.Join(backup.ErrConfig, err)
	}
	bundle, parseErr := backup.ParseBundle(bundleFile)
	closeErr := bundleFile.Close()
	if err := errors.Join(parseErr, closeErr); err != nil {
		return nil, errors.Join(backup.ErrConfig, err)
	}
	service, err := backup.NewService(operator, bundle, backup.Options{})
	if err != nil {
		return nil, err
	}
	factory, err := backup.NewRecoveryHandlerFactory(state, service)
	if err != nil {
		service.Close()
		return nil, err
	}
	handlers, err := recoveryHandlers(factory, policy)
	if err != nil {
		service.Close()
		return nil, err
	}
	client, err := backup.NewCommandKubernetesJobClient(runner, secondsEnv("RAIBITSERVER_RECOVERY_JOB_TIMEOUT_SECONDS", 30*time.Minute))
	if err != nil {
		service.Close()
		return nil, err
	}
	jobRunner, err := backup.NewKubernetesJobRunner(client)
	if err != nil {
		service.Close()
		return nil, err
	}
	dispatcher, err := backup.NewRecoveryDispatcher(state, policy, jobRunner, handlers, "provisioner-recovery")
	if err != nil {
		service.Close()
		return nil, err
	}
	return dispatcher, nil
}

func recoveryHandlers(factory *backup.RecoveryHandlerFactory, policy backup.RecoveryToolPolicy) ([]backup.RecoveryHandler, error) {
	adapters := []backup.RecoveryAdapter{
		backup.NewPostgreSQLAdapter(),
		backup.NewMySQLRecoveryAdapter(),
		backup.NewMariaDBRecoveryAdapter(),
		backup.NewMongoDBRecoveryAdapter(),
		backup.NewRedisRecoveryAdapter(),
		backup.NewValkeyRecoveryAdapter(),
	}
	handlers := make([]backup.RecoveryHandler, 0, len(adapters))
	for _, adapter := range adapters {
		if !policy.Enabled(adapter.Engine()) {
			continue
		}
		var (
			binding backup.RecoveryAdapterBinding
			err     error
		)
		switch adapter.Engine() {
		case backup.EnginePostgreSQL, backup.EngineMySQL, backup.EngineMariaDB:
			binding, err = backup.NewSQLRecoveryAdapterBinding(adapter)
		case backup.EngineMongoDB:
			binding, err = backup.NewMongoDBRecoveryAdapterBinding(adapter)
		case backup.EngineRedis, backup.EngineValkey:
			binding, err = backup.NewCacheRecoveryAdapterBinding(adapter)
		default:
			return nil, backup.ErrConfig
		}
		if err != nil {
			return nil, err
		}
		handler, err := factory.Handler(binding)
		if err != nil {
			return nil, err
		}
		handlers = append(handlers, handler)
	}
	return handlers, nil
}

func processEnvironment() map[string]string {
	result := make(map[string]string)
	for _, entry := range os.Environ() {
		for index := range entry {
			if entry[index] == '=' {
				result[entry[:index]] = entry[index+1:]
				break
			}
		}
	}
	return result
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
