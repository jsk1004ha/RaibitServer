import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { createApiHandler } from '../packages/core/src/api.ts';

test('HTTP JSON and SSE mask legacy quoted bodies at fresh page boundaries', async () => {
  // Given the real HTTP adapter and three legacy rows bypassing current ingestion.
  const plane = new RAIBITSERVERControlPlane();
  const org = plane.store.createOrganization({ name: 'Redaction review', plan: 'club' });
  const project = plane.store.createProject({ organizationId: org.id, name: 'logs' });
  const service = plane.store.createService({ projectId: project.id, name: 'web', type: 'web' });
  const source = { serviceId: service.id, deploymentId: 'deployment-review', podUid: 'pod-review', containerName: 'app', timestamp: '2026-09-13T00:00:00.000Z' };
  const canary = 'AuditSyntheticValue_97531';
  plane.store.runtimeLogs = [
    { ...source, id: 'log-1', line: 'POSTGRES_PASSWORD="begin' },
    { ...source, id: 'log-2', line: canary },
    { ...source, id: 'log-3', line: 'end" ready=true' },
  ];
  const server = http.createServer(createApiHandler(plane, { auth: { mode: 'disabled', allowDisabled: true } }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    // When a fresh latest page starts inside the quote and its cursor is followed.
    const response = await fetch(base + '/services/' + service.id + '/logs?limit=2');
    const page = await response.json();
    const next = await fetch(base + '/services/' + service.id + '/logs?limit=2&cursor=' + encodeURIComponent(page.nextCursor));
    const nextPage = await next.json();
    const stream = await fetch(base + '/services/' + service.id + '/logs/stream').then(result => result.text());
    // Then the actual HTTP surfaces retain useful suffixes without returning secret content.
    assert.equal(response.status, 200);
    assert.equal(next.status, 200);
    assert.deepEqual(page.logs.map(row => row.line), ['****', '****" ready=true']);
    assert.equal(JSON.stringify([page, nextPage, stream]).includes(canary), false);
    assert.equal(stream.includes('ready=true'), true);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
