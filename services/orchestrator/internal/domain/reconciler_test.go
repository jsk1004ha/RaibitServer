package domain

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"
	"time"

	"github.com/raibitserver/orchestrator/internal/kube"
	"github.com/raibitserver/orchestrator/internal/store"
)

type memoryDomainStore struct {
	domain      *store.Domain
	stealCommit bool
}

func (s *memoryDomainStore) ClaimNextDomain(ctx context.Context, _ store.ClaimOptions) (*store.Domain, error) {
	if err := ctx.Err(); err != nil { return nil, err }
	if s.domain == nil { return nil, nil }
	s.domain.ControllerLeaseGeneration++
	copy := *s.domain
	return &copy, nil
}

func (s *memoryDomainStore) CommitDomain(_ context.Context, lease store.DomainLease, next store.Domain) error {
	if s.stealCommit { s.domain.ControllerLeaseGeneration++; s.stealCommit = false }
	if s.domain == nil || s.domain.Lease() != lease { return store.ErrDomainLeaseLost }
	s.domain = &next
	return nil
}

func (s *memoryDomainStore) FinalizeDomain(_ context.Context, lease store.DomainLease) error {
	if s.domain == nil || s.domain.Lease() != lease || !s.domain.CleanupComplete() { return store.ErrDomainLeaseLost }
	s.domain = nil
	return nil
}

type fakeDomainKube struct {
	applied        int
	deleted        int
	ready          bool
	deleteErr      error
	generatedRoute string
}

type reconcilerFixture struct {
	now      time.Time
	state    store.DomainStore
	resolver TXTResolver
	cluster  kube.DomainKubernetes
}

func (k *fakeDomainKube) Apply(_ context.Context, _ kube.DomainPlan) error { k.applied++; return nil }
func (k *fakeDomainKube) Observe(_ context.Context, _ kube.DomainPlan) (kube.DomainObservation, error) {
	return kube.DomainObservation{CertificateReady: k.ready, IngressReady: k.ready}, nil
}
func (k *fakeDomainKube) Delete(_ context.Context, _ kube.DomainPlan) (kube.DomainAbsence, error) {
	k.deleted++
	if k.deleteErr != nil { return kube.DomainAbsence{}, k.deleteErr }
	return kube.DomainAbsence{CertificateAbsent: true, IngressAbsent: true}, nil
}

func TestDomainReconcilerHappy(t *testing.T) {
	// Given
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	resolver := &fixedResolver{answer: TXTAnswer{Records: []string{"raibit-verification=initial"}, Authoritative: true}}
	state := &memoryDomainStore{domain: domainFixture("initial", now)}
	cluster := &fakeDomainKube{ready: true, generatedRoute: "apps--org--project.example.test"}
	reconciler := newTestReconciler(reconcilerFixture{now: now, state: state, resolver: resolver, cluster: cluster})

	// When
	for range 3 { if _, err := reconciler.RunOnce(t.Context()); err != nil { t.Fatal(err) } }

	// Then
	if state.domain.Status != store.DomainReady || cluster.applied != 1 || state.domain.CertificateObservedGeneration != 1 || state.domain.RouteObservedGeneration != 1 {
		t.Fatalf("domain = %#v, applied = %d", state.domain, cluster.applied)
	}
	if cluster.generatedRoute != "apps--org--project.example.test" { t.Fatal("generated route was mutated") }

	// Given a disruptive rotation
	rotated := domainFixture("fresh", now.Add(time.Hour))
	rotated.VerificationVersion, rotated.DesiredGeneration = 2, 2
	rotated.CleanupRequiredForVersion = 1
	state.domain = rotated
	resolver.answer.Records = []string{"raibit-verification=fresh"}

	// When cleanup and fresh activation run
	if _, err := reconciler.RunOnce(t.Context()); err != nil { t.Fatal(err) }
	if _, err := reconciler.RunOnce(t.Context()); err != nil { t.Fatal(err) }

	// Then old objects were absent before the fresh proof activated
	if cluster.deleted != 1 || state.domain.Status != store.DomainVerified || !state.domain.CleanupComplete() {
		t.Fatalf("domain = %#v, deleted = %d", state.domain, cluster.deleted)
	}
}

func TestDomainReconcilerFailureMatrix(t *testing.T) {
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	t.Run("unverified domain creates no objects", func(t *testing.T) {
		// Given
		state := &memoryDomainStore{domain: domainFixture("expected", now)}
		cluster := &fakeDomainKube{}
		reconciler := newTestReconciler(reconcilerFixture{now: now, state: state, resolver: &fixedResolver{answer: TXTAnswer{Records: []string{"raibit-verification=wrong"}, Authoritative: true}}, cluster: cluster})

		// When
		_, err := reconciler.RunOnce(context.Background())

		// Then
		if err != nil || cluster.applied != 0 || state.domain.Status != store.DomainPending { t.Fatalf("domain = %#v, applied = %d, err = %v", state.domain, cluster.applied, err) }
	})
	t.Run("cleanup failure blocks recreation", func(t *testing.T) {
		// Given
		domain := domainFixture("fresh", now)
		domain.CleanupRequiredForVersion = 1
		state := &memoryDomainStore{domain: domain}
		cluster := &fakeDomainKube{deleteErr: errors.New("delete unavailable")}
		reconciler := newTestReconciler(reconcilerFixture{now: now, state: state, resolver: &fixedResolver{}, cluster: cluster})

		// When
		_, err := reconciler.RunOnce(context.Background())

		// Then
		if err == nil || cluster.applied != 0 || state.domain.LastErrorCode != "CLEANUP_FAILED" { t.Fatalf("domain = %#v, err = %v", state.domain, err) }
	})
	t.Run("cleanup does not depend on activation configuration", func(t *testing.T) {
		// Given
		domain := domainFixture("fresh", now)
		domain.CleanupRequiredForVersion = 1
		domain.ServiceType = "private"
		state := &memoryDomainStore{domain: domain}
		cluster := &fakeDomainKube{}
		clock := func() time.Time { return now }
		reconciler := NewReconciler(ReconcilerConfig{}, ReconcilerDependencies{Store: state, Verifier: NewVerifier(&fixedResolver{}, clock), Kube: cluster, Now: clock})

		// When
		_, err := reconciler.RunOnce(context.Background())

		// Then
		if err != nil || cluster.deleted != 1 || !state.domain.CleanupComplete() {
			t.Fatalf("domain = %#v, deleted = %d, err = %v", state.domain, cluster.deleted, err)
		}
	})
	t.Run("stale lease cannot commit", func(t *testing.T) {
		// Given
		state := &memoryDomainStore{domain: domainFixture("expected", now), stealCommit: true}
		reconciler := newTestReconciler(reconcilerFixture{now: now, state: state, resolver: &fixedResolver{answer: TXTAnswer{Records: []string{"raibit-verification=expected"}, Authoritative: true}}, cluster: &fakeDomainKube{}})

		// When
		_, err := reconciler.RunOnce(context.Background())

		// Then
		if !errors.Is(err, store.ErrDomainLeaseLost) { t.Fatalf("err = %v", err) }
	})
	t.Run("missing persisted proof creates no objects", func(t *testing.T) {
		// Given
		domain := domainFixture("expected", now)
		domain.Status = store.DomainVerified
		domain.VerifiedAt = time.Time{}
		state := &memoryDomainStore{domain: domain}
		cluster := &fakeDomainKube{}
		reconciler := newTestReconciler(reconcilerFixture{now: now, state: state, resolver: &fixedResolver{}, cluster: cluster})

		// When
		_, err := reconciler.RunOnce(context.Background())

		// Then
		if err != nil || cluster.applied != 0 || state.domain.LastErrorCode != "DNS_PROOF_MISSING" {
			t.Fatalf("domain = %#v, applied = %d, err = %v", state.domain, cluster.applied, err)
		}
	})
}

func domainFixture(token string, now time.Time) *store.Domain {
	digest := sha256.Sum256([]byte(token))
	return &store.Domain{ID: "domain-1", OrganizationID: "org-1", ProjectID: "project-1", ProjectSlug: "project", ServiceID: "service-1", ServiceName: "web", ServiceType: "web", ServicePort: 8080, Hostname: "app.example.test", Status: store.DomainPending, VerificationTokenHash: hex.EncodeToString(digest[:]), VerificationVersion: 1, IssuedAt: now, ExpiresAt: now.Add(24 * time.Hour), TLSStatus: store.DomainTLSPending, DesiredGeneration: 1, NextCheckAt: now}
}

func newTestReconciler(fixture reconcilerFixture) *Reconciler {
	clock := func() time.Time { return fixture.now }
	return NewReconciler(
		ReconcilerConfig{ClusterIssuer: "issuer", IngressClassName: "nginx"},
		ReconcilerDependencies{Store: fixture.state, Verifier: NewVerifier(fixture.resolver, clock), Kube: fixture.cluster, Now: clock},
	)
}
