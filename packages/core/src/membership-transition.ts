import { parseOrganizationMembershipRoleForMutation, type OrganizationMembershipRole } from './rbac.ts';

export type OrganizationMemberRecord = {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly role: OrganizationMembershipRole;
  readonly version: number;
  readonly createdAt: string;
  readonly user: { readonly id: string; readonly email: string; readonly name: string | null; readonly avatarUrl: string | null };
};

export interface MembershipTransitionRepository {
  listOrganizationMembers(input: { readonly organizationId: string; readonly actorUserId: string }): Promise<readonly OrganizationMemberRecord[]> | readonly OrganizationMemberRecord[];
  changeOrganizationMembershipRole(input: { readonly organizationId: string; readonly membershipId: string; readonly actorUserId: string; readonly role: OrganizationMembershipRole; readonly expectedVersion: number }): Promise<OrganizationMemberRecord> | OrganizationMemberRecord;
  removeOrganizationMember(input: { readonly organizationId: string; readonly membershipId: string; readonly actorUserId: string; readonly expectedVersion: number }): Promise<void> | void;
  leaveOrganization(input: { readonly organizationId: string; readonly actorUserId: string; readonly expectedVersion: number }): Promise<void> | void;
  revokeOrganizationInvite(input: { readonly organizationId: string; readonly inviteId: string; readonly actorUserId: string; readonly now: string }): Promise<void> | void;
}

export type MembershipTransitionErrorCode = 'MEMBERSHIP_INPUT_INVALID' | 'MEMBERSHIP_NOT_FOUND' | 'MEMBERSHIP_FORBIDDEN' | 'LAST_OWNER' | 'STALE_MEMBERSHIP' | 'INVITE_NOT_FOUND';

export class MembershipTransitionError extends Error {
  readonly name = 'MembershipTransitionError';
  readonly code: MembershipTransitionErrorCode;
  readonly statusCode: 400 | 403 | 404 | 409;
  constructor(code: MembershipTransitionErrorCode, statusCode: 400 | 403 | 404 | 409) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export async function listOrganizationMembers(repository: MembershipTransitionRepository, input: { readonly organizationId: string; readonly actorUserId: string }) {
  return { members: await repository.listOrganizationMembers(input) };
}

export async function changeOrganizationMembershipRole(repository: MembershipTransitionRepository, input: { readonly organizationId: string; readonly membershipId: string; readonly actorUserId: string; readonly role: unknown; readonly expectedVersion: unknown }) {
  const role = parseOrganizationMembershipRoleForMutation(input.role);
  const expectedVersion = parseExpectedVersion(input.expectedVersion);
  if (!role.ok) throw new MembershipTransitionError('MEMBERSHIP_INPUT_INVALID', 400);
  return { membership: await repository.changeOrganizationMembershipRole({ ...input, role: role.role, expectedVersion }) };
}

export async function removeOrganizationMember(repository: MembershipTransitionRepository, input: { readonly organizationId: string; readonly membershipId: string; readonly actorUserId: string; readonly expectedVersion: unknown }) {
  await repository.removeOrganizationMember({ ...input, expectedVersion: parseExpectedVersion(input.expectedVersion) });
  return { removed: true as const };
}

export async function leaveOrganization(repository: MembershipTransitionRepository, input: { readonly organizationId: string; readonly actorUserId: string; readonly expectedVersion: unknown }) {
  await repository.leaveOrganization({ ...input, expectedVersion: parseExpectedVersion(input.expectedVersion) });
  return { left: true as const };
}

export async function revokeOrganizationInvite(repository: MembershipTransitionRepository, input: { readonly organizationId: string; readonly inviteId: string; readonly actorUserId: string; readonly now?: Date }) {
  await repository.revokeOrganizationInvite({ ...input, now: (input.now ?? new Date()).toISOString() });
  return { revoked: true as const };
}

export function requireMembershipTransitionAuthority(actorRole: OrganizationMembershipRole, currentRole: OrganizationMembershipRole, targetRole: OrganizationMembershipRole): void {
  if (actorRole === 'OWNER') return;
  if (actorRole === 'ADMIN' && currentRole !== 'OWNER' && targetRole !== 'OWNER') return;
  throw new MembershipTransitionError('MEMBERSHIP_FORBIDDEN', 403);
}

export function requireMembershipRemovalAuthority(actorRole: OrganizationMembershipRole, targetRole: OrganizationMembershipRole): void {
  if (actorRole === 'OWNER') return;
  if (actorRole === 'ADMIN' && targetRole !== 'OWNER') return;
  throw new MembershipTransitionError('MEMBERSHIP_FORBIDDEN', 403);
}

function parseExpectedVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new MembershipTransitionError('MEMBERSHIP_INPUT_INVALID', 400);
  return value;
}
