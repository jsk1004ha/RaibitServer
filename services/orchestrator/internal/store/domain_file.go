package store

import (
	"context"
	"sort"
	"strings"
	"time"
)

func (s *FileStore) ClaimNextDomain(ctx context.Context, options ClaimOptions) (*Domain, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.load()
	if err != nil {
		return nil, err
	}
	rows := recordSlice(state, "domains")
	sort.SliceStable(rows, func(i, j int) bool { return stringField(rows[i], "id") < stringField(rows[j], "id") })
	claimAt, leaseDuration := deletionClaimClock(options)
	for _, row := range rows {
		domain := domainFromRecord(state, row)
		if !domainClaimable(domain, claimAt) {
			continue
		}
		row["controllerLeaseGeneration"] = domain.ControllerLeaseGeneration + 1
		row["nextCheckAt"] = claimAt.Add(leaseDuration).Format(time.RFC3339Nano)
		setRecordSlice(state, "domains", rows)
		if err := s.save(state); err != nil {
			return nil, err
		}
		domain.ControllerLeaseGeneration++
		domain.NextCheckAt = claimAt.Add(leaseDuration)
		return &domain, nil
	}
	return nil, nil
}

func (s *FileStore) CommitDomain(ctx context.Context, lease DomainLease, next Domain) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.load()
	if err != nil {
		return err
	}
	rows := recordSlice(state, "domains")
	index := findRecordIndex(rows, lease.DomainID)
	if index < 0 || !recordOwnsDomainLease(rows[index], lease) {
		return ErrDomainLeaseLost
	}
	if next.Status == DomainVerified && parseTimestamp(stringField(rows[index], "verifiedAt")).IsZero() && !next.LastCheckedAt.Before(parseTimestamp(stringField(rows[index], "expiresAt"))) {
		return ErrDomainLeaseLost
	}
	writeDomainRecord(rows[index], next)
	setRecordSlice(state, "domains", rows)
	return s.save(state)
}

func (s *FileStore) FinalizeDomain(ctx context.Context, lease DomainLease) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.load()
	if err != nil {
		return err
	}
	rows := recordSlice(state, "domains")
	index := findRecordIndex(rows, lease.DomainID)
	if index < 0 || !recordOwnsDomainLease(rows[index], lease) || !domainFromRecord(state, rows[index]).CleanupComplete() {
		return ErrDomainLeaseLost
	}
	setRecordSlice(state, "domains", append(rows[:index], rows[index+1:]...))
	return s.save(state)
}

func domainClaimable(domain Domain, now time.Time) bool {
	due := domain.NextCheckAt.IsZero() || !domain.NextCheckAt.After(now)
	if domain.Status == DomainDeleting {
		return true
	}
	if !domain.CleanupComplete() || domain.Status == DomainVerified || domain.Status == DomainRouting {
		return due
	}
	if domain.NextCheckAt.IsZero() || domain.NextCheckAt.After(now) {
		return false
	}
	return domain.Status == DomainPending || (!domain.VerifiedAt.IsZero() && (domain.Status == DomainReady || domain.Status == DomainFailed))
}

func recordOwnsDomainLease(row record, lease DomainLease) bool {
	return stringField(row, "id") == lease.DomainID && intField(row, "verificationVersion") == lease.VerificationVersion &&
		intField(row, "desiredGeneration") == lease.DesiredGeneration && intField(row, "controllerLeaseGeneration") == lease.LeaseGeneration
}

func domainFromRecord(state map[string]any, row record) Domain {
	service := findRecord(recordSlice(state, "services"), stringField(row, "serviceId"))
	project := findRecord(recordSlice(state, "projects"), stringField(row, "projectId"))
	return Domain{
		ID: stringField(row, "id"), OrganizationID: stringField(row, "organizationId"), ProjectID: stringField(row, "projectId"), ProjectSlug: stringField(project, "slug"),
		ServiceID: stringField(row, "serviceId"), ServiceName: coalesceString(stringField(service, "slug"), stringField(service, "name")), ServiceType: strings.ToLower(stringField(service, "type")), ServicePort: intField(service, "port"),
		Hostname: stringField(row, "domain"), Status: DomainStatus(stringField(row, "status")), VerificationTokenHash: stringField(row, "verificationTokenHash"), VerificationVersion: intField(row, "verificationVersion"),
		IssuedAt: parseTimestamp(stringField(row, "issuedAt")), ExpiresAt: parseTimestamp(stringField(row, "expiresAt")), VerifiedAt: parseTimestamp(stringField(row, "verifiedAt")), VerificationRequestedAt: parseTimestamp(stringField(row, "verificationRequestedAt")), LastCheckedAt: parseTimestamp(stringField(row, "lastCheckedAt")), NextCheckAt: parseTimestamp(stringField(row, "nextCheckAt")), ConsecutiveFailures: intField(row, "consecutiveFailures"),
		TLSStatus: DomainTLSStatus(stringField(row, "tlsStatus")), DesiredGeneration: intField(row, "desiredGeneration"), ControllerLeaseGeneration: intField(row, "controllerLeaseGeneration"), CertificateObservedGeneration: intField(row, "certificateObservedGeneration"), RouteObservedGeneration: intField(row, "routeObservedGeneration"), CleanupRequiredForVersion: intField(row, "cleanupRequiredForVersion"), CertificateAbsentObservedVersion: intField(row, "certificateAbsentObservedVersion"), RouteAbsentObservedVersion: intField(row, "routeAbsentObservedVersion"), DeletionRequestedAt: parseTimestamp(stringField(row, "deletionRequestedAt")), LastErrorCode: stringField(row, "lastErrorCode"), LastErrorMessage: stringField(row, "lastErrorMessage"),
	}
}

func writeDomainRecord(row record, domain Domain) {
	row["status"], row["tlsStatus"] = domain.Status, domain.TLSStatus
	row["verificationTokenHash"] = nullable(domain.VerificationTokenHash)
	row["verifiedAt"], row["lastCheckedAt"], row["nextCheckAt"] = nullableTime(domain.VerifiedAt), nullableTime(domain.LastCheckedAt), nullableTime(domain.NextCheckAt)
	row["verificationRequestedAt"], row["consecutiveFailures"] = nil, domain.ConsecutiveFailures
	row["certificateObservedGeneration"], row["routeObservedGeneration"] = domain.CertificateObservedGeneration, domain.RouteObservedGeneration
	row["cleanupRequiredForVersion"] = nullableInt(domain.CleanupRequiredForVersion)
	row["certificateAbsentObservedVersion"], row["routeAbsentObservedVersion"] = nullableInt(domain.CertificateAbsentObservedVersion), nullableInt(domain.RouteAbsentObservedVersion)
	row["lastErrorCode"], row["lastErrorMessage"] = nullable(domain.LastErrorCode), nullable(Redact(domain.LastErrorMessage))
}

func nullableTime(value time.Time) any {
	if value.IsZero() { return nil }
	return value.UTC().Format(time.RFC3339Nano)
}

func nullableInt(value int) any {
	if value == 0 { return nil }
	return value
}
