import assert from 'node:assert/strict';
import test from 'node:test';
import { ResourceRecoveryRepository } from '../packages/core/src/resource-recovery.ts';
import { PostgresRecoveryTransaction } from '../packages/core/src/resource-recovery-postgres.ts';

const now = '2026-09-03T00:00:00.000Z';

test('same-user recovery writes across organizations serialize before quota evaluation', async () => {
  const sql = recoverySql();
  let committedUsage = 0;
  const enforceQuota = async () => {
    const observedUsage = committedUsage;
    if (observedUsage >= 1) throw new Error('quota exceeded');
    await new Promise((resolve) => setTimeout(resolve, 20));
    committedUsage += 1;
  };
  const repositories = [0, 1].map(() => new ResourceRecoveryRepository(new PostgresRecoveryTransaction(sql), enforceQuota));

  const results = await Promise.allSettled([
    repositories[0].createBackup(request('org_a', 'resource_a')),
    repositories[1].createBackup(request('org_b', 'resource_b')),
  ]);

  const outcomes = results.map((result) => result.status === 'fulfilled' ? 'fulfilled' : String(result.reason?.message));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1, JSON.stringify(outcomes));
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.message === 'quota exceeded').length, 1);
  assert.equal(committedUsage, 1);
  for (const transaction of sql.events) {
    assert.equal(transaction[0], 'user:user_same');
    assert.equal(transaction[1].startsWith('organization:'), true);
  }
});

function request(organizationId, sourceId) {
  return { organizationId, actorUserId: 'user_same', sourceId, body: { requestIdempotencyKey: sourceId, formatVersion: 1 }, now };
}

function recoverySql() {
  const rows = {
    org_a: state('a'),
    org_b: state('b'),
  };
  const tails = new Map();
  const events = [];
  return {
    events,
    async $transaction(work) {
      const transactionEvents = [];
      const releases = [];
      const tx = {
        async $queryRawUnsafe(query, ...values) {
          if (query.includes('pg_advisory_xact_lock')) {
            const key = String(values[0]);
            const previous = tails.get(key) ?? Promise.resolve();
            let release;
            tails.set(key, new Promise((resolve) => { release = resolve; }));
            await previous;
            releases.push(release);
            transactionEvents.push(`user:${key.replace('raibitserver:quota:', '')}`);
            return [{ locked: 1 }];
          }
          const organizationId = String(values[0]);
          const current = rows[organizationId];
          if (query.includes('FROM "Organization"')) {
            transactionEvents.push(`organization:${organizationId}`);
            return current ? [{ row: current.organization }] : [];
          }
          if (query.includes('FROM "Project" p WHERE')) return current ? [{ row: current.project }] : [];
          if (query.includes('FROM "Resource" r WHERE')) return current ? [{ row: current.resource }] : [];
          if (query.includes('FROM "Membership"')) return current ? [{ row: current.member }] : [];
          return [];
        },
        async $executeRawUnsafe() { return 1; },
      };
      try { return await work(tx); }
      finally {
        events.push(transactionEvents);
        for (const release of releases.reverse()) release();
      }
    },
  };
}

function state(suffix) {
  const organizationId = `org_${suffix}`;
  const projectId = `project_${suffix}`;
  return {
    organization: { id: organizationId },
    project: { id: projectId, organizationId, status: 'ACTIVE' },
    member: { organizationId, userId: 'user_same', role: 'OWNER' },
    resource: {
      id: `resource_${suffix}`, projectId, name: 'source', slug: 'source', type: 'database', engine: 'postgresql',
      provider: 'local', plan: 'shared-small', region: 'local', version: '16', status: 'READY', desiredSpec: { storageMb: 1024 },
      connectionSecretName: `resource-${suffix}-connection`, desiredState: {
        providerIdentity: { namespace: `org-${suffix}`, name: `resource-${suffix}` },
        credentialSecretUID: `credential-${suffix}`, credentialSecretGeneration: suffix.repeat(43),
        providerImageProvenance: { schema: 'raibitserver.provider-image/v1', image: `postgres@sha256:${suffix.repeat(64)}`, workloadUid: `workload-${suffix}`, workloadGeneration: 1, observedAt: now },
      },
    },
  };
}
