import crypto from 'node:crypto';

export type OAuthTransactionErrorCode = 'oauth_transaction_invalid' | 'oauth_transaction_missing' | 'oauth_transaction_exists' | 'oauth_transaction_expired' | 'oauth_transaction_mismatch' | 'oauth_transaction_replayed';
export class OAuthTransactionError extends Error {
  readonly name = 'OAuthTransactionError';
  readonly code: OAuthTransactionErrorCode;
  readonly statusCode: number;
  constructor(code: OAuthTransactionErrorCode) {
    super(code);
    this.code = code;
    this.statusCode = code === 'oauth_transaction_replayed' || code === 'oauth_transaction_exists' ? 409 : 400;
  }
}

export type OAuthBindingInput = {
  readonly state: string;
  readonly source: string;
  readonly sourceSecret: string;
  readonly redirectUri: string;
  readonly now?: number;
};
export type CreateOAuthTransactionInput = OAuthBindingInput & { readonly codeChallenge: string; readonly ttlMs?: number };
export type ConsumeOAuthTransactionInput = OAuthBindingInput & { readonly codeVerifier: string };
export type OAuthCleanupInput = { readonly now?: number; readonly limit?: number };
export type OAuthTransactionRecord = {
  readonly id: string;
  readonly stateHash: string;
  readonly sourceHash: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly consumedAt: number | null;
  readonly failureCode: string | null;
  readonly failedAt: number | null;
};
type OAuthBinding = Pick<OAuthTransactionRecord, 'stateHash' | 'sourceHash' | 'redirectUri'> & { readonly now: number };
export type OAuthConsumeBinding = OAuthBinding & { readonly codeChallenge: string };

function timestamp(value: number = Date.now()): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000 - 600_000) throw new OAuthTransactionError('oauth_transaction_invalid');
  return value;
}

function binding(input: OAuthBindingInput): OAuthBinding {
  if (typeof input.state !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(input.state)
    || typeof input.source !== 'string' || input.source.length < 1 || input.source.length > 512
    || typeof input.sourceSecret !== 'string' || input.sourceSecret.length < 32 || input.sourceSecret.length > 512
    || typeof input.redirectUri !== 'string' || input.redirectUri.length > 2048) throw new OAuthTransactionError('oauth_transaction_invalid');
  let redirect: URL;
  try { redirect = new URL(input.redirectUri); }
  catch (error) { if (error instanceof TypeError) throw new OAuthTransactionError('oauth_transaction_invalid'); throw error; }
  if ((redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname)))
    || redirect.username || redirect.password || redirect.hash || redirect.search) throw new OAuthTransactionError('oauth_transaction_invalid');
  return {
    stateHash: crypto.createHash('sha256').update(input.state).digest('hex'),
    sourceHash: crypto.createHmac('sha256', input.sourceSecret).update('oauth-source\0').update(input.source).digest('hex'),
    redirectUri: input.redirectUri, now: timestamp(input.now),
  };
}

export function newOAuthTransaction(input: CreateOAuthTransactionInput): OAuthTransactionRecord {
  const parsed = binding(input);
  const ttlMs = input.ttlMs ?? 600_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 600_000
    || typeof input.codeChallenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)
    || Buffer.from(input.codeChallenge, 'base64url').toString('base64url') !== input.codeChallenge) throw new OAuthTransactionError('oauth_transaction_invalid');
  return { id: crypto.randomUUID(), stateHash: parsed.stateHash, sourceHash: parsed.sourceHash, redirectUri: parsed.redirectUri,
    codeChallenge: input.codeChallenge, createdAt: parsed.now, expiresAt: parsed.now + ttlMs, consumedAt: null, failureCode: null, failedAt: null };
}

export function parseOAuthConsume(input: ConsumeOAuthTransactionInput): OAuthConsumeBinding {
  const parsed = binding(input);
  if (typeof input.codeVerifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)) throw new OAuthTransactionError('oauth_transaction_invalid');
  return { ...parsed, codeChallenge: crypto.createHash('sha256').update(input.codeVerifier).digest('base64url') };
}

export function oauthConsumeFailure(row: OAuthTransactionRecord | undefined, input: OAuthConsumeBinding): OAuthTransactionErrorCode | null {
  if (!row) return 'oauth_transaction_missing';
  if (row.consumedAt !== null) return 'oauth_transaction_replayed';
  if (row.expiresAt <= input.now) return 'oauth_transaction_expired';
  if (row.createdAt > input.now || row.redirectUri !== input.redirectUri
    || !sameDigest(row.sourceHash, input.sourceHash) || !sameDigest(row.codeChallenge, input.codeChallenge)) return 'oauth_transaction_mismatch';
  return null;
}

function sameDigest(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function parseOAuthCleanup(input: OAuthCleanupInput): { readonly now: number; readonly limit: number } {
  const limit = input.limit ?? 256;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new OAuthTransactionError('oauth_transaction_invalid');
  return { now: timestamp(input.now), limit };
}

export function createMemoryOAuthTransaction(rows: Map<string, OAuthTransactionRecord>, input: CreateOAuthTransactionInput): OAuthTransactionRecord {
  const row = newOAuthTransaction(input);
  if (rows.has(row.stateHash)) throw new OAuthTransactionError('oauth_transaction_exists');
  rows.set(row.stateHash, row);
  return { ...row };
}

export function consumeMemoryOAuthTransaction(rows: Map<string, OAuthTransactionRecord>, input: ConsumeOAuthTransactionInput): OAuthTransactionRecord {
  const parsed = parseOAuthConsume(input);
  const row = rows.get(parsed.stateHash);
  const failure = oauthConsumeFailure(row, parsed);
  if (failure) {
    if (row && failure === 'oauth_transaction_mismatch') rows.set(row.stateHash, { ...row, failureCode: failure, failedAt: parsed.now });
    throw new OAuthTransactionError(failure);
  }
  if (!row) throw new OAuthTransactionError('oauth_transaction_missing');
  const consumed = { ...row, consumedAt: parsed.now };
  rows.set(row.stateHash, consumed);
  return { ...consumed };
}

export function deleteMemoryOAuthTransactions(rows: Map<string, OAuthTransactionRecord>, input: OAuthCleanupInput): number {
  const parsed = parseOAuthCleanup(input);
  const expired = [...rows.values()].filter((row) => row.expiresAt <= parsed.now)
    .sort((a, b) => a.expiresAt - b.expiresAt || a.id.localeCompare(b.id)).slice(0, parsed.limit);
  for (const row of expired) rows.delete(row.stateHash);
  return expired.length;
}
