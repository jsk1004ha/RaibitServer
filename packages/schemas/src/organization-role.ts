import { z } from 'zod';
import type { OrganizationMembershipRole as CoreOrganizationMembershipRole } from '../../core/src/rbac.ts';


export const ORGANIZATION_MEMBERSHIP_ROLES = ['OWNER', 'ADMIN', 'MAINTAINER', 'DEVELOPER', 'DB_ADMIN', 'VIEWER'] as const;
export const LEGACY_ORGANIZATION_ROLE_ALIASES = ['billing-manager', 'project-owner'] as const;

export const MembershipRoleMutationSchema = z.enum(ORGANIZATION_MEMBERSHIP_ROLES);
export const MembershipRoleReadSchema = z.enum([
  ...ORGANIZATION_MEMBERSHIP_ROLES,
  'owner', 'admin', 'maintainer', 'developer', 'db-admin', 'db_admin', 'viewer',
  ...LEGACY_ORGANIZATION_ROLE_ALIASES,
]);

export type OrganizationMembershipRole = z.infer<typeof MembershipRoleMutationSchema>;
export type OrganizationMembershipReadRole = z.infer<typeof MembershipRoleReadSchema>;

type MembershipRoleUnionMatchesCore = [OrganizationMembershipRole] extends [CoreOrganizationMembershipRole]
  ? [CoreOrganizationMembershipRole] extends [OrganizationMembershipRole] ? true : never
  : never;
const membershipRoleUnionMatchesCore: MembershipRoleUnionMatchesCore = true;
void membershipRoleUnionMatchesCore;

const RESERVED_ORGANIZATION_ROUTE_SLUGS = new Set([
  'app', 'api', 'admin', 'apps', 'preview', 'console', 'resources', 'logs', 'metrics',
]);
const ORGANIZATION_ROUTE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export type OrganizationRouteSlugResult =
  | { readonly ok: true; readonly statusCode: 200; readonly slug: string }
  | { readonly ok: false; readonly statusCode: 400; readonly code: 'organization_route_slug_invalid' | 'organization_route_slug_reserved' | 'organization_route_slug_too_long' };

export function normalizeOrganizationRoleForRead(value: unknown): OrganizationMembershipRole | null {
  const parsed = MembershipRoleReadSchema.safeParse(value);
  if (!parsed.success) return null;
  switch (parsed.data) {
    case 'billing-manager':
    case 'project-owner':
      return 'VIEWER';
    case 'db-admin':
    case 'db_admin':
    case 'DB_ADMIN':
      return 'DB_ADMIN';
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
    case 'VIEWER':
    case 'viewer':
      return 'VIEWER';
    default:
      return null;
  }
}

export function parseOrganizationMembershipRoleForMutation(value: unknown):
  | { readonly ok: true; readonly role: OrganizationMembershipRole }
  | { readonly ok: false; readonly statusCode: 400; readonly code: 'membership_role_invalid' } {
  const canonical = MembershipRoleMutationSchema.safeParse(value);
  if (canonical.success) return { ok: true, role: canonical.data };
  if (value === 'billing-manager' || value === 'project-owner') {
    return { ok: false, statusCode: 400, code: 'membership_role_invalid' };
  }
  const normalized = normalizeOrganizationRoleForRead(value);
  return normalized
    ? { ok: true, role: normalized }
    : { ok: false, statusCode: 400, code: 'membership_role_invalid' };
}

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

export const OrganizationRouteSlugSchema = z.string().superRefine((value, context) => {
  const result = parseOrganizationRouteSlug(value);
  if (result.ok === false) context.addIssue({ code: 'custom', message: result.code });
});
