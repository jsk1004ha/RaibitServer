import crypto from 'node:crypto';
import { maskSecretValue } from './secrets.ts';

const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_OAUTH_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API_URL = 'https://api.github.com';
const MAX_GITHUB_OAUTH_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_GITHUB_OAUTH_TIMEOUT_MS = 10_000;

type FetchLike = typeof fetch;

export type GitHubOAuthIdentity = Readonly<{
  avatarUrl: string | null;
  email: string;
  githubId: string;
  githubLogin: string;
  name: string;
}>;

export function parseGitHubRepository(input: string | Record<string, any>) {
  const value = typeof input === 'string' ? input : (input.repoUrl || input.repositoryUrl || `${input.owner}/${input.repo}`);
  const text = String(value || '').trim();
  const https = text.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[?#].*)?$/i);
  const ssh = text.match(/^git@github\.com:([^/\s]+)\/([^/\s#?]+?)(?:\.git)?$/i);
  const slug = text.match(/^([^/\s]+)\/([^/\s]+)$/);
  const match = https || ssh || slug;
  if (!match) {
    const error = new Error(`unsupported GitHub repository: ${text}`);
    (error as any).statusCode = 400;
    throw error;
  }
  const owner = match[1];
  const repo = match[2].replace(/\.git$/i, '');
  return { owner, repo, fullName: `${owner}/${repo}`, repoUrl: `https://github.com/${owner}/${repo}.git` };
}

export function githubTokenFingerprint(token: string) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 16);
}

export function githubIntegrationSummary(input: Record<string, any>) {
  return {
    provider: 'github',
    accountLogin: input.accountLogin || input.owner || null,
    installationId: input.installationId || null,
    tokenPreview: input.token ? maskSecretValue(input.token) : input.tokenPreview || null,
    tokenFingerprint: input.token ? githubTokenFingerprint(input.token) : input.tokenFingerprint || null,
    scopes: input.scopes || ['repo:read'],
  };
}

export function githubCloneOptionsFromIntegration(integration: Record<string, any>, repository: string | Record<string, any>, options: Record<string, any> = {}) {
  const repo = parseGitHubRepository(repository);
  return {
    repoUrl: repo.repoUrl,
    branch: options.branch || integration.defaultBranch || 'main',
    token: options.token || integration.token || undefined,
    redactedToken: integration.tokenPreview || (integration.token ? maskSecretValue(integration.token) : null),
  };
}

export function verifyGitHubWebhookSignature(body: any, signatureHeader: string, secret: string) {
  if (!secret) return false;
  const header = String(signatureHeader || '');
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function githubWebhookActionPlan(event: any, payload: Record<string, any> = {}) {
  const eventName = String(event || payload.event || '').toLowerCase();
  const action = String(payload.action || (eventName === 'push' ? 'push' : '')).toLowerCase();
  const repository = webhookRepository(payload);
  const repositoryId = String(payload.repository?.id || '').trim();
  const installationId = String(payload.installation?.id || '').trim();
  if (eventName === 'push') {
    const ref = String(payload.ref || '');
    const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : '';
    const commitSha = payload.after || payload.head_commit?.id || null;
    const ignoredReason = !repositoryId || !installationId
      ? 'missing-repository-identity'
      : !branch
        ? 'non-head-ref'
        : payload.deleted === true || /^0+$/.test(String(commitSha || ''))
          ? 'deleted-ref'
          : payload.forced === true
            ? 'forced-update'
            : !validGitHubCommitSha(commitSha)
              ? 'invalid-commit'
              : null;
    return {
      kind: ignoredReason ? 'ignored' : 'production-deploy',
      event: eventName,
      action: 'push',
      repository,
      repositoryId,
      installationId,
      branch,
      baseBranch: branch,
      commitSha,
      ignoredReason,
    };
  }
  if (eventName === 'pull_request' && ['opened', 'synchronize', 'reopened'].includes(action)) {
    const pr = payload.pull_request || {};
    const commitSha = pr.head?.sha || payload.after || null;
    const ignoredReason = !repositoryId || !installationId
      ? 'missing-repository-identity'
      : !validGitHubCommitSha(commitSha)
        ? 'invalid-commit'
        : null;
    return {
      kind: ignoredReason ? 'ignored' : 'preview-deploy',
      event: eventName,
      action,
      repository,
      repositoryId,
      installationId,
      branch: pr.head?.ref || payload.branch || 'preview',
      baseBranch: pr.base?.ref || payload.repository?.default_branch || '',
      commitSha,
      pullRequestNumber: Number(payload.number || pr.number || 0),
      ignoredReason,
    };
  }
  if (eventName === 'pull_request' && action === 'closed') {
    const pr = payload.pull_request || {};
    return {
      kind: repositoryId && installationId ? 'preview-cleanup' : 'ignored',
      event: eventName,
      action,
      repository,
      repositoryId,
      installationId,
      branch: pr.head?.ref || payload.branch || 'preview',
      baseBranch: pr.base?.ref || payload.repository?.default_branch || '',
      commitSha: pr.head?.sha || null,
      pullRequestNumber: Number(payload.number || pr.number || 0),
      ignoredReason: repositoryId && installationId ? null : 'missing-repository-identity',
    };
  }
  return { kind: 'ignored', event: eventName || 'unknown', action, repository, repositoryId, installationId, branch: null, baseBranch: null, commitSha: null, pullRequestNumber: null, ignoredReason: 'unsupported-event' };
}

export function githubWebhookOutboundPlan(actionPlan: Record<string, any>, actions: Array<Record<string, any>> = []) {
  const state = actions.length ? 'queued' : 'skipped';
  const previewUrl = actions.find((action) => action.previewUrl)?.previewUrl || null;
  const description = actions.length
    ? `${actions.length} RAIBITSERVER workflow action(s) queued`
    : 'No RAIBITSERVER service is attached to this repository';
  return {
    commitStatus: {
      state: state === 'queued' ? 'pending' : 'success',
      context: actionPlan.kind === 'preview-cleanup' ? 'raibitserver/preview-cleanup' : 'raibitserver/deploy',
      description,
      targetUrl: previewUrl,
    },
    checkRun: {
      name: actionPlan.kind === 'preview-cleanup' ? 'RAIBITSERVER preview cleanup' : 'RAIBITSERVER deployment',
      status: state === 'queued' ? 'queued' : 'completed',
      conclusion: state === 'queued' ? null : 'neutral',
      output: { title: 'RAIBITSERVER', summary: description },
    },
    pullRequestComment: actionPlan.pullRequestNumber
      ? { pullRequestNumber: actionPlan.pullRequestNumber, body: actions.length ? `RAIBITSERVER queued ${actions.map((action) => action.type).join(', ')}.${previewUrl ? ` Preview: ${previewUrl}` : ''}` : 'RAIBITSERVER found no attached service for this repository.' }
      : null,
  };
}

export function githubOAuthLoginPlan(options: Record<string, any> = {}) {
  const clientId = options.clientId || process.env.GITHUB_CLIENT_ID || process.env.RAIBITSERVER_GITHUB_CLIENT_ID || '';
  const redirectUri = options.redirectUri || process.env.RAIBITSERVER_GITHUB_REDIRECT_URI || '';
  const state = validOAuthState(options.state) ? options.state : crypto.randomBytes(32).toString('base64url');
  const configured = Boolean(clientId && redirectUri);
  const oauthUrl = configured ? new URL('https://github.com/login/oauth/authorize') : null;
  if (oauthUrl) {
    oauthUrl.searchParams.set('client_id', clientId);
    oauthUrl.searchParams.set('redirect_uri', redirectUri);
    oauthUrl.searchParams.set('scope', options.scope || 'read:user user:email');
    oauthUrl.searchParams.set('state', state);
    if (validCodeChallenge(options.codeChallenge)) {
      oauthUrl.searchParams.set('code_challenge', options.codeChallenge);
      oauthUrl.searchParams.set('code_challenge_method', 'S256');
    }
  }
  return { provider: 'github', configured, oauthUrl: oauthUrl?.toString() || null, state, mode: configured ? 'redirect' : 'configuration-required' };
}

export async function fetchGitHubOAuthIdentity(input: Record<string, any>, options: Record<string, any> = {}): Promise<GitHubOAuthIdentity> {
  const clientId = options.clientId || process.env.GITHUB_CLIENT_ID || process.env.RAIBITSERVER_GITHUB_CLIENT_ID || '';
  const clientSecret = options.clientSecret || process.env.GITHUB_CLIENT_SECRET || process.env.RAIBITSERVER_GITHUB_CLIENT_SECRET || '';
  const redirectUri = options.redirectUri || process.env.RAIBITSERVER_GITHUB_REDIRECT_URI || '';
  const code = requiredOAuthValue(input.code, 'github_oauth_code_required', 256);
  if (!clientId || !clientSecret || !redirectUri) throw githubOAuthError('github_oauth_not_configured', 503);

  const tokenBody = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri });
  if (validCodeVerifier(input.codeVerifier)) tokenBody.set('code_verifier', input.codeVerifier);
  const requestOptions = {
    fetchImpl: (options.fetchImpl || globalThis.fetch) as FetchLike,
    requestTimeoutMs: boundedTimeout(options.requestTimeoutMs),
  };
  const tokenResponse = await githubOAuthJson(options.tokenUrl || GITHUB_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'raibitserver-github-oauth',
    },
    body: tokenBody.toString(),
  }, requestOptions, 'github_oauth_exchange_failed');
  const accessToken = typeof tokenResponse.access_token === 'string' ? tokenResponse.access_token : '';
  if (!accessToken) throw githubOAuthError('github_oauth_exchange_failed', 502);

  const apiBaseUrl = String(options.apiBaseUrl || GITHUB_API_URL).replace(/\/$/, '');
  const apiHeaders = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${accessToken}`,
    'user-agent': 'raibitserver-github-oauth',
    'x-github-api-version': GITHUB_API_VERSION,
  };
  const [profile, emails] = await Promise.all([
    githubOAuthJson(`${apiBaseUrl}/user`, { headers: apiHeaders }, requestOptions, 'github_oauth_profile_failed'),
    githubOAuthJson(`${apiBaseUrl}/user/emails`, { headers: apiHeaders }, requestOptions, 'github_oauth_email_failed'),
  ]);
  const verifiedEmails = Array.isArray(emails)
    ? emails.filter((entry) => entry && entry.verified === true && validEmail(entry.email))
    : [];
  const selectedEmail = verifiedEmails.find((entry) => entry.primary === true)?.email || verifiedEmails[0]?.email;
  if (!selectedEmail) throw githubOAuthError('github_verified_email_required', 403);
  const githubId = requiredOAuthValue(profile.id, 'github_oauth_profile_failed', 80);
  const githubLogin = requiredOAuthValue(profile.login, 'github_oauth_profile_failed', 100);
  const profileName = boundedProfileName(profile.name) || githubLogin;
  return {
    avatarUrl: safeGitHubAvatarUrl(profile.avatar_url),
    email: String(selectedEmail).trim().toLowerCase(),
    githubId,
    githubLogin,
    name: profileName,
  };
}

export function deterministicGitHubCallbackAllowed(input: Record<string, any> = {}, env: Record<string, any> = process.env) {
  if (env.RAIBITSERVER_GITHUB_OAUTH_LOCAL_CALLBACK === '1') return true;
  if (env.NODE_ENV === 'production') return false;
  return Boolean(input.localDev === '1' || input.mode === 'deterministic-local-callback' || input.email || input.githubEmail || input.userEmail);
}

function validCodeChallenge(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(value);
}

function validOAuthState(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

function validCodeVerifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

function requiredOAuthValue(value: unknown, code: string, maxLength: number): string {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) throw githubOAuthError(code, 400);
  return normalized;
}

function validEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function boundedProfileName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return normalized && normalized.length <= 100 && !/[\u0000-\u001f\u007f]/.test(normalized) ? normalized : '';
}

function safeGitHubAvatarUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'avatars.githubusercontent.com' ? url.toString() : null;
  } catch {
    return null;
  }
}

function boundedTimeout(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 500), 30_000) : DEFAULT_GITHUB_OAUTH_TIMEOUT_MS;
}

async function githubOAuthJson(url: string, init: RequestInit, options: { fetchImpl: FetchLike; requestTimeoutMs: number }, failureCode: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.requestTimeoutMs);
  try {
    const response = await options.fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal });
    if (!response.ok) throw githubOAuthError(failureCode, response.status === 401 || response.status === 403 ? 401 : 502);
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_GITHUB_OAUTH_RESPONSE_BYTES) throw githubOAuthError('github_oauth_response_too_large', 502);
    const bytes = await readBoundedOAuthBody(response.body);
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw githubOAuthError(failureCode, 502);
    }
  } catch (error) {
    if (Number.isInteger((error as any)?.statusCode)) throw error;
    const timedOut = controller.signal.aborted || (error as Error)?.name === 'AbortError';
    throw githubOAuthError(timedOut ? 'github_oauth_timeout' : failureCode, timedOut ? 504 : 502);
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedOAuthBody(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_GITHUB_OAUTH_RESPONSE_BYTES) {
        await reader.cancel('github_oauth_response_too_large').catch(() => undefined);
        throw githubOAuthError('github_oauth_response_too_large', 502);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function githubOAuthError(code: string, statusCode: number) {
  const error = new Error(code) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function webhookRepository(payload: Record<string, any>) {
  const fullName = payload.repository?.full_name || payload.repository?.fullName || payload.repository?.nameWithOwner;
  if (fullName) return parseGitHubRepository(String(fullName)).fullName;
  if (payload.repository?.owner?.login && payload.repository?.name) return parseGitHubRepository(`${payload.repository.owner.login}/${payload.repository.name}`).fullName;
  return '';
}

function validGitHubCommitSha(value: any) {
  return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(String(value || ''));
}
