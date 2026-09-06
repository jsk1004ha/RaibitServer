import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

export const DOMAIN_STATUSES = ['PENDING_VERIFICATION', 'VERIFIED', 'ROUTING', 'READY', 'FAILED', 'DELETING'] as const;
export const DOMAIN_TLS_STATUSES = ['PENDING', 'ISSUING', 'READY', 'FAILED'] as const;
export const DOMAIN_CHALLENGE_TTL_MS = 24 * 60 * 60 * 1_000;

export type DomainStatus = typeof DOMAIN_STATUSES[number];
export type DomainTlsStatus = typeof DOMAIN_TLS_STATUSES[number];

export type DomainCleanupBarrier = {
  readonly version: number;
  readonly certificateAbsentObservedVersion: number | null;
  readonly routeAbsentObservedVersion: number | null;
  readonly complete: boolean;
};

export type CustomDomainRecord = {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly serviceId: string;
  readonly hostname: string;
  readonly status: DomainStatus;
  readonly verificationTokenHash: string | null;
  readonly verificationVersion: number;
  readonly issuedAt: string | null;
  readonly expiresAt: string | null;
  readonly verifiedAt: string | null;
  readonly verificationRequestedAt: string | null;
  readonly lastCheckedAt: string | null;
  readonly nextCheckAt: string | null;
  readonly consecutiveFailures: number;
  readonly tlsStatus: DomainTlsStatus;
  readonly desiredGeneration: number;
  readonly controllerLeaseGeneration: number;
  readonly certificateObservedGeneration: number;
  readonly routeObservedGeneration: number;
  readonly cleanupRequiredForVersion: number | null;
  readonly certificateAbsentObservedVersion: number | null;
  readonly routeAbsentObservedVersion: number | null;
  readonly deletionRequestedAt: string | null;
  readonly actorUserId: string;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type CustomDomainView = Omit<CustomDomainRecord, 'verificationTokenHash' | 'cleanupRequiredForVersion' | 'certificateAbsentObservedVersion' | 'routeAbsentObservedVersion'> & {
  readonly cleanupBarrier: DomainCleanupBarrier | null;
};

export class DomainLifecycleError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode = 400) {
    super(code);
    this.name = 'DomainLifecycleError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function normalizeCustomHostname(value: unknown, platformZones: readonly string[] = ['raibitserver.app']): string {
  if (typeof value !== 'string') throw new DomainLifecycleError('DOMAIN_HOSTNAME_INVALID');
  const candidate = value.trim().toLowerCase().replace(/\.$/, '');
  if (!candidate || candidate.includes('*') || isIP(candidate) !== 0) throw new DomainLifecycleError('DOMAIN_HOSTNAME_INVALID');
  const hostname = domainToASCII(candidate).toLowerCase();
  const labels = hostname.split('.');
  if (!hostname || hostname.length > 253 || labels.length < 2 || labels.some((label) => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new DomainLifecycleError('DOMAIN_HOSTNAME_INVALID');
  }
  const owned = platformZones.map((zone) => domainToASCII(zone.trim().toLowerCase().replace(/\.$/, ''))).filter(Boolean);
  if (owned.some((zone) => hostname === zone || hostname.endsWith(`.${zone}`))) throw new DomainLifecycleError('DOMAIN_PLATFORM_ZONE_FORBIDDEN');
  return hostname;
}

export function hashDomainChallenge(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function matchesDomainChallenge(token: string, expectedHash: string | null): boolean {
  if (!expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  return crypto.timingSafeEqual(Buffer.from(hashDomainChallenge(token), 'hex'), Buffer.from(expectedHash, 'hex'));
}

export function issueCustomDomain(input: {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly serviceId: string;
  readonly hostname: string;
  readonly actorUserId: string;
  readonly now?: Date;
}): { readonly domain: CustomDomainRecord; readonly challengeToken: string } {
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const challengeToken = crypto.randomBytes(32).toString('base64url');
  return {
    challengeToken,
    domain: {
      id: input.id, organizationId: input.organizationId, projectId: input.projectId, serviceId: input.serviceId,
      hostname: input.hostname, status: 'PENDING_VERIFICATION', verificationTokenHash: hashDomainChallenge(challengeToken), verificationVersion: 1,
      issuedAt: timestamp, expiresAt: new Date(now.getTime() + DOMAIN_CHALLENGE_TTL_MS).toISOString(), verifiedAt: null,
      verificationRequestedAt: null, lastCheckedAt: null, nextCheckAt: null, consecutiveFailures: 0, tlsStatus: 'PENDING',
      desiredGeneration: 1, controllerLeaseGeneration: 0, certificateObservedGeneration: 0, routeObservedGeneration: 0,
      cleanupRequiredForVersion: null, certificateAbsentObservedVersion: null, routeAbsentObservedVersion: null,
      deletionRequestedAt: null, actorUserId: input.actorUserId, lastErrorCode: null, lastErrorMessage: null,
      createdAt: timestamp, updatedAt: timestamp,
    },
  };
}

export function rotateCustomDomain(record: CustomDomainRecord, expectedVersion: number, actorUserId: string, now = new Date()): { readonly domain: CustomDomainRecord; readonly challengeToken: string } {
  assertMutableVersion(record, expectedVersion);
  const timestamp = now.toISOString();
  const challengeToken = crypto.randomBytes(32).toString('base64url');
  return {
    challengeToken,
    domain: {
      ...record, status: 'PENDING_VERIFICATION', verificationTokenHash: hashDomainChallenge(challengeToken), verificationVersion: record.verificationVersion + 1,
      issuedAt: timestamp, expiresAt: new Date(now.getTime() + DOMAIN_CHALLENGE_TTL_MS).toISOString(), verifiedAt: null,
      verificationRequestedAt: null, lastCheckedAt: null, nextCheckAt: null, consecutiveFailures: 0, tlsStatus: 'PENDING',
      desiredGeneration: record.desiredGeneration + 1, certificateObservedGeneration: 0, routeObservedGeneration: 0,
      cleanupRequiredForVersion: record.verificationVersion, certificateAbsentObservedVersion: null, routeAbsentObservedVersion: null,
      actorUserId, lastErrorCode: null, lastErrorMessage: null, updatedAt: timestamp,
    },
  };
}

export function requestCustomDomainCheck(record: CustomDomainRecord, expectedVersion: number, actorUserId: string, now = new Date()): CustomDomainRecord {
  assertMutableVersion(record, expectedVersion);
  const timestamp = now.toISOString();
  return { ...record, verificationRequestedAt: timestamp, nextCheckAt: timestamp, actorUserId, updatedAt: timestamp };
}

export function requestCustomDomainDelete(record: CustomDomainRecord, expectedVersion: number, actorUserId: string, now = new Date()): CustomDomainRecord {
  assertMutableVersion(record, expectedVersion);
  const timestamp = now.toISOString();
  return {
    ...record, status: 'DELETING', desiredGeneration: record.desiredGeneration + 1,
    cleanupRequiredForVersion: record.cleanupRequiredForVersion ?? record.verificationVersion,
    certificateAbsentObservedVersion: null, routeAbsentObservedVersion: null,
    deletionRequestedAt: record.deletionRequestedAt ?? timestamp, actorUserId, updatedAt: timestamp,
  };
}

export function publicCustomDomain(record: CustomDomainRecord): CustomDomainView {
  const { verificationTokenHash: _hash, cleanupRequiredForVersion, certificateAbsentObservedVersion, routeAbsentObservedVersion, ...view } = record;
  const cleanupBarrier = cleanupRequiredForVersion === null ? null : {
    version: cleanupRequiredForVersion,
    certificateAbsentObservedVersion,
    routeAbsentObservedVersion,
    complete: certificateAbsentObservedVersion === cleanupRequiredForVersion && routeAbsentObservedVersion === cleanupRequiredForVersion,
  };
  return { ...view, cleanupBarrier };
}

function assertMutableVersion(record: CustomDomainRecord, expectedVersion: number): void {
  if (record.status === 'DELETING') throw new DomainLifecycleError('DOMAIN_DELETING', 409);
  if (!Number.isInteger(expectedVersion) || expectedVersion !== record.verificationVersion) throw new DomainLifecycleError('DOMAIN_VERSION_CONFLICT', 409);
}
