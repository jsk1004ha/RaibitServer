package backup

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/raibitserver/provisioner/internal/store"
)

var ErrRecoveryHandlerUnavailable = errors.New("backup: recovery handler unavailable")

type RecoveryWork struct {
	Claim     store.RecoveryClaim
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
	CancelRestore(context.Context, store.RecoveryClaim) error
	RetryRecovery(context.Context, store.RecoveryClaim) error
	FailRecovery(context.Context, store.RecoveryClaim) error
}

type RecoveryDispatcher struct {
	store    recoveryDispatchStore
	policy   RecoveryToolPolicy
	runner   JobRunner
	handlers map[Engine]RecoveryHandler
	worker   string
	services []*Service
}

func NewRecoveryDispatcher(state recoveryDispatchStore, policy RecoveryToolPolicy, runner JobRunner, handlers []RecoveryHandler, worker string) (*RecoveryDispatcher, error) {
	registered, err := registerRecoveryHandlers(policy, handlers)
	if err != nil {
		return nil, err
	}
	if state == nil || runner == nil || !recoveryPart.MatchString(worker) {
		return nil, ErrConfig
	}
	services := make([]*Service, 0, 1)
	seenServices := make(map[*Service]bool)
	for _, handler := range registered {
		provider, ok := handler.(interface{ recoveryService() *Service })
		if !ok || provider.recoveryService() == nil || seenServices[provider.recoveryService()] {
			continue
		}
		seenServices[provider.recoveryService()] = true
		services = append(services, provider.recoveryService())
	}
	return &RecoveryDispatcher{store: state, policy: policy, runner: runner, handlers: registered, worker: worker, services: services}, nil
}

func (d *RecoveryDispatcher) Close() {
	for _, service := range d.services {
		service.Close()
	}
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
		return true, errors.Join(err, d.durableTransition(ctx, func(transitionCtx context.Context) error {
			return d.store.RetryRecovery(transitionCtx, *claim)
		}))
	}
	source, err := BindRecoverySource(execution, d.policy)
	if err != nil {
		return true, errors.Join(err, d.durableTransition(ctx, func(transitionCtx context.Context) error {
			return d.store.FailRecovery(transitionCtx, *claim)
		}))
	}
	var target *Connection
	if execution.Identity.Kind == store.RecoveryRestore {
		bound, bindErr := BindRecoveryTarget(execution, d.policy)
		if bindErr != nil {
			return true, errors.Join(bindErr, d.durableTransition(ctx, func(transitionCtx context.Context) error {
				return d.store.FailRecovery(transitionCtx, *claim)
			}))
		}
		target = &bound
	}
	handler := d.handlers[source.Engine()]
	if handler == nil {
		return true, errors.Join(ErrRecoveryHandlerUnavailable, d.durableTransition(ctx, func(transitionCtx context.Context) error {
			return d.store.RetryRecovery(transitionCtx, *claim)
		}))
	}
	err = handler.Handle(ctx, RecoveryWork{Claim: *claim, Execution: execution, Source: source, Target: target, Runner: d.runner})
	if err != nil {
		if errors.Is(err, store.ErrRecoveryFence) || errors.Is(err, ErrFence) {
			return true, err
		}
		transitionErr := d.durableTransition(ctx, func(transitionCtx context.Context) error {
			switch {
			case execution.Identity.Kind == store.RecoveryRestore && errors.Is(err, context.Canceled):
				return d.store.CancelRestore(transitionCtx, *claim)
			case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
				return d.store.FailRecovery(transitionCtx, *claim)
			default:
				return d.store.RetryRecovery(transitionCtx, *claim)
			}
		})
		return true, errors.Join(err, transitionErr)
	}
	return true, nil
}

func (*RecoveryDispatcher) durableTransition(ctx context.Context, transition func(context.Context) error) error {
	transitionCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	return transition(transitionCtx)
}
