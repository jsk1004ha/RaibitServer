package main

import (
	"errors"
	"strings"
	"testing"

	"github.com/raibitserver/provisioner/internal/backup"
	"github.com/raibitserver/provisioner/internal/command"
	"github.com/raibitserver/provisioner/internal/reconciler"
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

func TestRecoveryStartupFailsClosedBeforeClaimsWhenHandlersAreNotRegistered(t *testing.T) {
	env := map[string]string{
		"RAIBITSERVER_PROVISIONER_BACKUP_ENABLED": "true", "RAIBITSERVER_PROVISIONER_BACKUP_ENDPOINT": "https://backup.example", "RAIBITSERVER_PROVISIONER_BACKUP_BUCKET": "private-backups", "RAIBITSERVER_PROVISIONER_BACKUP_CONFIG_FILE": backup.ConfigFile,
	}
	for index, engine := range []string{"POSTGRESQL", "MYSQL", "MARIADB", "MONGODB", "REDIS", "VALKEY"} {
		env["RAIBITSERVER_RECOVERY_TOOL_"+engine+"_IMAGE"] = "registry.example/recovery/" + strings.ToLower(engine) + "@sha256:" + strings.Repeat(string(rune('1'+index)), 64)
	}
	if _, err := configureRecovery(nil, &command.OSRunner{}, env); !errors.Is(err, backup.ErrRecoveryHandlerUnavailable) {
		t.Fatalf("missing handlers did not fail startup: %v", err)
	}
}
