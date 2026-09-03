package controlplane

import (
	"context"
	"crypto/sha256"
	"errors"
	"sync"
	"time"
)

var errGitHubCredentialLifecycle = errors.New("GitHub clone credential lifecycle is not released")

type githubCredentialSession struct {
	mu       sync.Mutex
	binding  githubCredentialBinding
	private  bool
	state    string
	token    string
	stop     chan struct{}
	deadline time.Time
	revoked  bool
}

func githubUseDeadline(now time.Time, ttl time.Duration) (time.Time, error) {
	if ttl < time.Minute || ttl > 15*time.Minute {
		return time.Time{}, errGitHubCredentialLifecycle
	}
	return now.Add(ttl), nil
}

func (h *dispatchHandler) issueGitHubCredential(ctx context.Context, session dispatchSession, request *GitHubRepositoryCredentialRequest) (*GitHubRepositoryCredential, error) {
	c := session.GitHub
	if c == nil || !c.private || request == nil || request.ServiceID != session.ServiceID || request.RepositoryID != c.binding.RepositoryID || request.InstallationID != c.binding.InstallationID {
		return nil, errGitHubCredentialScope
	}
	authorizer, ok := h.store.(githubCredentialAuthorizer)
	if !ok || h.githubCredentials == nil {
		return nil, errGitHubCredentialScope
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state != "" {
		return nil, errGitHubCredentialLifecycle
	}
	c.state = "pending"
	if err := authorizer.authorizeGitHubCredential(ctx, c.binding, true); err != nil {
		c.state = "failed"
		return nil, err
	}
	credential, err := h.githubCredentials.IssueRepositoryCredential(ctx, c.binding.InstallationID, c.binding.RepositoryID)
	if err != nil {
		c.state = "failed"
		return nil, err
	}
	deadline, err := githubUseDeadline(time.Now().UTC(), 5*time.Minute)
	if err == nil && (credential == nil || !credential.UpstreamExpiresAt.After(deadline)) {
		err = errGitHubCredentialLifecycle
	}
	if err == nil {
		err = authorizer.authorizeGitHubCredential(ctx, c.binding, false)
	}
	if err == nil && (credential.InstallationID != c.binding.InstallationID || credential.RepositoryID != c.binding.RepositoryID || credential.Token == "") {
		err = errGitHubCredentialScope
	}
	if err != nil {
		c.state = "failed"
		if credential != nil {
			err = errors.Join(err, revokeGitHubToken(ctx, h.githubCredentials, credential.Token))
		}
		return nil, err
	}
	credential.UseDeadline = deadline
	c.token, c.deadline, c.state, c.stop = credential.Token, deadline, "active", make(chan struct{})
	// The independent watchdog owns timeout/lease-loss cleanup even after the HTTP request ends.
	go h.watchGitHubCredential(context.WithoutCancel(ctx), c)
	return credential, nil
}

func (h *dispatchHandler) watchGitHubCredential(ctx context.Context, c *githubCredentialSession) {
	c.mu.Lock()
	stop, deadline := c.stop, c.deadline
	c.mu.Unlock()
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-timer.C:
			h.releaseGitHubCredential(ctx, c, false)
			return
		case <-ticker.C:
			authorizer, ok := h.store.(githubCredentialAuthorizer)
			checkCtx, cancel := context.WithTimeout(ctx, time.Second)
			var err error
			if ok {
				err = authorizer.authorizeGitHubCredential(checkCtx, c.binding, false)
			}
			cancel()
			if !ok || err != nil {
				h.releaseGitHubCredential(ctx, c, false)
				return
			}
		}
	}
}

func revokeGitHubToken(ctx context.Context, issuer GitHubCredentialIssuer, token string) error {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	for attempt := 0; attempt < 2; attempt++ {
		if err := issuer.RevokeRepositoryCredential(cleanupCtx, token); err == nil {
			return nil
		}
		if cleanupCtx.Err() != nil {
			break
		}
	}
	return errors.New("GitHub credential revocation failed; build is blocked")
}

func (h *dispatchHandler) releaseGitHubCredential(ctx context.Context, c *githubCredentialSession, succeeded bool) error {
	if c == nil || !c.private {
		return errGitHubCredentialScope
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state == "released" {
		return nil
	}
	if c.revoked && !succeeded {
		return nil
	}
	if c.state != "active" {
		return errGitHubCredentialLifecycle
	}
	close(c.stop)
	c.state = "failed"
	err := revokeGitHubToken(ctx, h.githubCredentials, c.token)
	c.token = ""
	if err != nil {
		return err
	}
	c.revoked = true
	if !succeeded {
		return nil
	}
	if !time.Now().Before(c.deadline) {
		return errGitHubCredentialLifecycle
	}
	authorizer, ok := h.store.(githubCredentialAuthorizer)
	if !ok {
		return errGitHubCredentialScope
	}
	if err := authorizer.authorizeGitHubCredential(ctx, c.binding, false); err != nil {
		return err
	}
	c.state = "released"
	return nil
}

func (c *githubCredentialSession) publicationAllowed() bool {
	if c == nil || !c.private {
		return true
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.state == "released"
}

func (s *RemoteStore) ReleaseGitHubRepositoryCredential(ctx context.Context, succeeded bool) error {
	return s.rpc(ctx, dispatchRPCRequest{Operation: "releaseGitHubCredential", CloneSucceeded: succeeded}, true, nil)
}

func (s *RemoteStore) CheckGitHubRepositoryCredential(ctx context.Context) error {
	return s.rpc(ctx, dispatchRPCRequest{Operation: "checkGitHubCredential"}, true, nil)
}

func (h *dispatchHandler) checkGitHubCredential(ctx context.Context, c *githubCredentialSession) error {
	if c == nil || !c.private {
		return errGitHubCredentialScope
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state != "active" || !time.Now().Before(c.deadline) {
		return errGitHubCredentialLifecycle
	}
	authorizer, ok := h.store.(githubCredentialAuthorizer)
	if !ok {
		return errGitHubCredentialScope
	}
	return authorizer.authorizeGitHubCredential(ctx, c.binding, false)
}

func (h *dispatchHandler) abortGitHubCredential(ctx context.Context, c *githubCredentialSession) error {
	if c == nil || !c.private {
		return nil
	}
	c.mu.Lock()
	active := c.state == "active"
	c.mu.Unlock()
	if active {
		return h.releaseGitHubCredential(ctx, c, false)
	}
	return nil
}

func (h *dispatchHandler) releaseSession(token string) (dispatchSession, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	session, ok := h.sessions[sha256.Sum256([]byte(token))]
	return session, ok
}
