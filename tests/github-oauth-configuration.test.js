import assert from 'node:assert/strict';
import test from 'node:test';
import { startGitHubOAuth } from '../packages/core/src/github-oauth-flow.ts';
import { ControlPlaneStore } from '../packages/core/src/store.ts';

test('empty generic OAuth aliases do not shadow configured RAIBIT credentials', async () => {
  const values = {
    GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '',
    RAIBITSERVER_GITHUB_CLIENT_ID: 'fixture-client',
    RAIBITSERVER_GITHUB_CLIENT_SECRET: 'fixture-secret',
    RAIBITSERVER_GITHUB_REDIRECT_URI: 'https://console.example.test/api/control/auth/github/callback',
    RAIBITSERVER_AUTH_RATE_LIMIT_KEY_SECRET: 'fixture-configuration-key-32-characters',
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    const plan = await startGitHubOAuth(new ControlPlaneStore(), { codeChallenge: Buffer.alloc(32, 1).toString('base64url') }, { source: '127.0.0.1', jwtSecret: 'fixture-configuration-key-32-characters' });
    assert.equal(plan.configured, true);
    assert.equal(new URL(plan.oauthUrl).searchParams.get('client_id'), 'fixture-client');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
