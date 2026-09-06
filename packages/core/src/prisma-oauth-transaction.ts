import type { OAuthTransaction, PrismaClient } from '@prisma/client';
import { newOAuthTransaction, OAuthTransactionError, oauthConsumeFailure, parseOAuthCleanup, parseOAuthConsume } from './oauth-transaction.ts';
import type { ConsumeOAuthTransactionInput, CreateOAuthTransactionInput, OAuthCleanupInput, OAuthTransactionRecord } from './oauth-transaction.ts';

function record(row: OAuthTransaction): OAuthTransactionRecord {
  return { ...row, createdAt: row.createdAt.getTime(), expiresAt: row.expiresAt.getTime(), consumedAt: row.consumedAt?.getTime() ?? null, failedAt: row.failedAt?.getTime() ?? null };
}

export async function createPrismaOAuthTransaction(prisma: PrismaClient, input: CreateOAuthTransactionInput): Promise<OAuthTransactionRecord> {
  const row = newOAuthTransaction(input);
  const inserted = await prisma.oAuthTransaction.createMany({
    data: { ...row, createdAt: new Date(row.createdAt), expiresAt: new Date(row.expiresAt), consumedAt: null, failedAt: null },
    skipDuplicates: true,
  });
  if (inserted.count !== 1) throw new OAuthTransactionError('oauth_transaction_exists');
  return row;
}

export async function consumePrismaOAuthTransaction(prisma: PrismaClient, input: ConsumeOAuthTransactionInput): Promise<OAuthTransactionRecord> {
  const parsed = parseOAuthConsume(input);
  const outcome = await prisma.$transaction(async (transaction) => {
    const rows = await transaction.$queryRaw<OAuthTransaction[]>`
      SELECT * FROM "OAuthTransaction" WHERE "stateHash" = ${parsed.stateHash} FOR UPDATE`;
    const row = rows[0] ? record(rows[0]) : undefined;
    const failure = oauthConsumeFailure(row, parsed);
    if (failure) {
      if (row && failure === 'oauth_transaction_mismatch') await transaction.oAuthTransaction.update({ where: { id: row.id }, data: { failureCode: failure, failedAt: new Date(parsed.now) } });
      return new OAuthTransactionError(failure);
    }
    if (!row) return new OAuthTransactionError('oauth_transaction_missing');
    return record(await transaction.oAuthTransaction.update({ where: { id: row.id }, data: { consumedAt: new Date(parsed.now) } }));
  }, { isolationLevel: 'ReadCommitted', maxWait: 30_000, timeout: 30_000 });
  if (outcome instanceof OAuthTransactionError) throw outcome;
  return outcome;
}

export async function deletePrismaOAuthTransactions(prisma: PrismaClient, input: OAuthCleanupInput): Promise<number> {
  const parsed = parseOAuthCleanup(input);
  return prisma.$executeRaw`
    WITH expired AS (
      SELECT "id" FROM "OAuthTransaction" WHERE "expiresAt" <= (${new Date(parsed.now)}::timestamptz AT TIME ZONE 'UTC')
      ORDER BY "expiresAt", "id" LIMIT ${parsed.limit} FOR UPDATE SKIP LOCKED
    ) DELETE FROM "OAuthTransaction" WHERE "id" IN (SELECT "id" FROM expired)`;
}
