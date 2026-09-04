package backup

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/raibitserver/provisioner/internal/store"
)

type fakeRecoveryDispatchStore struct {
	claims    int
	reads     int
	execution store.RecoveryExecution
}

func (s *fakeRecoveryDispatchStore) ClaimNextRecovery(context.Context, string) (*store.RecoveryClaim, error) {
	s.claims++
	return &store.RecoveryClaim{}, nil
}
func (s *fakeRecoveryDispatchStore) ReadRecoveryExecution(context.Context, store.RecoveryClaim) (store.RecoveryExecution, error) {
	s.reads++
	return s.execution, nil
}
func (*fakeRecoveryDispatchStore) RetryRecovery(context.Context, store.RecoveryClaim) error {
	return nil
}
func (*fakeRecoveryDispatchStore) FailRecovery(context.Context, store.RecoveryClaim) error {
	return nil
}

type fakeRecoveryHandler struct{ called int }

func (*fakeRecoveryHandler) Engine() Engine { return EnginePostgreSQL }
func (h *fakeRecoveryHandler) Handle(_ context.Context, work RecoveryWork) error {
	h.called++
	if work.Source.ResourceID() != "source" || work.Target != nil || work.Runner == nil {
		return ErrRecoveryRequest
	}
	return nil
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
