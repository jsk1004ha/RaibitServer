export const IDENTITY_STATES = [
  'anonymous', 'pending', 'unverified', 'verified-password', 'verified-oauth-only',
  'expired-session', 'revoked-session',
] as const;

export const ORGANIZATION_ROLES = [
  'OWNER', 'ADMIN', 'MAINTAINER', 'DEVELOPER', 'DB_ADMIN', 'VIEWER',
] as const;

export const IDENTITY_ORGANIZATION_VIEWPORTS = [
  { width: 320, height: 720 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
] as const;

export const IDENTITY_ORGANIZATION_ACCESSIBILITY = [
  'keyboard', 'screen-reader-announcement', 'reduced-motion', 'zoom-200',
] as const;

type IdentityState = (typeof IDENTITY_STATES)[number];
type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];
type OrganizationScope = OrganizationRole | 'NONE' | 'GLOBAL_ADMIN';
type JourneySurface = 'organization-create' | 'invite-accept' | 'member-read' | 'member-mutate' | 'leave' | 'logout';
type ExpectedOutcome = 'allowed' | 'authentication-required' | 'verification-required' | 'permission-denied' | 'scoped-not-found' | 'claim-conflict' | 'last-owner-conflict' | 'replay-denied' | 'session-revoked';

export type IdentityOrganizationRow = Readonly<{
  id: string;
  identity: IdentityState;
  organizationA: OrganizationScope;
  organizationB: OrganizationScope;
  surface: JourneySurface;
  expected: ExpectedOutcome;
  apiAssertion: string;
  browserOutcome: string;
  redactionAssertion: string;
}>;

export const IDENTITY_ORGANIZATION_MATRIX = [
  { id: 'anonymous-create', identity: 'anonymous', organizationA: 'NONE', organizationB: 'NONE', surface: 'organization-create', expected: 'authentication-required', apiAssertion: 'POST /organizations returns 401 and creates no organization', browserOutcome: 'login screen preserves only an allowlisted return path', redactionAssertion: 'response contains no organization or user identifiers' },
  { id: 'pending-create', identity: 'pending', organizationA: 'NONE', organizationB: 'NONE', surface: 'organization-create', expected: 'authentication-required', apiAssertion: 'pending backed user receives 401 and creates no organization', browserOutcome: 'account state is announced without a creation success', redactionAssertion: 'response does not disclose approval workflow metadata' },
  { id: 'unverified-create', identity: 'unverified', organizationA: 'NONE', organizationB: 'NONE', surface: 'organization-create', expected: 'verification-required', apiAssertion: 'approved unverified user receives email_not_verified', browserOutcome: 'verification action receives focus and is keyboard reachable', redactionAssertion: 'response contains no verification code or token' },
  { id: 'oauth-only-create', identity: 'verified-oauth-only', organizationA: 'VIEWER', organizationB: 'NONE', surface: 'organization-create', expected: 'allowed', apiAssertion: 'OAuth-only approved user creates an organization and becomes its sole OWNER', browserOutcome: 'new organization appears in the switcher and opens its member page', redactionAssertion: 'response contains no session or provider token' },
  { id: 'global-admin-create', identity: 'verified-password', organizationA: 'GLOBAL_ADMIN', organizationB: 'NONE', surface: 'organization-create', expected: 'allowed', apiAssertion: 'backed human global ADMIN creates an organization and becomes its sole OWNER', browserOutcome: 'new tenant opens without inheriting platform authority controls', redactionAssertion: 'response contains no JWT or foreign tenant data' },
  { id: 'organization-safe-claim', identity: 'verified-password', organizationA: 'VIEWER', organizationB: 'NONE', surface: 'organization-create', expected: 'claim-conflict', apiAssertion: 'duplicate normalized slug returns one typed conflict and does not transfer ownership', browserOutcome: 'conflict keeps entered values and offers a new slug without naming the existing owner', redactionAssertion: 'response contains no existing organization or owner metadata' },
  { id: 'owner-invite-accept-leave', identity: 'verified-password', organizationA: 'OWNER', organizationB: 'NONE', surface: 'invite-accept', expected: 'allowed', apiAssertion: 'OWNER invite is accepted by the exact verified email and creates one membership', browserOutcome: 'mail-link acceptance opens the target organization and exposes a leave action', redactionAssertion: 'raw invite token exists only in the trusted mail link' },
  { id: 'oauth-invite-accept', identity: 'verified-oauth-only', organizationA: 'VIEWER', organizationB: 'NONE', surface: 'invite-accept', expected: 'allowed', apiAssertion: 'OAuth-only exact verified email accepts without a password or prior target membership', browserOutcome: 'acceptance completes after authenticated navigation and switches tenant safely', redactionAssertion: 'member, audit, and list responses omit the raw token' },
  { id: 'foreign-email-invite', identity: 'verified-password', organizationA: 'VIEWER', organizationB: 'NONE', surface: 'invite-accept', expected: 'permission-denied', apiAssertion: 'foreign normalized email receives the opaque invalid-invite response', browserOutcome: 'generic unavailable state exposes no target organization', redactionAssertion: 'organization, inviter, recipient, and membership metadata are absent' },
  { id: 'invite-replay', identity: 'verified-password', organizationA: 'VIEWER', organizationB: 'DEVELOPER', surface: 'invite-accept', expected: 'replay-denied', apiAssertion: 'consumed invite cannot create or change a second membership', browserOutcome: 'replayed mail link shows the same generic unavailable state', redactionAssertion: 'response does not reveal whether the invite was accepted, expired, or revoked' },
  { id: 'owner-member-mutate', identity: 'verified-password', organizationA: 'OWNER', organizationB: 'VIEWER', surface: 'member-mutate', expected: 'allowed', apiAssertion: 'OWNER changes a target role using the expected membership version', browserOutcome: 'saved role is announced and stale controls refresh', redactionAssertion: 'response is limited to the target organization member view' },
  { id: 'admin-member-mutate', identity: 'verified-password', organizationA: 'ADMIN', organizationB: 'VIEWER', surface: 'member-mutate', expected: 'allowed', apiAssertion: 'ADMIN manages a non-owner but cannot grant or revoke OWNER', browserOutcome: 'only legal grant roles are offered', redactionAssertion: 'forbidden OWNER transition exposes no hidden owner data' },
  ...(['MAINTAINER', 'DEVELOPER', 'DB_ADMIN', 'VIEWER'] as const).map((role) => ({ id: `${role.toLowerCase()}-member-mutate`, identity: 'verified-password', organizationA: role, organizationB: 'VIEWER', surface: 'member-mutate', expected: 'permission-denied', apiAssertion: `${role} cannot change or remove organization members`, browserOutcome: 'member mutation controls are absent and direct navigation renders permission denial', redactionAssertion: 'denial contains no foreign member details' } satisfies IdentityOrganizationRow)),
  { id: 'two-org-foreign-scope', identity: 'verified-password', organizationA: 'OWNER', organizationB: 'NONE', surface: 'member-read', expected: 'scoped-not-found', apiAssertion: 'organization A authority cannot enumerate organization B members', browserOutcome: 'foreign member URL renders scoped not-found and a safe return action', redactionAssertion: 'organization B name, members, roles, and invite state are absent' },
  { id: 'cjk-identity-reflow', identity: 'verified-password', organizationA: 'VIEWER', organizationB: 'DEVELOPER', surface: 'member-read', expected: 'allowed', apiAssertion: 'normalized CJK display names do not alter identity or tenant authorization', browserOutcome: 'CJK identity and organization labels remain readable at every viewport and 200% zoom', redactionAssertion: 'display labels never substitute for immutable user or organization IDs' },
  { id: 'hostile-member-redaction', identity: 'verified-password', organizationA: 'ADMIN', organizationB: 'NONE', surface: 'member-read', expected: 'allowed', apiAssertion: 'hostile member display text is returned only as inert data', browserOutcome: 'markup-shaped names render literally without script, URL, or accessibility-tree injection', redactionAssertion: 'errors and announcements omit raw upstream stacks and secret-shaped values' },
  { id: 'sole-owner-leave', identity: 'verified-password', organizationA: 'OWNER', organizationB: 'VIEWER', surface: 'leave', expected: 'last-owner-conflict', apiAssertion: 'concurrent demote, remove, and leave attempts cannot reduce owner count to zero', browserOutcome: 'LAST_OWNER conflict is announced and the owner remains in the member list', redactionAssertion: 'conflict exposes no unrelated member or session data' },
  { id: 'membership-session-revoked', identity: 'revoked-session', organizationA: 'OWNER', organizationB: 'VIEWER', surface: 'member-read', expected: 'session-revoked', apiAssertion: 'pre-role-change JWT receives 401 after sessionVersion increments', browserOutcome: 'session-expired screen clears authentication and requires an explicit login', redactionAssertion: 'response contains no current sessionVersion or target membership' },
  { id: 'expired-session-read', identity: 'expired-session', organizationA: 'VIEWER', organizationB: 'NONE', surface: 'member-read', expected: 'authentication-required', apiAssertion: 'cryptographically valid expired JWT receives 401 before tenant lookup', browserOutcome: 'session-expired screen clears authentication and announces a required login', redactionAssertion: 'response contains no tenant, membership, or token claims' },
  { id: 'logout-replay', identity: 'revoked-session', organizationA: 'VIEWER', organizationB: 'NONE', surface: 'logout', expected: 'session-revoked', apiAssertion: 'logout increments sessionVersion and the prior JWT cannot be reused', browserOutcome: 'desktop and mobile shells clear the cookie and preserve only a safe return path', redactionAssertion: 'logout and subsequent denial contain no token or cookie value' },
] as const satisfies readonly IdentityOrganizationRow[];

export const IDENTITY_ORGANIZATION_EXECUTION = {
  localNode: { status: 'RUNNABLE', command: 'node --test tests/identity-organization-matrix.test.js' },
  postgres: { status: 'NOT_RUN', reason: 'RAIBITSERVER_TEST_DATABASE_URL is intentionally deferred' },
  browser: { status: 'NOT_RUN', reason: 'Playwright/browser execution is intentionally deferred' },
} as const;
