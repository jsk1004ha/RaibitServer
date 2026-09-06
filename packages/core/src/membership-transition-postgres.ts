import type { Prisma, PrismaClient } from '@prisma/client';
import { MembershipTransitionError, requireMembershipRemovalAuthority, requireMembershipTransitionAuthority, type OrganizationMemberRecord } from './membership-transition.ts';
import { normalizeOrganizationRoleForRead, type OrganizationMembershipRole } from './rbac.ts';

type DbMember = {
  readonly id: string; readonly organizationId: string; readonly userId: string; readonly role: string;
  readonly version: number; readonly createdAt: Date; readonly email: string; readonly name: string | null; readonly avatarUrl: string | null;
};
type DbActor = { readonly id: string; readonly role: string };
type DbInviteRole = { readonly role: string };

export class PostgresMembershipTransitionRepository {
  private readonly prisma: PrismaClient;
  constructor(prisma: PrismaClient) { this.prisma = prisma; }

  async listOrganizationMembers(input: { readonly organizationId: string; readonly actorUserId: string }): Promise<readonly OrganizationMemberRecord[]> {
    const members = await this.prisma.$queryRawUnsafe<DbMember[]>(
      `SELECT m."id",m."organizationId",m."userId",m."role",m."version",m."createdAt",u."email",u."name",u."avatarUrl"
       FROM "Membership" m JOIN "User" u ON u."id"=m."userId" WHERE m."organizationId"=$1
       AND EXISTS (SELECT 1 FROM "Membership" actor WHERE actor."organizationId"=$1 AND actor."userId"=$2)
       ORDER BY m."createdAt",m."id"`, input.organizationId, input.actorUserId,
    );
    if (!members[0]) throw new MembershipTransitionError('MEMBERSHIP_NOT_FOUND', 404);
    return members.map(dbMemberView);
  }

  async changeOrganizationMembershipRole(input: { readonly organizationId: string; readonly membershipId: string; readonly actorUserId: string; readonly role: OrganizationMembershipRole; readonly expectedVersion: number }): Promise<OrganizationMemberRecord> {
    return this.prisma.$transaction(async transaction => {
      await lockOrganization(transaction, input.organizationId);
      const actor = await findActor(transaction, input.organizationId, input.actorUserId);
      const target = await findMember(transaction, input.organizationId, input.membershipId);
      const actorRole = canonicalRole(actor.role);
      const currentRole = canonicalRole(target.role);
      requireMembershipTransitionAuthority(actorRole, currentRole, input.role);
      if (target.version !== input.expectedVersion) throw new MembershipTransitionError('STALE_MEMBERSHIP', 409);
      if (currentRole === input.role) return dbMemberView(target);
      if (currentRole === 'OWNER' && input.role !== 'OWNER' && await ownerCount(transaction, input.organizationId) <= 1) throw new MembershipTransitionError('LAST_OWNER', 409);
      const rows = await transaction.$queryRawUnsafe<DbMember[]>(
        `UPDATE "Membership" SET "role"=$2,"version"="version"+1 WHERE "id"=$1 AND "version"=$3
         RETURNING "id","organizationId","userId","role","version","createdAt",$4::text AS "email",$5::text AS "name",$6::text AS "avatarUrl"`,
        target.id, input.role, input.expectedVersion, target.email, target.name, target.avatarUrl,
      );
      const membership = rows[0];
      if (!membership) throw new MembershipTransitionError('STALE_MEMBERSHIP', 409);
      await transaction.user.update({ where: { id: target.userId }, data: { sessionVersion: { increment: 1 } } });
      await transaction.auditLog.create({ data: { actorUserId: input.actorUserId, action: 'organization.member:role-change', targetType: 'membership', targetId: target.id, metadata: { organizationId: input.organizationId, role: input.role, version: membership.version } } });
      return dbMemberView(membership);
    }, await readCommittedTransaction());
  }

  async removeOrganizationMember(input: { readonly organizationId: string; readonly membershipId: string; readonly actorUserId: string; readonly expectedVersion: number }): Promise<void> {
    return this.prisma.$transaction(async transaction => {
      await lockOrganization(transaction, input.organizationId);
      const actor = await findActor(transaction, input.organizationId, input.actorUserId);
      const target = await findMember(transaction, input.organizationId, input.membershipId);
      const targetRole = canonicalRole(target.role);
      requireMembershipRemovalAuthority(canonicalRole(actor.role), targetRole);
      if (target.version !== input.expectedVersion) throw new MembershipTransitionError('STALE_MEMBERSHIP', 409);
      if (targetRole === 'OWNER' && await ownerCount(transaction, input.organizationId) <= 1) throw new MembershipTransitionError('LAST_OWNER', 409);
      const removed = await transaction.$executeRawUnsafe('DELETE FROM "Membership" WHERE "id"=$1 AND "version"=$2', target.id, input.expectedVersion);
      if (removed !== 1) throw new MembershipTransitionError('STALE_MEMBERSHIP', 409);
      await transaction.user.update({ where: { id: target.userId }, data: { sessionVersion: { increment: 1 } } });
      await transaction.auditLog.create({ data: { actorUserId: input.actorUserId, action: 'organization.member:remove', targetType: 'membership', targetId: target.id, metadata: { organizationId: input.organizationId, role: targetRole } } });
    }, await readCommittedTransaction());
  }

  async leaveOrganization(input: { readonly organizationId: string; readonly actorUserId: string; readonly expectedVersion: number }): Promise<void> {
    return this.prisma.$transaction(async transaction => {
      await lockOrganization(transaction, input.organizationId);
      const target = await findActorMember(transaction, input.organizationId, input.actorUserId);
      const targetRole = canonicalRole(target.role);
      if (target.version !== input.expectedVersion) throw new MembershipTransitionError('STALE_MEMBERSHIP', 409);
      if (targetRole === 'OWNER' && await ownerCount(transaction, input.organizationId) <= 1) throw new MembershipTransitionError('LAST_OWNER', 409);
      const removed = await transaction.$executeRawUnsafe('DELETE FROM "Membership" WHERE "id"=$1 AND "version"=$2', target.id, input.expectedVersion);
      if (removed !== 1) throw new MembershipTransitionError('STALE_MEMBERSHIP', 409);
      await transaction.user.update({ where: { id: input.actorUserId }, data: { sessionVersion: { increment: 1 } } });
      await transaction.auditLog.create({ data: { actorUserId: input.actorUserId, action: 'organization.member:leave', targetType: 'membership', targetId: target.id, metadata: { organizationId: input.organizationId } } });
    }, await readCommittedTransaction());
  }

  async revokeOrganizationInvite(input: { readonly organizationId: string; readonly inviteId: string; readonly actorUserId: string; readonly now: string }): Promise<void> {
    return this.prisma.$transaction(async transaction => {
      await lockOrganization(transaction, input.organizationId);
      const actor = await findActor(transaction, input.organizationId, input.actorUserId);
      const invites = await transaction.$queryRawUnsafe<DbInviteRole[]>('SELECT "role" FROM "OrganizationInvite" WHERE "id"=$1 AND "organizationId"=$2 AND "acceptedAt" IS NULL AND "revokedAt" IS NULL', input.inviteId, input.organizationId);
      const invite = invites[0];
      if (!invite) throw new MembershipTransitionError('INVITE_NOT_FOUND', 404);
      const inviteRole = canonicalRole(invite.role);
      requireMembershipRemovalAuthority(canonicalRole(actor.role), inviteRole);
      await transaction.$executeRawUnsafe('UPDATE "OrganizationInvite" SET "revokedAt"=$2 WHERE "id"=$1', input.inviteId, new Date(input.now));
      await transaction.auditLog.create({ data: { actorUserId: input.actorUserId, action: 'organization.invite:revoked', targetType: 'organization-invite', targetId: input.inviteId, metadata: { organizationId: input.organizationId, role: inviteRole } } });
    }, await readCommittedTransaction());
  }
}

async function lockOrganization(transaction: Prisma.TransactionClient, organizationId: string): Promise<void> {
  const rows = await transaction.$queryRawUnsafe<Array<{ readonly id: string }>>('SELECT "id" FROM "Organization" WHERE "id"=$1 FOR UPDATE', organizationId);
  if (!rows[0]) throw new MembershipTransitionError('MEMBERSHIP_NOT_FOUND', 404);
}

async function findActor(transaction: Prisma.TransactionClient, organizationId: string, userId: string): Promise<DbActor> {
  const rows = await transaction.$queryRawUnsafe<DbActor[]>('SELECT "id","role" FROM "Membership" WHERE "organizationId"=$1 AND "userId"=$2', organizationId, userId);
  const actor = rows[0];
  if (!actor) throw new MembershipTransitionError('MEMBERSHIP_NOT_FOUND', 404);
  return actor;
}

async function findActorMember(transaction: Prisma.TransactionClient, organizationId: string, userId: string): Promise<DbMember> {
  const rows = await transaction.$queryRawUnsafe<DbMember[]>(
    `SELECT m."id",m."organizationId",m."userId",m."role",m."version",m."createdAt",u."email",u."name",u."avatarUrl"
     FROM "Membership" m JOIN "User" u ON u."id"=m."userId" WHERE m."organizationId"=$1 AND m."userId"=$2`, organizationId, userId,
  );
  const membership = rows[0];
  if (!membership) throw new MembershipTransitionError('MEMBERSHIP_NOT_FOUND', 404);
  return membership;
}

async function findMember(transaction: Prisma.TransactionClient, organizationId: string, membershipId: string): Promise<DbMember> {
  const rows = await transaction.$queryRawUnsafe<DbMember[]>(
    `SELECT m."id",m."organizationId",m."userId",m."role",m."version",m."createdAt",u."email",u."name",u."avatarUrl"
     FROM "Membership" m JOIN "User" u ON u."id"=m."userId" WHERE m."organizationId"=$1 AND m."id"=$2`, organizationId, membershipId,
  );
  const membership = rows[0];
  if (!membership) throw new MembershipTransitionError('MEMBERSHIP_NOT_FOUND', 404);
  return membership;
}

function dbMemberView(row: DbMember): OrganizationMemberRecord {
  return { id: row.id, organizationId: row.organizationId, userId: row.userId, role: canonicalRole(row.role), version: row.version, createdAt: row.createdAt.toISOString(), user: { id: row.userId, email: row.email, name: row.name, avatarUrl: row.avatarUrl } };
}

function canonicalRole(value: unknown): OrganizationMembershipRole {
  const role = normalizeOrganizationRoleForRead(value);
  if (!role) throw new MembershipTransitionError('MEMBERSHIP_NOT_FOUND', 404);
  return role;
}

function ownerCount(transaction: Prisma.TransactionClient, organizationId: string): Promise<number> {
  return transaction.membership.count({ where: { organizationId, role: { in: ['OWNER', 'owner'] } } });
}

async function readCommittedTransaction() {
  const { Prisma } = await import('@prisma/client');
  return { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted };
}
