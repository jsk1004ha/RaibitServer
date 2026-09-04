package backup

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/raibitserver/provisioner/internal/store"
)

type fakeRecoveryDispatchStore struct {
	claims    int
	reads     int
	retries   int
	failures  int
	cancels   int
	execution store.RecoveryExecution
	cleanup   *store.RecoveryIdentity
	noClaim   bool
}

func (s *fakeRecoveryDispatchStore) ClaimNextRecovery(context.Context, string) (*store.RecoveryClaim, error) {
	s.claims++
	if s.noClaim {
		return nil, nil
	}
	return &store.RecoveryClaim{}, nil
}
func (s *fakeRecoveryDispatchStore) NextRecoveryCleanup(context.Context) (*store.RecoveryIdentity, error) {
	return s.cleanup, nil
}
func (s *fakeRecoveryDispatchStore) ReadRecoveryExecution(context.Context, store.RecoveryClaim) (store.RecoveryExecution, error) {
	s.reads++
	return s.execution, nil
}

func (s *fakeRecoveryDispatchStore) RetryRecovery(ctx context.Context, _ store.RecoveryClaim) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.retries++
	return nil
}
func (s *fakeRecoveryDispatchStore) FailRecovery(ctx context.Context, _ store.RecoveryClaim) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.failures++
	return nil
}
func (s *fakeRecoveryDispatchStore) CancelRestore(ctx context.Context, _ store.RecoveryClaim) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.cancels++
	return nil
}

type fakeRecoveryHandler struct {
	called       int
	cleanupKinds []store.RecoveryKind
	cleanupErr   error
}

func (*fakeRecoveryHandler) Engine() Engine { return EnginePostgreSQL }
func (h *fakeRecoveryHandler) Handle(_ context.Context, work RecoveryWork) error {
	h.called++
	if work.Source.ResourceID() != "source" || work.Target != nil || work.Runner == nil {
		return ErrRecoveryRequest
	}
	return nil
}

func (h *fakeRecoveryHandler) Cleanup(_ context.Context, identity store.RecoveryIdentity) error {
	if identity.Kind != store.RecoveryBackup && identity.Kind != store.RecoveryRestore {
		return ErrRecoveryRequest
	}
	h.cleanupKinds = append(h.cleanupKinds, identity.Kind)
	return h.cleanupErr
}

func postgresqlOnlyPolicy(t *testing.T) RecoveryToolPolicy {
	t.Helper()
	policy, err := ParseRecoveryToolPolicy(map[string]string{"RAIBITSERVER_RECOVERY_TOOL_POSTGRESQL_IMAGE": "registry.example/recovery/postgresql@sha256:" + strings.Repeat("1", 64)})
	if err != nil {
		t.Fatal(err)
	}
	return policy
}

func Test_RecoveryDispatcher_missing_handler_fails_before_claim(t *testing.T) {
	state := &fakeRecoveryDispatchStore{}
	if _, err := NewRecoveryDispatcher(state, postgresqlOnlyPolicy(t), writeRunner{payload: "dump"}, nil, "worker-1"); !errors.Is(err, ErrRecoveryHandlerUnavailable) {
		t.Fatalf("err=%v", err)
	}
	if state.claims != 0 {
		t.Fatalf("claims=%d", state.claims)
	}
}

func Test_RecoveryDispatcher_registered_handler_claims_and_dispatches_once(t *testing.T) {
	state := &fakeRecoveryDispatchStore{execution: testRecoveryExecution()}
	handler := &fakeRecoveryHandler{}
	dispatcher, err := NewRecoveryDispatcher(state, postgresqlOnlyPolicy(t), writeRunner{payload: "dump"}, []RecoveryHandler{handler}, "worker-1")
	if err != nil {
		t.Fatal(err)
	}
	processed, err := dispatcher.RunOnce(context.Background())
	if err != nil || !processed || state.claims != 1 || state.reads != 1 || handler.called != 1 {
		t.Fatalf("processed=%v claims=%d reads=%d calls=%d err=%v", processed, state.claims, state.reads, handler.called, err)
	}
}

func Test_RecoveryDispatcher_runs_durable_backup_and_restore_cleanup_when_recovery_queue_is_idle(t *testing.T) {
	for _, kind := range []store.RecoveryKind{store.RecoveryBackup, store.RecoveryRestore} {
		t.Run(string(kind), func(t *testing.T) {
			identity := &store.RecoveryIdentity{Kind: kind, OperationID: "operation-1"}
			state := &fakeRecoveryDispatchStore{noClaim: true, cleanup: identity}
			handler := &fakeRecoveryHandler{}
			dispatcher, err := NewRecoveryDispatcher(state, postgresqlOnlyPolicy(t), writeRunner{payload: "dump"}, []RecoveryHandler{handler}, "worker-1")
			if err != nil {
				t.Fatal(err)
			}
			processed, err := dispatcher.RunOnce(context.Background())
			if err != nil || !processed || len(handler.cleanupKinds) != 1 || handler.cleanupKinds[0] != kind {
				t.Fatalf("processed=%v cleanup kinds=%v err=%v", processed, handler.cleanupKinds, err)
			}
		})
	}
}

func Test_RecoveryDispatcher_cleanup_failure_remains_retryable(t *testing.T) {
	identity := &store.RecoveryIdentity{Kind: store.RecoveryRestore, OperationID: "restore-1"}
	state := &fakeRecoveryDispatchStore{noClaim: true, cleanup: identity}
	handler := &fakeRecoveryHandler{cleanupErr: ErrBackend}
	dispatcher, err := NewRecoveryDispatcher(state, postgresqlOnlyPolicy(t), writeRunner{payload: "dump"}, []RecoveryHandler{handler}, "worker-1")
	if err != nil {
		t.Fatal(err)
	}
	if processed, runErr := dispatcher.RunOnce(context.Background()); !processed || !errors.Is(runErr, ErrBackend) {
		t.Fatalf("first processed=%v err=%v", processed, runErr)
	}
	handler.cleanupErr = nil
	if processed, runErr := dispatcher.RunOnce(context.Background()); !processed || runErr != nil || len(handler.cleanupKinds) != 2 {
		t.Fatalf("retry processed=%v calls=%d err=%v", processed, len(handler.cleanupKinds), runErr)
	}
}

func Test_RecoveryDispatcher_gives_cleanup_bounded_fairness_during_recovery_backlog(t *testing.T) {
	state := &fakeRecoveryDispatchStore{execution: testRecoveryExecution()}
	handler := &fakeRecoveryHandler{}
	dispatcher, err := NewRecoveryDispatcher(state, postgresqlOnlyPolicy(t), writeRunner{payload: "dump"}, []RecoveryHandler{handler}, "worker-1")
	if err != nil {
		t.Fatal(err)
	}
	if processed, runErr := dispatcher.RunOnce(context.Background()); !processed || runErr != nil {
		t.Fatalf("recovery processed=%v err=%v", processed, runErr)
	}
	state.cleanup = &store.RecoveryIdentity{Kind: store.RecoveryBackup, OperationID: "failed-before-intent"}
	if processed, runErr := dispatcher.RunOnce(context.Background()); !processed || runErr != nil || state.claims != 1 || len(handler.cleanupKinds) != 1 {
		t.Fatalf("cleanup processed=%v claims=%d cleanup=%v err=%v", processed, state.claims, handler.cleanupKinds, runErr)
	}
}

type failingRecoveryHandler struct{ err error }

func (failingRecoveryHandler) Engine() Engine                               { return EnginePostgreSQL }
func (h failingRecoveryHandler) Handle(context.Context, RecoveryWork) error { return h.err }

func Test_RecoveryDispatcher_persists_cancel_deadline_retry_without_retrying_lost_lease(t *testing.T) {
	for _, scenario := range []struct {
		name                            string
		execution                       store.RecoveryExecution
		handlerErr                      error
		cancelInput                     bool
		wantRetry, wantFail, wantCancel int
	}{
		{name: "cancel restore", execution: dispatchRestoreExecution(t), handlerErr: context.Canceled, cancelInput: true, wantCancel: 1},
		{name: "deadline", execution: testRecoveryExecution(), handlerErr: context.DeadlineExceeded, wantFail: 1},
		{name: "retry", execution: testRecoveryExecution(), handlerErr: ErrBackend, wantRetry: 1},
		{name: "cleanup pending", execution: testRecoveryExecution(), handlerErr: ErrCleanupPending, wantRetry: 1},
		{name: "lease loss", execution: testRecoveryExecution(), handlerErr: store.ErrRecoveryFence},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			state := &fakeRecoveryDispatchStore{execution: scenario.execution}
			dispatcher, err := NewRecoveryDispatcher(state, postgresqlOnlyPolicy(t), writeRunner{payload: "dump"}, []RecoveryHandler{failingRecoveryHandler{err: scenario.handlerErr}}, "worker-1")
			if err != nil {
				t.Fatal(err)
			}
			runCtx := context.Background()
			if scenario.cancelInput {
				cancelled, cancel := context.WithCancel(runCtx)
				cancel()
				runCtx = cancelled
			}
			processed, runErr := dispatcher.RunOnce(runCtx)
			if !processed || !errors.Is(runErr, scenario.handlerErr) || state.retries != scenario.wantRetry || state.failures != scenario.wantFail || state.cancels != scenario.wantCancel {
				t.Fatalf("processed=%v retries=%d failures=%d cancels=%d err=%v", processed, state.retries, state.failures, state.cancels, runErr)
			}
		})
	}
}

func dispatchRestoreExecution(t *testing.T) store.RecoveryExecution {
	t.Helper()
	attempt, err := NewAttempt(AttemptSpec{OrganizationID: "org-1", ResourceID: "source", BackupID: "backup-1", KeyVersion: "key-1", Number: 1, FirstClaimAt: time.Now().Add(-time.Minute)})
	if err != nil {
		t.Fatal(err)
	}
	return restoreExecution(attempt)
}
