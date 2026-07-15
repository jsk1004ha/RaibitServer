package reconciler

import (
	"context"
	"time"

	"github.com/raibitserver/provisioner/internal/command"
	"github.com/raibitserver/provisioner/internal/store"
)

type claimRenewingRunner struct {
	delegate command.Runner
	store    store.Store
	resource *store.Resource
}

func (r *Reconciler) runnerFor(resource *store.Resource) command.Runner {
	if r.config.DryRun {
		return r.runner
	}
	return &claimRenewingRunner{delegate: r.runner, store: r.store, resource: resource}
}

func (r *claimRenewingRunner) renew(ctx context.Context) error {
	return r.store.RenewResourceClaim(ctx, r.resource)
}

func (r *claimRenewingRunner) Run(ctx context.Context, name string, args []string, dryRun bool, timeout time.Duration) (string, error) {
	if err := r.renew(ctx); err != nil {
		return "", err
	}
	return r.delegate.Run(ctx, name, args, dryRun, timeout)
}

func (r *claimRenewingRunner) RunInput(ctx context.Context, name string, args []string, input []byte, dryRun bool, timeout time.Duration) (string, error) {
	if err := r.renew(ctx); err != nil {
		return "", err
	}
	return r.delegate.RunInput(ctx, name, args, input, dryRun, timeout)
}

func (r *claimRenewingRunner) RunCreateInput(ctx context.Context, name string, args []string, input []byte, timeout time.Duration) (string, error) {
	if err := r.renew(ctx); err != nil {
		return "", err
	}
	return r.delegate.RunCreateInput(ctx, name, args, input, timeout)
}

func (r *claimRenewingRunner) RunCreateInputUID(ctx context.Context, name string, args []string, input []byte, timeout time.Duration) (string, string, error) {
	if err := r.renew(ctx); err != nil {
		return "", "", err
	}
	return r.delegate.RunCreateInputUID(ctx, name, args, input, timeout)
}

func (r *claimRenewingRunner) RunSensitiveOutput(ctx context.Context, name string, args []string, timeout time.Duration) (string, []byte, error) {
	if err := r.renew(ctx); err != nil {
		return "", nil, err
	}
	return r.delegate.RunSensitiveOutput(ctx, name, args, timeout)
}

func (r *claimRenewingRunner) GetSecretMetadata(ctx context.Context, namespace, secretName string, timeout time.Duration) (string, *command.SecretMetadata, error) {
	if err := r.renew(ctx); err != nil {
		return "", nil, err
	}
	return r.delegate.GetSecretMetadata(ctx, namespace, secretName, timeout)
}

func (r *claimRenewingRunner) VerifySecretUID(ctx context.Context, namespace, secretName, uid string, timeout time.Duration) (string, error) {
	if err := r.renew(ctx); err != nil {
		return "", err
	}
	return r.delegate.VerifySecretUID(ctx, namespace, secretName, uid, timeout)
}

func (r *claimRenewingRunner) DeleteSecretUID(ctx context.Context, namespace, secretName, uid string, timeout time.Duration) (string, error) {
	if err := r.renew(ctx); err != nil {
		return "", err
	}
	return r.delegate.DeleteSecretUID(ctx, namespace, secretName, uid, timeout)
}

func (r *claimRenewingRunner) DeleteObjectUID(ctx context.Context, resource, namespace, name, uid string, timeout time.Duration) (string, error) {
	if err := r.renew(ctx); err != nil {
		return "", err
	}
	return r.delegate.DeleteObjectUID(ctx, resource, namespace, name, uid, timeout)
}
