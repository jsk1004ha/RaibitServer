import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createApiHandler } from '../packages/core/src/api.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';

const CALLBACK_URL = 'https://console.raibit.kr/api/control/auth/github/callback';
const JWT_SECRET = 'github-oauth-session-secret';
const STATE = 'state_value_abcdefghijklmnopqrstuvwxyz_123456';
const CODE_VERIFIER = 'verifier_value_abcdefghijklmnopqrstuvwxyz_0123456789_ABCDEFG';
const AVATAR_URL = 'https://avatars.githubusercontent.com/u/4242?v=4';

test('GitHub OAuth links an existing approved account and persists its provider avatar', async () => {
  const controlPlane = approvedControlPlane('member@example.com');
  const calls = [];
  const server = await startApi(controlPlane, githubFetch({ calls, email: 'member@example.com' }));
  try {
    const callback = await request(server, `/auth/github/callback?${new URLSearchParams({ code: 'one-time-code', state: STATE, codeVerifier: CODE_VERIFIER })}`);
    assert.equal(callback.statusCode, 200);
    assert.equal(callback.body.linked, true);
    assert.equal(callback.body.mode, 'oauth-complete');
    assert.equal(callback.body.user.avatarUrl, AVATAR_URL);
    assert.equal(callback.body.user.githubId, '4242');
    assert.equal(callback.body.user.name, 'RAIBIT Member', 'GitHub must not overwrite the approved RAIBIT identity name');
    assert.equal(typeof callback.body.token, 'string');
    assert.equal(JSON.stringify(callback.body).includes('provider-access-secret'), false);

    const currentUser = await request(server, '/auth/me', callback.body.token);
    assert.equal(currentUser.statusCode, 200);
    assert.equal(currentUser.body.user.avatarUrl, AVATAR_URL);
    assert.equal(controlPlane.store.findUserByEmail('member@example.com').githubId, '4242');
    assert.equal(calls.length, 3);
    assert.match(calls[0].body, /code_verifier=verifier_value_/);
    assert.match(calls[0].body, /redirect_uri=https%3A%2F%2Fconsole\.raibit\.kr%2Fapi%2Fcontrol%2Fauth%2Fgithub%2Fcallback/);
  } finally {
    await closeServer(server);
  }
});

test('GitHub OAuth rejects unverified provider email without linking the account', async () => {
  const controlPlane = approvedControlPlane('member@example.com');
  const server = await startApi(controlPlane, githubFetch({ email: 'member@example.com', verified: false }));
  try {
    const callback = await request(server, `/auth/github/callback?${new URLSearchParams({ code: 'unverified-code', state: STATE, codeVerifier: CODE_VERIFIER })}`);
    assert.equal(callback.statusCode, 403);
    assert.equal(callback.body.error, 'github_verified_email_required');
    assert.equal(controlPlane.store.findUserByEmail('member@example.com').githubId, null);
    assert.equal(controlPlane.store.findUserByEmail('member@example.com').avatarUrl, null);
  } finally {
    await closeServer(server);
  }
});

test('GitHub OAuth never creates an unapproved account from provider data', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  const server = await startApi(controlPlane, githubFetch({ email: 'unknown@example.com' }));
  try {
    const callback = await request(server, `/auth/github/callback?${new URLSearchParams({ code: 'unknown-code', state: STATE, codeVerifier: CODE_VERIFIER })}`);
    assert.equal(callback.statusCode, 403);
    assert.equal(callback.body.error, 'github_account_not_registered');
    assert.equal(controlPlane.store.findUserByEmail('unknown@example.com'), null);
  } finally {
    await closeServer(server);
  }
});

function approvedControlPlane(email) {
  const controlPlane = new RAIBITSERVERControlPlane();
  const organization = controlPlane.store.createOrganization({ name: 'RAIBIT', slug: 'raibit' });
  const user = controlPlane.store.createUser({
    email,
    name: 'RAIBIT Member',
    studentId: '2414',
    approvalStatus: 'APPROVED',
    emailVerifiedAt: new Date().toISOString(),
  });
  controlPlane.store.addMember({ organizationId: organization.id, userId: user.id, role: 'developer' });
  return controlPlane;
}

function githubFetch({ calls = [], email, verified = true }) {
  return async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method || 'GET', body: String(init.body || '') });
    if (url === 'https://github.com/login/oauth/access_token') {
      return jsonResponse({ access_token: 'provider-access-secret', token_type: 'bearer' });
    }
    if (url === 'https://api.github.com/user') {
      assert.equal(init.headers.authorization, 'Bearer provider-access-secret');
      return jsonResponse({ id: 4242, login: 'raibit-member', name: 'GitHub Display Name', avatar_url: AVATAR_URL });
    }
    if (url === 'https://api.github.com/user/emails') {
      assert.equal(init.headers.authorization, 'Bearer provider-access-secret');
      return jsonResponse([{ email, primary: true, verified }]);
    }
    throw new Error(`unexpected GitHub URL: ${url}`);
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

async function startApi(controlPlane, fetchImpl) {
  const server = http.createServer(createApiHandler(controlPlane, {
    auth: { mode: 'jwt', jwtSecret: JWT_SECRET },
    githubOAuth: {
      clientId: 'github-client-id',
      clientSecret: 'github-client-secret',
      redirectUri: CALLBACK_URL,
      fetchImpl,
    },
  }));
  server.listen(0);
  await once(server, 'listening');
  return server;
}

function request(server, pathname, token = null) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: address.port,
      path: pathname,
      method: 'GET',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: raw ? JSON.parse(raw) : null });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function closeServer(server) {
  server.close();
  await once(server, 'close');
}
