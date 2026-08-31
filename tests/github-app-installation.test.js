import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import { createApiHandler } from '../packages/core/src/api.ts';
import { signJwtHs256 } from '../packages/core/src/auth.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import {
  createGitHubAppAuthorizationPlan,
  createGitHubAppAuthorizationRetryPlan,
  createGitHubAppInstallationPlan,
  resolveGitHubAppInstallationSelection,
  verifyGitHubAppInstallationState,
} from '../packages/core/src/github-app.ts';
import { ControlPlaneStore } from '../packages/core/src/store.ts';

const stateSecret = 'github-state-secret-for-tests-only-1234567890';
const now = Date.parse('2026-08-28T00:00:00Z');

test('GitHub App setup keeps update redirects enabled for existing installations', async () => {
  const [guide, readme] = await Promise.all([
    fs.readFile(new URL('../docs/github-app.md', import.meta.url), 'utf8'),
    fs.readFile(new URL('../README.md', import.meta.url), 'utf8'),
  ]);
  assert.match(guide, /\| Redirect on update \| 켬 \|/);
  assert.match(readme, /Redirect on update\*\*는 켭니다/);
  assert.doesNotMatch(`${guide}\n${readme}`, /Redirect on update(?:\*\*)?[^\n]*끕니다/);
});

test('GitHub App states expire strictly while authenticated scoped flows remain resumable', () => {
  const install = createGitHubAppInstallationPlan({ userId: 'user-1', organizationId: 'org-1' }, {
    appSlug: 'raibit-server', stateSecret, now,
  });
  const installUrl = new URL(install.installUrl);
  assert.equal(installUrl.origin, 'https://github.com');
  assert.equal(installUrl.pathname, '/apps/raibit-server/installations/new');
  const installState = installUrl.searchParams.get('state');
  assert.equal(verifyGitHubAppInstallationState(installState, {
    userId: 'user-1', organizationId: 'org-1', purpose: 'github-app-install',
  }, { stateSecret, now }).purpose, 'github-app-install');

  const authorization = createGitHubAppAuthorizationPlan({
    userId: 'user-1', organizationId: 'org-1', installation_id: '900', setup_action: 'install', state: installState,
  }, {
    clientId: 'Iv1.fixture', callbackUrl: 'https://console.raibit.kr/github/callback', stateSecret, now,
  });
  const authorizationUrl = new URL(authorization.authorizationUrl);
  assert.equal(authorizationUrl.pathname, '/login/oauth/authorize');
  assert.equal(authorizationUrl.searchParams.get('client_id'), 'Iv1.fixture');
  assert.equal(authorizationUrl.searchParams.get('redirect_uri'), 'https://console.raibit.kr/github/callback');
  const callbackState = verifyGitHubAppInstallationState(authorizationUrl.searchParams.get('state'), {
    userId: 'user-1', organizationId: 'org-1', purpose: 'github-app-authorize',
  }, { stateSecret, now });
  assert.equal(callbackState.installationId, '900');

  const localAuthorization = createGitHubAppAuthorizationPlan({
    userId: 'user-1', organizationId: 'org-1', installation_id: '900', setup_action: 'update', state: installState,
  }, {
    clientId: 'Iv1.fixture', callbackUrl: 'http://localhost:3000/github/callback', stateSecret, now, production: false,
  });
  assert.equal(new URL(localAuthorization.authorizationUrl).searchParams.get('redirect_uri'), 'http://localhost:3000/github/callback');
  assert.throws(() => createGitHubAppAuthorizationPlan({
    userId: 'user-1', organizationId: 'org-1', installation_id: '900', state: installState,
  }, {
    clientId: 'Iv1.fixture', callbackUrl: 'http://console.raibit.kr/github/callback', stateSecret, now, production: true,
  }), /github_callback_url_invalid/);

  assert.throws(() => verifyGitHubAppInstallationState(installState, {
    userId: 'user-2', organizationId: 'org-1', purpose: 'github-app-install',
  }, { stateSecret, now }), /github_install_state_scope_mismatch/);
  assert.throws(() => verifyGitHubAppInstallationState(`${installState}x`, {
    userId: 'user-1', organizationId: 'org-1', purpose: 'github-app-install',
  }, { stateSecret, now }), /github_install_state_invalid/);
  assert.equal(verifyGitHubAppInstallationState(installState, {
    userId: 'user-1', organizationId: 'org-1', purpose: 'github-app-install',
  }, { stateSecret, now: now + 60 * 60_000 }).purpose, 'github-app-install');
  assert.throws(() => verifyGitHubAppInstallationState(installState, {
    userId: 'user-1', organizationId: 'org-1', purpose: 'github-app-install',
  }, { stateSecret, now: now + 2 * 60 * 60_000 + 1_000 }), /github_install_state_expired/);

  const resumedAt = now + 30 * 24 * 60 * 60_000;
  const resumedAuthorization = createGitHubAppAuthorizationPlan({
    userId: 'user-1', organizationId: 'org-1', installation_id: '900', setup_action: 'install', state: installState,
  }, { clientId: 'Iv1.fixture', stateSecret, now: resumedAt });
  const resumedCallbackState = new URL(resumedAuthorization.authorizationUrl).searchParams.get('state');
  assert.equal(verifyGitHubAppInstallationState(resumedCallbackState, {
    userId: 'user-1', organizationId: 'org-1', purpose: 'github-app-authorize',
  }, { stateSecret, now: resumedAt }).installationId, '900');
  assert.throws(() => createGitHubAppAuthorizationPlan({
    userId: 'user-2', organizationId: 'org-1', installation_id: '900', setup_action: 'install', state: installState,
  }, { clientId: 'Iv1.fixture', stateSecret, now: resumedAt }), /github_install_state_scope_mismatch/);

  const retriedAt = resumedAt + 31 * 60_000;
  assert.throws(() => verifyGitHubAppInstallationState(resumedCallbackState, {
    userId: 'user-1', organizationId: 'org-1', purpose: 'github-app-authorize',
  }, { stateSecret, now: retriedAt }), /github_install_state_expired/);
  const retry = createGitHubAppAuthorizationRetryPlan({
    userId: 'user-1', organizationId: 'org-1', state: resumedCallbackState,
  }, { clientId: 'Iv1.fixture', stateSecret, now: retriedAt });
  assert.equal(verifyGitHubAppInstallationState(new URL(retry.authorizationUrl).searchParams.get('state'), {
    userId: 'user-1', organizationId: 'org-1', purpose: 'github-app-authorize',
  }, { stateSecret, now: retriedAt }).installationId, '900');
  assert.throws(() => createGitHubAppAuthorizationRetryPlan({
    userId: 'user-1', organizationId: 'org-2', state: resumedCallbackState,
  }, { clientId: 'Iv1.fixture', stateSecret, now: retriedAt }), /github_install_state_scope_mismatch/);

  assert.throws(() => createGitHubAppInstallationPlan({ userId: 'user-1', organizationId: 'org-1' }, {
    appSlug: 'raibit-server', stateSecret, now, installTtlSeconds: 24 * 60 * 60 + 1,
  }), /github_state_ttl_invalid/);

  assert.throws(() => createGitHubAppAuthorizationPlan({
    userId: 'user-1', organizationId: 'org-1', installation_id: '900', setup_action: 'install', state: installState,
  }, {
    clientId: 'Iv1.fixture', stateSecret, now, authorizationTtlSeconds: 30 * 60 + 1,
  }), /github_state_ttl_invalid/);
});

test('GitHub user authorization proves the installation, catalogs selected repositories, and revokes its token', async () => {
  const requests = [];
  const fetchImpl = async (resource, init = {}) => {
    const url = new URL(String(resource));
    requests.push({ url, init });
    if (url.pathname === '/login/oauth/access_token') return jsonResponse({ access_token: 'ghu_ephemeral-secret' });
    if (url.pathname === '/user/installations') return jsonResponse({ installations: [{ id: 900, account: { login: 'jsk1004ha', type: 'User' }, repository_selection: 'selected' }] });
    if (url.pathname === '/user/installations/900/repositories') return jsonResponse({ repositories: [
      { id: 102, full_name: 'jsk1004ha/Private-App', default_branch: 'main', private: true },
      { id: 101, full_name: 'jsk1004ha/Public-App', default_branch: 'trunk', private: false },
    ] });
    if (url.pathname === '/applications/Iv1.fixture/token' && init.method === 'DELETE') return new Response(null, { status: 204 });
    return jsonResponse({ message: 'unexpected request' }, 500);
  };

  const result = await resolveGitHubAppInstallationSelection({ code: 'one-use-code', installationId: '900' }, {
    clientId: 'Iv1.fixture', clientSecret: 'client-secret', fetchImpl,
  });

  assert.deepEqual(result.repositories.map((repository) => [repository.githubRepoId, repository.fullName, repository.private]), [
    ['102', 'jsk1004ha/private-app', true],
    ['101', 'jsk1004ha/public-app', false],
  ]);
  assert.equal(result.accountLogin, 'jsk1004ha');
  assert.equal(JSON.stringify(result).includes('ghu_ephemeral-secret'), false);
  assert.equal(requests.some(({ url, init }) => url.pathname === '/applications/Iv1.fixture/token' && init.method === 'DELETE'), true);
});

test('verified installation catalog replacement is idempotent and rejects cross-organization ownership', () => {
  const store = new ControlPlaneStore();
  const organizationA = store.createOrganization({ name: 'A', slug: 'github-a' });
  const organizationB = store.createOrganization({ name: 'B', slug: 'github-b' });
  const integration = store.connectVerifiedGitHubInstallation({
    organizationId: organizationA.id, userId: 'user-a', installationId: '900', accountLogin: 'jsk1004ha',
  });
  const repeated = store.connectVerifiedGitHubInstallation({
    organizationId: organizationA.id, userId: 'user-a', installationId: '900', accountLogin: 'jsk1004ha',
  });
  assert.equal(repeated.id, integration.id);

  store.replaceGitHubInstallationRepositories({ installationId: '900', repositories: [
    { githubRepoId: '101', fullName: 'jsk1004ha/one', private: true },
    { githubRepoId: '102', fullName: 'jsk1004ha/two', private: false },
  ] });
  const replacement = store.replaceGitHubInstallationRepositories({ installationId: '900', repositories: [
    { githubRepoId: '102', fullName: 'jsk1004ha/two', private: false, defaultBranch: 'trunk' },
  ] });
  assert.equal(replacement.repositoryCount, 1);
  assert.deepEqual(store.listGitHubInstallationRepositories({ installationId: '900', organizationId: organizationA.id }).repositories.map((row) => row.githubRepoId), ['102']);
  assert.throws(() => store.connectVerifiedGitHubInstallation({
    organizationId: organizationB.id, installationId: '900', accountLogin: 'attacker',
  }), /another organization/);
});

test('prototype API completes the one-button install, proof, and repository sync flow without returning credentials', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  const organization = controlPlane.store.createOrganization({ name: 'GitHub App Org', slug: 'github-app-org' });
  const user = controlPlane.store.createUser({ email: 'owner@example.com', approvalStatus: 'APPROVED', accountType: 'NON_CLUB' });
  controlPlane.store.addMember({ organizationId: organization.id, userId: user.id, role: 'owner' });
  const jwtSecret = 'jwt-secret-for-github-app-tests-1234567890';
  let currentTime = now;
  const token = signJwtHs256({ sub: user.id, role: 'owner', organizationId: organization.id }, jwtSecret);
  const fetchImpl = async (resource, init = {}) => {
    const url = new URL(String(resource));
    if (url.pathname === '/login/oauth/access_token') return jsonResponse({ access_token: 'ghu_callback-secret' });
    if (url.pathname === '/user/installations') return jsonResponse({ installations: [{ id: 900, account: { login: 'jsk1004ha', type: 'User' }, repository_selection: 'selected' }] });
    if (url.pathname === '/user/installations/900/repositories') return jsonResponse({ repositories: [{ id: 101, full_name: 'jsk1004ha/private-app', default_branch: 'main', private: true }] });
    if (url.pathname === '/applications/Iv1.fixture/token' && init.method === 'DELETE') return new Response(null, { status: 204 });
    return jsonResponse({}, 500);
  };
  const githubAppOptions = {
    appSlug: 'raibit-server', clientId: 'Iv1.fixture', clientSecret: 'client-secret', stateSecret, fetchImpl,
    get now() { return currentTime; },
  };
  const server = http.createServer(createApiHandler(controlPlane, {
    auth: { mode: 'jwt', jwtSecret },
    githubApp: githubAppOptions,
  }));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const install = await request(port, '/github/install', token);
    assert.equal(install.statusCode, 200);
    const installState = new URL(install.body.installUrl).searchParams.get('state');

    currentTime += 30 * 24 * 60 * 60_000;
    const authorize = await request(port, `/github/authorize?${new URLSearchParams({ installation_id: '900', setup_action: 'install', state: installState })}`, token);
    assert.equal(authorize.statusCode, 200);
    const callbackState = new URL(authorize.body.authorizationUrl).searchParams.get('state');

    currentTime += 31 * 60_000;
    const expiredCallback = await request(port, `/github/callback?${new URLSearchParams({ code: 'expired-code', state: callbackState })}`, token);
    assert.equal(expiredCallback.statusCode, 200);
    assert.equal(expiredCallback.body.connected, false);
    assert.equal(expiredCallback.body.resumeRequired, true);
    const retriedCallbackState = new URL(expiredCallback.body.authorizationUrl).searchParams.get('state');

    const callback = await request(port, `/github/callback?${new URLSearchParams({ code: 'single-use-code', state: retriedCallbackState })}`, token);
    assert.equal(callback.statusCode, 200);
    assert.equal(callback.body.connected, true);
    assert.equal(callback.body.repositoryCount, 1);
    assert.equal(JSON.stringify(callback.body).includes('ghu_callback-secret'), false);
    assert.equal(controlPlane.store.listGitHubInstallationRepositories({ installationId: '900', organizationId: organization.id }).repositories[0].private, true);
  } finally {
    server.close();
  }
});

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function request(port, path, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path, method: 'GET', headers: { authorization: `Bearer ${token}` } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}
