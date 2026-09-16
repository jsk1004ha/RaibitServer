export type RecoveryIntent = Readonly<{
  readonly key: string;
  readonly payload: string;
}>;

export type IdempotencyKeyFactory = (prefix: string) => string;

export function resolveRecoveryIntent(
  current: RecoveryIntent,
  payload: string,
  prefix: string,
  createKey: IdempotencyKeyFactory,
): RecoveryIntent {
  return current.payload === payload ? current : { key: createKey(prefix), payload };
}

export function createBrowserIdempotencyKey(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

export function isRecoverableAt(
  status: string,
  recoverable: boolean,
  expiresAt: string | null,
  now: number,
): boolean {
  if (status !== 'READY' || !recoverable) return false;
  if (!expiresAt) return true;
  const expiry = new Date(expiresAt).getTime();
  return Number.isFinite(expiry) && expiry > now;
}
