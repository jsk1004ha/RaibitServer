import { fetchGitHubOAuthIdentity, githubOAuthLoginPlan } from './github-integration.ts';
import type { CreateOAuthTransactionInput, ConsumeOAuthTransactionInput, OAuthTransactionRecord } from './oauth-transaction.ts';

type OAuthRepository = {
  createOAuthTransaction(input: CreateOAuthTransactionInput): OAuthTransactionRecord | Promise<OAuthTransactionRecord>;
  consumeOAuthTransaction(input: ConsumeOAuthTransactionInput): OAuthTransactionRecord | Promise<OAuthTransactionRecord>;
};
type OAuthContext = {
  readonly source: string;
  readonly jwtSecret: unknown;
  readonly provider?: Readonly<Record<string, unknown>>;
  readonly now?: number;
};
export class GitHubOAuthFlowError extends Error {
  readonly name = 'GitHubOAuthFlowError';
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, statusCode: number = 400) { super(code); this.code = code; this.statusCode = statusCode; }
}

// The compatibility core deliberately uses built-in parsers, not a new runtime
// dependency. The public Zod schemas are checked against these HTTP boundaries.
function query(input: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new GitHubOAuthFlowError('github_oauth_input_invalid');
  if (Object.keys(input).some((key) => !keys.includes(key))) throw new GitHubOAuthFlowError('github_oauth_input_invalid');
  return Object.fromEntries(Object.entries(input));
}

function text(value: unknown, pattern: RegExp, code: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new GitHubOAuthFlowError(code);
  return value;
}

function configuration(context: OAuthContext, input: Readonly<Record<string, unknown>>) {
  const provider = context.provider ?? {};
  const clientId = provider.clientId ?? process.env.GITHUB_CLIENT_ID ?? process.env.RAIBITSERVER_GITHUB_CLIENT_ID;
  const clientSecret = provider.clientSecret ?? process.env.GITHUB_CLIENT_SECRET ?? process.env.RAIBITSERVER_GITHUB_CLIENT_SECRET;
  const redirectUri = provider.redirectUri ?? process.env.RAIBITSERVER_GITHUB_REDIRECT_URI;
  const sourceSecret = process.env.RAIBITSERVER_AUTH_RATE_LIMIT_KEY_SECRET ?? context.jwtSecret;
  if (typeof sourceSecret !== 'string' || sourceSecret.length < 32 || sourceSecret.length > 512
    || typeof clientId !== 'string' || !clientId || typeof clientSecret !== 'string' || !clientSecret
    || typeof redirectUri !== 'string' || !redirectUri) throw new GitHubOAuthFlowError('github_oauth_not_configured', 503);
  if ('redirectUri' in input && input.redirectUri !== redirectUri) throw new GitHubOAuthFlowError('github_oauth_redirect_invalid');
  return { provider: { ...provider, clientId, clientSecret, redirectUri }, binding: {
    source: context.source, sourceSecret, redirectUri, ...(context.now === undefined ? {} : { now: context.now }),
  } };
}

export async function startGitHubOAuth(repository: OAuthRepository, raw: unknown, context: OAuthContext) {
  const input = query(raw, ['codeChallenge', 'redirectUri']);
  const codeChallenge = text(input.codeChallenge, /^[A-Za-z0-9_-]{43}$/, 'github_oauth_challenge_required');
  if (Buffer.from(codeChallenge, 'base64url').toString('base64url') !== codeChallenge) throw new GitHubOAuthFlowError('github_oauth_challenge_invalid');
  const config = configuration(context, input);
  const plan = githubOAuthLoginPlan({ ...config.provider, codeChallenge });
  await repository.createOAuthTransaction({ ...config.binding, state: plan.state, codeChallenge });
  return plan;
}

export async function consumeGitHubOAuthIdentity(repository: OAuthRepository, raw: unknown, context: OAuthContext) {
  const input = query(raw, ['code', 'state', 'codeVerifier', 'redirectUri', 'error', 'error_description', 'error_uri']);
  if ('error' in input) throw new GitHubOAuthFlowError('github_oauth_denied');
  const code = text(input.code, /^[^\u0000-\u0020\u007f]{1,256}$/, 'github_oauth_code_required');
  const state = text(input.state, /^[A-Za-z0-9_-]{32,128}$/, 'github_oauth_state_required');
  const codeVerifier = text(input.codeVerifier, /^[A-Za-z0-9._~-]{43,128}$/, 'github_oauth_verifier_required');
  const config = configuration(context, input);
  await repository.consumeOAuthTransaction({ ...config.binding, state, codeVerifier });
  return fetchGitHubOAuthIdentity({ code, codeVerifier }, config.provider);
}
