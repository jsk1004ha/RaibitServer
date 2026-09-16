package store

import (
	"context"
	"errors"
	"time"
)

type DomainStatus string

type DomainTLSStatus string

const (
	DomainPending  DomainStatus = "PENDING_VERIFICATION"
	DomainVerified DomainStatus = "VERIFIED"
	DomainRouting  DomainStatus = "ROUTING"
	DomainReady    DomainStatus = "READY"
	DomainFailed   DomainStatus = "FAILED"
	DomainDeleting DomainStatus = "DELETING"

	DomainTLSPending DomainTLSStatus = "PENDING"
	DomainTLSIssuing DomainTLSStatus = "ISSUING"
	DomainTLSReady   DomainTLSStatus = "READY"
	DomainTLSFailed  DomainTLSStatus = "FAILED"
)

var ErrDomainLeaseLost = errors.New("domain reconcile lease ownership lost")

type DomainStore interface {
	ClaimNextDomain(context.Context, ClaimOptions) (*Domain, error)
	CommitDomain(context.Context, DomainLease, Domain) error
	FinalizeDomain(context.Context, DomainLease) error
}

type DomainLease struct {
	DomainID            string
	VerificationVersion int
	DesiredGeneration   int
	LeaseGeneration     int
}

type Domain struct {
	ID                               string
	OrganizationID                   string
	ProjectID                        string
	ProjectSlug                      string
	ServiceID                        string
	ServiceName                      string
	ServiceType                      string
	ServicePort                      int
	Hostname                         string
	Status                           DomainStatus
	VerificationTokenHash            string
	VerificationVersion              int
	IssuedAt                         time.Time
	ExpiresAt                        time.Time
	VerifiedAt                       time.Time
	VerificationRequestedAt          time.Time
	LastCheckedAt                    time.Time
	NextCheckAt                      time.Time
	ConsecutiveFailures              int
	TLSStatus                        DomainTLSStatus
	DesiredGeneration                int
	ControllerLeaseGeneration        int
	CertificateObservedGeneration    int
	RouteObservedGeneration          int
	CleanupRequiredForVersion        int
	CertificateAbsentObservedVersion int
	RouteAbsentObservedVersion       int
	DeletionRequestedAt              time.Time
	LastErrorCode                    string
	LastErrorMessage                 string
}

func (d Domain) Lease() DomainLease {
	return DomainLease{DomainID: d.ID, VerificationVersion: d.VerificationVersion, DesiredGeneration: d.DesiredGeneration, LeaseGeneration: d.ControllerLeaseGeneration}
}

func (d Domain) CleanupComplete() bool {
	return d.CleanupRequiredForVersion == 0 ||
		(d.CertificateAbsentObservedVersion == d.CleanupRequiredForVersion && d.RouteAbsentObservedVersion == d.CleanupRequiredForVersion)
}
