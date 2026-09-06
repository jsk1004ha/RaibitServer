import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import YAML from 'yaml';
import {
  ResourceBackupCreateSchema,
  ResourceBackupDeleteSchema,
  ResourceBackupListSchema,
  ResourceBackupViewSchema,
  ResourceRestoreCreateSchema,
  ResourceRestoreViewSchema,
} from '../packages/schemas/src/resource-recovery.ts';
import { apiOperations, createOpenApiDocument } from '../packages/schemas/src/api-contract.ts';
import { RAIBITSERVERClient } from '../packages/api-client/src/index.ts';

const backup = {
  id: 'backup_1', organizationId: 'org_1', projectId: 'project_1', resourceId: 'resource_1', engine: 'postgresql',
  status: 'READY', createdAt: '2026-09-04T00:00:00.000Z', readyAt: '2026-09-04T00:01:00.000Z', errorCode: null,
  size: '42', expiresAt: '2026-09-05T00:00:00.000Z', recoverable: true,
};
const restore = {
  id: 'restore_1', organizationId: 'org_1', projectId: 'project_1', backupId: backup.id, sourceResourceId: backup.resourceId,
  targetResourceId: 'resource_2', engine: 'postgresql', status: 'QUEUED', createdAt: '2026-09-04T00:02:00.000Z', readyAt: null, errorCode: null,
};

test('Given recovery request boundaries, When strict inputs are parsed, Then only the approved public fields are accepted', () => {
  // Given the five recovery request shapes.
  const backupRequest = { requestIdempotencyKey: 'backup-1', formatVersion: 1 };
  const restoreRequest = { requestIdempotencyKey: 'restore-1', formatVersion: 1, name: 'restored-db' };

  // When each boundary receives valid and capability-expanding inputs.
  const invalid = [
    () => ResourceBackupCreateSchema.parse({ ...backupRequest, artifactKey: 'private' }),
    () => ResourceRestoreCreateSchema.parse({ ...restoreRequest, targetResourceId: 'forged' }),
    () => ResourceBackupDeleteSchema.parse({ confirmed: false }),
    () => ResourceBackupDeleteSchema.parse({ confirmed: true, requestIdempotencyKey: 'not-allowed' }),
    () => ResourceBackupListSchema.parse({ after: 'legacy-cursor' }),
  ];

  // Then the public DTOs remain strict and private mutation controls never cross the boundary.
  assert.deepEqual(ResourceBackupCreateSchema.parse(backupRequest), backupRequest);
  assert.deepEqual(ResourceRestoreCreateSchema.parse(restoreRequest), restoreRequest);
  assert.deepEqual(ResourceBackupDeleteSchema.parse({ confirmed: true }), { confirmed: true });
  assert.equal(invalid.every((parse) => { try { parse(); return false; } catch { return true; } }), true);
  assert.equal(ResourceBackupViewSchema.safeParse({ ...backup, artifactKey: 'private' }).success, false);
  assert.equal(ResourceRestoreViewSchema.safeParse({ ...restore, workflowJob: {} }).success, false);
});

test('Given the recovery transport contract, When OpenAPI is generated, Then the five public routes retain methods, status and permissions', async () => {
  // Given generated Zod operations and the checked-in OpenAPI artifact.
  const generated = JSON.parse(JSON.stringify(createOpenApiDocument()));
  const artifact = YAML.parse(await import('node:fs/promises').then((fs) => fs.readFile(new URL('../openapi/raibitserver.yaml', import.meta.url), 'utf8')));
  const expected = [
    ['resource-backups-create', '/resources/{resourceId}/backups', 'post', 202, 'backup:manage'],
    ['resource-backups-list', '/resources/{resourceId}/backups', 'get', 200, 'backup:manage'],
    ['resource-backups-delete', '/backups/{backupId}', 'delete', 200, 'backup:manage'],
    ['backup-restores-create', '/backups/{backupId}/restores', 'post', 202, 'backup:restore'],
    ['restores-get', '/restores/{restoreId}', 'get', 200, 'backup:restore'],
  ];

  // When every declared recovery operation is inspected across both artifacts.
  const observed = expected.map(([operationId, path, method, status, permission]) => {
    const operation = generated.paths[path]?.[method];
    const published = artifact.paths[path]?.[method];
    return { operationId, path, method, status, permission, operation, published };
  });

  // Then status, permission, response projection and public query surface agree exactly.
  for (const item of observed) {
    assert.equal(apiOperations[item.operationId]?.status, item.status);
    assert.equal(apiOperations[item.operationId]?.permission, item.permission);
    assert.deepEqual(item.published, item.operation);
    assert.equal(item.operation['x-permission'], item.permission);
    assert.deepEqual(Object.keys(item.operation.responses).filter((status) => Number(status) >= 400 && status !== 'default').sort(), ['400', '403', '404', '409']);
  }
  const listParameters = generated.paths['/resources/{resourceId}/backups'].get.parameters.filter((parameter) => parameter.in === 'query');
  assert.deepEqual(listParameters.map((parameter) => parameter.name).sort(), ['cursor', 'limit']);
  assert.equal(generated.paths['/backups/{backupId}'].delete.requestBody.required, true);
});

test('Given a typed client, When the five recovery calls are sent, Then their exact public wire payloads are used', async () => {
  // Given an HTTP listener that returns the public recovery projections.
  const captured = [];
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    captured.push({ method: request.method, url: request.url, body });
    const payload = request.url?.startsWith('/resources/resource_1/backups') && request.method === 'GET'
      ? { backups: [backup], nextCursor: null }
      : request.url?.startsWith('/restores/') && request.method === 'GET'
        ? restore
        : request.url?.startsWith('/backups/backup_1/restores') ? restore : backup;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    // When the public client invokes creation, history, deletion, restore and restore status.
    const client = new RAIBITSERVERClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    await client.createBackup('resource_1', { requestIdempotencyKey: 'backup-1', formatVersion: 1 });
    await client.listBackups('resource_1', { limit: 200, cursor: 'next-cursor' });
    await client.deleteBackup('backup_1', { confirmed: true });
    await client.createRestore('backup_1', { requestIdempotencyKey: 'restore-1', formatVersion: 1, name: 'restored-db' });
    await client.getRestore('restore_1');

    // Then no internal IDs, jobs, artifacts, or legacy pagination fields reach the wire.
    assert.deepEqual(captured, [
      { method: 'POST', url: '/resources/resource_1/backups', body: JSON.stringify({ requestIdempotencyKey: 'backup-1', formatVersion: 1 }) },
      { method: 'GET', url: '/resources/resource_1/backups?limit=200&cursor=next-cursor', body: '' },
      { method: 'DELETE', url: '/backups/backup_1', body: JSON.stringify({ confirmed: true }) },
      { method: 'POST', url: '/backups/backup_1/restores', body: JSON.stringify({ requestIdempotencyKey: 'restore-1', formatVersion: 1, name: 'restored-db' }) },
      { method: 'GET', url: '/restores/restore_1', body: '' },
    ]);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
});
