import type { OAuthCleanupInput } from './oauth-transaction.ts';

const failures = {
  github_oauth_input_invalid: [400, 'mismatch'], github_oauth_challenge_required: [400, 'mismatch'],
  github_oauth_challenge_invalid: [400, 'mismatch'], github_oauth_redirect_invalid: [400, 'mismatch'],
  github_oauth_code_required: [400, 'mismatch'], github_oauth_state_required: [400, 'mismatch'],
  github_oauth_verifier_required: [400, 'mismatch'], github_oauth_denied: [400, 'denial'],
  oauth_transaction_invalid: [400, 'mismatch'], oauth_transaction_missing: [400, 'mismatch'],
  oauth_transaction_mismatch: [400, 'mismatch'], oauth_transaction_expired: [400, 'expiry'],
  oauth_transaction_replayed: [409, 'replay'], oauth_transaction_exists: [409, 'mismatch'],
  github_account_not_registered: [403, 'denial'], github_verified_email_required: [403, 'denial'],
  email_not_verified: [403, 'denial'], email_verification_required: [403, 'denial'], account_pending_approval: [403, 'denial'],
  account_not_approved: [403, 'denial'], account_banned: [403, 'denial'], account_rejected: [403, 'denial'],
  github_oauth_exchange_failed: [502, 'exchange_failure'], github_oauth_profile_failed: [502, 'exchange_failure'],
  github_oauth_email_failed: [502, 'exchange_failure'], github_oauth_response_too_large: [502, 'exchange_failure'],
  github_oauth_timeout: [504, 'exchange_failure'], github_oauth_failed: [502, 'exchange_failure'],
  github_oauth_not_configured: [503, 'denial'], github_oauth_audit_unavailable: [503, 'denial'],
  github_oauth_cleanup_unavailable: [503, 'denial'], github_oauth_storage_unavailable: [503, 'denial'],
  rate_limit_exceeded: [429, 'rate_limited'],
} as const;
type OAuthErrorCode = keyof typeof failures;
export type OAuthAction = 'github-oauth-start' | 'github-oauth-callback';
export type OAuthAuditEvent = {
  readonly action: OAuthAction;
  readonly outcome: 'start' | 'success' | (typeof failures)[OAuthErrorCode][1];
  readonly errorCode: OAuthErrorCode | 'none';
  readonly cleanup: 'complete' | 'failed';
};
export type OAuthAuditRepository = {
  deleteExpiredOAuthTransactions(input: OAuthCleanupInput): number | Promise<number>;
  recordOAuthAudit(event: OAuthAuditEvent): unknown;
};
function isErrorCode(value: unknown): value is OAuthErrorCode { return typeof value === 'string' && Object.hasOwn(failures, value); }

export class OAuthPublicError extends Error {
  readonly statusCode: number;
  readonly outcome: OAuthAuditEvent['outcome'];
  readonly retryAfterSeconds: number;
  readonly code: OAuthErrorCode;
  constructor(code: OAuthErrorCode, retryAfter: unknown = 1) {
    super(code);
    this.code = code;
    [this.statusCode, this.outcome] = failures[code];
    const seconds = Number(retryAfter);
    this.retryAfterSeconds = Number.isFinite(seconds) ? Math.min(3600, Math.max(1, Math.ceil(seconds))) : 1;
  }
}

export function publicOAuthError(error: unknown): OAuthPublicError {
  if (error instanceof OAuthPublicError) return error;
  if (error instanceof Error && error.message === 'durable_auth_rate_limiter_not_configured') return new OAuthPublicError('github_oauth_storage_unavailable');
  const code = error instanceof Error && isErrorCode(error.message) ? error.message : 'github_oauth_failed';
  return new OAuthPublicError(code, error instanceof Error && 'retryAfterSeconds' in error ? error.retryAfterSeconds : 1);
}

export function oauthAuditData(event: OAuthAuditEvent) {
  const action = event.action === 'github-oauth-start' ? 'github-oauth-start' : 'github-oauth-callback';
  const errorCode = isErrorCode(event.errorCode) ? event.errorCode : 'none';
  const outcome = errorCode === 'none' ? (action === 'github-oauth-start' ? 'start' : 'success') : failures[errorCode][1];
  return { actorUserId: null, action: `auth.${action}`, targetType: 'auth', targetId: 'github',
    metadata: { outcome, errorCode, cleanup: event.cleanup === 'failed' ? 'failed' : 'complete' } };
}

// One terminal boundary owns classification, cleanup and audit; inner helpers never log.
export async function oauthAttempt<T>(repository: OAuthAuditRepository, action: OAuthAction, work: () => Promise<T>): Promise<T> {
  let result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: OAuthPublicError };
  try {
    if (typeof repository.recordOAuthAudit !== 'function' || typeof repository.deleteExpiredOAuthTransactions !== 'function') throw new OAuthPublicError('github_oauth_storage_unavailable');
    result = { ok: true, value: await work() };
  } catch (error) { result = { ok: false, error: publicOAuthError(error) }; }
  let cleanup: OAuthAuditEvent['cleanup'] = 'complete';
  try { await repository.deleteExpiredOAuthTransactions({ limit: 256 }); }
  catch (error) {
    cleanup = 'failed';
    if (result.ok) result = { ok: false, error: new OAuthPublicError('github_oauth_cleanup_unavailable') };
  }
  let event: OAuthAuditEvent;
  switch (result.ok) {
    case true: event = { action, outcome: action === 'github-oauth-start' ? 'start' : 'success', errorCode: 'none', cleanup }; break;
    case false: event = { action, outcome: result.error.outcome, errorCode: result.error.code, cleanup }; break;
  }
  try { await repository.recordOAuthAudit(event); }
  catch (error) { throw new OAuthPublicError('github_oauth_audit_unavailable'); }
  switch (result.ok) {
    case true: return result.value;
    case false: throw result.error;
  }
}
