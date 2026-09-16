package controlplane

import (
	"context"
	"errors"
	"time"
)

type PreviewResolver struct {
	store  PreviewResolverStore
	issuer GitHubPullRequestCredentialIssuer
	github *GitHubPullRequestClient
	now    func() time.Time
}

func NewPreviewResolver(store PreviewResolverStore, issuer GitHubPullRequestCredentialIssuer, github *GitHubPullRequestClient, now func() time.Time) (*PreviewResolver, error) {
	if store == nil || issuer == nil || github == nil {
		return nil, errors.New("preview resolver requires store, PR issuer, and GitHub client")
	}
	if now == nil {
		now = time.Now
	}
	return &PreviewResolver{store: store, issuer: issuer, github: github, now: now}, nil
}

func (r *PreviewResolver) ResolveNext(ctx context.Context, workerID string) (bool, error) {
	claim, err := r.store.ClaimNextPreviewResolution(ctx, workerID, r.now().UTC())
	if err != nil || claim == nil {
		return false, err
	}
	operationCtx, cancel := context.WithDeadline(ctx, claim.DeadlineAt)
	defer cancel()
	heartbeatCtx, stopHeartbeat := context.WithCancel(operationCtx)
	heartbeatDone := make(chan error, 1)
	go r.heartbeat(heartbeatCtx, *claim, heartbeatDone)

	credential, issueErr := r.issuer.IssuePullRequestCredential(operationCtx, claim.Target.InstallationID, claim.Target.RepositoryID)
	if issueErr != nil {
		stopHeartbeat()
		<-heartbeatDone
		return true, r.store.FailPreviewResolution(ctx, *claim, PreviewErrorAuth, r.now().UTC())
	}
	observation, observeErr := r.github.Observe(operationCtx, credential.Token, claim.Target, r.now().UTC())
	revokeCtx, revokeCancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	revokeErr := r.issuer.RevokeRepositoryCredential(revokeCtx, credential.Token)
	revokeCancel()
	stopHeartbeat()
	heartbeatErr := <-heartbeatDone
	if heartbeatErr != nil {
		return true, heartbeatErr
	}
	if observeErr != nil {
		return true, r.store.FailPreviewResolution(ctx, *claim, PreviewErrorFetch, r.now().UTC())
	}
	if revokeErr != nil {
		return true, r.store.FailPreviewResolution(ctx, *claim, PreviewErrorAuth, r.now().UTC())
	}
	_, err = r.store.CommitPreviewResolution(ctx, *claim, *observation, r.now().UTC())
	return true, err
}

func (r *PreviewResolver) heartbeat(ctx context.Context, claim PreviewResolutionClaim, done chan<- error) {
	ticker := time.NewTicker(PreviewHeartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			done <- nil
			return
		case <-ticker.C:
			if err := r.store.RenewPreviewResolutionLease(ctx, claim, r.now().UTC()); err != nil {
				done <- err
				return
			}
		}
	}
}
