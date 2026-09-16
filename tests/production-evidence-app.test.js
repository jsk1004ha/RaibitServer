import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createEvidenceServer } from '../examples/production-evidence-app/server.js';

test('Given an evidence app, HTTP proves database readback and refuses unavailable or invalid evidence', async (t) => {
  const payload = {
    runId: '931d8867-3e75-4e99-95c9-1d953d2b25ca',
    deploymentId: 'deployment-fixture-1',
    nonce: 'a'.repeat(64),
  };
  const logs = [];
  const calls = [];
  const rows = new Map();
  let available = true;
  let corruptRead = false;
  const database = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (!available) throw new Error('postgresql://private:password@database/private?token=secret');
      if (/^SELECT 1\b/.test(sql)) return { rows: [{ ready: 1 }] };
      if (/^CREATE TABLE IF NOT EXISTS\b/.test(sql)) return { rows: [] };
      if (/^INSERT INTO\b/.test(sql)) {
        assert.match(sql, /VALUES \(\$1, \$2, \$3\)/);
        assert.deepEqual(values, [payload.runId, payload.deploymentId, payload.nonce]);
        rows.set(JSON.stringify(values), values[2]);
        return { rows: [], rowCount: 1 };
      }
      if (/^SELECT nonce\b/.test(sql)) {
        assert.match(sql, /run_id = \$1 AND deployment_id = \$2 AND nonce = \$3/);
        const nonce = rows.get(JSON.stringify(values));
        return { rows: nonce ? [{ nonce: corruptRead ? 'b'.repeat(64) : nonce }] : [] };
      }
      throw new Error('unexpected database query');
    },
  };
  const server = createEvidenceServer(database, (event) => logs.push(event));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${origin}/_evidence/db`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  const live = await fetch(`${origin}/healthz/live`);
  assert.equal(live.status, 200);
  assert.equal(calls.length, 0);
  const ready = await fetch(`${origin}/healthz/ready`);
  assert.equal(ready.status, 200);
  assert.match(calls[0].sql, /^SELECT 1\b/);
  const written = await post(payload);
  assert.equal(written.status, 200);
  assert.deepEqual(await written.json(), { nonce: payload.nonce, readBack: payload.nonce });
  const insert = calls.findIndex(({ sql }) => /^INSERT INTO\b/.test(sql));
  assert.match(calls[insert + 1].sql, /^SELECT nonce\b/);
  assert.deepEqual(logs.at(-1), {
    level: 'info', event: 'evidence.db.completed', runId: payload.runId,
    deploymentId: payload.deploymentId, correlationId: payload.nonce,
  });

  const beforeInvalid = calls.length;
  for (const body of [
    { ...payload, runId: 'not-a-uuid' }, { ...payload, deploymentId: '../private' },
    { ...payload, nonce: 'A'.repeat(64) }, { ...payload, extra: 'secret' }, '{',
  ]) assert.equal((await post(body)).status, 400);
  assert.equal((await post(' '.repeat(4097))).status, 413);
  assert.equal(calls.length, beforeInvalid);
  assert.equal((await fetch(`${origin}/_evidence/db`)).status, 405);

  corruptRead = true;
  assert.equal((await post(payload)).status, 503);
  available = false;
  assert.equal((await fetch(`${origin}/healthz/ready`)).status, 503);
  assert.equal((await post(payload)).status, 503);
  assert.equal((await fetch(`${origin}/healthz/live`)).status, 200);
  assert.deepEqual(logs.at(-1), {
    level: 'error', event: 'evidence.db.failed', runId: payload.runId,
    deploymentId: payload.deploymentId, correlationId: payload.nonce,
  });
  assert.doesNotMatch(JSON.stringify(logs), /private|password|token|Bearer|secret|DATABASE_URL/);
});
