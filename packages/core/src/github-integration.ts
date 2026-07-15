import crypto from 'node:crypto';
import { maskSecretValue } from './secrets.ts';

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
  const state = options.state || crypto.randomBytes(24).toString('base64url');
  const configured = Boolean(clientId && redirectUri);
  const oauthUrl = configured
    ? `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(options.scope || 'read:user user:email')}&state=${encodeURIComponent(state)}`
    : null;
  return { provider: 'github', configured, oauthUrl, state, mode: configured ? 'redirect' : 'configuration-required' };
}

export function deterministicGitHubCallbackAllowed(input: Record<string, any> = {}, env: Record<string, any> = process.env) {
  if (env.RAIBITSERVER_GITHUB_OAUTH_LOCAL_CALLBACK === '1') return true;
  if (env.NODE_ENV === 'production') return false;
  return Boolean(input.localDev === '1' || input.mode === 'deterministic-local-callback' || input.email || input.githubEmail || input.userEmail);
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
