import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { assertCurrentSession, signJwtHs256 } from '../packages/core/src/auth.ts';
import { createApiHandler } from '../packages/core/src/api.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';

test('permanent and temporary bans revoke sessions, block actions, and preserve audit actors', () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  const admin = controlPlane.store.createUser({ email: 'ban-admin@example.com', role: 'ADMIN', approvalStatus: 'APPROVED' });
  const user = controlPlane.store.createUser({ email: 'ban-user@example.com', role: 'USER', accountType: 'CLUB_MEMBER', approvalStatus: 'APPROVED' });
  const session = { authMode: 'jwt', id: user.id, claims: { sessionVersion: user.sessionVersion } };

  const permanentlyBanned = controlPlane.store.banUser(user.id, { actorUserId: admin.id, reason: 'repeated abuse' });
  assert.equal(permanentlyBanned.banReason, 'repeated abuse');
  assert.equal(permanentlyBanned.banExpiresAt, null);
  assert.equal(permanentlyBanned.sessionVersion, user.sessionVersion + 1);
  assert.throws(() => assertCurrentSession(session, controlPlane.store.findUserById(user.id)), /account is banned/);
  assert.throws(() => controlPlane.store.enforceUserCan({ userId: user.id, action: 'project:create' }), /is banned/);

  const unbanned = controlPlane.store.unbanUser(user.id, { actorUserId: admin.id });
  assert.equal(unbanned.bannedAt, null);
  const temporary = controlPlane.store.banUser(user.id, { actorUserId: admin.id, reason: 'cooldown', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  assert.ok(temporary.banExpiresAt);
  const stored = controlPlane.store.users.get(user.id);
  stored.banExpiresAt = new Date(Date.now() - 1_000).toISOString();
  assert.doesNotThrow(() => controlPlane.store.enforceUserCan({ userId: user.id, action: 'project:create' }));

  assert.throws(() => controlPlane.store.banUser(admin.id, { actorUserId: admin.id, reason: 'self' }), /cannot ban themselves/);
  assert.throws(() => controlPlane.store.banUser(user.id, { actorUserId: admin.id, reason: '' }), /ban reason/);
  assert.throws(() => controlPlane.store.banUser(user.id, { actorUserId: admin.id, reason: 'bad date', expiresAt: 'not-a-date' }), /ban expiration/);
  assert.deepEqual(controlPlane.store.auditLogs.filter((row) => ['user:ban', 'user:unban'].includes(row.action)).map((row) => [row.action, row.actorUserId]), [
    ['user:ban', admin.id],
    ['user:unban', admin.id],
    ['user:ban', admin.id],
  ]);
});

test('admin ban and unban endpoints enforce self-protection and invalidate the target session', async () => {
  const secret = 'user-ban-api-test-secret';
  const controlPlane = new RAIBITSERVERControlPlane();
  const admin = controlPlane.store.createUser({ email: 'api-admin@example.com', role: 'ADMIN', approvalStatus: 'APPROVED' });
  const user = controlPlane.store.createUser({ email: 'api-user@example.com', role: 'USER', approvalStatus: 'APPROVED' });
  const adminToken = tokenFor(admin, secret, { userRole: 'ADMIN', role: 'owner' });
  const userToken = tokenFor(user, secret, { userRole: 'USER', role: 'owner' });
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret: secret } }));
  server.listen(0);
  await once(server, 'listening');
  const port = server.address().port;
  try {
    const selfBan = await request(port, `/admin/users/${admin.id}/ban`, { reason: 'no' }, adminToken);
    assert.equal(selfBan.statusCode, 400);
    assert.equal(selfBan.body.error, 'cannot_ban_self');

    const banned = await request(port, `/admin/users/${user.id}/ban`, { reason: 'security incident' }, adminToken);
    assert.equal(banned.statusCode, 200);
    assert.equal(banned.body.banReason, 'security incident');
    const staleSession = await request(port, '/projects', null, userToken, 'GET');
    assert.equal(staleSession.statusCode, 401);
    assert.equal(staleSession.body.error, 'account is banned');

    const unbanned = await request(port, `/admin/users/${user.id}/unban`, {}, adminToken);
    assert.equal(unbanned.statusCode, 200);
    assert.equal(unbanned.body.bannedAt, null);
  } finally {
    server.close();
  }
});

test('Prisma bans update the user and audit row in one transaction', async () => {
  const calls = [];
  const transaction = {
    user: {
      update: async (input) => {
        calls.push(['user.update', input]);
        return { id: 'target', email: 'target@example.com', sessionVersion: 3, ...input.data };
      },
    },
    auditLog: { create: async (input) => { calls.push(['auditLog.create', input]); return input.data; } },
  };
  const prisma = { $transaction: async (callback) => callback(transaction) };
  const repository = new PrismaControlPlaneRepository(prisma);
  const result = await repository.banUser('target', { actorUserId: 'admin', reason: 'incident', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(result.banReason, 'incident');
  assert.equal(calls[0][1].data.sessionVersion.increment, 1);
  assert.equal(calls[1][1].data.action, 'user:ban');
  assert.equal(calls[1][1].data.actorUserId, 'admin');
});

function tokenFor(user, secret, extra = {}) {
  return signJwtHs256({ sub: user.id, sessionVersion: user.sessionVersion, approvalStatus: user.approvalStatus, accountType: user.accountType, ...extra }, secret);
}

function request(port, pathname, body, token, method = 'POST') {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const req = http.request({ port, path: pathname, method, headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
