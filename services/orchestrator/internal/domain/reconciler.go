package domain

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/raibitserver/orchestrator/internal/kube"
	"github.com/raibitserver/orchestrator/internal/store"
)

const revalidationInterval = 24 * time.Hour

type ReconcilerConfig struct {
	WorkerID        string
	Lease           time.Duration
	RetryAfter      time.Duration
	ClusterIssuer   string
	IngressClassName string
}

type ReconcileResult struct {
	Processed bool   `json:"processed"`
	DomainID  string `json:"domainId,omitempty"`
	Status    string `json:"status,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

type Reconciler struct {
	config   ReconcilerConfig
	store    store.DomainStore
	verifier *Verifier
	kube     kube.DomainKubernetes
	now      func() time.Time
}

type ReconcilerDependencies struct {
	Store    store.DomainStore
	Verifier *Verifier
	Kube     kube.DomainKubernetes
	Now      func() time.Time
}

func NewReconciler(config ReconcilerConfig, dependencies ReconcilerDependencies) *Reconciler {
	if config.WorkerID == "" { config.WorkerID = "raibitserver-domain-controller" }
	if config.Lease <= 0 { config.Lease = 15 * time.Minute }
	if config.RetryAfter <= 0 { config.RetryAfter = 5 * time.Minute }
	return &Reconciler{config: config, store: dependencies.Store, verifier: dependencies.Verifier, kube: dependencies.Kube, now: dependencies.Now}
}

func (r *Reconciler) RunOnce(ctx context.Context) (ReconcileResult, error) {
	if err := ctx.Err(); err != nil { return ReconcileResult{}, err }
	now := r.now().UTC()
	domain, err := r.store.ClaimNextDomain(ctx, store.ClaimOptions{WorkerID: r.config.WorkerID, Lease: r.config.Lease, Now: now})
	if err != nil { return ReconcileResult{}, fmt.Errorf("claim domain: %w", err) }
	if domain == nil { return ReconcileResult{}, nil }
	result := ReconcileResult{Processed: true, DomainID: domain.ID, Status: string(domain.Status)}

	if domain.Status == store.DomainDeleting && domain.CleanupRequiredForVersion == 0 {
		domain.CleanupRequiredForVersion = domain.VerificationVersion
		domain.CertificateAbsentObservedVersion, domain.RouteAbsentObservedVersion = 0, 0
	}
	if !domain.CleanupComplete() {
		plan, err := r.cleanupPlan(*domain)
		if err != nil {
			domain.LastErrorCode, domain.LastErrorMessage = "INVALID_CLEANUP_BINDING", "Custom domain cleanup binding is invalid."
			domain.NextCheckAt = now.Add(r.config.RetryAfter)
			return result, errors.Join(err, r.store.CommitDomain(ctx, domain.Lease(), *domain))
		}
		return r.cleanup(ctx, *domain, plan, now)
	}
	if domain.Status == store.DomainDeleting {
		if err := r.store.FinalizeDomain(ctx, domain.Lease()); err != nil { return result, fmt.Errorf("finalize domain: %w", err) }
		result.Status, result.Reason = "DELETED", "domain_deleted"
		return result, nil
	}
	if (domain.Status == store.DomainVerified || domain.Status == store.DomainRouting) && domain.VerifiedAt.IsZero() {
		domain.Status, domain.TLSStatus = store.DomainFailed, store.DomainTLSFailed
		domain.LastErrorCode, domain.LastErrorMessage = "DNS_PROOF_MISSING", "Domain ownership proof is missing; rotate the challenge to recover."
		domain.NextCheckAt = time.Time{}
		result.Status, result.Reason = string(domain.Status), "dns_proof_missing"
		return result, r.store.CommitDomain(ctx, domain.Lease(), *domain)
	}
	plan, err := r.plan(*domain)
	if err != nil {
		domain.Status, domain.TLSStatus = store.DomainFailed, store.DomainTLSFailed
		domain.LastErrorCode, domain.LastErrorMessage = "INVALID_BINDING", "Custom domain binding is invalid."
		domain.NextCheckAt = now.Add(r.config.RetryAfter)
		return result, errors.Join(err, r.store.CommitDomain(ctx, domain.Lease(), *domain))
	}

	switch domain.Status {
	case store.DomainPending, store.DomainReady, store.DomainFailed:
		return r.verify(ctx, *domain, now)
	case store.DomainVerified:
		if err := r.kube.Apply(ctx, plan); err != nil {
			domain.Status, domain.TLSStatus, domain.LastErrorCode, domain.LastErrorMessage = store.DomainFailed, store.DomainTLSFailed, "KUBERNETES_APPLY_FAILED", "Custom domain routing could not be applied."
			domain.NextCheckAt = now.Add(r.config.RetryAfter)
			return result, errors.Join(err, r.store.CommitDomain(ctx, domain.Lease(), *domain))
		}
		domain.Status, domain.TLSStatus, domain.LastErrorCode, domain.LastErrorMessage = store.DomainRouting, store.DomainTLSIssuing, "", ""
		domain.NextCheckAt = now.Add(r.config.RetryAfter)
		if err := r.store.CommitDomain(ctx, domain.Lease(), *domain); err != nil { return result, err }
		result.Status, result.Reason = string(domain.Status), "domain_objects_applied"
		return result, nil
	case store.DomainRouting:
		return r.observe(ctx, *domain, plan, now)
	default:
		return result, fmt.Errorf("unsupported domain status %q", domain.Status)
	}
}

func (r *Reconciler) verify(ctx context.Context, domain store.Domain, now time.Time) (ReconcileResult, error) {
	result := ReconcileResult{Processed: true, DomainID: domain.ID, Status: string(domain.Status)}
	verification, err := r.verifier.Verify(ctx, Challenge{Hostname: domain.Hostname, TokenHash: domain.VerificationTokenHash, ExpiresAt: domain.ExpiresAt, VerifiedAt: domain.VerifiedAt, ConsecutiveFailures: domain.ConsecutiveFailures})
	domain.LastCheckedAt, domain.VerificationRequestedAt = verification.CheckedAt, time.Time{}
	domain.ConsecutiveFailures = verification.ConsecutiveFailures
	switch verification.Outcome {
	case VerificationMatched:
		if domain.VerifiedAt.IsZero() { domain.VerifiedAt = verification.CheckedAt }
		domain.Status, domain.TLSStatus = store.DomainVerified, store.DomainTLSPending
		domain.LastErrorCode, domain.LastErrorMessage = "", ""
		domain.NextCheckAt = verification.CheckedAt
	case VerificationExpired:
		domain.Status, domain.VerificationTokenHash = store.DomainFailed, ""
		domain.LastErrorCode, domain.LastErrorMessage = "CHALLENGE_EXPIRED", "Domain verification challenge expired; rotate it to continue."
		domain.NextCheckAt = time.Time{}
	case VerificationOwnershipLost:
		domain.Status, domain.TLSStatus, domain.VerificationTokenHash, domain.VerifiedAt = store.DomainFailed, store.DomainTLSFailed, "", time.Time{}
		domain.LastErrorCode, domain.LastErrorMessage = "OWNERSHIP_LOST", "Domain ownership proof was lost; rotate the challenge to recover."
		domain.CleanupRequiredForVersion = domain.VerificationVersion
		domain.CertificateAbsentObservedVersion, domain.RouteAbsentObservedVersion = 0, 0
		domain.NextCheckAt = now.Add(r.config.RetryAfter)
	case VerificationFailed:
		domain.LastErrorCode, domain.LastErrorMessage = "DNS_PROOF_MISMATCH", "Domain ownership TXT record does not match."
		domain.NextCheckAt = now.Add(r.config.RetryAfter)
	case VerificationRetry:
		domain.LastErrorCode, domain.LastErrorMessage = "DNS_RETRYABLE", "Domain ownership DNS lookup is temporarily unavailable."
		domain.NextCheckAt = now.Add(r.config.RetryAfter)
	default:
		return result, errors.New("domain verifier returned an unknown outcome")
	}
	commitErr := r.store.CommitDomain(ctx, domain.Lease(), domain)
	result.Status, result.Reason = string(domain.Status), string(verification.Outcome)
	return result, errors.Join(err, commitErr)
}

func (r *Reconciler) cleanup(ctx context.Context, domain store.Domain, plan kube.DomainPlan, now time.Time) (ReconcileResult, error) {
	result := ReconcileResult{Processed: true, DomainID: domain.ID, Status: string(domain.Status), Reason: "cleanup_pending"}
	absence, err := r.kube.Delete(ctx, plan)
	if err != nil {
		domain.LastErrorCode, domain.LastErrorMessage, domain.NextCheckAt = "CLEANUP_FAILED", "Custom domain cleanup is pending.", now.Add(r.config.RetryAfter)
		return result, errors.Join(err, r.store.CommitDomain(ctx, domain.Lease(), domain))
	}
	if absence.CertificateAbsent { domain.CertificateAbsentObservedVersion = domain.CleanupRequiredForVersion }
	if absence.IngressAbsent { domain.RouteAbsentObservedVersion = domain.CleanupRequiredForVersion }
	domain.LastErrorCode, domain.LastErrorMessage, domain.NextCheckAt = "", "", now
	if err := r.store.CommitDomain(ctx, domain.Lease(), domain); err != nil { return result, err }
	result.Reason = "cleanup_observed"
	return result, nil
}

func (r *Reconciler) observe(ctx context.Context, domain store.Domain, plan kube.DomainPlan, now time.Time) (ReconcileResult, error) {
	result := ReconcileResult{Processed: true, DomainID: domain.ID, Status: string(domain.Status), Reason: "routing_pending"}
	observation, err := r.kube.Observe(ctx, plan)
	if err != nil {
		domain.LastErrorCode, domain.LastErrorMessage, domain.NextCheckAt = "OBSERVATION_FAILED", "Custom domain readiness observation failed.", now.Add(r.config.RetryAfter)
		return result, errors.Join(err, r.store.CommitDomain(ctx, domain.Lease(), domain))
	}
	if observation.CertificateReady { domain.CertificateObservedGeneration = domain.DesiredGeneration }
	if observation.IngressReady { domain.RouteObservedGeneration = domain.DesiredGeneration }
	if observation.CertificateReady && observation.IngressReady {
		domain.Status, domain.TLSStatus, domain.LastErrorCode, domain.LastErrorMessage = store.DomainReady, store.DomainTLSReady, "", ""
		domain.NextCheckAt = domain.LastCheckedAt.Add(revalidationInterval)
		result.Status, result.Reason = string(domain.Status), "domain_ready"
	} else {
		domain.NextCheckAt = now.Add(r.config.RetryAfter)
	}
	return result, r.store.CommitDomain(ctx, domain.Lease(), domain)
}

func (r *Reconciler) plan(domain store.Domain) (kube.DomainPlan, error) {
	if !strings.EqualFold(domain.ServiceType, "web") { return kube.DomainPlan{}, errors.New("custom domains require a public web service") }
	project := &store.Project{ID: domain.ProjectID, OrganizationID: domain.OrganizationID, Slug: domain.ProjectSlug}
	service := &store.Service{ID: domain.ServiceID, ProjectID: domain.ProjectID, Slug: domain.ServiceName, Name: domain.ServiceName, Type: "web", Port: domain.ServicePort}
	runtime := kube.SpecFromState(project, service, &store.Deployment{ID: "domain-" + domain.ID}, "raibitserver.local")
	return kube.CompileDomain(kube.DomainSpec{DomainID: domain.ID, OrganizationID: domain.OrganizationID, ProjectID: domain.ProjectID, ServiceID: domain.ServiceID, Hostname: domain.Hostname, Namespace: runtime.Namespace, ServiceName: runtime.Name, ServicePort: runtime.Port, Generation: domain.DesiredGeneration, ClusterIssuer: r.config.ClusterIssuer, IngressClassName: r.config.IngressClassName})
}

func (r *Reconciler) cleanupPlan(domain store.Domain) (kube.DomainPlan, error) {
	namespace, err := kube.DomainTenantNamespace(domain.OrganizationID, domain.ProjectID, domain.ProjectSlug)
	if err != nil {
		return kube.DomainPlan{}, err
	}
	return kube.CompileDomainCleanup(domain.ID, namespace)
}
