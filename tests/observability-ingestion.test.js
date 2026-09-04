import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { sanitizeLogRecord } from '../packages/core/src/security.ts';
import * as observability from '../packages/core/src/observability.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { createApiHandler } from '../packages/core/src/api.ts';
import { decodeKeysetCursor } from '../packages/core/src/store-helpers.ts';
import { projectObservationPayload } from '../packages/core/src/observability-projection.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/observability-redaction-v1.json', import.meta.url)));
for (const item of fixture.cases) {
  test('ingestion adversarial matrix masks ' + item.name, () => {
    // Given a synthetic source record, when it crosses the shared boundary.
    const result = sanitizeLogRecord(item.input);
    // Then assert equality as a boolean so failing artifacts never echo secrets.
    assert.equal(result === item.expected, true, item.name);
    assert.equal(sanitizeLogRecord(result) === result, true, 'idempotent');
  });
}
test('ingestion adversarial matrix bounds UTF8 and nested records', () => {
  // Given hostile size and depth, when sanitized.
  let nested = {password: 'FORBIDDEN_NESTED'};
  for (let i = 0; i < 100; i++) nested = {child: nested};
  const result = sanitizeLogRecord({line:'한'.repeat(20000), nested, password:'FORBIDDEN_OBJECT'});
  // Then all output is finite and contains no secret.
  assert.equal(Buffer.byteLength(result.line) <= 16384, true);
  assert.equal(JSON.stringify(result).includes('FORBIDDEN_'), false);
  assert.equal(Buffer.byteLength(JSON.stringify(result)) < 65536, true);
});
test('ingestion adversarial matrix persists nonsecret PEM continuation across restart', () => {
  // Given split records and a JSON-roundtripped continuation.
  assert.equal(typeof observability.sanitizeObservationLine, 'function');
  let state = {v:1,pem:false};
  for (const record of fixture.streams[0].records) {
    // When the next source record resumes after restart.
    const result = observability.sanitizeObservationLine(record.input, JSON.parse(JSON.stringify(state)));
    // Then only boolean context survives, never private bytes.
    assert.equal(result.line === record.expected, true);
    assert.deepEqual(result.state, {v:1,pem:record.pemAfter});
    state = result.state;
  }
});
test('runtime log writer keeps PEM state separate for same-name pod incarnations', () => {
  // Given two producer-supplied immutable source IDs behind the same mutable pod name.
  const plane = new RAIBITSERVERControlPlane();
  const org = plane.store.createOrganization({name:'Runtime identity fixture',plan:'club'});
  const project = plane.store.createProject({organizationId:org.id,name:'identity'});
  const service = plane.store.createService({projectId:project.id,name:'web',type:'web'});
  const deployment = plane.store.createDeployment({serviceId:service.id,status:'READY'});
  const first = plane.store.appendRuntimeLog({serviceId:service.id,deploymentId:deployment.id,podName:'web-0',sourceInstanceId:'pod-incarnation-a',containerName:'app',line:'-----BEGIN PRIVATE KEY-----'});
  const second = plane.store.appendRuntimeLog({serviceId:service.id,deploymentId:deployment.id,podName:'web-0',sourceInstanceId:'pod-incarnation-b',containerName:'app',line:'healthy incarnation'});
  // When both rows share one response projection, then one incarnation's PEM cursor cannot mask the other.
  const projected = projectObservationPayload({logs:[first,second]});
  assert.notEqual(first.podUid,second.podUid);
  assert.equal(projected.logs[0].line,'****');
  assert.equal(projected.logs[1].line,'healthy incarnation');
});
test('runtime log writer rejects a missing immutable source instance', () => {
  // Given a runtime record containing only mutable naming fields.
  const plane = new RAIBITSERVERControlPlane();
  // When the public writer is called, then it rejects instead of synthesizing identity from names.
  assert.throws(() => plane.store.appendRuntimeLog({serviceId:'service',deploymentId:'deployment',podName:'web-0',containerName:'app',line:'unsafe identity'}), /immutable source instance/i);
});
test('correlated ingestion happy path masks writes and legacy HTTP JSON/SSE with complete-row cursor', async () => {
  // Given actual repository and HTTP adapter with legacy unmasked rows.
  const plane = new RAIBITSERVERControlPlane();
  const org = plane.store.createOrganization({name:'Observability fixture',plan:'club'});
  const project = plane.store.createProject({organizationId:org.id,name:'demo'});
  const service = plane.store.createService({projectId:project.id,name:'web',type:'web'});
  for (const item of fixture.cases) {
    const row = plane.store.appendRuntimeLog({serviceId:service.id,sourceInstanceId:'fixture-runtime-source',line:item.input});
    assert.equal(row.line === item.expected,true,item.name);
  }
  plane.store.runtimeLogs = Array.from({length:1001}, (_,i) => ({
    id:'log-'+String(i).padStart(5,'0'),serviceId:service.id,deploymentId:'legacy-deployment',
    podName:'legacy-pod',podUid:'legacy-pod-uid',containerName:'app',timestamp:'2026-09-03T00:00:00.000Z',
    line:'Authorization: Basic Rk9SQklEREVOX0JBU0lD\n'+'한'.repeat(5000),
  }));
  const server = http.createServer(createApiHandler(plane,{auth:{mode:'disabled',allowDisabled:true}}));
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const base = 'http://127.0.0.1:'+server.address().port;
  try {
    // When reading the real JSON and SSE surfaces.
    const json = await fetch(base+'/services/'+service.id+'/logs?limit=1000').then(r=>r.text());
    const stream = await fetch(base+'/services/'+service.id+'/logs/stream').then(r=>r.text());
    const page = JSON.parse(json);
    // Then rows remain whole, bounded, sanitized and the cursor identifies the last returned row.
    assert.equal(Buffer.byteLength(json)<=524288,true);
    assert.equal(Buffer.byteLength(stream)<=524288,true);
    assert.equal(json.includes('Rk9SQklEREVO'),false);
    assert.equal(stream.includes('Rk9SQklEREVO'),false);
    assert.equal(page.logs.length>0 && page.logs.length<=1000,true);
    assert.equal(decodeKeysetCursor(page.nextCursor).id,page.logs.at(-1).id);
    const next = await fetch(base+'/services/'+service.id+'/logs?limit=1000&cursor='+page.nextCursor).then(r=>r.json());
    if (next.logs.length) assert.equal(next.logs[0].id > page.logs.at(-1).id,true);
    else assert.equal(page.logs.length,1000);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
});
