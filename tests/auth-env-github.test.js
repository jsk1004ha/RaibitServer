import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiHandler } from '../packages/core/src/api.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { parseDotEnv } from '../packages/core/src/env-file.ts';
import { buildEmailVerificationMessage } from '../packages/core/src/email-verification.ts';
import { deterministicGitHubCallbackAllowed, parseGitHubRepository, verifyGitHubWebhookSignature } from '../packages/core/src/github-integration.ts';
import { hashPassword } from '../packages/core/src/identity.ts';
import crypto from 'node:crypto';

test('.env upload parser separates plain values from important secrets', () => {
  const parsed = parseDotEnv('PUBLIC_URL=https://example.com\nDATABASE_URL=postgresql://u:p@db/app\nAPI_KEY=super-secret\n');
  assert.equal(parsed.plainCount, 1);
  assert.equal(parsed.secretCount, 2);
  assert.equal(parsed.entries.find((entry) => entry.key === 'PUBLIC_URL').valueMasked, 'https://example.com');
  assert.notEqual(parsed.entries.find((entry) => entry.key === 'DATABASE_URL').valueMasked, 'postgresql://u:p@db/app');
  assert.throws(() => parseDotEnv('1BAD=value'), /invalid \.env content/);
});

test('email verification uses a sending-only sender from the configured domain', () => {
  const message = buildEmailVerificationMessage({
    email: 'member@example.com',
    code: '123456',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    env: { RAIBITSERVER_EMAIL_DOMAIN: 'mydomain.com' },
  });
  assert.equal(message.from, 'RAIBITSERVER <email-verification@mydomain.com>');
});

test('first auth user bootstraps as admin non-club and GitHub callback remains passive', async () => {
  const secret = 'first-user-bootstrap-secret';
  const previousAdminEmails = process.env.ADMIN_EMAILS;
  const previousCode = process.env.RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE;
  delete process.env.ADMIN_EMAILS;
  process.env.RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE = '111111';
  const controlPlane = new RAIBITSERVERControlPlane();
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret: secret } }));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const first = await request(port, 'POST', '/auth/signup', { email: 'first@example.com', password: 'correct-horse', name: 'First User', studentId: '2501', organizationSlug: 'first-org' });
    assert.equal(first.statusCode, 201);
    assert.equal(first.body.user, undefined);
    assert.equal(first.body.organization, undefined);
    const firstVerified = await request(port, 'POST', '/auth/email/verify', { email: 'first@example.com', code: '111111' });
    assert.equal(firstVerified.statusCode, 200);
    assert.equal(firstVerified.body.user.role, 'ADMIN');
    assert.equal(firstVerified.body.user.accountType, 'NON_CLUB');
    assert.equal(firstVerified.body.user.approvalStatus, 'APPROVED');
    assert.equal(firstVerified.body.user.name, 'First User');
    assert.equal(firstVerified.body.user.studentId, '2501');

    const adminSnapshot = await request(port, 'GET', '/snapshot', null, firstVerified.body.token);
    assert.equal(adminSnapshot.statusCode, 200);
    assert.equal(adminSnapshot.body.users[0].name, 'First User');
    assert.equal(adminSnapshot.body.users[0].studentId, '2501');
    const second = await request(port, 'POST', '/auth/signup', { email: 'second@example.com', password: 'correct-horse', name: 'Second User', studentId: '2502', clubMemberClaim: true, accountType: 'CLUB_MEMBER', approvalStatus: 'APPROVED' });
    assert.equal(second.statusCode, 201);
    const secondVerified = await request(port, 'POST', '/auth/email/verify', { email: 'second@example.com', code: '111111' });
    assert.equal(secondVerified.statusCode, 200);
    assert.equal(secondVerified.body.user.role, 'USER');
    assert.equal(secondVerified.body.user.accountType, 'NON_CLUB');
    assert.equal(secondVerified.body.user.clubMemberClaim, true);
    assert.equal(secondVerified.body.user.approvalStatus, 'PENDING');
    assert.equal(secondVerified.body.organization.slug, 'second');
    const secondSnapshot = await request(port, 'GET', '/snapshot', null, secondVerified.body.token);
    assert.equal(secondSnapshot.statusCode, 401);
    assert.equal(secondSnapshot.body.error, 'account is not approved');
    const secondBlocked = await request(port, 'POST', '/projects', { name: 'blocked', slug: 'blocked' }, secondVerified.body.token);
    assert.equal(secondBlocked.statusCode, 401);

    const githubOnly = new RAIBITSERVERControlPlane();
    const githubServer = http.createServer(createApiHandler(githubOnly, { auth: { mode: 'jwt', jwtSecret: secret } }));
    githubServer.listen(0);
    await once(githubServer, 'listening');
    try {
      const callback = await request(githubServer.address().port, 'GET', '/auth/github/callback?email=gh-first%40example.com&githubId=42&login=gh-first&organizationSlug=gh-first-org&state=oauth-state');
      assert.equal(callback.statusCode, 200);
      assert.equal(callback.body.linked, false);
      assert.equal(callback.body.state, 'oauth-state');
      assert.equal(callback.body.mode, 'oauth-callback-pending');
      assert.equal(callback.body.user, undefined);
      assert.equal(Boolean(callback.body.token), false);
    } finally {
      githubServer.close();
    }
  } finally {
    server.close();
    if (previousAdminEmails === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = previousAdminEmails;
    if (previousCode === undefined) delete process.env.RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE; else process.env.RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE = previousCode;
  }
});

test('legacy first user is promoted to admin on first login when no admin exists', async () => {
  const secret = 'first-login-bootstrap-secret';
  const controlPlane = new RAIBITSERVERControlPlane();
  const org = controlPlane.store.createOrganization({ name: 'Legacy Org', slug: 'legacy-org' });
  const legacy = controlPlane.store.createUser({ email: 'legacy@example.com', name: 'Legacy User', passwordHash: hashPassword('correct-horse'), role: 'USER', accountType: 'NON_CLUB', approvalStatus: 'PENDING' });
  controlPlane.store.addMember({ organizationId: org.id, userId: legacy.id, role: 'owner' });
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret: secret } }));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const login = await request(port, 'POST', '/auth/login', { email: 'legacy@example.com', password: 'correct-horse' });
    assert.equal(login.statusCode, 200);
    assert.equal(login.body.user.role, 'ADMIN');
    assert.equal(login.body.user.accountType, 'NON_CLUB');
    assert.equal(login.body.user.approvalStatus, 'APPROVED');
    const project = await request(port, 'POST', '/projects', { name: 'legacy', slug: 'legacy' }, login.body.token);
    assert.equal(project.statusCode, 201);
  } finally {
    server.close();
  }
});

test('approval changes revoke existing sessions and rejected users cannot log in', async () => {
  const secret = 'approval-session-revocation-secret';
  const controlPlane = new RAIBITSERVERControlPlane();
  const org = controlPlane.store.createOrganization({ name: 'Session Org', slug: 'session-org' });
  const admin = controlPlane.store.createUser({
    email: 'session-admin@example.com',
    name: 'Session Admin',
    passwordHash: hashPassword('correct-horse'),
    role: 'ADMIN',
    accountType: 'NON_CLUB',
    approvalStatus: 'APPROVED',
  });
  const member = controlPlane.store.createUser({
    email: 'session-member@example.com',
    name: 'Session Member',
    passwordHash: hashPassword('correct-horse'),
    role: 'USER',
    accountType: 'NON_CLUB',
    approvalStatus: 'APPROVED',
  });
  controlPlane.store.addMember({ organizationId: org.id, userId: admin.id, role: 'owner' });
  controlPlane.store.addMember({ organizationId: org.id, userId: member.id, role: 'owner' });
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret: secret } }));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const adminLogin = await request(port, 'POST', '/auth/login', { email: admin.email, password: 'correct-horse' });
    const memberLogin = await request(port, 'POST', '/auth/login', { email: member.email, password: 'correct-horse' });
    assert.equal(adminLogin.statusCode, 200);
    assert.equal(memberLogin.statusCode, 200);

    const unconfirmedReject = await request(port, 'POST', `/admin/users/${member.id}/reject`, {}, adminLogin.body.token);
    assert.equal(unconfirmedReject.statusCode, 400);
    assert.equal(unconfirmedReject.body.error, 'confirmation_required');

    const rejected = await request(port, 'POST', `/admin/users/${member.id}/reject`, { confirmed: true }, adminLogin.body.token);
    assert.equal(rejected.statusCode, 200);
    assert.equal(rejected.body.approvalStatus, 'REJECTED');

    const staleRejectedSession = await request(port, 'GET', '/projects', null, memberLogin.body.token);
    assert.equal(staleRejectedSession.statusCode, 401);
    const rejectedLogin = await request(port, 'POST', '/auth/login', { email: member.email, password: 'correct-horse' });
    assert.equal(rejectedLogin.statusCode, 403);

    const approved = await request(port, 'POST', `/admin/users/${member.id}/approve`, { accountType: 'NON_CLUB' }, adminLogin.body.token);
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.body.approvalStatus, 'APPROVED');

    const staleApprovedSession = await request(port, 'GET', '/projects', null, memberLogin.body.token);
    assert.equal(staleApprovedSession.statusCode, 401);
    const freshLogin = await request(port, 'POST', '/auth/login', { email: member.email, password: 'correct-horse' });
    assert.equal(freshLogin.statusCode, 200);
    const freshSession = await request(port, 'GET', '/projects', null, freshLogin.body.token);
    assert.equal(freshSession.statusCode, 200);
  } finally {
    server.close();
  }
});

test('signup sends an email code and requires verification before login issues a session', async () => {
  const secret = 'email-verification-secret';
  const previousCode = process.env.RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE;
  const previousFrom = process.env.RAIBITSERVER_EMAIL_FROM;
  process.env.RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE = '246810';
  process.env.RAIBITSERVER_EMAIL_FROM = 'RAIBITSERVER <email-verification@example.com>';
  const controlPlane = new RAIBITSERVERControlPlane();
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret: secret } }));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const missingName = await request(port, 'POST', '/auth/signup', { email: 'missing-name@example.com', password: 'correct-horse', studentId: '2598', organizationSlug: 'missing-name-org' });
    assert.equal(missingName.statusCode, 400);
    assert.equal(missingName.body.error, 'name_is_required');
    const missingStudentId = await request(port, 'POST', '/auth/signup', { email: 'missing-student@example.com', password: 'correct-horse', name: 'Missing Student', organizationSlug: 'missing-student-org' });
    assert.equal(missingStudentId.statusCode, 400);
    assert.equal(missingStudentId.body.error, 'student_id_is_required');

    const signup = await request(port, 'POST', '/auth/signup', { email: 'verify@example.com', password: 'correct-horse', name: 'Verify User', studentId: '2503', organizationSlug: 'verify-org' });
    assert.equal(signup.statusCode, 201);
    assert.equal(Boolean(signup.body.token), false);
    assert.equal(signup.body.user, undefined);
    assert.equal(signup.body.organization, undefined);
    assert.equal(controlPlane.store.users.size, 0);
    assert.equal(controlPlane.store.organizations.size, 0);
    assert.deepEqual(signup.body.emailVerification, { accepted: true });
    await waitForEmailDeliveries(controlPlane.store, 1);
    assert.equal(controlPlane.store.emailDeliveries.length, 1);
    assert.equal(controlPlane.store.emailDeliveries[0].from, 'RAIBITSERVER <email-verification@example.com>');
    assert.equal(controlPlane.store.emailDeliveries[0].to, 'verify@example.com');
    assert.match(controlPlane.store.emailDeliveries[0].text, /246810/);

    const blockedLogin = await request(port, 'POST', '/auth/login', { email: 'verify@example.com', password: 'correct-horse' });
    assert.equal(blockedLogin.statusCode, 401);
    assert.equal(blockedLogin.body.error, 'invalid_credentials');

    const rejected = await request(port, 'POST', '/auth/email/verify', { email: 'verify@example.com', code: '000000' });
    assert.equal(rejected.statusCode, 403);

    const verified = await request(port, 'POST', '/auth/email/verify', { email: 'verify@example.com', code: '246810' });
    assert.equal(verified.statusCode, 200);
    assert.equal(Boolean(verified.body.token), true);
    assert.ok(verified.body.user.emailVerifiedAt);
    assert.equal(verified.body.user.name, 'Verify User');
    assert.equal(verified.body.user.studentId, '2503');
    assert.equal(controlPlane.store.users.size, 1);
    assert.equal(controlPlane.store.organizations.size, 1);
    assert.equal(verified.body.user.passwordHash, undefined);

    const login = await request(port, 'POST', '/auth/login', { email: 'verify@example.com', password: 'correct-horse' });
    assert.equal(login.statusCode, 200);
    assert.equal(Boolean(login.body.token), true);
  } finally {
    server.close();
    if (previousCode === undefined) delete process.env.RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE; else process.env.RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE = previousCode;
    if (previousFrom === undefined) delete process.env.RAIBITSERVER_EMAIL_FROM; else process.env.RAIBITSERVER_EMAIL_FROM = previousFrom;
  }
});

test('signup replacement invalidates stale or malicious pending email verification payloads', async () => {
  const secret = 'email-verification-replacement-secret';
  const previousCode = process.env.RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE;
  process.env.RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE = '135790';
  const controlPlane = new RAIBITSERVERControlPlane();
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret: secret } }));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const attackerSignup = await request(port, 'POST', '/auth/signup', { email: 'pending@example.com', password: 'attacker-password', name: 'Attacker', studentId: '6666', organizationSlug: 'attacker-org' });
    assert.equal(attackerSignup.statusCode, 201);

    const victimSignup = await request(port, 'POST', '/auth/signup', { email: 'pending@example.com', password: 'victim-password', name: 'Victim', studentId: '2504', organizationSlug: 'pending-org' });
    assert.equal(victimSignup.statusCode, 201);
    assert.equal(controlPlane.store.emailVerificationCodes.filter((row) => row.email === 'pending@example.com' && !row.consumedAt).length, 1);

    const verified = await request(port, 'POST', '/auth/email/verify', { email: 'pending@example.com', code: '135790' });
    assert.equal(verified.statusCode, 200);
    assert.equal(verified.body.user.name, 'Victim');
    assert.equal(verified.body.user.studentId, '2504');
    assert.equal(verified.body.organization.slug, 'pending-org');

    const attackerLogin = await request(port, 'POST', '/auth/login', { email: 'pending@example.com', password: 'attacker-password' });
    assert.equal(attackerLogin.statusCode, 401);
    const victimLogin = await request(port, 'POST', '/auth/login', { email: 'pending@example.com', password: 'victim-password' });
    assert.equal(victimLogin.statusCode, 200);

    const staleSignup = await request(port, 'POST', '/auth/signup', { email: 'stale@example.com', password: 'old-password', name: 'Stale', studentId: '2505', organizationSlug: 'stale-old-org' });
    assert.equal(staleSignup.statusCode, 201);
    const staleRecord = controlPlane.store.emailVerificationCodes.find((row) => row.email === 'stale@example.com' && !row.consumedAt);
    staleRecord.expiresAt = '2000-01-01T00:00:00.000Z';

    const freshSignup = await request(port, 'POST', '/auth/signup', { email: 'stale@example.com', password: 'fresh-password', name: 'Fresh', studentId: '2506', organizationSlug: 'stale-fresh-org' });
    assert.equal(freshSignup.statusCode, 201);
    const freshVerified = await request(port, 'POST', '/auth/email/verify', { email: 'stale@example.com', code: '135790' });
    assert.equal(freshVerified.statusCode, 200);
    assert.equal(freshVerified.body.user.name, 'Fresh');
    assert.equal(freshVerified.body.user.studentId, '2506');
    assert.equal(freshVerified.body.organization.slug, 'stale-fresh-org');
  } finally {
    server.close();
    if (previousCode === undefined) delete process.env.RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE; else process.env.RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE = previousCode;
  }
});

test('signup/login tokens isolate hosted projects, service env upload, and GitHub integration', async () => {
  const secret = 'auth-env-github-secret';
  const previousAdminEmails = process.env.ADMIN_EMAILS;
  const previousCode = process.env.RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE;
  process.env.ADMIN_EMAILS = 'alice@example.com';
  process.env.RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE = '135790';
  const controlPlane = new RAIBITSERVERControlPlane();
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret: secret } }));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const aliceSignup = await request(port, 'POST', '/auth/signup', { email: 'alice@example.com', password: 'correct-horse', name: 'Alice', studentId: '2507', organizationSlug: 'alice-org', accountType: 'CLUB_MEMBER', approvalStatus: 'APPROVED' });
    assert.equal(aliceSignup.statusCode, 201);
    assert.equal(Boolean(aliceSignup.body.token), false);
    assert.equal(aliceSignup.body.user, undefined);
    const aliceVerified = await request(port, 'POST', '/auth/email/verify', { email: 'alice@example.com', code: '135790' });
    assert.equal(aliceVerified.statusCode, 200);
    assert.equal(Boolean(aliceVerified.body.token), true);
    assert.equal(aliceVerified.body.user.passwordHash, undefined);
    assert.equal(aliceVerified.body.user.role, 'ADMIN');
    assert.equal(aliceVerified.body.user.accountType, 'NON_CLUB');
    assert.equal(aliceVerified.body.user.approvalStatus, 'APPROVED');

    const bobSignup = await request(port, 'POST', '/auth/signup', { email: 'bob@example.com', password: 'correct-horse', name: 'Bob', studentId: '2508', organizationSlug: 'bob-org' });
    assert.equal(bobSignup.statusCode, 201);
    const bobVerified = await request(port, 'POST', '/auth/email/verify', { email: 'bob@example.com', code: '135790' });
    assert.equal(bobVerified.statusCode, 200);
    assert.equal(bobVerified.body.user.accountType, 'NON_CLUB');
    assert.equal(bobVerified.body.user.approvalStatus, 'PENDING');

    const eveSignup = await request(port, 'POST', '/auth/signup', { email: 'eve@example.com', password: 'correct-horse', name: 'Eve', studentId: '2509', organizationSlug: 'eve-org', plan: 'club', accountType: 'CLUB_MEMBER', approvalStatus: 'APPROVED' });
    assert.equal(eveSignup.statusCode, 201);
    const eveVerified = await request(port, 'POST', '/auth/email/verify', { email: 'eve@example.com', code: '135790' });
    assert.equal(eveVerified.statusCode, 200);
    assert.equal(eveVerified.body.user.accountType, 'NON_CLUB');
    assert.equal(eveVerified.body.user.approvalStatus, 'PENDING');

    const duplicateOrg = await request(port, 'POST', '/auth/signup', { email: 'mallory@example.com', password: 'correct-horse', name: 'Mallory', studentId: '2510', organizationSlug: 'alice-org' });
    assert.equal(duplicateOrg.statusCode, 201);
    assert.deepEqual(duplicateOrg.body.emailVerification, { accepted: true });
    assert.equal(controlPlane.store.emailVerificationCodes.some((row) => row.email === 'mallory@example.com' && row.purpose === 'signup' && !row.consumedAt), false);

    const aliceLogin = await request(port, 'POST', '/auth/login', { email: 'alice@example.com', password: 'correct-horse' });
    assert.equal(aliceLogin.statusCode, 200);

    const aliceProject = await request(port, 'POST', '/projects', { name: 'Alice API', slug: 'alice-api' }, aliceLogin.body.token);
    assert.equal(aliceProject.statusCode, 201);
    assert.equal(aliceProject.body.organizationId, aliceVerified.body.organization.id);

    const aliceService = await request(port, 'POST', '/services', { projectId: aliceProject.body.id, name: 'web', type: 'web', sourceType: 'github' }, aliceLogin.body.token);
    assert.equal(aliceService.statusCode, 201);

    const bobDenied = await request(port, 'POST', '/services', { projectId: aliceProject.body.id, name: 'steal' }, bobVerified.body.token);
    assert.equal(bobDenied.statusCode, 401);

    const bobOwnProjectBlocked = await request(port, 'POST', '/projects', { name: 'blocked', slug: 'blocked' }, bobVerified.body.token);
    assert.equal(bobOwnProjectBlocked.statusCode, 401);

    const bobProjects = await request(port, 'GET', '/projects', null, bobVerified.body.token);
    assert.equal(bobProjects.statusCode, 401);

    const bobGithub = await request(port, 'GET', '/auth/github/callback?email=bob%40example.com&githubId=gh-bob&login=bob&state=link-existing');
    assert.equal(bobGithub.statusCode, 200);
    assert.equal(bobGithub.body.linked, false);
    assert.equal(bobGithub.body.mode, 'oauth-callback-pending');
    const duplicateGithub = await request(port, 'GET', '/auth/github/callback?email=eve%40example.com&githubId=gh-bob&login=eve&state=duplicate-link');
    assert.equal(duplicateGithub.statusCode, 200);

    const approveBob = await request(port, 'POST', `/admin/users/${bobVerified.body.user.id}/approve`, { accountType: 'NON_CLUB' }, aliceLogin.body.token);
    assert.equal(approveBob.statusCode, 200);
    assert.equal(approveBob.body.approvalStatus, 'APPROVED');
    const bobQuota = await request(port, 'PATCH', `/admin/users/${bobVerified.body.user.id}/quota`, { maxProjects: 1, maxServices: 1 }, aliceLogin.body.token);
    assert.equal(bobQuota.statusCode, 200);
    const bobLogin = await request(port, 'POST', '/auth/login', { email: 'bob@example.com', password: 'correct-horse' });
    assert.equal(bobLogin.statusCode, 200);
    const bobProject = await request(port, 'POST', '/projects', { name: 'Bob API', slug: 'bob-api' }, bobLogin.body.token);
    assert.equal(bobProject.statusCode, 201);
    const bobService = await request(port, 'POST', `/projects/${bobProject.body.id}/services`, { name: 'web', type: 'web', sourceType: 'image', image: 'localhost:5000/bob/web:latest' }, bobLogin.body.token);
    assert.equal(bobService.statusCode, 201);
    const bobQuotaDenied = await request(port, 'POST', `/projects/${bobProject.body.id}/services`, { name: 'worker', type: 'worker', sourceType: 'image', image: 'localhost:5000/bob/worker:latest' }, bobLogin.body.token);
    assert.equal(bobQuotaDenied.statusCode, 403);

    const bobClub = await request(port, 'POST', `/admin/users/${bobVerified.body.user.id}/approve`, { accountType: 'CLUB_MEMBER' }, aliceLogin.body.token);
    assert.equal(bobClub.statusCode, 200);
    assert.equal(bobClub.body.accountType, 'CLUB_MEMBER');
    const bobClubLogin = await request(port, 'POST', '/auth/login', { email: 'bob@example.com', password: 'correct-horse' });
    assert.equal(bobClubLogin.statusCode, 200);
    assert.equal(bobClubLogin.body.user.accountType, 'CLUB_MEMBER');

    const rejectEve = await request(port, 'POST', `/admin/users/${eveVerified.body.user.id}/reject`, { confirmed: true }, aliceLogin.body.token);
    assert.equal(rejectEve.statusCode, 200);
    assert.equal(rejectEve.body.approvalStatus, 'REJECTED');
    const eveRejectedProject = await request(port, 'POST', '/projects', { name: 'eve', slug: 'eve' }, eveVerified.body.token);
    assert.equal(eveRejectedProject.statusCode, 401);
    const eveRejectedLogin = await request(port, 'POST', '/auth/login', { email: 'eve@example.com', password: 'correct-horse' });
    assert.equal(eveRejectedLogin.statusCode, 403);

    const envUpload = await request(port, 'POST', `/projects/${aliceProject.body.id}/services/${aliceService.body.id}/env-file`, {
      filename: '.env.production',
      content: 'PUBLIC_URL=https://alice.example\nDATABASE_URL=postgresql://alice:secret@db/app\nGITHUB_TOKEN=ghp_secret\n',
    }, aliceLogin.body.token);
    assert.equal(envUpload.statusCode, 200);
    assert.equal(envUpload.body.secretCount, 2);
    assert.equal(JSON.stringify(envUpload.body).includes('ghp_secret'), false);

    const envList = await request(port, 'GET', `/projects/${aliceProject.body.id}/services/${aliceService.body.id}/env`, null, aliceLogin.body.token);
    assert.equal(envList.statusCode, 200);
    assert.equal(envList.body.entries.some((entry) => entry.key === 'PUBLIC_URL' && entry.value === 'https://alice.example'), true);
    assert.equal(JSON.stringify(envList.body).includes('postgresql://alice:secret'), false);
    assert.equal(controlPlane.store.services.get(aliceService.body.id).desiredSpec.env.PUBLIC_URL, 'https://alice.example');
    assert.equal(controlPlane.store.services.get(aliceService.body.id).desiredSpec.env.DATABASE_URL, undefined);

    const github = await request(port, 'POST', '/integrations/github', { organizationId: aliceVerified.body.organization.id, accountLogin: 'alice', token: 'ghp_private_token' }, aliceLogin.body.token);
    assert.equal(github.statusCode, 201);
    assert.equal(github.body.provider, 'github');
    assert.equal(JSON.stringify(github.body).includes('ghp_private_token'), false);

    const attached = await request(port, 'POST', `/projects/${aliceProject.body.id}/services/${aliceService.body.id}/github`, { integrationId: github.body.id, repoUrl: 'https://github.com/alice/web', branch: 'main' }, aliceLogin.body.token);
    assert.equal(attached.statusCode, 403);
    assert.match(attached.body.error, /verified GitHub App installation/i);
    assert.equal(controlPlane.store.services.get(aliceService.body.id).repoUrl, undefined);
  } finally {
    server.close();
    if (previousAdminEmails === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = previousAdminEmails;
    if (previousCode === undefined) delete process.env.RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE; else process.env.RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE = previousCode;
  }
});

test('GitHub helpers normalize repositories and verify webhook signatures', () => {
  assert.deepEqual(parseGitHubRepository('alice/web'), { owner: 'alice', repo: 'web', fullName: 'alice/web', repoUrl: 'https://github.com/alice/web.git' });
  const body = JSON.stringify({ action: 'push' });
  const signature = `sha256=${crypto.createHmac('sha256', 'webhook-secret').update(body).digest('hex')}`;
  assert.equal(verifyGitHubWebhookSignature(body, signature, 'webhook-secret'), true);
  assert.equal(verifyGitHubWebhookSignature(body, signature, 'wrong-secret'), false);
  assert.equal(deterministicGitHubCallbackAllowed({ email: 'local@example.com' }, { NODE_ENV: 'test' }), true);
  assert.equal(deterministicGitHubCallbackAllowed({ email: 'prod@example.com' }, { NODE_ENV: 'production' }), false);
  assert.equal(deterministicGitHubCallbackAllowed({ email: 'prod@example.com' }, { NODE_ENV: 'production', RAIBITSERVER_GITHUB_OAUTH_LOCAL_CALLBACK: '1' }), true);
});

test('CLI parses env files and GitHub repo references without leaking secrets', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'raibitserver-env-'));
  const file = path.join(dir, '.env');
  await fs.writeFile(file, 'API_KEY=super-secret\nPUBLIC_URL=https://example.com\n');
  const env = await runCli(['env-parse', file]);
  assert.equal(env.secretCount, 1);
  assert.equal(JSON.stringify(env).includes('super-secret'), false);
  const repo = await runCli(['github-repo', 'alice/web']);
  assert.equal(repo.repoUrl, 'https://github.com/alice/web.git');
});

function request(port, method, requestPath, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {};
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request({ port, path: requestPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForEmailDeliveries(store, expected, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (store.emailDeliveries.length < expected) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${expected} email deliveries`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = process.execPath;
    import('node:child_process').then(({ spawn }) => {
      const proc = spawn(child, ['src/cli.js', ...args], { cwd: fileURLToPath(new URL('..', import.meta.url)) });
      const stdout = [];
      const stderr = [];
      proc.stdout.on('data', (chunk) => stdout.push(chunk));
      proc.stderr.on('data', (chunk) => stderr.push(chunk));
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code) reject(new Error(Buffer.concat(stderr).toString('utf8') || `cli exited ${code}`));
        else resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')));
      });
    }, reject);
  });
}
