package recoverycache

import (
	"context"
	"crypto/rand"
	"errors"
	"io"
	"os"
	"time"
)

type helper struct {
	config       config
	processes    processExecutor
	dialer       cacheDialer
	codec        artifactCodec
	waiter       waiter
	random       io.Reader
	now          func() time.Time
	readPassword func() ([]byte, error)
	receipts     receiptController
}

type dependencies struct {
	processes processExecutor
	dialer    cacheDialer
	codec     artifactCodec
	waiter    waiter
	random    io.Reader
	now       func() time.Time
}

func newHelper(config config, dependencies dependencies) *helper {
	now := dependencies.now
	if now == nil {
		now = time.Now
	}
	return &helper{
		config:       config,
		processes:    dependencies.processes,
		dialer:       dependencies.dialer,
		codec:        dependencies.codec,
		waiter:       dependencies.waiter,
		random:       dependencies.random,
		now:          now,
		readPassword: config.readCredential,
	}
}

func Run(ctx context.Context, action Action, stdin io.Reader, stdout io.Writer) error {
	config, err := loadConfig(os.Getenv)
	if err != nil {
		return err
	}
	helper := newHelper(config, dependencies{
		processes: osProcessExecutor{},
		dialer:    netCacheDialer{},
		codec:     newRecoveryWireCodec(config.index),
		waiter:    timerWaiter{},
		random:    rand.Reader,
	})
	helper.receipts = osReceiptController{index: config.index}
	return helper.runReceiptAction(ctx, action, stdin, stdout)
}

func (h *helper) run(ctx context.Context, token string, stdin io.Reader, stdout io.Writer) error {
	action, err := parseAction([]string{token})
	if err != nil {
		return err
	}
	return h.runAction(ctx, action, stdin, stdout)
}

func (h *helper) runAction(ctx context.Context, action Action, stdin io.Reader, stdout io.Writer) error {
	if ctx == nil || stdin == nil || stdout == nil || action.value == "" || h.processes == nil || h.dialer == nil || h.codec == nil || h.waiter == nil || h.random == nil {
		return ErrConfig
	}
	if err := h.config.validate(); err != nil {
		return err
	}
	operationContext, cancel := context.WithTimeout(ctx, h.config.operationTimeout)
	defer cancel()
	if err := h.processes.probe(operationContext, action.engine); err != nil {
		if errors.Is(err, ErrCapability) {
			return ErrCapability
		}
		return safeStep("capability probe", ErrCapability)
	}
	switch action.operation {
	case operationBackup:
		return h.backup(operationContext, action.engine, stdout)
	case operationRestore:
		return h.restore(operationContext, action.engine, stdin)
	case operationVerify:
		return h.verify(operationContext, action.engine)
	default:
		return ErrAction
	}
}

type waiter interface {
	wait(context.Context, time.Duration) error
}

type timerWaiter struct{}

func (timerWaiter) wait(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
