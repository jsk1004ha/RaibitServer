import { OrganizationInviteError, type OrganizationInviteAcceptance, type OrganizationInviteRecord, type ReplaceOrganizationInviteInput } from './organization-invite.ts';
import { normalizeOrganizationRoleForRead } from './rbac.ts';

type MemoryUser = { readonly id: string; readonly email: string; emailVerifiedAt?: string | null; sessionVersion?: number };
type MemoryMembership = { readonly organizationId: string; readonly userId: string; readonly role: string; readonly createdAt?: string };

export interface OrganizationInviteMemoryState {
  readonly organizations: Map<string, object>;
  readonly users: Map<string, MemoryUser>;
  readonly members: MemoryMembership[];
  readonly organizationInvites: OrganizationInviteRecord[];
  audit(actorUserId: string, action: string, targetType: string, targetId: string, metadata?: Readonly<Record<string, unknown>>): unknown;
}

export function replaceMemoryOrganizationInvite(state: OrganizationInviteMemoryState, input: ReplaceOrganizationInviteInput): OrganizationInviteRecord {
  requireInviter(state, input.organizationId, input.invitedByUserId, input.role);
  const versions = state.organizationInvites.filter(row => row.organizationId === input.organizationId && row.email === input.email).map(row => row.tokenVersion);
  const tokenVersion = (versions.length ? Math.max(...versions) : 0) + 1;
  for (let index = 0; index < state.organizationInvites.length; index += 1) {
    const row = state.organizationInvites[index];
    if (row?.organizationId === input.organizationId && row.email === input.email && !row.acceptedAt && !row.revokedAt) {
      state.organizationInvites[index] = { ...row, revokedAt: input.createdAt };
    }
  }
  const invite: OrganizationInviteRecord = { ...input, tokenVersion, acceptedAt: null, revokedAt: null };
  state.organizationInvites.push(invite);
  state.audit(input.invitedByUserId, 'organization.invite:created', 'organization-invite', input.id, { organizationId: input.organizationId, role: input.role, tokenVersion });
  return structuredClone(invite);
}

export function revokeMemoryOrganizationInviteAfterDeliveryFailure(state: OrganizationInviteMemoryState, id: string, revokedAt: string): void {
  const index = state.organizationInvites.findIndex(row => row.id === id && !row.acceptedAt && !row.revokedAt);
  const invite = state.organizationInvites[index];
  if (!invite) return;
  state.organizationInvites[index] = { ...invite, revokedAt };
  state.audit(invite.invitedByUserId, 'organization.invite:delivery-failed', 'organization-invite', id, { organizationId: invite.organizationId });
}

export function acceptMemoryOrganizationInvite(state: OrganizationInviteMemoryState, input: { readonly tokenHash: string; readonly userId: string; readonly now: string }): OrganizationInviteAcceptance | null {
  const index = state.organizationInvites.findIndex(row => row.tokenHash === input.tokenHash && !row.acceptedAt && !row.revokedAt && row.expiresAt > input.now);
  const invite = state.organizationInvites[index];
  const user = state.users.get(input.userId);
  if (!invite || !user?.emailVerifiedAt || user.email !== invite.email) return null;
  state.organizationInvites[index] = { ...invite, acceptedAt: input.now };
  const existing = state.members.find(row => row.organizationId === invite.organizationId && row.userId === input.userId);
  if (existing) {
    state.audit(input.userId, 'organization.invite:accepted-existing-member', 'organization-invite', invite.id, { organizationId: invite.organizationId });
    return { status: 'already_member' };
  }
  state.members.push({ organizationId: invite.organizationId, userId: input.userId, role: invite.role, createdAt: input.now });
  state.users.set(input.userId, { ...user, sessionVersion: (user.sessionVersion ?? 0) + 1 });
  state.audit(input.userId, 'organization.invite:accepted', 'organization-invite', invite.id, { organizationId: invite.organizationId, role: invite.role });
  return { status: 'accepted', membership: { organizationId: invite.organizationId, role: invite.role } };
}

export function listMemoryOrganizationInvites(state: OrganizationInviteMemoryState, input: { readonly organizationId: string; readonly actorUserId: string }): readonly OrganizationInviteRecord[] {
  requireInviter(state, input.organizationId, input.actorUserId);
  return structuredClone(state.organizationInvites.filter(row => row.organizationId === input.organizationId));
}

function requireInviter(state: OrganizationInviteMemoryState, organizationId: string, actorUserId: string, targetRole?: string): void {
  if (!state.organizations.has(organizationId)) throw new OrganizationInviteError('organization_invite_forbidden', 403);
  const membership = state.members.find(row => row.organizationId === organizationId && row.userId === actorUserId);
  const actorRole = normalizeOrganizationRoleForRead(membership?.role);
  if ((actorRole !== 'OWNER' && actorRole !== 'ADMIN') || (actorRole === 'ADMIN' && targetRole === 'OWNER')) {
    throw new OrganizationInviteError('organization_invite_forbidden', 403);
  }
}
