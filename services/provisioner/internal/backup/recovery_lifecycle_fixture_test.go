package backup

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/raibitserver/provisioner/internal/store"
)

type lifecycleStore struct {
	mu          sync.Mutex
	events      []string
	wire        *testJournal
	attempts    []store.RecoveryAttempt
	renewErr    error
	cleanupErr  error
	finishCount int
}

func (s *lifecycleStore) event(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, name)
}

func (s *lifecycleStore) snapshot() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.events...)
}

func (s *lifecycleStore) ClaimNextRecovery(context.Context, string) (*store.RecoveryClaim, error) {
	s.event("claim")
	return &store.RecoveryClaim{}, nil
}
func (s *lifecycleStore) RenewRecovery(context.Context, store.RecoveryClaim) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, "renew")
	return s.renewErr
}

func (s *lifecycleStore) setRenewError(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.renewErr = err
}
func (s *lifecycleStore) FenceRecovery(context.Context, store.RecoveryClaim) error {
	s.event("fence")
	return nil
}
func (s *lifecycleStore) ReadRecoveryExecution(context.Context, store.RecoveryClaim) (store.RecoveryExecution, error) {
	return store.RecoveryExecution{}, errors.New("unused")
}
func (s *lifecycleStore) RecordRecoveryIntent(_ context.Context, _ store.RecoveryClaim, key string) (store.RecoveryAttempt, error) {
	s.event("intent")
	s.wire.mu.Lock()
	s.wire.intent = true
	s.wire.mu.Unlock()
	attempt := s.attempts[0]
	attempt.Artifact.KeyVersion = key
	return attempt, nil
}
func (s *lifecycleStore) RecordRecoveryUpload(_ context.Context, _ store.RecoveryClaim, uploadID string) error {
	s.event("upload")
	s.wire.mu.Lock()
	s.wire.upload = uploadID != ""
	s.wire.mu.Unlock()
	return nil
}
func (s *lifecycleStore) RecordRecoveryCandidate(_ context.Context, _ store.RecoveryClaim, artifact store.RecoveryArtifact) error {
	s.event("candidate")
	s.attempts[0].Artifact = artifact
	s.attempts[0].State = "PREPARED"
	s.wire.mu.Lock()
	s.wire.candidate = Candidate{record: artifactRecord(artifact)}
	s.wire.mu.Unlock()
	return nil
}
func (s *lifecycleStore) RecordRecoveryComplete(_ context.Context, _ store.RecoveryClaim) error {
	s.event("complete")
	s.attempts[0].State = "COMPLETE"
	s.wire.mu.Lock()
	s.wire.complete = RemoteCompletion{record: artifactRecord(s.attempts[0].Artifact)}
	s.wire.mu.Unlock()
	return nil
}
func (s *lifecycleStore) RecordRecoveryVerified(context.Context, store.RecoveryClaim) error {
	s.event("verified")
	s.attempts[0].State = "VERIFIED"
	return nil
}
func (s *lifecycleStore) StartRestoreVerification(context.Context, store.RecoveryClaim) error {
	s.event("start-verification")
	return nil
}
func (s *lifecycleStore) FinishRecovery(context.Context, store.RecoveryClaim) error {
	s.event("finish")
	s.finishCount++
	return nil
}
func (s *lifecycleStore) FailRecovery(context.Context, store.RecoveryClaim) error {
	s.event("fail")
	return nil
}
func (s *lifecycleStore) CancelRestore(context.Context, store.RecoveryClaim) error {
	s.event("cancel")
	return nil
}
func (s *lifecycleStore) RetryRecovery(context.Context, store.RecoveryClaim) error {
	s.event("retry")
	return nil
}
func (s *lifecycleStore) ReadRecoveryAttempts(context.Context, store.RecoveryClaim) ([]store.RecoveryAttempt, error) {
	s.event("read-attempts")
	return append([]store.RecoveryAttempt(nil), s.attempts...), nil
}
func (s *lifecycleStore) ClaimRecoveryCleanup(context.Context, store.RecoveryIdentity, string) (store.RecoveryCleanupClaim, error) {
	s.event("cleanup-claim")
	return store.RecoveryCleanupClaim{}, s.cleanupErr
}
func (s *lifecycleStore) FenceRecoveryCleanup(context.Context, store.RecoveryCleanupClaim) error {
	s.event("cleanup-fence")
	return nil
}
func (s *lifecycleStore) ReadRecoveryCleanup(context.Context, store.RecoveryCleanupClaim) ([]store.RecoveryAttempt, error) {
	s.event("cleanup-read")
	return append([]store.RecoveryAttempt(nil), s.attempts...), nil
}
func (s *lifecycleStore) RecordRecoveryCleanupRemoteCompletion(context.Context, store.RecoveryCleanupClaim, store.RecoveryArtifact) error {
	s.event("cleanup-remote-complete")
	return nil
}
func (s *lifecycleStore) MarkRecoveryAttemptCleaned(_ context.Context, _ store.RecoveryCleanupClaim, attempt int) error {
	s.event("cleanup-mark")
	for index := range s.attempts {
		if s.attempts[index].Artifact.Attempt == attempt {
			s.attempts[index].CleanupPending = false
		}
	}
	return nil
}
func (s *lifecycleStore) FinishRecoveryCleanup(context.Context, store.RecoveryCleanupClaim) error {
	s.event("cleanup-finish")
	return nil
}

func backupExecution(attempt Attempt) store.RecoveryExecution {
	execution := testRecoveryExecution()
	spec := attempt.Spec()
	execution.Identity = store.RecoveryIdentity{Kind: store.RecoveryBackup, OperationID: spec.BackupID, BackupID: spec.BackupID, OrganizationID: spec.OrganizationID, ProjectID: "project-1", SourceID: spec.ResourceID, Attempt: spec.Number, FirstClaimAt: spec.FirstClaimAt, DeadlineAt: attempt.Deadline()}
	execution.Source.ID = spec.ResourceID
	return execution
}

func restoreExecution(attempt Attempt) store.RecoveryExecution {
	execution := backupExecution(attempt)
	execution.Identity = store.RecoveryIdentity{Kind: store.RecoveryRestore, OperationID: "restore-1", BackupID: attempt.Spec().BackupID, OrganizationID: "org-1", ProjectID: "project-1", SourceID: attempt.Spec().ResourceID, TargetID: "target", Attempt: 1, FirstClaimAt: time.Now().Add(-time.Minute), DeadlineAt: time.Now().Add(20 * time.Minute)}
	target := execution.Source
	target.ID = "target"
	target.Name = "target-provider"
	target.SecretName = "target-provider-connection"
	target.SecretUID = "target-secret-uid"
	target.WorkloadUID = "target-workload-uid"
	target.Connection.Host = "target-provider.tenant.svc.cluster.local"
	target.Connection.User = "target_provider_app"
	target.Connection.SecretName = target.SecretName
	target.Connection.CredentialUID = target.SecretUID
	execution.Target = &target
	execution.TargetPrepared = true
	return execution
}

func newLifecycleForTest(t *testing.T, mode string) (*RecoveryHandlerFactory, *lifecycleStore, *wireStore, Attempt) {
	t.Helper()
	service, wire, journal, attempt := fixture(t, mode, Options{})
	state := &lifecycleStore{wire: journal, attempts: []store.RecoveryAttempt{{Artifact: store.RecoveryArtifact{OrganizationID: attempt.Spec().OrganizationID, ResourceID: attempt.Spec().ResourceID, BackupID: attempt.Spec().BackupID, KeyVersion: attempt.Spec().KeyVersion, Attempt: attempt.Spec().Number, FirstClaimAt: attempt.Spec().FirstClaimAt}, State: "INTENT", CleanupPending: true}}}
	factory, err := newRecoveryHandlerFactory(state, service, idleLeaseSchedule{})
	if err != nil {
		t.Fatal(err)
	}
	return factory, state, wire, attempt
}

type idleLeaseSchedule struct{}
type idleLeaseTicker struct{ ticks chan time.Time }

func (idleLeaseSchedule) NewTicker(time.Duration) leaseTicker {
	return idleLeaseTicker{ticks: make(chan time.Time)}
}
func (t idleLeaseTicker) C() <-chan time.Time { return t.ticks }
func (idleLeaseTicker) Stop()                 {}

type manualLeaseSchedule struct{ ticks chan time.Time }

func (s manualLeaseSchedule) NewTicker(time.Duration) leaseTicker {
	return idleLeaseTicker{ticks: s.ticks}
}

type cancelRunner struct {
	started chan struct{}
	once    sync.Once
}

func (r *cancelRunner) Run(ctx context.Context, _ IsolatedJob, _ JobStream) (completedJobObservation, error) {
	r.once.Do(func() { close(r.started) })
	<-ctx.Done()
	return completedJobObservation{}, ctx.Err()
}
