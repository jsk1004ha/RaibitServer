package backup

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/raibitserver/provisioner/internal/store"
)

var ErrRecoveryHandlerUnavailable = errors.New("backup: recovery handler unavailable")

type RecoveryWork struct {
	Execution store.RecoveryExecution
	Source    Connection
	Target    *Connection
	Runner    JobRunner
}

type RecoveryHandler interface {
	Engine() Engine
	Handle(context.Context, RecoveryWork) error
}

type recoveryDispatchStore interface {
	ClaimNextRecovery(context.Context, string) (*store.RecoveryClaim, error)
	ReadRecoveryExecution(context.Context, store.RecoveryClaim) (store.RecoveryExecution, error)
	RetryRecovery(context.Context, store.RecoveryClaim) error
	FailRecovery(context.Context, store.RecoveryClaim) error
}

type RecoveryDispatcher struct {
	store    recoveryDispatchStore
	policy   RecoveryToolPolicy
	runner   JobRunner
	handlers map[Engine]RecoveryHandler
	worker   string
}

func NewRecoveryDispatcher(state recoveryDispatchStore, policy RecoveryToolPolicy, runner JobRunner, handlers []RecoveryHandler, worker string) (*RecoveryDispatcher, error) {
	registered, err := registerRecoveryHandlers(policy, handlers)
	if err != nil {
		return nil, err
	}
	if state == nil || runner == nil || !recoveryPart.MatchString(worker) {
		return nil, ErrConfig
	}
	return &RecoveryDispatcher{store: state, policy: policy, runner: runner, handlers: registered, worker: worker}, nil
}

func registerRecoveryHandlers(policy RecoveryToolPolicy, handlers []RecoveryHandler) (map[Engine]RecoveryHandler, error) {
	if len(policy.images) == 0 {
		return nil, ErrConfig
	}
	registered := make(map[Engine]RecoveryHandler, len(handlers))
	for _, handler := range handlers {
		if handler == nil || policy.images[handler.Engine()] == "" || registered[handler.Engine()] != nil {
			return nil, ErrConfig
		}
		registered[handler.Engine()] = handler
	}
	var missing []string
	for engine := range policy.images {
		if registered[engine] == nil {
			missing = append(missing, string(engine))
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return nil, fmt.Errorf("%w: %v", ErrRecoveryHandlerUnavailable, missing)
	}
	return registered, nil
}

func (d *RecoveryDispatcher) RunOnce(ctx context.Context) (bool, error) {
	claim, err := d.store.ClaimNextRecovery(ctx, d.worker)
	if err != nil || claim == nil {
		return false, err
	}
	execution, err := d.store.ReadRecoveryExecution(ctx, *claim)
	if err != nil {
		return true, errors.Join(err, d.store.RetryRecovery(ctx, *claim))
	}
	source, err := BindRecoverySource(execution, d.policy)
	if err != nil {
		return true, errors.Join(err, d.store.FailRecovery(ctx, *claim))
	}
	var target *Connection
	if execution.Identity.Kind == store.RecoveryRestore {
		bound, bindErr := BindRecoveryTarget(execution, d.policy)
		if bindErr != nil {
			return true, errors.Join(bindErr, d.store.FailRecovery(ctx, *claim))
		}
		target = &bound
	}
	handler := d.handlers[source.Engine()]
	if handler == nil {
		return true, errors.Join(ErrRecoveryHandlerUnavailable, d.store.RetryRecovery(ctx, *claim))
	}
	err = handler.Handle(ctx, RecoveryWork{Execution: execution, Source: source, Target: target, Runner: d.runner})
	if err != nil {
		return true, errors.Join(err, d.store.RetryRecovery(ctx, *claim))
	}
	return true, nil
}
