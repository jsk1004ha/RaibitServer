import crypto from 'node:crypto';
import { parseGitHubRepository } from './github-integration.ts';

const GITHUB_API_VERSION = '2022-11-28';
const DEFAULT_STATE_TTL_SECONDS = 10 * 60;
const MAX_GITHUB_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_GITHUB_PAGES = 100;
const DEFAULT_GITHUB_REQUEST_TIMEOUT_MS = 15_000;

type FetchLike = typeof fetch;

export type GitHubAppInstallationState = {
  version: 1;
  purpose: 'github-app-install' | 'github-app-authorize';
  userId: string;
  organizationId: string;
  installationId?: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

export type GitHubInstallationRepository = {
  installationId: string;
  githubRepoId: string;
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
};

export function createGitHubAppInstallationPlan(input: Record<string, any>, options: Record<string, any> = {}) {
  const appSlug = requiredGitHubAppSlug(options.appSlug || input.appSlug || process.env.GITHUB_APP_SLUG || process.env.RAIBITSERVER_GITHUB_APP_SLUG);
  const state = signGitHubAppInstallationState({
    userId: input.userId,
    organizationId: input.organizationId,
  }, options);
  const installUrl = new URL(`https://github.com/apps/${appSlug}/installations/new`);
  installUrl.searchParams.set('state', state);
  return {
    provider: 'github',
    configured: true,
    installUrl: installUrl.toString(),
    mode: 'github-app-install',
  };
}

export function createGitHubAppAuthorizationPlan(input: Record<string, any>, options: Record<string, any> = {}) {
  const userId = requiredIdentifier(input.userId, 'github_state_user_required');
  const organizationId = requiredIdentifier(input.organizationId, 'github_state_organization_required');
  verifyGitHubAppInstallationState(input.state, { userId, organizationId, purpose: 'github-app-install' }, options);
  const installationId = requiredNumericIdentifier(input.installationId || input.installation_id, 'github_installation_id_invalid');
  const setupAction = String(input.setupAction || input.setup_action || 'install').trim().toLowerCase();
  if (!['install', 'update'].includes(setupAction)) throw githubAppError('github_setup_action_invalid', 400);
  const clientId = requiredConfiguredIdentifier(options.clientId || process.env.GITHUB_CLIENT_ID || process.env.RAIBITSERVER_GITHUB_CLIENT_ID, 'github_client_id_not_configured');
  const state = signGitHubAppInstallationState({
    userId,
    organizationId,
    installationId,
    purpose: 'github-app-authorize',
  }, options);
  const authorizationUrl = new URL('https://github.com/login/oauth/authorize');
  authorizationUrl.searchParams.set('client_id', clientId);
  authorizationUrl.searchParams.set('state', state);
  const callbackUrl = configuredCallbackUrl(options.callbackUrl || process.env.RAIBITSERVER_GITHUB_CALLBACK_URL, options);
  if (callbackUrl) authorizationUrl.searchParams.set('redirect_uri', callbackUrl);
  return {
    provider: 'github',
    authorizationUrl: authorizationUrl.toString(),
    mode: 'github-app-authorize',
  };
}

export function signGitHubAppInstallationState(input: Record<string, any>, options: Record<string, any> = {}) {
  const secret = githubStateSecret(options);
  const now = finiteTimestamp(options.now, Date.now());
  const ttlSeconds = boundedStateTtl(options.ttlSeconds);
  const userId = requiredIdentifier(input.userId, 'github_state_user_required');
  const organizationId = requiredIdentifier(input.organizationId, 'github_state_organization_required');
  const purpose = input.purpose === 'github-app-authorize' ? 'github-app-authorize' : 'github-app-install';
  const payload: GitHubAppInstallationState = {
    version: 1,
    purpose,
    userId,
    organizationId,
    ...(purpose === 'github-app-authorize'
      ? { installationId: requiredNumericIdentifier(input.installationId, 'github_installation_id_invalid') }
      : {}),
    issuedAt: Math.floor(now / 1000),
    expiresAt: Math.floor(now / 1000) + ttlSeconds,
    nonce: crypto.randomBytes(18).toString('base64url'),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyGitHubAppInstallationState(state: unknown, expected: Record<string, any>, options: Record<string, any> = {}) {
  const value = String(state || '');
  const [encoded, signature, extra] = value.split('.');
  if (!encoded || !signature || extra) throw githubAppError('github_install_state_invalid', 400);
  const expectedSignature = crypto.createHmac('sha256', githubStateSecret(options)).update(encoded).digest();
  let receivedSignature: Uint8Array;
  try {
    receivedSignature = Buffer.from(signature, 'base64url');
  } catch {
    throw githubAppError('github_install_state_invalid', 400);
  }
  if (receivedSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(receivedSignature, expectedSignature)) {
    throw githubAppError('github_install_state_invalid', 400);
  }
  let payload: GitHubAppInstallationState;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw githubAppError('github_install_state_invalid', 400);
  }
  const nowSeconds = Math.floor(finiteTimestamp(options.now, Date.now()) / 1000);
  if (payload.version !== 1 || !['github-app-install', 'github-app-authorize'].includes(payload.purpose) || !payload.nonce || payload.expiresAt <= nowSeconds || payload.issuedAt > nowSeconds + 60) {
    throw githubAppError(payload?.expiresAt <= nowSeconds ? 'github_install_state_expired' : 'github_install_state_invalid', 400);
  }
  if (String(payload.userId) !== String(expected.userId || '') || String(payload.organizationId) !== String(expected.organizationId || '')) {
    throw githubAppError('github_install_state_scope_mismatch', 403);
  }
  if (expected.purpose && payload.purpose !== expected.purpose) throw githubAppError('github_install_state_stage_mismatch', 400);
  if (payload.purpose === 'github-app-authorize' && !/^\d+$/.test(String(payload.installationId || ''))) throw githubAppError('github_install_state_invalid', 400);
  if (expected.installationId && String(payload.installationId) !== String(expected.installationId)) throw githubAppError('github_install_state_scope_mismatch', 403);
  return payload;
}

export async function resolveGitHubAppInstallationSelection(input: Record<string, any>, options: Record<string, any> = {}) {
  const code = requiredIdentifier(input.code, 'github_oauth_code_required');
  const installationId = requiredNumericIdentifier(input.installationId || input.installation_id, 'github_installation_id_invalid');
  const clientId = requiredConfiguredIdentifier(options.clientId || process.env.GITHUB_CLIENT_ID || process.env.RAIBITSERVER_GITHUB_CLIENT_ID, 'github_client_id_not_configured');
  const clientSecret = requiredConfiguredIdentifier(options.clientSecret || process.env.GITHUB_CLIENT_SECRET || process.env.RAIBITSERVER_GITHUB_CLIENT_SECRET, 'github_client_secret_not_configured');
  const fetchImpl: FetchLike = options.fetchImpl || fetch;
  const requestTimeoutMs = boundedRequestTimeout(options.requestTimeoutMs);
  const apiBaseUrl = githubApiBaseUrl(options.apiBaseUrl);
  const oauthTokenUrl = githubOAuthTokenUrl(options.oauthTokenUrl);
  const accessToken = await exchangeGitHubOAuthCode({ code, clientId, clientSecret, fetchImpl, requestTimeoutMs, oauthTokenUrl });
  try {
    const installation = await findUserInstallation({ installationId, accessToken, fetchImpl, requestTimeoutMs, apiBaseUrl });
    const repositories = await listUserInstallationRepositories({ installationId, accessToken, fetchImpl, requestTimeoutMs, apiBaseUrl });
    return {
      installationId,
      accountLogin: requiredIdentifier(installation.account?.login, 'github_installation_account_invalid'),
      accountType: String(installation.account?.type || 'Organization'),
      repositorySelection: String(installation.repository_selection || 'selected'),
      repositories,
    };
  } finally {
    await revokeGitHubUserToken({ accessToken, clientId, clientSecret, fetchImpl, requestTimeoutMs, apiBaseUrl }).catch(() => undefined);
  }
}

async function exchangeGitHubOAuthCode(input: Record<string, any>) {
  const response = await githubFetch(input.fetchImpl, input.oauthTokenUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'raibitserver-github-app',
    },
    body: new URLSearchParams({ client_id: input.clientId, client_secret: input.clientSecret, code: input.code }),
    redirect: 'error',
  }, input.requestTimeoutMs);
  const payload = await boundedGitHubJson(response);
  if (!response.ok || payload.error || !payload.access_token) throw githubAppError('github_oauth_exchange_failed', 502);
  return requiredIdentifier(payload.access_token, 'github_oauth_exchange_failed');
}

async function findUserInstallation(input: Record<string, any>) {
  for (let page = 1; page <= MAX_GITHUB_PAGES; page += 1) {
    const url = new URL('/user/installations', input.apiBaseUrl);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    const response = await githubUserRequest(url, input.accessToken, input.fetchImpl, input.requestTimeoutMs);
    const payload = await boundedGitHubJson(response);
    if (!response.ok) throw githubAppError('github_installation_lookup_failed', response.status === 401 ? 401 : 502);
    const installations = Array.isArray(payload.installations) ? payload.installations : [];
    const match = installations.find((candidate: Record<string, any>) => String(candidate.id) === input.installationId);
    if (match) return match;
    if (installations.length < 100) break;
  }
  throw githubAppError('github_installation_not_accessible', 403);
}

async function listUserInstallationRepositories(input: Record<string, any>) {
  const repositories: GitHubInstallationRepository[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= MAX_GITHUB_PAGES; page += 1) {
    const url = new URL(`/user/installations/${encodeURIComponent(input.installationId)}/repositories`, input.apiBaseUrl);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    const response = await githubUserRequest(url, input.accessToken, input.fetchImpl, input.requestTimeoutMs);
    const payload = await boundedGitHubJson(response);
    if (!response.ok) throw githubAppError('github_repository_sync_failed', response.status === 401 ? 401 : 502);
    const rows = Array.isArray(payload.repositories) ? payload.repositories : [];
    for (const row of rows) {
      const githubRepoId = requiredNumericIdentifier(row?.id, 'github_repository_identity_invalid');
      if (seen.has(githubRepoId)) continue;
      const parsed = parseGitHubRepository(row?.full_name || '');
      seen.add(githubRepoId);
      repositories.push({
        installationId: input.installationId,
        githubRepoId,
        fullName: parsed.fullName.toLowerCase(),
        owner: parsed.owner.toLowerCase(),
        name: parsed.repo.toLowerCase(),
        defaultBranch: String(row?.default_branch || 'main'),
        private: row?.private === true,
      });
    }
    if (rows.length < 100) return repositories.sort((left, right) => left.fullName.localeCompare(right.fullName));
  }
  throw githubAppError('github_repository_pagination_limit', 502);
}

async function revokeGitHubUserToken(input: Record<string, any>) {
  const url = new URL(`/applications/${encodeURIComponent(input.clientId)}/token`, input.apiBaseUrl);
  const authorization = Buffer.from(`${input.clientId}:${input.clientSecret}`).toString('base64');
  const response = await githubFetch(input.fetchImpl, url, {
    method: 'DELETE',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Basic ${authorization}`,
      'content-type': 'application/json',
      'user-agent': 'raibitserver-github-app',
      'x-github-api-version': GITHUB_API_VERSION,
    },
    body: JSON.stringify({ access_token: input.accessToken }),
    redirect: 'error',
  }, input.requestTimeoutMs);
  if (response.status !== 204) await boundedGitHubJson(response).catch(() => undefined);
}

function githubUserRequest(url: URL, accessToken: string, fetchImpl: FetchLike, requestTimeoutMs: number) {
  return githubFetch(fetchImpl, url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${accessToken}`,
      'user-agent': 'raibitserver-github-app',
      'x-github-api-version': GITHUB_API_VERSION,
    },
    redirect: 'error',
  }, requestTimeoutMs);
}

async function githubFetch(fetchImpl: FetchLike, resource: URL | string, init: RequestInit, timeoutMs: number) {
  try {
    return await fetchImpl(resource, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw githubAppError('github_request_failed', 502);
  }
}

async function boundedGitHubJson(response: Response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_GITHUB_RESPONSE_BYTES) throw githubAppError('github_response_too_large', 502);
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_GITHUB_RESPONSE_BYTES) throw githubAppError('github_response_too_large', 502);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw githubAppError('github_response_invalid', 502);
  }
}

function githubStateSecret(options: Record<string, any>) {
  const secret = String(options.stateSecret || process.env.RAIBITSERVER_GITHUB_STATE_SECRET || process.env.RAIBITSERVER_AUTH_JWT_SECRET || '');
  if (Buffer.byteLength(secret) < 32) throw githubAppError('github_state_secret_not_configured', 503);
  return secret;
}

function githubApiBaseUrl(value: unknown) {
  const url = new URL(String(value || 'https://api.github.com'));
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw githubAppError('github_api_url_invalid', 500);
  return url.toString().replace(/\/$/, '');
}

function githubOAuthTokenUrl(value: unknown) {
  const url = new URL(String(value || 'https://github.com/login/oauth/access_token'));
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw githubAppError('github_oauth_url_invalid', 500);
  return url.toString();
}

function configuredCallbackUrl(value: unknown, options: Record<string, any> = {}) {
  if (!value) return '';
  const url = new URL(String(value));
  const production = options.production === undefined ? process.env.NODE_ENV === 'production' : options.production === true;
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  const allowedProtocol = url.protocol === 'https:' || (!production && url.protocol === 'http:' && loopback);
  if (!allowedProtocol || url.username || url.password || url.search || url.hash) throw githubAppError('github_callback_url_invalid', 500);
  return url.toString();
}

function requiredGitHubAppSlug(value: unknown) {
  const slug = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(slug)) throw githubAppError('github_app_slug_not_configured', 503);
  return slug;
}

function requiredNumericIdentifier(value: unknown, code: string) {
  const normalized = String(value || '').trim();
  if (!/^\d+$/.test(normalized)) throw githubAppError(code, 400);
  return normalized;
}

function requiredIdentifier(value: unknown, code: string) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 512 || /[\r\n\0]/.test(normalized)) throw githubAppError(code, 400);
  return normalized;
}

function requiredConfiguredIdentifier(value: unknown, code: string) {
  try {
    return requiredIdentifier(value, code);
  } catch {
    throw githubAppError(code, 503);
  }
}

function boundedStateTtl(value: unknown) {
  const ttl = Number(value || DEFAULT_STATE_TTL_SECONDS);
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 30 * 60) throw githubAppError('github_state_ttl_invalid', 500);
  return ttl;
}

function boundedRequestTimeout(value: unknown) {
  const timeout = value === undefined ? DEFAULT_GITHUB_REQUEST_TIMEOUT_MS : Number(value);
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 30_000) throw githubAppError('github_request_timeout_invalid', 500);
  return timeout;
}

function finiteTimestamp(value: unknown, fallback: number) {
  const timestamp = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(timestamp)) throw githubAppError('github_time_invalid', 500);
  return timestamp;
}

function githubAppError(code: string, statusCode: number) {
  const error = new Error(code) as Error & { statusCode: number; code: string };
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
