export const ORGANIZATION_MEMBERSHIP_ROLES = Object.freeze(['OWNER', 'ADMIN', 'MAINTAINER', 'DEVELOPER', 'DB_ADMIN', 'VIEWER'] as const);
export const LEGACY_ORGANIZATION_ROLE_ALIASES = Object.freeze(['billing-manager', 'project-owner'] as const);
export const TEAM_ROLES = Object.freeze([...ORGANIZATION_MEMBERSHIP_ROLES]);

export type OrganizationMembershipRole = typeof ORGANIZATION_MEMBERSHIP_ROLES[number];

const RESERVED_ORGANIZATION_ROUTE_SLUGS = new Set([
  'app', 'api', 'admin', 'apps', 'preview', 'console', 'resources', 'logs', 'metrics',
]);
const ORGANIZATION_ROUTE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export type OrganizationRouteSlugResult =
  | { readonly ok: true; readonly statusCode: 200; readonly slug: string }
  | { readonly ok: false; readonly statusCode: 400; readonly code: 'organization_route_slug_invalid' | 'organization_route_slug_reserved' | 'organization_route_slug_too_long' };

export function parseOrganizationRouteSlug(value: unknown): OrganizationRouteSlugResult {
  if (typeof value !== 'string' || !ORGANIZATION_ROUTE_SLUG_PATTERN.test(value) || value.includes('--')) {
    return { ok: false, statusCode: 400, code: 'organization_route_slug_invalid' };
  }
  if (new TextEncoder().encode(value).byteLength > 63) {
    return { ok: false, statusCode: 400, code: 'organization_route_slug_too_long' };
  }
  if (RESERVED_ORGANIZATION_ROUTE_SLUGS.has(value)) {
    return { ok: false, statusCode: 400, code: 'organization_route_slug_reserved' };
  }
  return { ok: true, statusCode: 200, slug: value };
}

const ROLE_PERMISSIONS: Readonly<Record<OrganizationMembershipRole, readonly string[]>> = Object.freeze({
  OWNER: ['*'],
  ADMIN: ['project:read', 'project:create', 'project:update', 'project:delete', 'service:create', 'service:update', 'deploy:run', 'env:write', 'env:read', 'db:create', 'db:delete', 'db:schema:read', 'backup:manage', 'team:invite', 'audit:read', 'billing:read', 'logs:read', 'metrics:read', 'domain:read', 'domain:verify', 'domain:manage'],
  MAINTAINER: ['project:read', 'project:update', 'service:create', 'service:update', 'deploy:run', 'env:write', 'env:read', 'db:connect', 'db:schema:read', 'db:data:read', 'logs:read', 'metrics:read', 'domain:read', 'domain:verify'],
  DEVELOPER: ['project:read', 'deploy:run', 'logs:read', 'metrics:read', 'env:write-limited', 'db:schema:read', 'domain:read'],
  DB_ADMIN: ['project:read', 'db:create', 'db:delete', 'db:connect', 'db:schema:read', 'db:data:read', 'db:query', 'db:query:write', 'backup:manage', 'backup:restore', 'domain:read'],
  VIEWER: ['project:read', 'logs:read', 'metrics:read', 'domain:read'],
});

export type MembershipRoleTransitionResult =
  | { readonly statusCode: 200; readonly role: OrganizationMembershipRole }
  | { readonly statusCode: 400; readonly code: 'membership_role_invalid' }
  | { readonly statusCode: 403; readonly code: 'membership_role_transition_forbidden' }
  | { readonly statusCode: 409; readonly code: 'membership_last_owner' };

export function normalizeOrganizationRoleForRead(value: unknown): OrganizationMembershipRole | null {
  switch (value) {
    case 'OWNER':
    case 'owner':
      return 'OWNER';
    case 'ADMIN':
    case 'admin':
      return 'ADMIN';
    case 'MAINTAINER':
    case 'maintainer':
      return 'MAINTAINER';
    case 'DEVELOPER':
    case 'developer':
      return 'DEVELOPER';
    case 'DB_ADMIN':
    case 'db_admin':
    case 'db-admin':
      return 'DB_ADMIN';
    case 'VIEWER':
    case 'viewer':
    case 'billing-manager':
    case 'project-owner':
      return 'VIEWER';
    default:
      return null;
  }
}

export function parseOrganizationMembershipRoleForMutation(value: unknown):
  | { readonly ok: true; readonly role: OrganizationMembershipRole }
  | { readonly ok: false; readonly statusCode: 400; readonly code: 'membership_role_invalid' } {
  if (value === 'billing-manager' || value === 'project-owner') {
    return { ok: false, statusCode: 400, code: 'membership_role_invalid' };
  }
  const role = normalizeOrganizationRoleForRead(value);
  return role
    ? { ok: true, role }
    : { ok: false, statusCode: 400, code: 'membership_role_invalid' };
}

export function can(role: unknown, action: string) {
  const normalizedRole = normalizeOrganizationRoleForRead(role);
  if (!normalizedRole) return false;
  const permissions = ROLE_PERMISSIONS[normalizedRole];
  if (action === 'env:write-limited' && permissions.includes('env:write')) return true;
  if (action === 'db:connect-limited' && permissions.includes('db:connect')) return true;
  if (action === 'db:schema:read' && (permissions.includes('db:connect') || permissions.includes('db:data:read'))) return true;
  if (action === 'db:data:read' && permissions.includes('db:connect')) return true;
  if (action === 'db:query:write' && permissions.includes('db:query')) return true;
  return permissions.includes('*')
    || permissions.includes(action)
    || permissions.some((permission) => permission.endsWith(':*') && action.startsWith(permission.slice(0, -1)));
}

export function membershipRoleTransition({ actorRole, targetRole, currentRole, ownerCount }: {
  readonly actorRole: unknown;
  readonly targetRole: unknown;
  readonly currentRole: unknown;
  readonly ownerCount: number;
}): MembershipRoleTransitionResult {
  const next = parseOrganizationMembershipRoleForMutation(targetRole);
  if (next.ok === false) return { statusCode: 400, code: 'membership_role_invalid' };
  const actor = normalizeOrganizationRoleForRead(actorRole);
  const current = normalizeOrganizationRoleForRead(currentRole);
  if (current === 'OWNER' && next.role !== 'OWNER' && ownerCount <= 1) return { statusCode: 409, code: 'membership_last_owner' };
  if (actor === 'OWNER') return { statusCode: 200, role: next.role };
  if (actor === 'ADMIN' && next.role !== 'OWNER' && current !== 'OWNER') return { statusCode: 200, role: next.role };
  return { statusCode: 403, code: 'membership_role_transition_forbidden' };
}

export function assertCan(role: unknown, action: string) {
  if (!can(role, action)) {
    throw new RolePermissionError(String(role), action);
  }
  return true;
}

export function visibleEnvironment(environment: Readonly<Record<string, unknown>> = {}, role: unknown = 'VIEWER') {
  if (can(role, 'env:read')) return { ...environment };
  if (can(role, 'env:write-limited') || can(role, 'db:schema:read')) {
    return Object.fromEntries(Object.keys(environment).map((key) => [key, '<restricted>']));
  }
  return {};
}

class RolePermissionError extends Error {
  readonly statusCode = 403;

  constructor(role: string, action: string) {
    super(`role ${role} cannot perform ${action}`);
    this.name = 'RolePermissionError';
  }
}
