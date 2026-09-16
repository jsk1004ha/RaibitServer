package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestDomainStoreFencesVersionGenerationAndCommitExpiry(t *testing.T) {
	// Given
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	path := writePreviewState(t, map[string]any{
		"projects": []any{map[string]any{"id": "project-1", "organizationId": "org-1", "slug": "demo"}},
		"services": []any{map[string]any{"id": "service-1", "projectId": "project-1", "slug": "web", "type": "web", "port": 8080}},
		"domains": []any{map[string]any{"id": "domain-1", "organizationId": "org-1", "projectId": "project-1", "serviceId": "service-1", "domain": "app.example.test", "status": DomainPending, "verificationTokenHash": "00", "verificationVersion": 2, "issuedAt": now.Add(-24 * time.Hour).Format(time.RFC3339Nano), "expiresAt": now.Format(time.RFC3339Nano), "nextCheckAt": now.Format(time.RFC3339Nano), "tlsStatus": DomainTLSPending, "desiredGeneration": 4, "controllerLeaseGeneration": 8}},
	})
	state := NewFileStore(path)
	claimed, err := state.ClaimNextDomain(context.Background(), ClaimOptions{Now: now, Lease: time.Minute})
	if err != nil || claimed == nil { t.Fatalf("claimed = %#v, err = %v", claimed, err) }

	// When a stale lease attempts a commit
	stale := claimed.Lease()
	stale.LeaseGeneration--
	err = state.CommitDomain(context.Background(), stale, *claimed)

	// Then it is fenced
	if !errors.Is(err, ErrDomainLeaseLost) { t.Fatalf("err = %v", err) }

	// When activation commits exactly at expiry
	claimed.Status, claimed.VerifiedAt, claimed.LastCheckedAt = DomainVerified, now, now
	err = state.CommitDomain(context.Background(), claimed.Lease(), *claimed)

	// Then the transactional deadline fence rejects it
	if !errors.Is(err, ErrDomainLeaseLost) { t.Fatalf("err = %v", err) }
}

func TestDomainClaimSchedulingPrioritizesDeletionAndBacksOffCleanup(t *testing.T) {
	// Given
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	deleting := Domain{Status: DomainDeleting, NextCheckAt: now.Add(24 * time.Hour)}
	cleanup := Domain{Status: DomainPending, CleanupRequiredForVersion: 1, NextCheckAt: now.Add(time.Minute)}

	// When / Then
	if !domainClaimable(deleting, now) {
		t.Fatal("explicit deletion was delayed by an old verification schedule")
	}
	if domainClaimable(cleanup, now) {
		t.Fatal("cleanup retry ignored its bounded backoff")
	}
}
