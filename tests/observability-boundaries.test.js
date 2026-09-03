import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { boundedDnsLabel, identityDnsLabel, tenantProjectLabel } from '../packages/core/src/domain-router.ts';
import { sanitizeObservationLine } from '../packages/core/src/observability-redaction.ts';
import { maskedObservationRows, projectObservationPayload } from '../packages/core/src/observability-projection.ts';

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
