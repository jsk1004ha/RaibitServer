package backup

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/raibitserver/provisioner/internal/store"
)

func Test_RecoveryLifecycle_backup_uploads_reads_back_and_publishes_last(t *testing.T) {
	factory, state, wire, attempt := newLifecycleForTest(t, "")
	binding, err := NewSQLRecoveryAdapterBinding(NewPostgreSQLAdapter())
	if err != nil {
		t.Fatal(err)
	}
	handler, err := factory.Handler(binding)
	if err != nil {
		t.Fatal(err)
	}
	execution := backupExecution(attempt)

	err = handler.Handle(context.Background(), RecoveryWork{Claim: store.RecoveryClaim{}, Execution: execution, Source: mustBindSource(t, execution), Runner: &sqlRunner{}})

	if err != nil {
		t.Fatal(err)
	}
	want := []string{"renew", "fence", "intent", "upload", "fence", "candidate", "fence", "complete", "fence", "fence", "verified", "finish"}
	if events := state.snapshot(); !slices.Equal(events, want) || state.finishCount != 1 {
		t.Fatalf("durable order=%v", events)
	}
	if wire.readBytes == 0 || wire.object == nil {
		t.Fatalf("authenticated readback/upload missing: reads=%d object=%d", wire.readBytes, len(wire.object))
	}
}

func Test_RecoveryLifecycle_restore_authenticates_then_restores_distinct_target_before_ready(t *testing.T) {
	factory, state, wire, attempt := newLifecycleForTest(t, "")
	binding, _ := NewSQLRecoveryAdapterBinding(NewPostgreSQLAdapter())
	handler, _ := factory.Handler(binding)
	backup := backupExecution(attempt)
	if err := handler.Handle(context.Background(), RecoveryWork{Claim: store.RecoveryClaim{}, Execution: backup, Source: mustBindSource(t, backup), Runner: &sqlRunner{}}); err != nil {
		t.Fatal(err)
	}
	state.events = nil
	restore := restoreExecution(attempt)
	runner := &sqlRunner{}

	err := handler.Handle(context.Background(), RecoveryWork{Claim: store.RecoveryClaim{}, Execution: restore, Source: mustBindSource(t, restore), Target: mustBindTarget(t, restore), Runner: runner})

	if err != nil {
		t.Fatal(err)
	}
	if len(runner.runs) != 1 || runner.runs[0].input != "dump" {
		t.Fatalf("restore runs=%+v", runner.runs)
	}
	want := []string{"renew", "fence", "read-attempts", "fence", "start-verification", "finish"}
	if events := state.snapshot(); !slices.Equal(events, want) || wire.readBytes == 0 {
		t.Fatalf("restore order=%v read=%d", events, wire.readBytes)
	}
}

func Test_RecoveryLifecycle_lease_loss_prevents_side_effects_and_publication(t *testing.T) {
	factory, state, _, attempt := newLifecycleForTest(t, "")
	state.renewErr = store.ErrRecoveryFence
	binding, _ := NewSQLRecoveryAdapterBinding(NewPostgreSQLAdapter())
	handler, _ := factory.Handler(binding)
	execution := backupExecution(attempt)

	err := handler.Handle(context.Background(), RecoveryWork{Claim: store.RecoveryClaim{}, Execution: execution, Source: mustBindSource(t, execution), Runner: &sqlRunner{}})

	if !errors.Is(err, store.ErrRecoveryFence) || !slices.Equal(state.snapshot(), []string{"renew"}) {
		t.Fatalf("events=%v err=%v", state.snapshot(), err)
	}
}

func Test_RecoveryLifecycle_renewal_loss_cancels_running_handoff_and_blocks_publication(t *testing.T) {
	factory, state, _, attempt := newLifecycleForTest(t, "")
	ticks := make(chan time.Time, 1)
	factory.schedule = manualLeaseSchedule{ticks: ticks}
	binding, _ := NewSQLRecoveryAdapterBinding(NewPostgreSQLAdapter())
	handler, _ := factory.Handler(binding)
	execution := backupExecution(attempt)
	source := mustBindSource(t, execution)
	runner := &cancelRunner{started: make(chan struct{})}
	done := make(chan error, 1)
	go func() {
		done <- handler.Handle(context.Background(), RecoveryWork{Claim: store.RecoveryClaim{}, Execution: execution, Source: source, Runner: runner})
	}()
	select {
	case <-runner.started:
	case <-time.After(2 * time.Second):
		t.Fatal("runner did not start")
	}
	state.setRenewError(store.ErrRecoveryFence)
	ticks <- time.Now()
	select {
	case err := <-done:
		if !errors.Is(err, store.ErrRecoveryFence) || slices.Contains(state.snapshot(), "candidate") || slices.Contains(state.snapshot(), "finish") {
			t.Fatalf("events=%v err=%v", state.snapshot(), err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("lease loss did not cancel the running handoff")
	}
}

func Test_RecoveryLifecycle_upload_uncertainty_remains_cleanup_pending(t *testing.T) {
	factory, state, _, attempt := newLifecycleForTest(t, "create-unknown")
	binding, _ := NewSQLRecoveryAdapterBinding(NewPostgreSQLAdapter())
	handler, _ := factory.Handler(binding)
	execution := backupExecution(attempt)

	err := handler.Handle(context.Background(), RecoveryWork{Claim: store.RecoveryClaim{}, Execution: execution, Source: mustBindSource(t, execution), Runner: &sqlRunner{}})

	if !errors.Is(err, ErrCleanupPending) || slices.Contains(state.snapshot(), "finish") || !state.attempts[0].CleanupPending {
		t.Fatalf("events=%v cleanup=%v err=%v", state.snapshot(), state.attempts[0].CleanupPending, err)
	}
}

func Test_RecoveryLifecycle_cleanup_records_remote_completion_before_finish(t *testing.T) {
	factory, state, _, attempt := newLifecycleForTest(t, "")
	binding, _ := NewSQLRecoveryAdapterBinding(NewPostgreSQLAdapter())
	handler, _ := factory.Handler(binding)
	execution := backupExecution(attempt)
	if err := handler.Handle(context.Background(), RecoveryWork{Claim: store.RecoveryClaim{}, Execution: execution, Source: mustBindSource(t, execution), Runner: &sqlRunner{}}); err != nil {
		t.Fatal(err)
	}
	state.attempts[0].State = "PREPARED"
	state.events = nil

	err := handler.(*RecoveryLifecycle).Cleanup(context.Background(), execution.Identity)

	if err != nil {
		t.Fatal(err)
	}
	want := []string{"cleanup-claim", "cleanup-fence", "cleanup-read", "cleanup-fence", "cleanup-remote-complete", "cleanup-fence", "cleanup-mark", "cleanup-finish"}
	if events := state.snapshot(); !slices.Equal(events, want) || state.attempts[0].CleanupPending {
		t.Fatalf("cleanup order=%v pending=%v", events, state.attempts[0].CleanupPending)
	}
}

func mustBindSource(t *testing.T, execution store.RecoveryExecution) Connection {
	t.Helper()
	value, err := BindRecoverySource(execution, testToolPolicy(t))
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func mustBindTarget(t *testing.T, execution store.RecoveryExecution) *Connection {
	t.Helper()
	value, err := BindRecoveryTarget(execution, testToolPolicy(t))
	if err != nil {
		t.Fatal(err)
	}
	return &value
}
