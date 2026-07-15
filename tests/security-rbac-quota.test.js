import test from 'node:test';
import assert from 'node:assert/strict';
import { guardDatabaseQuery, sanitizeLogRecord, sanitizeTenantServiceInput, secureContainerDefaults, validateServiceSecurity } from '../packages/core/src/security.ts';
import { ControlPlaneStore } from '../packages/core/src/store.ts';
import { sealSecret } from '../packages/core/src/secret-vault.ts';
import { can, visibleEnvironment } from '../packages/core/src/rbac.ts';
import { checkQuota, quotaUsageGauges, quotaWarnings } from '../packages/core/src/quota.ts';


test('security validator blocks privileged and hostPath workloads', () => {
  const result = validateServiceSecurity({
    name: 'bad',
    privileged: true,
    hostPID: true,
    hostIPC: true,
    automountServiceAccountToken: true,
    volumes: [{ name: 'host', hostPath: '/var/run/docker.sock' }],
    volumeMounts: [{ name: 'cache', mountPath: '/var/cache' }],
    securityContext: {
      runAsUser: 0,
      allowPrivilegeEscalation: true,
      readOnlyRootFilesystem: false,
      capabilities: { add: ['NET_ADMIN'] },
      seccompProfile: { type: 'Unconfined' },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings.filter((finding) => finding.level === 'block').length >= 10, true);
});

test('container security context ignores unsafe user overrides', () => {
  const context = secureContainerDefaults({
    securityContext: {
      privileged: true,
      runAsUser: 0,
      allowPrivilegeEscalation: true,
      readOnlyRootFilesystem: false,
      capabilities: { add: ['SYS_ADMIN'], drop: [] },
      seccompProfile: { type: 'Unconfined' },
    },
  });
  assert.equal(context.privileged, false);
  assert.equal(context.runAsNonRoot, true);
  assert.equal(context.runAsUser, 10001);
  assert.equal(context.allowPrivilegeEscalation, false);
  assert.equal(context.readOnlyRootFilesystem, true);
  assert.deepEqual(context.capabilities, { drop: ['ALL'] });
  assert.deepEqual(context.seccompProfile, { type: 'RuntimeDefault' });
});

test('tenant runtime command sanitizer accepts only bounded string arrays', () => {
  const safe = sanitizeTenantServiceInput({
    name: 'worker',
    command: ['node', 'worker.js'],
    args: ['--queue', 'critical jobs'],
    desiredSpec: { command: ['node', 'spec.js'], args: ['--once'] },
  });
  assert.deepEqual(safe.command, ['node', 'worker.js']);
  assert.deepEqual(safe.args, ['--queue', 'critical jobs']);
  assert.deepEqual(safe.desiredSpec.command, ['node', 'spec.js']);
  assert.deepEqual(safe.desiredSpec.args, ['--once']);

  for (const input of [
    { command: 'sh -c "curl attacker"' },
    { args: '--unsafe scalar' },
    { command: ['node', ''] },
    { args: Array.from({ length: 65 }, (_, index) => `arg-${index}`) },
    { desiredSpec: { command: ['node', 42], args: ['--ok'] } },
  ]) {
    const sanitized = sanitizeTenantServiceInput(input);
    assert.equal(sanitized.command, undefined);
    assert.equal(sanitized.args, undefined);
    if (sanitized.desiredSpec) assert.equal(sanitized.desiredSpec.command, undefined);
  }
});

test('query guard requires confirmation for destructive queries', () => {
  assert.equal(guardDatabaseQuery('DROP TABLE users').allowed, false);
  assert.equal(guardDatabaseQuery('DROP TABLE users', { confirmed: true, role: 'db-admin' }).allowed, true);
  assert.equal(guardDatabaseQuery('DELETE FROM users').allowed, false);
  assert.equal(guardDatabaseQuery('UPDATE users SET admin = true WHERE id = 1').allowed, false);
  assert.equal(guardDatabaseQuery("INSERT INTO users(email) VALUES ('a@example.com')").allowed, false);
  assert.equal(guardDatabaseQuery('UPDATE users SET admin = true WHERE id = 1', { confirmed: true }).allowed, false);
  assert.equal(guardDatabaseQuery('UPDATE users SET admin = true WHERE id = 1', { confirmed: true, role: 'admin' }).allowed, false);
  assert.equal(guardDatabaseQuery('UPDATE users SET admin = true WHERE id = 1', { confirmed: true, role: 'db-admin' }).allowed, true);
  assert.equal(guardDatabaseQuery('CALL rotate_keys()', { role: 'developer', confirmed: true }).allowed, false);
  assert.equal(guardDatabaseQuery('COPY users TO STDOUT', { role: 'developer', confirmed: true }).allowed, false);
  assert.equal(guardDatabaseQuery('REFRESH MATERIALIZED VIEW reporting', { role: 'developer', confirmed: true }).allowed, false);
  assert.equal(guardDatabaseQuery('CALL rotate_keys()', { role: 'db-admin', confirmed: true }).allowed, true);
  assert.equal(guardDatabaseQuery('SELECT * FROM users', { role: 'viewer' }).allowed, false);
  assert.equal(guardDatabaseQuery('SELECT * FROM users', { role: 'developer' }).allowed, false);
  assert.equal(guardDatabaseQuery('SELECT * FROM users', { role: 'maintainer' }).allowed, true);
  assert.equal(guardDatabaseQuery('UPDATE users SET admin = true', { role: 'viewer' }).allowed, false);
});

test('secret-looking log values are masked', () => {
  const line = sanitizeLogRecord('DATABASE_URL=postgres://user:pass@host/db TOKEN=abc123 OK=yes');
  assert.match(line, /DATABASE_URL=\*\*\*\*/);
  assert.match(line, /TOKEN=\*\*\*\*/);
  const structured = sanitizeLogRecord({ message: 'Bearer ghp_private', nested: { password: 'top-secret', line: 'api_key=raw-key' } });
  assert.equal(structured.message, 'Bearer ****');
  assert.equal(structured.nested.password, 'to****et');
  assert.equal(structured.nested.line, 'api_key=****');
});

test('RBAC and quota helpers model governance constraints', () => {
  assert.equal(can('owner', 'db:delete'), true);
  assert.equal(can('viewer', 'db:delete'), false);
  assert.deepEqual(visibleEnvironment({ DATABASE_URL: 'secret' }, 'viewer'), {});
  const quota = checkQuota({ plan: 'free', current: { apps: 3 }, requested: { apps: 1 } });
  assert.equal(quota.ok, false);
});


test('quota enforcement accounts for existing project and service usage', () => {
  const store = new ControlPlaneStore();
  const org = store.createOrganization({ name: 'Quota Org', slug: 'quota-org' });
  const user = store.createUser({ email: 'quota@example.com', name: 'Quota User', approvalStatus: 'APPROVED', accountType: 'NON_CLUB' });
  store.addMember({ organizationId: org.id, userId: user.id, role: 'owner' });
  store.setQuota({ userId: user.id, maxProjects: 1, maxServices: 1 });
  const project = store.createProject({ organizationId: org.id, name: 'one', slug: 'one' });
  store.createService({ projectId: project.id, name: 'web' });

  assert.throws(() => store.enforceUserCan({ userId: user.id, action: 'project:create', metric: 'maxProjects', increment: 1 }), /quota exceeded: maxProjects/);
  assert.throws(() => store.enforceUserCan({ userId: user.id, action: 'service:create', metric: 'maxServices', increment: 1 }), /quota exceeded: maxServices/);
  assert.equal(store.auditLogs.filter((row) => row.action === 'quota:block').length, 2);
});

test('quota usage includes build minutes, runtime hours, CPU, and memory', () => {
  const store = new ControlPlaneStore();
  const org = store.createOrganization({ name: 'Usage Org', slug: 'usage-org' });
  const user = store.createUser({ email: 'usage@example.com', name: 'Usage User', approvalStatus: 'APPROVED', accountType: 'NON_CLUB' });
  store.addMember({ organizationId: org.id, userId: user.id, role: 'owner' });
  const project = store.createProject({ organizationId: org.id, name: 'usage', slug: 'usage' });
  const service = store.createService({ projectId: project.id, name: 'web', desiredSpec: { resources: { requests: { cpu: '500m', memory: '512Mi' } } } });
  store.recordUsage({ userId: user.id, organizationId: org.id, projectId: project.id, serviceId: service.id, metric: 'build-minutes', value: 7 });
  store.recordUsage({ userId: user.id, organizationId: org.id, projectId: project.id, serviceId: service.id, metric: 'runtime-hours', value: 3 });
  const usage = store.quotaUsageForUser(user.id);
  assert.equal(usage.maxBuildMinutesPerMonth, 7);
  assert.equal(usage.maxRuntimeHoursPerMonth, 3);
  assert.equal(usage.maxCpuMillicores, 500);
  assert.equal(usage.maxMemoryMb, 512);
  const gauges = quotaUsageGauges(usage, { maxBuildMinutesPerMonth: 8, maxRuntimeHoursPerMonth: 10, accountType: 'NON_CLUB' });
  assert.equal(gauges.find((gauge) => gauge.metric === 'maxBuildMinutesPerMonth').level, 'warning');
  assert.equal(quotaWarnings(usage, { maxBuildMinutesPerMonth: 7 })[0].code, 'QUOTA_EXHAUSTED');
});

test('monthly quota usage excludes usage records and deployment time outside the current UTC month', () => {
  const store = new ControlPlaneStore();
  const org = store.createOrganization({ name: 'Monthly Org', slug: 'monthly-org' });
  const user = store.createUser({ email: 'monthly@example.com', name: 'Monthly User', approvalStatus: 'APPROVED' });
  store.addMember({ organizationId: org.id, userId: user.id, role: 'owner' });
  const project = store.createProject({ organizationId: org.id, name: 'monthly', slug: 'monthly' });
  const service = store.createService({ projectId: project.id, name: 'web' });
  const now = new Date();
  const previousMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
  const currentMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 2));

  store.recordUsage({ userId: user.id, serviceId: service.id, metric: 'build-minutes', value: 99, recordedAt: previousMonth.toISOString() });
  store.recordUsage({ userId: user.id, serviceId: service.id, metric: 'build-minutes', value: 4, recordedAt: currentMonth.toISOString() });
  const oldDeployment = store.createDeployment({ projectId: project.id, serviceId: service.id });
  store.updateDeployment(oldDeployment.id, {
    buildStartedAt: new Date(previousMonth.getTime()).toISOString(),
    buildFinishedAt: new Date(previousMonth.getTime() + 60 * 60_000).toISOString(),
    deployedAt: new Date(previousMonth.getTime()).toISOString(),
    finishedAt: new Date(previousMonth.getTime() + 10 * 3_600_000).toISOString(),
  });

  const usage = store.quotaUsageForUser(user.id);
  assert.equal(usage.maxBuildMinutesPerMonth, 4);
  assert.equal(usage.maxRuntimeHoursPerMonth, 0);
});

test('production secret sealing requires a runtime encryption key', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousEncryptionKey = process.env.ENCRYPTION_KEY;
  const previousRaibitKey = process.env.RAIBITSERVER_SECRET_ENCRYPTION_KEY;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.ENCRYPTION_KEY;
    delete process.env.RAIBITSERVER_SECRET_ENCRYPTION_KEY;
    assert.throws(() => sealSecret('secret'), /ENCRYPTION_KEY/);
    assert.doesNotThrow(() => sealSecret('secret', { encryptionKey: 'x'.repeat(32) }));
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = previousEncryptionKey;
    if (previousRaibitKey === undefined) delete process.env.RAIBITSERVER_SECRET_ENCRYPTION_KEY; else process.env.RAIBITSERVER_SECRET_ENCRYPTION_KEY = previousRaibitKey;
  }
});
