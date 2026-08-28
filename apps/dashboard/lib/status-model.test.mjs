import test from 'node:test';
import assert from 'node:assert/strict';
import { createSystemStatusSnapshot, healthResultIsOperational, SYSTEM_STATUS_REFRESH_SECONDS } from './status-model.js';

test('status model reports an operational system only when API and data checks pass', () => {
  const snapshot = createSystemStatusSnapshot({
    apiResult: { ok: true, body: { status: 'ok' } },
    dataResult: { ok: true, body: { sites: [] } },
    apiLatencyMs: 12.6,
    dataLatencyMs: 18.2,
    checkedAt: '2026-08-27T00:00:00.000Z',
    gitSha: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
    githubRepository: 'jsk1004ha/RaibitServer',
  });

  assert.equal(snapshot.status, 'operational');
  assert.equal(snapshot.refreshIntervalSeconds, SYSTEM_STATUS_REFRESH_SECONDS);
  assert.deepEqual(snapshot.components.map((component) => component.status), ['operational', 'operational', 'operational']);
  assert.equal(snapshot.components[1].latencyMs, 13);
  assert.equal(snapshot.components[2].latencyMs, 18);
  assert.deepEqual(snapshot.deployment, {
    repository: 'jsk1004ha/RaibitServer',
    commitSha: 'abcdef0123456789abcdef0123456789abcdef01',
    shortCommitSha: 'abcdef012345',
    commitUrl: 'https://github.com/jsk1004ha/RaibitServer/commit/abcdef0123456789abcdef0123456789abcdef01',
  });
});

test('status model distinguishes a degraded data path from a control-plane outage', () => {
  const degraded = createSystemStatusSnapshot({
    apiResult: { ok: true, body: { status: 'healthy' } },
    dataResult: { ok: false, body: null },
  });
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.components.find((component) => component.id === 'data-store').status, 'degraded');

  const outage = createSystemStatusSnapshot({
    apiResult: { ok: false, body: { status: 'offline' } },
    dataResult: { ok: false, body: null },
  });
  assert.equal(outage.status, 'outage');
  assert.deepEqual(outage.components.map((component) => component.status), ['operational', 'outage', 'outage']);
});

test('health check requires a successful response with a known healthy status', () => {
  assert.equal(healthResultIsOperational({ ok: true, body: { status: 'ready' } }), true);
  assert.equal(healthResultIsOperational({ ok: true, body: { status: 'unknown' } }), false);
  assert.equal(healthResultIsOperational({ ok: false, body: { status: 'ok' } }), false);
});

test('status model never turns invalid deployment metadata into a link', () => {
  const snapshot = createSystemStatusSnapshot({
    apiResult: { ok: true, body: { status: 'ok' } },
    dataResult: { ok: true, body: { sites: [] } },
    gitSha: 'main',
    githubRepository: 'example/repo?next=https://attacker.invalid',
  });

  assert.deepEqual(snapshot.deployment, {
    repository: null,
    commitSha: null,
    shortCommitSha: null,
    commitUrl: null,
  });
});
