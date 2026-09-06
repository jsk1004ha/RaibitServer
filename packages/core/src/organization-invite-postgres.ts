import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { OrganizationInviteError, type OrganizationInviteAcceptance, type OrganizationInviteRecord, type ReplaceOrganizationInviteInput } from './organization-invite.ts';
import { normalizeOrganizationRoleForRead } from './rbac.ts';

type DbInvite = {
  readonly id: string; readonly organizationId: string; readonly email: string; readonly role: string;
  readonly tokenHash: string; readonly tokenVersion: number; readonly invitedByUserId: string;
  readonly expiresAt: Date; readonly acceptedAt: Date | null; readonly revokedAt: Date | null; readonly createdAt: Date;
};

export class PostgresOrganizationInviteRepository {
  private readonly prisma: PrismaClient;
  constructor(prisma: PrismaClient) { this.prisma = prisma; }

  replaceOrganizationInvite(input: ReplaceOrganizationInviteInput): Promise<OrganizationInviteRecord> {
    return this.prisma.$transaction(async transaction => {
      const actor = await transaction.membership.findUnique({ where: { organizationId_userId: { organizationId: input.organizationId, userId: input.invitedByUserId } }, select: { role: true } });
      const actorRole = normalizeOrganizationRoleForRead(actor?.role);
      if ((actorRole !== 'OWNER' && actorRole !== 'ADMIN') || (actorRole === 'ADMIN' && input.role === 'OWNER')) {
        throw new OrganizationInviteError('organization_invite_forbidden', 403);
      }
      await transaction.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', JSON.stringify([input.organizationId, input.email]));
      await transaction.$executeRawUnsafe(
        'UPDATE "OrganizationInvite" SET "revokedAt"=$3 WHERE "organizationId"=$1 AND "email"=$2 AND "acceptedAt" IS NULL AND "revokedAt" IS NULL',
        input.organizationId, input.email, new Date(input.createdAt),
      );
      const rows = await transaction.$queryRawUnsafe<DbInvite[]>(
        `INSERT INTO "OrganizationInvite" ("id","organizationId","email","role","tokenHash","tokenVersion","invitedByUserId","expiresAt","createdAt")
         VALUES ($1,$2,$3,$4,$5,COALESCE((SELECT MAX("tokenVersion") FROM "OrganizationInvite" WHERE "organizationId"=$2 AND "email"=$3),0)+1,$6,$7,$8)
         RETURNING *`,
        input.id, input.organizationId, input.email, input.role, input.tokenHash, input.invitedByUserId, new Date(input.expiresAt), new Date(input.createdAt),
      );
      const invite = rows[0];
      if (!invite) throw new TypeError('Organization invite insert returned no row');
      await transaction.auditLog.create({ data: { actorUserId: input.invitedByUserId, action: 'organization.invite:created', targetType: 'organization-invite', targetId: invite.id, metadata: { organizationId: input.organizationId, role: input.role, tokenVersion: invite.tokenVersion } } });
      return normalizeDbInvite(invite);
    });
  }

  async revokeOrganizationInviteAfterDeliveryFailure(id: string, revokedAt: string): Promise<void> {
    await this.prisma.$transaction(async transaction => {
      const rows = await transaction.$queryRawUnsafe<Pick<DbInvite, 'organizationId' | 'invitedByUserId'>[]>(
        'UPDATE "OrganizationInvite" SET "revokedAt"=$2 WHERE "id"=$1 AND "acceptedAt" IS NULL AND "revokedAt" IS NULL RETURNING "organizationId","invitedByUserId"', id, new Date(revokedAt),
      );
      const invite = rows[0];
      if (invite) await transaction.auditLog.create({ data: { actorUserId: invite.invitedByUserId, action: 'organization.invite:delivery-failed', targetType: 'organization-invite', targetId: id, metadata: { organizationId: invite.organizationId } } });
    });
  }

  async acceptOrganizationInvite(input: { readonly tokenHash: string; readonly userId: string; readonly now: string }): Promise<OrganizationInviteAcceptance | null> {
    return this.prisma.$transaction(async transaction => {
      const invites = await transaction.$queryRawUnsafe<DbInvite[]>(
        'SELECT * FROM "OrganizationInvite" WHERE "tokenHash"=$1 FOR UPDATE', input.tokenHash,
      );
      const invite = invites[0];
      const now = new Date(input.now);
      if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt <= now) return null;
      const user = await transaction.user.findUnique({ where: { id: input.userId }, select: { email: true, emailVerifiedAt: true } });
      if (!user?.emailVerifiedAt || user.email !== invite.email) return null;
      const claimed = await transaction.$queryRawUnsafe<Pick<DbInvite, 'id'>[]>(
        'UPDATE "OrganizationInvite" SET "acceptedAt"=$2 WHERE "id"=$1 AND "acceptedAt" IS NULL AND "revokedAt" IS NULL AND "expiresAt">$2 RETURNING "id"', invite.id, now,
      );
      if (!claimed[0]) return null;
      const memberships = await transaction.$queryRawUnsafe<Array<{ readonly organizationId: string; readonly role: string }>>(
        `INSERT INTO "Membership" ("id","organizationId","userId","role","createdAt") VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT ("organizationId","userId") DO NOTHING RETURNING "organizationId","role"`,
        crypto.randomUUID(), invite.organizationId, input.userId, invite.role, now,
      );
      const membership = memberships[0];
      if (!membership) {
        await transaction.auditLog.create({ data: { actorUserId: input.userId, action: 'organization.invite:accepted-existing-member', targetType: 'organization-invite', targetId: invite.id, metadata: { organizationId: invite.organizationId } } });
        return { status: 'already_member' };
      }
      const role = normalizeOrganizationRoleForRead(membership.role);
      if (!role) throw new TypeError('Organization invite membership role is invalid');
      await transaction.user.update({ where: { id: input.userId }, data: { sessionVersion: { increment: 1 } } });
      await transaction.auditLog.create({ data: { actorUserId: input.userId, action: 'organization.invite:accepted', targetType: 'organization-invite', targetId: invite.id, metadata: { organizationId: invite.organizationId, role } } });
      return { status: 'accepted', membership: { organizationId: membership.organizationId, role } };
    }, await readCommittedTransaction());
  }

  listOrganizationInvites(input: { readonly organizationId: string; readonly actorUserId: string }): Promise<readonly OrganizationInviteRecord[]> {
    return this.prisma.$transaction(async transaction => {
      const actor = await transaction.membership.findUnique({ where: { organizationId_userId: { organizationId: input.organizationId, userId: input.actorUserId } }, select: { role: true } });
      const role = normalizeOrganizationRoleForRead(actor?.role);
      if (role !== 'OWNER' && role !== 'ADMIN') throw new OrganizationInviteError('organization_invite_forbidden', 403);
      const rows = await transaction.$queryRawUnsafe<DbInvite[]>('SELECT * FROM "OrganizationInvite" WHERE "organizationId"=$1 ORDER BY "createdAt" DESC,"id" DESC', input.organizationId);
      return rows.map(normalizeDbInvite);
    });
  }
}

function normalizeDbInvite(row: DbInvite): OrganizationInviteRecord {
  const role = normalizeOrganizationRoleForRead(row.role);
  if (!role) throw new TypeError('Organization invite role is invalid');
  return { ...row, role, expiresAt: row.expiresAt.toISOString(), acceptedAt: row.acceptedAt?.toISOString() ?? null, revokedAt: row.revokedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString() };
}

async function readCommittedTransaction() {
  const { Prisma } = await import('@prisma/client');
  return { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted };
}
