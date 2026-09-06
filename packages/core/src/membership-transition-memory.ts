import crypto from 'node:crypto';
import { MembershipTransitionError, requireMembershipRemovalAuthority, requireMembershipTransitionAuthority, type OrganizationMemberRecord } from './membership-transition.ts';
import type { OrganizationInviteRecord } from './organization-invite.ts';
import { normalizeOrganizationRoleForRead, type OrganizationMembershipRole } from './rbac.ts';

type MemoryMembership = { readonly organizationId: string; readonly userId: string; role: string; readonly createdAt?: string; version?: number };
type MemoryUser = { readonly id: string; readonly email: string; readonly name?: string | null; readonly avatarUrl?: string | null };

export interface MembershipTransitionMemoryState {
  readonly organizations: Map<string, object>;
  readonly users: Map<string, MemoryUser>;
  readonly members: MemoryMembership[];
  readonly organizationInvites: OrganizationInviteRecord[];
  incrementSessionVersion(userId: string): unknown;
  audit(actorUserId: string, action: string, targetType: string, targetId: string, metadata?: Readonly<Record<string, unknown>>): unknown;
}

export function listMemoryOrganizationMembers(state: MembershipTransitionMemoryState, input: { readonly organizationId: string; readonly actorUserId: string }): readonly OrganizationMemberRecord[] {
  requireOrganizationMember(state, input.organizationId, input.actorUserId);
  return state.members.filter(row => row.organizationId === input.organizationId).map(row => memoryMemberView(state, row));
}

export function changeMemoryOrganizationMembershipRole(state: MembershipTransitionMemoryState, input: { readonly organizationId: string; readonly membershipId: string; readonly actorUserId: string; readonly role: OrganizationMembershipRole; readonly expectedVersion: number }): OrganizationMemberRecord {
  const actor = requireOrganizationMember(state, input.organizationId, input.actorUserId);
  const target = findMemoryMembership(state, input.organizationId, input.membershipId);
  const actorRole = canonicalRole(actor.role);
  const currentRole = canonicalRole(target.role);
  requireMembershipTransitionAuthority(actorRole, currentRole, input.role);
  const version = target.version ?? 1;
  if (version !== input.expectedVersion) throw new MembershipTransitionError('STALE_MEMBERSHIP', 409);
  if (currentRole === input.role) return memoryMemberView(state, target);
  if (currentRole === 'OWNER' && input.role !== 'OWNER' && ownerCount(state, input.organizationId) <= 1) throw new MembershipTransitionError('LAST_OWNER', 409);
  target.role = input.role;
  target.version = version + 1;
  state.incrementSessionVersion(target.userId);
  state.audit(input.actorUserId, 'organization.member:role-change', 'membership', input.membershipId, { organizationId: input.organizationId, role: input.role, version: target.version });
  return memoryMemberView(state, target);
}

export function removeMemoryOrganizationMember(state: MembershipTransitionMemoryState, input: { readonly organizationId: string; readonly membershipId: string; readonly actorUserId: string; readonly expectedVersion: number }): void {
  const actor = requireOrganizationMember(state, input.organizationId, input.actorUserId);
  const index = state.members.findIndex(row => row.organizationId === input.organizationId && memoryMembershipId(row) === input.membershipId);
  const target = state.members[index];
  if (!target) throw new MembershipTransitionError('MEMBERSHIP_NOT_FOUND', 404);
  const actorRole = canonicalRole(actor.role);
  const targetRole = canonicalRole(target.role);
  requireMembershipRemovalAuthority(actorRole, targetRole);
  const version = target.version ?? 1;
  if (version !== input.expectedVersion) throw new MembershipTransitionError('STALE_MEMBERSHIP', 409);
  if (targetRole === 'OWNER' && ownerCount(state, input.organizationId) <= 1) throw new MembershipTransitionError('LAST_OWNER', 409);
  state.members.splice(index, 1);
  state.incrementSessionVersion(target.userId);
  state.audit(input.actorUserId, 'organization.member:remove', 'membership', input.membershipId, { organizationId: input.organizationId, role: targetRole });
}

export function leaveMemoryOrganization(state: MembershipTransitionMemoryState, input: { readonly organizationId: string; readonly actorUserId: string; readonly expectedVersion: number }): void {
  const target = requireOrganizationMember(state, input.organizationId, input.actorUserId);
  const version = target.version ?? 1;
  if (version !== input.expectedVersion) throw new MembershipTransitionError('STALE_MEMBERSHIP', 409);
  if (canonicalRole(target.role) === 'OWNER' && ownerCount(state, input.organizationId) <= 1) throw new MembershipTransitionError('LAST_OWNER', 409);
  const index = state.members.indexOf(target);
  const membershipId = memoryMembershipId(target);
  state.members.splice(index, 1);
  state.incrementSessionVersion(input.actorUserId);
  state.audit(input.actorUserId, 'organization.member:leave', 'membership', membershipId, { organizationId: input.organizationId });
}

export function revokeMemoryOrganizationInvite(state: MembershipTransitionMemoryState, input: { readonly organizationId: string; readonly inviteId: string; readonly actorUserId: string; readonly now: string }): void {
  const actor = requireOrganizationMember(state, input.organizationId, input.actorUserId);
  const index = state.organizationInvites.findIndex(row => row.id === input.inviteId && row.organizationId === input.organizationId && !row.acceptedAt && !row.revokedAt);
  const invite = state.organizationInvites[index];
  if (!invite) throw new MembershipTransitionError('INVITE_NOT_FOUND', 404);
  requireMembershipRemovalAuthority(canonicalRole(actor.role), invite.role);
  state.organizationInvites[index] = { ...invite, revokedAt: input.now };
  state.audit(input.actorUserId, 'organization.invite:revoked', 'organization-invite', input.inviteId, { organizationId: input.organizationId, role: invite.role });
}

function requireOrganizationMember(state: MembershipTransitionMemoryState, organizationId: string, userId: string): MemoryMembership {
  if (!state.organizations.has(organizationId)) throw new MembershipTransitionError('MEMBERSHIP_NOT_FOUND', 404);
  const membership = state.members.find(row => row.organizationId === organizationId && row.userId === userId);
  if (!membership) throw new MembershipTransitionError('MEMBERSHIP_NOT_FOUND', 404);
  return membership;
}

function findMemoryMembership(state: MembershipTransitionMemoryState, organizationId: string, membershipId: string): MemoryMembership {
  const membership = state.members.find(row => row.organizationId === organizationId && memoryMembershipId(row) === membershipId);
  if (!membership) throw new MembershipTransitionError('MEMBERSHIP_NOT_FOUND', 404);
  return membership;
}

function memoryMemberView(state: MembershipTransitionMemoryState, membership: MemoryMembership): OrganizationMemberRecord {
  const user = state.users.get(membership.userId);
  if (!user) throw new MembershipTransitionError('MEMBERSHIP_NOT_FOUND', 404);
  return {
    id: memoryMembershipId(membership), organizationId: membership.organizationId, userId: membership.userId,
    role: canonicalRole(membership.role), version: membership.version ?? 1, createdAt: membership.createdAt ?? new Date(0).toISOString(),
    user: { id: user.id, email: user.email, name: user.name ?? null, avatarUrl: user.avatarUrl ?? null },
  };
}

function memoryMembershipId(membership: Pick<MemoryMembership, 'organizationId' | 'userId'>): string {
  return `mem_${crypto.createHash('sha256').update(`${membership.organizationId}:${membership.userId}`).digest('hex').slice(0, 24)}`;
}

function canonicalRole(value: unknown): OrganizationMembershipRole {
  const role = normalizeOrganizationRoleForRead(value);
  if (!role) throw new MembershipTransitionError('MEMBERSHIP_NOT_FOUND', 404);
  return role;
}

function ownerCount(state: MembershipTransitionMemoryState, organizationId: string): number {
  return state.members.filter(row => row.organizationId === organizationId && normalizeOrganizationRoleForRead(row.role) === 'OWNER').length;
}
