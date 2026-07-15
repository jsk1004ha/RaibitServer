package main

import (
	"errors"
	"testing"

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
