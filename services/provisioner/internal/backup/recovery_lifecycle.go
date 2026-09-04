package backup

import (
	"context"
	"errors"
	"time"

	"github.com/raibitserver/provisioner/internal/store"
)

type RecoveryArtifactRehydrator interface {
	Rehydrate(Connection, VerifiedArtifact) (RecoveryArtifact, error)
}

type recoveryRehydratorFunc func(Connection, VerifiedArtifact) (RecoveryArtifact, error)

func (f recoveryRehydratorFunc) Rehydrate(connection Connection, verified VerifiedArtifact) (RecoveryArtifact, error) {
	return f(connection, verified)
}

type RecoveryAdapterBinding struct {
	adapter    RecoveryAdapter
	rehydrator RecoveryArtifactRehydrator
}

func NewRecoveryAdapterBinding(adapter RecoveryAdapter, rehydrator RecoveryArtifactRehydrator) (RecoveryAdapterBinding, error) {
	if adapter == nil || rehydrator == nil {
		return RecoveryAdapterBinding{}, ErrConfig
	}
	return RecoveryAdapterBinding{adapter: adapter, rehydrator: rehydrator}, nil
}

func NewSQLRecoveryAdapterBinding(adapter RecoveryAdapter) (RecoveryAdapterBinding, error) {
	var formatName string
	switch adapter.Engine() {
	case EnginePostgreSQL:
		formatName = postgresqlCustomFormat
	case EngineMySQL:
		formatName = mysqlLogicalFormat
	case EngineMariaDB:
		formatName = mariaDBLogicalFormat
	default:
		return RecoveryAdapterBinding{}, ErrConfig
	}
	rehydrator := recoveryRehydratorFunc(func(source Connection, verified VerifiedArtifact) (RecoveryArtifact, error) {
		format, metadata, err := sqlMetadata(source, formatName)
		if err != nil {
			return RecoveryArtifact{}, err
		}
		return newStoredRecoveryArtifact(source, format, metadata, verified)
	})
	return NewRecoveryAdapterBinding(adapter, rehydrator)
}

func newStoredRecoveryArtifact(source Connection, format EngineFormat, baseline VerificationMetadata, verified VerifiedArtifact) (RecoveryArtifact, error) {
	record := verified.Record()
	if source.spec.ResourceID == "" || source.Engine() != format.spec.Engine || baseline.spec.Schema == "" || record.Attempt.OrganizationID != source.spec.OrganizationID || record.Attempt.ResourceID != source.ResourceID() || record.StoredBytes < 1 || record.PlaintextBytes < 1 || record.SHA256 == [32]byte{} {
		return RecoveryArtifact{}, ErrRecoveryRequest
	}
	if _, err := NewAttempt(record.Attempt); err != nil {
		return RecoveryArtifact{}, ErrRecoveryRequest
	}
	dump := DumpResult{request: DumpRequest{source: source}, format: format, baseline: baseline}
	return RecoveryArtifact{dump: dump, record: record}, nil
}

type leaseTicker interface {
	C() <-chan time.Time
	Stop()
}

type leaseSchedule interface {
	NewTicker(time.Duration) leaseTicker
}

type wallLeaseSchedule struct{}
type wallLeaseTicker struct{ ticker *time.Ticker }

func (wallLeaseSchedule) NewTicker(interval time.Duration) leaseTicker {
	return wallLeaseTicker{ticker: time.NewTicker(interval)}
}
func (t wallLeaseTicker) C() <-chan time.Time { return t.ticker.C }
func (t wallLeaseTicker) Stop()               { t.ticker.Stop() }

type RecoveryHandlerFactory struct {
	state     store.RecoveryStore
	artifacts *Service
	schedule  leaseSchedule
}

func NewRecoveryHandlerFactory(state store.RecoveryStore, artifacts *Service) (*RecoveryHandlerFactory, error) {
	return newRecoveryHandlerFactory(state, artifacts, wallLeaseSchedule{})
}

func newRecoveryHandlerFactory(state store.RecoveryStore, artifacts *Service, schedule leaseSchedule) (*RecoveryHandlerFactory, error) {
	if state == nil || artifacts == nil || schedule == nil {
		return nil, ErrConfig
	}
	return &RecoveryHandlerFactory{state: state, artifacts: artifacts, schedule: schedule}, nil
}

func (f *RecoveryHandlerFactory) Handler(binding RecoveryAdapterBinding) (RecoveryHandler, error) {
	if f == nil || binding.adapter == nil || binding.rehydrator == nil {
		return nil, ErrConfig
	}
	return &RecoveryLifecycle{state: f.state, artifacts: f.artifacts, binding: binding, schedule: f.schedule}, nil
}

type RecoveryLifecycle struct {
	state     store.RecoveryStore
	artifacts *Service
	binding   RecoveryAdapterBinding
	schedule  leaseSchedule
}

func (l *RecoveryLifecycle) Engine() Engine            { return l.binding.adapter.Engine() }
func (l *RecoveryLifecycle) recoveryService() *Service { return l.artifacts }

func (l *RecoveryLifecycle) Handle(ctx context.Context, work RecoveryWork) error {
	if ctx == nil || work.Runner == nil || work.Execution.Identity.DeadlineAt.IsZero() || work.Source.Engine() != l.Engine() {
		return ErrRecoveryRequest
	}
	bounded, cancel := context.WithDeadline(ctx, work.Execution.Identity.DeadlineAt)
	defer cancel()
	return l.withLease(bounded, work.Claim, func(runCtx context.Context) error {
		if err := l.state.FenceRecovery(runCtx, work.Claim); err != nil {
			return err
		}
		switch work.Execution.Identity.Kind {
		case store.RecoveryBackup:
			return l.backup(runCtx, work)
		case store.RecoveryRestore:
			return l.restore(runCtx, work)
		default:
			return ErrRecoveryRequest
		}
	})
}

func (l *RecoveryLifecycle) withLease(ctx context.Context, claim store.RecoveryClaim, work func(context.Context) error) error {
	if err := l.state.RenewRecovery(ctx, claim); err != nil {
		return err
	}
	runCtx, cancel := context.WithCancelCause(ctx)
	ticker := l.schedule.NewTicker(store.RecoveryRenewal)
	done := make(chan error, 1)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-runCtx.Done():
				done <- nil
				return
			case <-ticker.C():
				if err := l.state.RenewRecovery(runCtx, claim); err != nil {
					cancel(err)
					done <- err
					return
				}
			}
		}
	}()
	workErr := work(runCtx)
	cancel(workErr)
	return errors.Join(workErr, <-done)
}
