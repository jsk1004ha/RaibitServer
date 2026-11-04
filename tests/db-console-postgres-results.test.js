import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { runDbConsoleQuery } from '../packages/core/src/db-console.ts';
import { queryState } from './fixtures/db-console-prisma.mjs';

const fixtureUrl = new URL('./fixtures/db-console-prisma.mjs', import.meta.url).href;
const resource = {
  engine: 'postgresql',
  providerConnection: { databaseUrl: 'postgresql://fixture.invalid/console' },
};

test('PostgreSQL console returns precision-preserving JSON values within the result byte limit', async (t) => {
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === '@prisma/client') return { url: fixtureUrl, shortCircuit: true };
      return next(specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  queryState.rows = [
    { id: 9223372036854775807n, count: 1n, nested: { values: [-9223372036854775808n, null] }, title: '한글', createdAt: new Date('2026-11-03T00:00:00.000Z') },
  ];
  queryState.statements = [];
  queryState.disconnects = 0;
  const result = await runDbConsoleQuery(resource, 'SELECT * FROM notes', { role: 'maintainer' });
  const response = JSON.parse(JSON.stringify(result));
  assert.deepEqual(response.rows, [{
    id: '9223372036854775807',
    count: '1',
    nested: { values: ['-9223372036854775808', null] },
    title: '한글',
    createdAt: '2026-11-03T00:00:00.000Z',
  }]);
  assert.ok(queryState.statements.includes('SET TRANSACTION READ ONLY'));
  assert.equal(queryState.disconnects, 1);

  queryState.rows = [
    { id: 9223372036854775807n, title: '가'.repeat(200) },
    { id: 9223372036854775806n, title: '나'.repeat(200) },
  ];
  const bounded = await runDbConsoleQuery(resource, 'SELECT * FROM notes', { role: 'maintainer', maxResultBytes: 1024 });
  assert.equal(bounded.rows.length, 1);
  assert.equal(bounded.rows[0].id, '9223372036854775807');
  assert.ok(Buffer.byteLength(JSON.stringify(bounded.rows)) <= 1024);
  assert.equal(bounded.rowCount, 1);
  assert.equal(queryState.disconnects, 2);
});
