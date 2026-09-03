package controlplane

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"testing/synctest"
	"time"
)

func TestGitHubCredentialFailureMatrixLifecycle(t *testing.T) {
	for _, row := range []string{"revocation-failure", "expired-release", "cancel-release", "pending-publication"} {
		t.Run(row, func(t *testing.T) {
			fixture := newDispatchFixtureStore()
			fixture.service.GitHubInstallationID, fixture.service.GitHubRepositoryID, fixture.service.GitHubRepositoryVisibility = "202", "101", "private"
			issuer := &recordingGitHubCredentialIssuer{credential: &GitHubRepositoryCredential{Token: "ghs_lifecycle_fixture", InstallationID: "202", RepositoryID: "101", UpstreamExpiresAt: time.Now().Add(time.Hour)}}
			handler := NewDispatchHandlerWithGitHubCredentials(fixture, 15*time.Minute, issuer).(*dispatchHandler)
			claim := sendDispatchRPCRequest(t, handler, "", map[string]any{"operation": "claim", "claimOptions": map[string]any{"workerId": "executor"}})
			var claimed dispatchRPCResponse
			if json.Unmarshal(claim.Body.Bytes(), &claimed) != nil || claim.Code != 200 {
				t.Fatal("claim fixture failed")
			}
			if row != "pending-publication" {
				issued := sendDispatchRPCRequest(t, handler, claimed.Token, map[string]any{"operation": "issueGitHubCredential", "githubCredential": map[string]any{"serviceId": "service-1", "installationId": "202", "repositoryId": "101"}})
				if issued.Code != 200 {
					t.Fatal("issuance fixture failed")
				}
			}
			if row == "revocation-failure" {
				issuer.revokeError = errors.New("fixture revoke unavailable")
			}
			if row == "expired-release" {
				handler.mu.Lock()
				for key, session := range handler.sessions {
					session.ExpiresAt = time.Now().Add(-time.Minute)
					handler.sessions[key] = session
				}
				handler.mu.Unlock()
			}
			// When cleanup runs even after session expiry, or publication races pending credentials.
			if row != "pending-publication" {
				release := sendDispatchRPCRequest(t, handler, claimed.Token, map[string]any{"operation": "releaseGitHubCredential", "cloneSucceeded": row == "revocation-failure"})
				if row == "revocation-failure" {
					if release.Code == 200 || issuer.revokeCalls != 2 {
						t.Fatal("failed revocation did not fail closed with bounded retry")
					}
				} else if release.Code != 200 || issuer.revokeCalls != 1 {
					t.Fatal("cleanup after cancel/expiry failed")
				}
				if row != "revocation-failure" {
					again := sendDispatchRPCRequest(t, handler, claimed.Token, map[string]any{"operation": "releaseGitHubCredential"})
					if again.Code != 200 || issuer.revokeCalls != 1 {
						t.Fatal("cleanup was not idempotent")
					}
				}
			}
			publication := sendDispatchRPCRequest(t, handler, claimed.Token, map[string]any{"operation": "publishImageReady"})
			if publication.Code == 200 || fixture.published {
				t.Fatal("publication bypassed credential lifecycle")
			}
			reissue := sendDispatchRPCRequest(t, handler, claimed.Token, map[string]any{"operation": "issueGitHubCredential", "githubCredential": map[string]any{"serviceId": "service-1", "installationId": "202", "repositoryId": "101"}})
			if row != "pending-publication" && reissue.Code == 200 {
				t.Fatal("credential reissued after terminal lifecycle")
			}
			if row == "pending-publication" && reissue.Code == 200 {
				sendDispatchRPCRequest(t, handler, claimed.Token, map[string]any{"operation": "releaseGitHubCredential"})
			}
		})
	}
}

func TestGitHubCredentialFailureMatrixWatchdog(t *testing.T) {
	for _, cause := range []string{"expiry", "lease-loss"} {
		t.Run(cause, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				fixture := newDispatchFixtureStore()
				issuer := &recordingGitHubCredentialIssuer{}
				c := &githubCredentialSession{private: true, state: "active", token: "ghs_watchdog_fixture", deadline: time.Now().Add(time.Minute), stop: make(chan struct{}), binding: githubCredentialBinding{Lease: fixture.job.Lease()}}
				if cause == "lease-loss" {
					c.binding.Lease.Attempt++
				}
				handler := NewDispatchHandlerWithGitHubCredentials(fixture, time.Minute, issuer).(*dispatchHandler)
				go handler.watchGitHubCredential(context.Background(), c)
				// Virtual time advances the actual production watchdog, not wall-clock polling.
				time.Sleep(time.Minute + time.Second)
				synctest.Wait()
				c.mu.Lock()
				defer c.mu.Unlock()
				if c.state != "failed" || c.token != "" || !c.revoked || issuer.revokeCalls != 1 {
					t.Fatal("watchdog failed to revoke and dispose")
				}
			})
		})
	}
}

func TestGitHubCredentialFailureMatrixUseDeadline(t *testing.T) {
	now := time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC)
	for _, seconds := range []int{59, 60, 300, 900, 901} {
		deadline, err := githubUseDeadline(now, time.Duration(seconds)*time.Second)
		allowed := seconds >= 60 && seconds <= 900
		if (err == nil) != allowed || (allowed && !deadline.Equal(now.Add(time.Duration(seconds)*time.Second))) {
			t.Fatalf("deadline policy seconds=%d", seconds)
		}
	}
}
