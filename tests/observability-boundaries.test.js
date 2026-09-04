import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PEM_CONTEXT_LIMITS, PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';
import { boundedDnsLabel, identityDnsLabel, tenantProjectLabel } from '../packages/core/src/domain-router.ts';
import { sanitizeObservationLine } from '../packages/core/src/observability-redaction.ts';
import { createObservationProjectionContinuation, maskedObservationRows, projectObservationPayload } from '../packages/core/src/observability-projection.ts';

test('runtime identity fixture matches existing TypeScript naming primitives', () => {
  // Given the frozen Go/TypeScript shared corpus, when existing naming primitives derive identity.
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/observability-runtime-identity-v1.json', import.meta.url)));
  for (const item of fixture.cases) {
    const {project,service,deployment,expected} = item;
    const base = boundedDnsLabel(service.slug,63,service.id);
    const name = deployment.deploymentType === 'preview' ? identityDnsLabel('pr-'+deployment.pullRequestNumber+'-'+base,deployment.id) : base;
    let workload = name;
    if (service.type === 'cron') workload = boundedDnsLabel(name,52,service.id+'\0'+name);
    if (service.type === 'job') workload = boundedDnsLabel(name,50,name)+'-'+createHash('sha256').update(deployment.id).digest('hex').slice(0,12);
    // Then each independently frozen expected name is exact.
    assert.deepEqual({namespace:tenantProjectLabel(project.organizationId,project.slug,project.organizationId+'\0'+project.id),serviceName:name,workloadName:workload,containerName:name},
      {namespace:expected.namespace,serviceName:expected.serviceName,workloadName:expected.workloadName,containerName:expected.containerName});
  }
});

test('redaction consumes escaped quotes and truncated quoted assignments', () => {
  // Given JSON strings with escaped quotes, or an interrupted quoted value.
  const inputs = [
    '{"password":"prefix\\\"FORBIDDEN_ESCAPED_SUFFIX","ok":true}',
    '{"password":"FORBIDDEN_TRUNCATED',
    'password=plain\\FORBIDDEN_BACKSLASH',
  ];
  // When sanitized, then no source secret suffix survives.
  for (const input of inputs) assert.equal(sanitizeObservationLine(input).line.includes('FORBIDDEN_'),false);
});

test('projection preserves empty stream cursor and handles combined event/log budget', () => {
  // Given a previously delivered cursor and two full row streams.
  const at = '2026-09-03T00:00:00.000Z';
  const cursor = Buffer.from(JSON.stringify({v:1,at,id:'previous'})).toString('base64url');
  const empty = projectObservationPayload({logs:[],logCursor:cursor});
  // When an empty page arrives, then it does not rewind the caller.
  assert.equal(empty.logCursor,cursor);
  const rows = Array.from({length:200},(_,i)=>({id:String(i),timestamp:at,line:'x'.repeat(16000)}));
  const result = projectObservationPayload({logs:rows,events:rows,logCursor:cursor,eventCursor:cursor});
  assert.equal(Buffer.byteLength(JSON.stringify(result))<=524288,true);
  assert.equal(result.logs.length>0,true);
  if (result.events.length===0) assert.equal(result.eventCursor,cursor);
});

test('a wide legacy metadata object cannot block complete-row cursor progress', () => {
  // Given many long keys rather than large string values.
  const wide = Object.fromEntries(Array.from({length:64},(_,i)=>[String(i)+'x'.repeat(255),0]));
  const row = {id:'wide-row',timestamp:'2026-09-03T00:00:00.000Z',metadata:Array.from({length:64},()=>({...wide}))};
  // When the row is projected, then bounded metadata leaves room for the row and its cursor.
  const rows = maskedObservationRows([row]);
  assert.equal(rows.length,1);
  assert.equal(Buffer.byteLength(JSON.stringify(rows))<262144,true);
});

test('Given a PEM end row beyond the byte prefix, When it is replayed, Then the source state rolls back with the cursor', () => {
  // Given one immutable runtime source and a payload whose service metadata consumes most of the response budget.
  const continuation = createObservationProjectionContinuation();
  const source = {serviceId:'service-1',deploymentId:'deployment-1',podUid:'pod-1',containerName:'app'};
  const otherSource = {...source,podUid:'pod-2'};
  const filling = Array.from({length:40},(_,index)=>({id:'fill-'+index,timestamp:'2026-09-04T00:00:00.000Z',...otherSource,line:'x'.repeat(16_000)}));
  // When the end row does not fit the first complete-row prefix.
  const first = projectObservationPayload({service:{metadata:'x'.repeat(65_000)},logs:[
    {id:'begin',timestamp:'2026-09-04T00:00:00.000Z',...source,line:'-----BEGIN RSA PRIVATE KEY-----'},
    ...filling,
    {id:'end',timestamp:'2026-09-04T00:00:01.000Z',...source,line:'-----END RSA PRIVATE KEY----- after'},
  ]},{continuation});
  // Then replaying that row still observes the prior PEM state and only later text becomes visible.
  assert.equal(first.logs.some((row)=>row.id==='end'),false);
  const replay = projectObservationPayload({logs:[
    {id:'end',timestamp:'2026-09-04T00:00:01.000Z',...source,line:'-----END RSA PRIVATE KEY----- after'},
    {id:'after',timestamp:'2026-09-04T00:00:02.000Z',...source,line:'VISIBLE_AFTER_END'},
  ]},{continuation});
  assert.equal(replay.logs[0].line,'**** after');
  assert.equal(replay.logs[1].line,'VISIBLE_AFTER_END');
});

test('Given an SSE setup write failure, When close paths repeat, Then projection cleanup runs exactly once', async () => {
  const { startBoundedSseStream } = await import('../packages/core/src/sse.ts');
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.setHeader = () => { throw new Error('header write failed'); };
  res.end = () => {};
  let cleanup = 0;
  const stream = startBoundedSseStream({
    req,
    res,
    event:'service.logs.snapshot',
    initialPayload:{logs:[]},
    load:async()=>({logs:[]}),
    onClose:()=>{ cleanup += 1; },
  });
  req.emit('close');
  res.emit('close');
  stream.stop();
  assert.equal(stream.closed,true);
  assert.equal(cleanup,1);
});

test('Given 128 immutable log sources, When predecessor context is requested, Then only the source budget reaches the database seam', async () => {
  let legacyQueries = 0;
  let batchQueries = 0;
  const repository = new PrismaControlPlaneRepository({
    runtimeLog: { findMany: async () => { legacyQueries += 1; return []; } },
    buildLog: { findMany: async () => { legacyQueries += 1; return []; } },
    $queryRaw: async () => { batchQueries += 1; return [{requestId:1,line:'x'.repeat(PEM_CONTEXT_LIMITS.lineCharacters+1),truncated:true}]; },
  });
  const rows = Array.from({length:128},(_,index)=>({
    id:'row-'+index,
    timestamp:'2026-09-04T00:00:00.000Z',
    serviceId:'service-1',
    deploymentId:'deployment-1',
    podUid:'pod-'+index,
    containerName:'app',
    line:'visible',
  }));
  const contexts = await repository.logPemContext(rows);
  assert.equal(legacyQueries,0);
  assert.equal(batchQueries<=2,true);
  assert.equal(contexts.length<=16,true);
  assert.equal(contexts.every((context)=>context.rows.length<=4),true);
  assert.equal(contexts[0].complete,false);
  assert.equal(PEM_CONTEXT_LIMITS.queryRows*PEM_CONTEXT_LIMITS.lineBytes,PEM_CONTEXT_LIMITS.queryBytes);
});
