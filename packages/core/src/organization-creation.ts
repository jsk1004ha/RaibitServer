import { parseOrganizationRouteSlug } from './rbac.ts';

export type OrganizationCreationErrorCode =
  | 'organization_creation_auth_required'
  | 'organization_creation_input_invalid'
  | 'organization_name_invalid'
  | 'organization_route_slug_invalid'
  | 'organization_route_slug_reserved'
  | 'organization_route_slug_too_long'
  | 'organization_slug_already_exists'
  | 'email_not_verified'
  | 'account_not_approved'
  | 'account_banned';

export class OrganizationCreationError extends Error {
  readonly code: OrganizationCreationErrorCode;
  readonly statusCode: number;

  constructor(code: OrganizationCreationErrorCode, statusCode: number) {
    super(code);
    this.name = 'OrganizationCreationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type AuthenticatedOrganizationCreateInput = {
  readonly actorUserId: string;
  readonly name: string;
  readonly slug: string;
};

export function parseAuthenticatedOrganizationCreateInput(input: AuthenticatedOrganizationCreateInput) {
  if (Object.keys(input).some((key) => !['actorUserId', 'name', 'slug'].includes(key))) {
    throw new OrganizationCreationError('organization_creation_input_invalid', 400);
  }
  const actorUserId = String(input.actorUserId || '').trim();
  if (!actorUserId) throw new OrganizationCreationError('organization_creation_auth_required', 401);
  const name = String(input.name || '').trim();
  if (!name || name.length > 128 || new TextEncoder().encode(name).byteLength > 256) {
    throw new OrganizationCreationError('organization_name_invalid', 400);
  }
  const slug = parseOrganizationRouteSlug(input.slug);
  if (slug.ok === false) throw new OrganizationCreationError(slug.code, 400);
  return { actorUserId, name, slug: slug.slug };
}

export function assertOrganizationCreatorEligible(user: Readonly<Record<string, unknown>> | null | undefined, now = Date.now()) {
  if (!user) throw new OrganizationCreationError('organization_creation_auth_required', 401);
  if (!user.emailVerifiedAt) throw new OrganizationCreationError('email_not_verified', 403);
  if (String(user.approvalStatus || 'PENDING').toUpperCase() !== 'APPROVED') {
    throw new OrganizationCreationError('account_not_approved', 403);
  }
  if (user.bannedAt) {
    const expiresAt = user.banExpiresAt ? new Date(String(user.banExpiresAt)).getTime() : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(expiresAt) || expiresAt > now) throw new OrganizationCreationError('account_banned', 403);
  }
  return true;
}

export function assertInteractiveOrganizationCreator(subject: Readonly<Record<string, unknown>>) {
  const claims = subject.claims && typeof subject.claims === 'object' ? subject.claims as Readonly<Record<string, unknown>> : {};
  if (subject.authMode !== 'jwt' || claims.system === true || !String(subject.id || '').trim()) {
    throw new OrganizationCreationError('organization_creation_auth_required', 401);
  }
  return String(subject.id);
}
