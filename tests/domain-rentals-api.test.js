import assert from 'node:assert/strict';
import test from 'node:test';
import { bootRentalRuntime } from './fixtures/domain-rentals-runtime.mjs';

const targetUrl = 'https://example.org/docs?version=1#intro';
test('rental API uses real authentication and shared custom-domain persistence', async (t) => {
  const fx = await bootRentalRuntime();
  t.after(() => fx.close());
  const custom = (token, hostname) => fx.request(token, `/projects/${fx.project.id}/domains`, { serviceId: fx.service.id, hostname });
  await t.test('unauthenticated management is rejected', async () => {
    assert.equal((await fx.request(null, '/domain-rentals')).status, 401);
  });
  await t.test('pre-existing normalized custom domain blocks rental create and rename', async () => {
    const { token } = await fx.account('occupied', 'CLUB_MEMBER');
    assert.equal((await custom(token, 'Taken.Raibit.Kr.')).status, 201);
    const blocked = await fx.request(token, '/domain-rentals', { name: 'taken', targetUrl });
    assert.equal(blocked.status, 409); assert.equal(blocked.body.error, 'DOMAIN_RENTAL_NAME_TAKEN');
    const row = await fx.request(token, '/domain-rentals', { name: 'free-name', targetUrl });
    assert.equal(row.status, 201);
    const renamed = await fx.request(token, `/domain-rentals/${row.body.id}/update`, { expectedVersion: 1, name: 'taken' });
    assert.equal(renamed.status, 409);
    const list = await fx.request(token, '/domain-rentals');
    assert.equal(list.body.rentals[0].hostname, 'free-name.raibit.kr');
    assert.equal(list.body.rentals[0].version, 1);
  });
  await t.test('rental blocks later custom domain and simultaneous claims have exactly one winner', async () => {
    const { token } = await fx.account('reverse', 'CLUB_MEMBER');
    assert.equal((await fx.request(token, '/domain-rentals', { name: 'rental-first', targetUrl })).status, 201);
    assert.equal((await custom(token, 'RENTAL-FIRST.RAIBIT.KR.')).status, 409);
    for (let i = 0; i < 3; i++) {
      const name = `concurrent-${i}`;
      const responses = await Promise.all([
        fx.request(token, '/domain-rentals', { name, targetUrl }), custom(token, `${name}.raibit.kr`),
      ]);
      assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
      const rentals = (await fx.request(token, '/domain-rentals')).body.rentals;
      const rentalCount = rentals.filter((r) => r.hostname === `${name}.raibit.kr`).length;
      const domainCount = [...fx.store.domains.values()].filter((r) => r.hostname === `${name}.raibit.kr`).length;
      assert.equal(rentalCount + domainCount, 1);
    }
  });
  await t.test('development domains keep environment scope and share rental hostname claims', async () => {
    const previous = process.env.RAIBITSERVER_OPERATIONAL_FEATURES_ENABLED;
    process.env.RAIBITSERVER_OPERATIONAL_FEATURES_ENABLED = '1';
    try {
      const { token } = await fx.account('dev-domain', 'CLUB_MEMBER');
      const environment = fx.store.createEnvironment({ projectId: fx.project.id, kind: 'dev', expectedVersion: 0 });
      const service = fx.store.createService({ projectId: fx.project.id, environmentId: environment.id, name: 'Web', type: 'web' });
      const path = `/projects/${fx.project.id}/domains`;
      const input = { serviceId: service.id, hostname: 'dev-only.raibit.kr', environmentId: environment.id };
      const wrongScope = await fx.request(token, path, { ...input, environmentKind: 'prod' });
      assert.equal(wrongScope.status, 404);
      assert.equal((await fx.request(token, path, input)).status, 201);
      assert.equal((await fx.request(token, path)).body.domains.some(row => row.hostname === input.hostname), false);
      const selected = await fx.request(token, `${path}?environmentId=${environment.id}`);
      assert.equal(selected.status, 200);
      assert.equal(selected.body.domains.some(row => row.hostname === input.hostname), true);
      const rental = await fx.request(token, '/domain-rentals', { name: 'dev-only', targetUrl });
      assert.equal(rental.status, 409);
      assert.equal(rental.body.error, 'DOMAIN_RENTAL_NAME_TAKEN');
    } finally {
      if (previous === undefined) delete process.env.RAIBITSERVER_OPERATIONAL_FEATURES_ENABLED;
      else process.env.RAIBITSERVER_OPERATIONAL_FEATURES_ENABLED = previous;
    }
  });
  await t.test('2/5 limits come from current account and paused addresses count', async () => {
    for (const [type, limit] of [['NON_CLUB', 2], ['CLUB_MEMBER', 5]]) {
      const { token } = await fx.account(`quota-${limit}`, type);
      const responses = await Promise.all(Array.from({ length: limit + 2 }, (_, i) =>
        fx.request(token, '/domain-rentals', { name: `quota-${limit}-${i}`, targetUrl, enabled: false })));
      assert.equal(responses.filter((r) => r.status === 201).length, limit);
      assert.equal(responses.filter((r) => r.status === 409).length, 2);
      const list = (await fx.request(token, '/domain-rentals')).body;
      assert.equal(list.limit, limit); assert.equal(list.used, limit); assert.equal(list.remaining, 0);
    }
  });
  await t.test('foreign ownership and stale version never mutate or delete', async () => {
    const owner = await fx.account('version-owner'); const foreign = await fx.account('version-other');
    const row = (await fx.request(owner.token, '/domain-rentals', { name: 'version-check', targetUrl })).body;
    for (const op of ['update', 'delete']) {
      const body = { expectedVersion: 1, ...(op === 'update' ? { enabled: false } : {}) };
      assert.equal((await fx.request(foreign.token, `/domain-rentals/${row.id}/${op}`, body)).status, 404);
    }
    assert.equal((await fx.request(owner.token, `/domain-rentals/${row.id}/update`, { expectedVersion: 1, enabled: false })).status, 200);
    assert.equal((await fx.request(owner.token, `/domain-rentals/${row.id}/delete`, { expectedVersion: 1 })).status, 409);
    assert.equal((await fx.request(owner.token, '/domain-rentals')).body.used, 1);
    assert.equal((await fx.request(owner.token, `/domain-rentals/${row.id}/delete`, { expectedVersion: 2 })).status, 200);
    assert.equal((await fx.request(owner.token, '/domain-rentals')).body.remaining, 2);
  });
});
