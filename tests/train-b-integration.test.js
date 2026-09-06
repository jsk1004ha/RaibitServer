import assert from 'node:assert/strict';
import test from 'node:test';
import { RAIBITSERVERClient } from '@raibitserver/api-client';
import { hashPassword, signJwtHs256 } from '@raibitserver/core';
import { bootParityApi } from './fixtures/api-parity-runtime.mjs';

test('composed password recovery revokes project settings access until a new login', async (t) => {
  const runtime = await bootParityApi();
  process.env.RAIBITSERVER_EMAIL_FROM = 'Train B <recovery@example.test>';
  process.env.RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE = '246810';
  process.env.RAIBITSERVER_EMAIL_DELIVERY_MODE = 'console';
  const store = runtime.repository.store;
  const user = store.createUser({
    email: 'train-b-owner@example.test', name: 'Train B Owner',
    passwordHash: hashPassword('old-password'), approvalStatus: 'APPROVED',
    emailVerifiedAt: new Date().toISOString(),
  });
  const organization = store.createOrganization({ name: 'Train B', slug: 'train-b' });
  store.addMember({ organizationId: organization.id, userId: user.id, role: 'OWNER' });
  const project = store.createProject({ organizationId: organization.id, name: 'Before reset', slug: 'before-reset' });
  const anonymous = new RAIBITSERVERClient({ baseUrl: runtime.baseUrl });
  const oldSession = anonymous.withToken(signJwtHs256({
    sub: user.id, role: 'OWNER', organizationId: organization.id, sessionVersion: user.sessionVersion,
  }, process.env.RAIBITSERVER_AUTH_JWT_SECRET));

  try {
    const rendered = await oldSession.getProjectSettings(project.id);
    assert.equal(rendered.project.name, 'Before reset');
    assert.deepEqual(await anonymous.requestPasswordReset({ email: user.email }), { accepted: true });
    for (let attempt = 0; attempt < 100 && !store.emailDeliveries.length; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(store.emailDeliveries.length, 1);
    const code = store.emailDeliveries[0].text.match(/\b\d{6}\b/)?.[0];
    assert.equal(code, '246810');
    assert.deepEqual(await anonymous.completePasswordReset({ email: user.email, code, newPassword: 'new-password' }), { reset: true });
    await assert.rejects(oldSession.getProjectSettings(project.id), error => error.status === 401);
    await assert.rejects(oldSession.updateProjectSettings(project.id, {
      name: 'Revoked mutation', expectedUpdatedAt: rendered.snapshot.updatedAt,
    }), error => error.status === 401);

    const login = await anonymous.login({ email: user.email, password: 'new-password' });
    assert.equal(typeof login.token, 'string');
    const current = anonymous.withToken(login.token);
    const saved = await current.updateProjectSettings(project.id, {
      name: 'After reset', expectedUpdatedAt: rendered.snapshot.updatedAt,
    });
    assert.equal(saved.project.name, 'After reset');
    await assert.rejects(current.updateProjectSettings(project.id, {
      name: 'Stale overwrite', expectedUpdatedAt: rendered.snapshot.updatedAt,
    }), error => error.status === 409 && error.body.code === 'STALE_PROJECT');
    assert.equal((await current.getProjectSettings(project.id)).project.name, 'After reset');
    t.diagnostic(JSON.stringify({ surface: 'actual Nest HTTP + typed SDK', reset: 200, revokedRead: 401, revokedWrite: 401, newLogin: 200, settingsUpdate: 200, staleUpdate: 409 }));
  } finally {
    await runtime.app.close();
  }
});
