package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/raibitserver/provisioner/internal/backup"
	"github.com/raibitserver/provisioner/internal/command"
	"github.com/raibitserver/provisioner/internal/reconciler"
	"github.com/raibitserver/provisioner/internal/store"
)

func TestReconcileLoopDrainsSuccessfulBacklogWithoutAnIdlePollingDelay(t *testing.T) {
	if shouldWait(&reconciler.Result{Processed: 1}, nil) {
		t.Fatal("a successful processed resource must immediately yield to the next backlog item")
	}
	if !shouldWait(&reconciler.Result{}, nil) {
		t.Fatal("an idle poll must wait for the configured interval")
	}
	if shouldWait(&reconciler.Result{Processed: 1, DryRun: true}, nil) {
		t.Fatal("dry-run must drain other eligible rows before the store-level recheck window makes the first row eligible again")
	}
	if !shouldWait(&reconciler.Result{Processed: 1}, errors.New("control-plane unavailable")) {
		t.Fatal("errors must retain backoff instead of creating a tight retry loop")
	}
}

func TestRecoveryStartupFailsClosedBeforeClaimsWhenObjectEncryptionConfigIsUnavailable(t *testing.T) {
	env := map[string]string{
		"RAIBITSERVER_PROVISIONER_BACKUP_ENABLED": "true", "RAIBITSERVER_PROVISIONER_BACKUP_ENDPOINT": "https://backup.example", "RAIBITSERVER_PROVISIONER_BACKUP_BUCKET": "private-backups", "RAIBITSERVER_PROVISIONER_BACKUP_CONFIG_FILE": backup.ConfigFile,
	}
	for index, engine := range []string{"POSTGRESQL", "MYSQL", "MARIADB"} {
		env["RAIBITSERVER_RECOVERY_TOOL_"+engine+"_IMAGE"] = "registry.example/recovery/" + strings.ToLower(engine) + "@sha256:" + strings.Repeat(string(rune('1'+index)), 64)
	}
	if _, err := configureRecovery(nil, &command.OSRunner{}, env); !errors.Is(err, backup.ErrConfig) {
		t.Fatalf("missing object/encryption material did not fail startup before store access: %v", err)
	}
}

func TestRecoveryHandlersRegistersEveryImplementedAdapter(t *testing.T) {
	service := registrationService(t)
	state := &registrationStore{}
	factory, err := backup.NewRecoveryHandlerFactory(state, service)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := backup.ParseRecoveryToolPolicy(map[string]string{
		"RAIBITSERVER_RECOVERY_TOOL_POSTGRESQL_IMAGE": "registry.example/recovery/postgresql@sha256:" + strings.Repeat("1", 64),
		"RAIBITSERVER_RECOVERY_TOOL_MYSQL_IMAGE":      "registry.example/recovery/mysql@sha256:" + strings.Repeat("2", 64),
		"RAIBITSERVER_RECOVERY_TOOL_MARIADB_IMAGE":    "registry.example/recovery/mariadb@sha256:" + strings.Repeat("3", 64),
		"RAIBITSERVER_RECOVERY_TOOL_MONGODB_IMAGE":    "registry.example/recovery/mongodb@sha256:" + strings.Repeat("4", 64),
		"RAIBITSERVER_RECOVERY_TOOL_REDIS_IMAGE":      "registry.example/recovery/redis@sha256:" + strings.Repeat("5", 64),
		"RAIBITSERVER_RECOVERY_TOOL_VALKEY_IMAGE":     "registry.example/recovery/valkey@sha256:" + strings.Repeat("6", 64),
	})
	if err != nil {
		t.Fatal(err)
	}

	handlers, err := recoveryHandlers(factory, policy)
	if err != nil {
		t.Fatal(err)
	}
	if len(handlers) != 6 {
		t.Fatalf("registered handlers=%d", len(handlers))
	}
	want := map[backup.Engine]bool{
		backup.EnginePostgreSQL: false,
		backup.EngineMySQL:      false,
		backup.EngineMariaDB:    false,
		backup.EngineMongoDB:    false,
		backup.EngineRedis:      false,
		backup.EngineValkey:     false,
	}
	for _, handler := range handlers {
		if handler == nil {
			t.Fatal("nil production handler")
		}
		want[handler.Engine()] = true
	}
	for engine, registered := range want {
		if !registered {
			t.Fatalf("engine %s is not registered", engine)
		}
	}
	if state.claims != 0 {
		t.Fatalf("registration touched durable claims: %d", state.claims)
	}
}

func registrationService(t *testing.T) *backup.Service {
	t.Helper()
	server := httptest.NewTLSServer(http.NotFoundHandler())
	t.Cleanup(server.Close)
	config, err := backup.ParseOperator(map[string]string{
		"RAIBITSERVER_PROVISIONER_BACKUP_ENABLED": "true", "RAIBITSERVER_PROVISIONER_BACKUP_ENDPOINT": server.URL,
		"RAIBITSERVER_PROVISIONER_BACKUP_BUCKET": "private-test", "RAIBITSERVER_PROVISIONER_BACKUP_CONFIG_FILE": backup.ConfigFile,
	})
	if err != nil {
		t.Fatal(err)
	}
	key := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	bundle, err := backup.ParseBundle(strings.NewReader(`{"version":1,"accessKeyId":"access","secretAccessKey":"secret","currentKeyVersion":"key-1","keys":{"key-1":"` + key + `"}}`))
	if err != nil {
		t.Fatal(err)
	}
	tlsConfig := server.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
	tlsConfig.MinVersion = tls.VersionTLS12
	service, err := backup.NewService(config, bundle, backup.Options{TLSConfig: tlsConfig})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(service.Close)
	return service
}

type registrationStore struct{ claims int }

func (s *registrationStore) ClaimNextRecovery(context.Context, string) (*store.RecoveryClaim, error) {
	s.claims++
	return nil, nil
}
func (*registrationStore) RenewRecovery(context.Context, store.RecoveryClaim) error { return nil }
func (*registrationStore) FenceRecovery(context.Context, store.RecoveryClaim) error { return nil }
func (*registrationStore) RecordRecoveryIntent(context.Context, store.RecoveryClaim, string) (store.RecoveryAttempt, error) {
	return store.RecoveryAttempt{}, nil
}
func (*registrationStore) RecordRecoveryUpload(context.Context, store.RecoveryClaim, string) error {
	return nil
}
func (*registrationStore) RecordRecoveryCandidate(context.Context, store.RecoveryClaim, store.RecoveryArtifact) error {
	return nil
}
func (*registrationStore) RecordRecoveryComplete(context.Context, store.RecoveryClaim) error {
	return nil
}
func (*registrationStore) RecordRecoveryVerified(context.Context, store.RecoveryClaim) error {
	return nil
}
func (*registrationStore) StartRestoreVerification(context.Context, store.RecoveryClaim) error {
	return nil
}
func (*registrationStore) FinishRecovery(context.Context, store.RecoveryClaim) error { return nil }
func (*registrationStore) FailRecovery(context.Context, store.RecoveryClaim) error   { return nil }
func (*registrationStore) CancelRestore(context.Context, store.RecoveryClaim) error  { return nil }
func (*registrationStore) RetryRecovery(context.Context, store.RecoveryClaim) error  { return nil }
func (*registrationStore) ReadRecoveryAttempts(context.Context, store.RecoveryClaim) ([]store.RecoveryAttempt, error) {
	return nil, nil
}
func (*registrationStore) ReadRecoveryExecution(context.Context, store.RecoveryClaim) (store.RecoveryExecution, error) {
	return store.RecoveryExecution{}, nil
}
func (*registrationStore) ClaimRecoveryCleanup(context.Context, store.RecoveryIdentity, string) (store.RecoveryCleanupClaim, error) {
	return store.RecoveryCleanupClaim{}, nil
}
func (*registrationStore) FenceRecoveryCleanup(context.Context, store.RecoveryCleanupClaim) error {
	return nil
}
func (*registrationStore) ReadRecoveryCleanup(context.Context, store.RecoveryCleanupClaim) ([]store.RecoveryAttempt, error) {
	return nil, nil
}
func (*registrationStore) RecordRecoveryCleanupRemoteCompletion(context.Context, store.RecoveryCleanupClaim, store.RecoveryArtifact) error {
	return nil
}
func (*registrationStore) MarkRecoveryAttemptCleaned(context.Context, store.RecoveryCleanupClaim, int) error {
	return nil
}
func (*registrationStore) FinishRecoveryCleanup(context.Context, store.RecoveryCleanupClaim) error {
	return nil
}
