import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GITHUB_OAUTH_STATE_COOKIE_NAME,
  GITHUB_OAUTH_VERIFIER_COOKIE_NAME,
  dashboardSecurityHeaders,
  githubOAuthAuthorizeHref,
  githubOAuthCookieOptions,
  isGitHubOAuthCodeVerifier,
  isGitHubOAuthState,
} from './request-security.js';

const state = 'state_value_abcdefghijklmnopqrstuvwxyz_123456';
const verifier = 'verifier_value_abcdefghijklmnopqrstuvwxyz_0123456789_ABCDEFG';
const challenge = 'challenge_value_abcdefghijklmnopqrstuvwxyz_123456';
const redirectUri = 'https://console.raibit.kr/api/control/auth/github/callback';

test('GitHub OAuth transient cookies are host-only, HttpOnly, and callback-scoped', () => {
  assert.equal(GITHUB_OAUTH_STATE_COOKIE_NAME, 'raibitserver_github_oauth_state');
  assert.equal(GITHUB_OAUTH_VERIFIER_COOKIE_NAME, 'raibitserver_github_oauth_verifier');
  assert.deepEqual(githubOAuthCookieOptions({ NODE_ENV: 'development' }), {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    path: '/api/control/auth/github/callback',
    maxAge: 600,
  });
  assert.equal(githubOAuthCookieOptions({ NODE_ENV: 'production' }).secure, true);
  assert.equal(githubOAuthCookieOptions({ NODE_ENV: 'production', RAIBITSERVER_COOKIE_DOMAIN: '.raibit.kr' }).domain, undefined);
  assert.equal(isGitHubOAuthState(state), true);
  assert.equal(isGitHubOAuthCodeVerifier(verifier), true);
  assert.equal(isGitHubOAuthState('short'), false);
  assert.equal(isGitHubOAuthCodeVerifier('short'), false);
});

test('GitHub OAuth authorization accepts only the exact GitHub endpoint and PKCE request', () => {
  const valid = new URL('https://github.com/login/oauth/authorize');
  valid.search = new URLSearchParams({
    client_id: 'github-client-id',
    redirect_uri: redirectUri,
    scope: 'read:user user:email',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  assert.equal(githubOAuthAuthorizeHref(valid.toString(), { state, redirectUri, codeChallenge: challenge }), valid.toString());

  const wrongHost = new URL(valid);
  wrongHost.hostname = 'github.com.attacker.example';
  assert.equal(githubOAuthAuthorizeHref(wrongHost.toString(), { state, redirectUri, codeChallenge: challenge }), null);
  const wrongState = new URL(valid);
  wrongState.searchParams.set('state', 'other_state_abcdefghijklmnopqrstuvwxyz_123456');
  assert.equal(githubOAuthAuthorizeHref(wrongState.toString(), { state, redirectUri, codeChallenge: challenge }), null);
  const extraRedirect = new URL(valid);
  extraRedirect.searchParams.set('return_to', 'https://attacker.example');
  assert.equal(githubOAuthAuthorizeHref(extraRedirect.toString(), { state, redirectUri, codeChallenge: challenge }), null);
  const duplicateRedirect = new URL(valid);
  duplicateRedirect.searchParams.append('redirect_uri', 'https://attacker.example');
  assert.equal(githubOAuthAuthorizeHref(duplicateRedirect.toString(), { state, redirectUri, codeChallenge: challenge }), null);
  const elevatedScope = new URL(valid);
  elevatedScope.searchParams.set('scope', 'read:user user:email repo');
  assert.equal(githubOAuthAuthorizeHref(elevatedScope.toString(), { state, redirectUri, codeChallenge: challenge }), null);
});

test('avatar content policy permits GitHub avatars without opening arbitrary HTTPS images', () => {
  const policy = dashboardSecurityHeaders({ nonce: 'oauth-nonce', production: true, https: true })['content-security-policy'];
  const imageDirective = policy.split('; ').find((directive) => directive.startsWith('img-src'));
  assert.equal(imageDirective, "img-src 'self' data: blob: https://avatars.githubusercontent.com");
});
