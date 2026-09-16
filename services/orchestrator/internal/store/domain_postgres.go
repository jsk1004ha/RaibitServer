package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

const claimDomainSQL = `
SELECT d.id, d."organizationId", d."projectId", p.slug, d."serviceId", s.slug, s.type, s.port, d.domain,
 d.status, d."verificationTokenHash", d."verificationVersion", d."issuedAt", d."expiresAt", d."verifiedAt",
 d."verificationRequestedAt", d."lastCheckedAt", d."nextCheckAt", d."consecutiveFailures", d."tlsStatus",
 d."desiredGeneration", d."controllerLeaseGeneration", d."certificateObservedGeneration", d."routeObservedGeneration",
 d."cleanupRequiredForVersion", d."certificateAbsentObservedVersion", d."routeAbsentObservedVersion",
 d."deletionRequestedAt", d."lastErrorCode", d."lastErrorMessage"
FROM "Domain" d
JOIN "Project" p ON p.id = d."projectId" AND p."organizationId" = d."organizationId"
JOIN "Service" s ON s.id = d."serviceId" AND s."projectId" = d."projectId"
WHERE d.status = 'DELETING'
 OR ((d.status IN ('VERIFIED', 'ROUTING') OR
        (d."cleanupRequiredForVersion" IS NOT NULL AND
         (d."certificateAbsentObservedVersion" IS DISTINCT FROM d."cleanupRequiredForVersion" OR d."routeAbsentObservedVersion" IS DISTINCT FROM d."cleanupRequiredForVersion")))
       AND (d."nextCheckAt" IS NULL OR d."nextCheckAt" <= $1))
 OR (d."nextCheckAt" IS NOT NULL AND d."nextCheckAt" <= $1 AND
     (d.status = 'PENDING_VERIFICATION' OR (d."verifiedAt" IS NOT NULL AND d.status IN ('READY', 'FAILED'))))
ORDER BY COALESCE(d."nextCheckAt", d."updatedAt"), d.id
FOR UPDATE OF d SKIP LOCKED
LIMIT 1`

func (s *PostgresStore) ClaimNextDomain(ctx context.Context, options ClaimOptions) (*Domain, error) {
	claimAt, leaseDuration := deletionClaimClock(options)
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	domain, err := scanPostgresDomain(tx.QueryRowContext(ctx, claimDomainSQL, claimAt))
	if errors.Is(err, sql.ErrNoRows) {
		if err := tx.Commit(); err != nil { return nil, err }
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	result, err := tx.ExecContext(ctx, `UPDATE "Domain" SET "controllerLeaseGeneration" = "controllerLeaseGeneration" + 1,
 "nextCheckAt" = $1, "updatedAt" = $2 WHERE id = $3 AND "verificationVersion" = $4 AND "desiredGeneration" = $5 AND "controllerLeaseGeneration" = $6`,
		claimAt.Add(leaseDuration), claimAt, domain.ID, domain.VerificationVersion, domain.DesiredGeneration, domain.ControllerLeaseGeneration)
	if err != nil {
		return nil, err
	}
	rows, err := result.RowsAffected()
	if err != nil || rows != 1 {
		return nil, ErrDomainLeaseLost
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	domain.ControllerLeaseGeneration++
	domain.NextCheckAt = claimAt.Add(leaseDuration)
	return &domain, nil
}

func (s *PostgresStore) CommitDomain(ctx context.Context, lease DomainLease, next Domain) error {
	result, err := s.db.ExecContext(ctx, `
UPDATE "Domain" SET status=$1, "tlsStatus"=$2, "verificationTokenHash"=NULLIF($3,''),
 "verifiedAt"=$4, "verificationRequestedAt"=NULL, "lastCheckedAt"=$5, "nextCheckAt"=$6,
 "consecutiveFailures"=$7, "certificateObservedGeneration"=$8, "routeObservedGeneration"=$9,
 "cleanupRequiredForVersion"=$10, "certificateAbsentObservedVersion"=$11, "routeAbsentObservedVersion"=$12,
 "lastErrorCode"=NULLIF($13,''), "lastErrorMessage"=NULLIF($14,''), "updatedAt"=CURRENT_TIMESTAMP
WHERE id=$15 AND "verificationVersion"=$16 AND "desiredGeneration"=$17 AND "controllerLeaseGeneration"=$18
 AND ($1 <> 'VERIFIED' OR "verifiedAt" IS NOT NULL OR "expiresAt" > $5)`,
		next.Status, next.TLSStatus, next.VerificationTokenHash, nullableSQLTime(next.VerifiedAt), nullableSQLTime(next.LastCheckedAt), nullableSQLTime(next.NextCheckAt),
		next.ConsecutiveFailures, next.CertificateObservedGeneration, next.RouteObservedGeneration, nullableSQLInt(next.CleanupRequiredForVersion), nullableSQLInt(next.CertificateAbsentObservedVersion), nullableSQLInt(next.RouteAbsentObservedVersion),
		next.LastErrorCode, Redact(next.LastErrorMessage), lease.DomainID, lease.VerificationVersion, lease.DesiredGeneration, lease.LeaseGeneration)
	if err != nil {
		return err
	}
	rows, err := result.RowsAffected()
	if err != nil || rows != 1 {
		return ErrDomainLeaseLost
	}
	return nil
}

func (s *PostgresStore) FinalizeDomain(ctx context.Context, lease DomainLease) error {
	result, err := s.db.ExecContext(ctx, `DELETE FROM "Domain" WHERE id=$1 AND status='DELETING'
 AND "verificationVersion"=$2 AND "desiredGeneration"=$3 AND "controllerLeaseGeneration"=$4
 AND ("cleanupRequiredForVersion" IS NULL OR ("certificateAbsentObservedVersion"="cleanupRequiredForVersion" AND "routeAbsentObservedVersion"="cleanupRequiredForVersion"))`,
		lease.DomainID, lease.VerificationVersion, lease.DesiredGeneration, lease.LeaseGeneration)
	if err != nil {
		return err
	}
	rows, err := result.RowsAffected()
	if err != nil || rows != 1 {
		return ErrDomainLeaseLost
	}
	return nil
}

type domainScanner interface{ Scan(...any) error }

func scanPostgresDomain(row domainScanner) (Domain, error) {
	var domain Domain
	var status, tlsStatus string
	var tokenHash, lastErrorCode, lastErrorMessage sql.NullString
	var servicePort sql.NullInt64
	var issuedAt, expiresAt, verifiedAt, requestedAt, lastCheckedAt, nextCheckAt, deletionRequestedAt sql.NullTime
	var cleanupVersion, certificateAbsentVersion, routeAbsentVersion sql.NullInt64
	err := row.Scan(&domain.ID, &domain.OrganizationID, &domain.ProjectID, &domain.ProjectSlug, &domain.ServiceID, &domain.ServiceName, &domain.ServiceType, &servicePort, &domain.Hostname,
		&status, &tokenHash, &domain.VerificationVersion, &issuedAt, &expiresAt, &verifiedAt, &requestedAt, &lastCheckedAt, &nextCheckAt, &domain.ConsecutiveFailures, &tlsStatus,
		&domain.DesiredGeneration, &domain.ControllerLeaseGeneration, &domain.CertificateObservedGeneration, &domain.RouteObservedGeneration, &cleanupVersion, &certificateAbsentVersion, &routeAbsentVersion,
		&deletionRequestedAt, &lastErrorCode, &lastErrorMessage)
	if err != nil {
		return Domain{}, err
	}
	domain.VerificationTokenHash, domain.LastErrorCode, domain.LastErrorMessage = tokenHash.String, lastErrorCode.String, lastErrorMessage.String
	domain.Status, domain.TLSStatus = DomainStatus(status), DomainTLSStatus(tlsStatus)
	domain.ServicePort = int(servicePort.Int64)
	if domain.ServicePort == 0 { domain.ServicePort = 3000 }
	domain.IssuedAt, domain.ExpiresAt, domain.VerifiedAt, domain.VerificationRequestedAt = issuedAt.Time, expiresAt.Time, verifiedAt.Time, requestedAt.Time
	domain.LastCheckedAt, domain.NextCheckAt, domain.DeletionRequestedAt = lastCheckedAt.Time, nextCheckAt.Time, deletionRequestedAt.Time
	domain.CleanupRequiredForVersion, domain.CertificateAbsentObservedVersion, domain.RouteAbsentObservedVersion = int(cleanupVersion.Int64), int(certificateAbsentVersion.Int64), int(routeAbsentVersion.Int64)
	return domain, nil
}

func nullableSQLTime(value time.Time) any {
	if value.IsZero() { return nil }
	return value.UTC()
}

func nullableSQLInt(value int) any {
	if value == 0 { return nil }
	return value
}
