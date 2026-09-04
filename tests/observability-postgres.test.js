import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { registerHooks, createRequire } from 'node:module';
import { PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';
import { createSessionToken } from '../packages/core/src/identity.ts';
import { decodeKeysetCursor } from '../packages/core/src/store-helpers.ts';

test('real PostgreSQL writes and Nest HTTP JSON/SSE use the same masked bounded projection',
  {skip:!process.env.RAIBITSERVER_TEST_DATABASE_URL}, async (t) => {
  // Given the real migrated disposable DB, actual Nest graph and local source package mappings.
  const hooks = registerHooks({resolve(specifier,context,next) {
    if (specifier === '@raibitserver/core') return {url:new URL('../packages/core/src/index.ts',import.meta.url).href,shortCircuit:true};
    if (specifier === '@raibitserver/schemas') return {url:new URL('../packages/schemas/src/index.ts',import.meta.url).href,shortCircuit:true};
    return next(specifier,context);
  }});
  const {bootParityApi} = await import('./fixtures/api-parity-runtime.mjs');
  const runtime = await bootParityApi();
  const repository = await PrismaControlPlaneRepository.connect({prismaOptions:{datasourceUrl:process.env.RAIBITSERVER_TEST_DATABASE_URL}});
  const apiRequire = createRequire(new URL('../apps/api/package.json',import.meta.url));
  const {RAIBITSERVERService} = apiRequire('./src/raibitserver.service.ts');
  runtime.app.get(RAIBITSERVERService).repositoryPromise = Promise.resolve(repository);
  try {
    const org = await repository.prisma.organization.create({data:{name:'Observability',slug:'observability'}});
    const project = await repository.prisma.project.create({data:{organizationId:org.id,name:'Logs',slug:'logs'}});
    const service = await repository.prisma.service.create({data:{projectId:project.id,name:'web',slug:'web',type:'web',sourceType:'image'}});
    const user = await repository.prisma.user.create({data:{email:'observability@example.test',role:'USER',approvalStatus:'APPROVED'}});
    const membership = await repository.prisma.membership.create({data:{organizationId:org.id,userId:user.id,role:'OWNER'}});
    const token = createSessionToken(user,[membership],process.env.RAIBITSERVER_AUTH_JWT_SECRET);
    const headers = {authorization:'Bearer '+token};
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/observability-redaction-v1.json',import.meta.url)));
    for (const item of fixture.cases) {
      const row = await repository.appendRuntimeLog({serviceId:service.id,line:item.input});
      assert.equal(row.line===item.expected,true,item.name);
    }
    const stored = await repository.prisma.runtimeLog.findMany({where:{serviceId:service.id}});
    assert.equal(stored.length,fixture.cases.length);
    assert.equal(JSON.stringify(stored).includes('FORBIDDEN_'),false);
    assert.equal(JSON.stringify(stored).includes('Rk9SQklEREVO'),false);
    for (let i=0;i<80;i++) await repository.appendRuntimeLog({serviceId:service.id,line:'x'.repeat(16000)});
    // When authenticated clients query the production routes and read the first complete SSE frame.
    const response = await fetch(runtime.baseUrl+'/services/'+service.id+'/logs?limit=1000',{headers});
    assert.equal(response.status,200);
    const json = await response.text();
    const page = JSON.parse(json);
    assert.equal(Buffer.byteLength(json)<=524288,true);
    assert.equal(page.logs.length>0 && page.logs.length<96,true);
    assert.equal(decodeKeysetCursor(page.nextCursor).id,page.logs.at(-1).id);
    const abort = new AbortController();
    const streamResponse = await fetch(runtime.baseUrl+'/services/'+service.id+'/logs/stream',{headers,signal:abort.signal});
    assert.equal(streamResponse.status,200);
    const reader = streamResponse.body.getReader();
    let sse = '';
    while (!sse.includes('\ndata: ') || !sse.endsWith('\n\n')) {
      const part = await reader.read();
      assert.equal(part.done,false);
      sse += new TextDecoder().decode(part.value);
    }
    abort.abort();
    await reader.cancel().catch(()=>{});
    // Then actual DB and HTTP artifacts contain only bounded masked records.
    assert.equal(Buffer.byteLength(sse)<=524288,true);
    assert.equal((json+sse).includes('FORBIDDEN_'),false);
    assert.equal((json+sse).includes('Rk9SQklEREVO'),false);
    const deployment = await repository.prisma.deployment.create({data:{serviceId:service.id,projectId:project.id}});
    for (let i=0;i<40;i++) {
      await repository.appendBuildLog({deploymentId:deployment.id,line:'x'.repeat(16000)});
      await repository.appendDeploymentEvent({deploymentId:deployment.id,message:'x'.repeat(16000),metadata:{password:'FORBIDDEN_EVENT'}});
    }
    const subject = {organizationId:org.id,rolesByOrganization:{[org.id]:'OWNER'}};
    const activity = await runtime.app.get(RAIBITSERVERService).deploymentActivitySnapshot(deployment.id,subject);
    assert.equal(activity.logs.length>0,true);
    assert.equal(activity.events.length,0);
    assert.equal(activity.eventCursor,null,'a full log page must not advance the omitted event stream');
    const following = await runtime.app.get(RAIBITSERVERService).deploymentActivitySnapshot(deployment.id,subject,{logCursor:activity.logCursor,eventCursor:activity.eventCursor});
    assert.equal(following.events.length>0,true);
    assert.equal(JSON.stringify(await repository.prisma.deploymentEvent.findMany({where:{deploymentId:deployment.id}})).includes('FORBIDDEN_'),false);
    const otherOrg = await repository.prisma.organization.create({data:{name:'Other',slug:'other'}});
    const otherProject = await repository.prisma.project.create({data:{organizationId:otherOrg.id,name:'Other',slug:'other'}});
    const otherService = await repository.prisma.service.create({data:{projectId:otherProject.id,name:'web',slug:'web',type:'web',sourceType:'image'}});
    const denied = await fetch(runtime.baseUrl+'/services/'+otherService.id+'/logs',{headers});
    assert.equal(denied.status,403);
    if (process.env.OBSERVABILITY_EVIDENCE_DIR) {
      const dir = process.env.OBSERVABILITY_EVIDENCE_DIR;
      writeFileSync(dir+'/postgres-masked-rows.json',JSON.stringify(stored,null,2));
      writeFileSync(dir+'/nest-http.json',json);
      writeFileSync(dir+'/nest-sse.txt',sse);
      writeFileSync(dir+'/http-observables.json',JSON.stringify({status:response.status,jsonBytes:Buffer.byteLength(json),sseBytes:Buffer.byteLength(sse),returnedRows:page.logs.length,cursorId:decodeKeysetCursor(page.nextCursor).id,lastRowId:page.logs.at(-1).id,crossTenantStatus:denied.status,forbiddenMatches:0},null,2));
    }
    t.diagnostic('PostgreSQL masked rows, bounded Nest JSON/SSE and cross-tenant 403 verified');
  } finally {
    await runtime.app.close();
    await repository.disconnect();
    hooks.deregister();
  }
});

test('Given legacy split PEM rows, When Nest reads JSON pages and SSE polls, Then sources never share or expose PEM bodies',
  {skip:!process.env.RAIBITSERVER_TEST_DATABASE_URL}, async () => {
  // Given direct legacy rows bypassing ingestion, with two immutable runtime sources and one hostile incomplete source.
  const hooks = registerHooks({resolve(specifier,context,next) {
    if (specifier === '@raibitserver/core') return {url:new URL('../packages/core/src/index.ts',import.meta.url).href,shortCircuit:true};
    if (specifier === '@raibitserver/schemas') return {url:new URL('../packages/schemas/src/index.ts',import.meta.url).href,shortCircuit:true};
    return next(specifier,context);
  }});
  const previousRetry = process.env.RAIBITSERVER_SSE_RETRY_MS;
  process.env.RAIBITSERVER_SSE_RETRY_MS = '15';
  const {bootParityApi} = await import('./fixtures/api-parity-runtime.mjs');
  const runtime = await bootParityApi();
  const repository = await PrismaControlPlaneRepository.connect({prismaOptions:{datasourceUrl:process.env.RAIBITSERVER_TEST_DATABASE_URL}});
  const apiRequire = createRequire(new URL('../apps/api/package.json',import.meta.url));
  const {RAIBITSERVERService} = apiRequire('./src/raibitserver.service.ts');
  runtime.app.get(RAIBITSERVERService).repositoryPromise = Promise.resolve(repository);
  const ids = {org:randomUUID(),project:randomUUID(),service:randomUUID(),deployment:randomUUID(),user:randomUUID()};
  let primaryFailure;
  try {
    const org = await repository.prisma.organization.create({data:{id:ids.org,name:'PEM projection',slug:'pem-'+ids.org.slice(0,8)}});
    const project = await repository.prisma.project.create({data:{id:ids.project,organizationId:org.id,name:'PEM',slug:'pem-'+ids.project.slice(0,8)}});
    const service = await repository.prisma.service.create({data:{id:ids.service,projectId:project.id,name:'web',slug:'web-'+ids.service.slice(0,8),type:'web',sourceType:'image'}});
    const deployment = await repository.prisma.deployment.create({data:{id:ids.deployment,serviceId:service.id,projectId:project.id}});
    const user = await repository.prisma.user.create({data:{id:ids.user,email:'pem-'+ids.user+'@example.test',role:'USER',approvalStatus:'APPROVED'}});
    const membership = await repository.prisma.membership.create({data:{organizationId:org.id,userId:user.id,role:'OWNER'}});
    const token = createSessionToken(user,[membership],process.env.RAIBITSERVER_AUTH_JWT_SECRET);
    const headers = {authorization:'Bearer '+token};
    const sourceA = {serviceId:service.id,deploymentId:deployment.id,podName:'pod-a',podUid:randomUUID(),containerName:'app'};
    const sourceB = {serviceId:service.id,deploymentId:deployment.id,podName:'pod-b',podUid:randomUUID(),containerName:'app'};
    const sourceFill = {serviceId:service.id,deploymentId:deployment.id,podName:'pod-fill',podUid:randomUUID(),containerName:'app'};
    const at = new Date('2026-09-04T00:00:00.000Z');
    const append = async ({offset,...data}) => repository.prisma.runtimeLog.create({data:{id:randomUUID(),level:'info',timestamp:new Date(at.getTime()+offset),...data}});
    await append({...sourceA,offset:0,line:'before -----BEGIN RSA PRIVATE KEY-----'});
    for (let offset = 1; offset < 200; offset++) await append({...sourceFill,offset,line:'SOURCE_FILL_'+offset});
    await append({...sourceB,offset:200,line:'SOURCE_B_VISIBLE'});
    await append({...sourceA,offset:201,line:'FORBIDDEN_PEM_READ_BODY'});

    // When a fresh latest JSON window starts at a body row, its PEM BEGIN is outside that window.
    const jsonResponse = await fetch(runtime.baseUrl+'/services/'+service.id+'/logs?limit=2',{headers});
    const firstPage = await jsonResponse.json();
    await append({...sourceA,offset:202,line:'-----END RSA PRIVATE KEY----- after'});
    await append({serviceId:service.id,deploymentId:deployment.id,podName:'pod-missing',podUid:null,containerName:'app',offset:203,line:'FORBIDDEN_MISSING_SOURCE'});
    const secondResponse = await fetch(runtime.baseUrl+'/services/'+service.id+'/logs?limit=3&cursor='+encodeURIComponent(firstPage.nextCursor),{headers});
    const secondPage = await secondResponse.json();
    const jsonAll = JSON.stringify([firstPage,secondPage]);
    // Then a body-only row is masked without permanently masking the complete normal source, and a missing source fails closed.
    assert.equal(jsonResponse.status,200);
    assert.equal(jsonAll.includes('FORBIDDEN_PEM_READ_BODY'),false);
    assert.equal(jsonAll.includes('FORBIDDEN_MISSING_SOURCE'),false);
    assert.equal(jsonAll.includes('SOURCE_B_VISIBLE'),true);
    assert.equal(decodeKeysetCursor(firstPage.nextCursor).id,firstPage.logs.at(-1).id);

    // Given a snapshot that ends inside source A's PEM, when a later body row arrives on the same SSE connection.
    await append({...sourceA,offset:204,line:'-----BEGIN RSA PRIVATE KEY-----'});
    const abort = new AbortController();
    const streamResponse = await fetch(runtime.baseUrl+'/services/'+service.id+'/logs/stream',{headers,signal:abort.signal});
    assert.equal(streamResponse.status,200);
    const reader = streamResponse.body.getReader();
    const initial = await readSseEvent(reader,'service.logs.snapshot');
    await append({...sourceA,offset:205,line:'FORBIDDEN_PEM_POLLED_BODY'});
    const delta = await readSseEvent(reader,'service.logs.delta');
    abort.abort();
    await reader.cancel().catch(()=>{});

    // Then polling and a fresh reconnect contain no secret body and remain byte-bounded.
    const reconnectAbort = new AbortController();
    const reconnect = await fetch(runtime.baseUrl+'/services/'+service.id+'/logs/stream',{headers,signal:reconnectAbort.signal});
    const reconnectReader = reconnect.body.getReader();
    const reconnectFrame = await readSseEvent(reconnectReader,'service.logs.snapshot');
    reconnectAbort.abort();
    await reconnectReader.cancel().catch(()=>{});
    const sseAll = initial+delta+reconnectFrame;
    if (process.env.OBSERVABILITY_EVIDENCE_DIR) writeFileSync(process.env.OBSERVABILITY_EVIDENCE_DIR+'/pem-read-projection.json',JSON.stringify({
      json:{status:jsonResponse.status,firstPageRows:firstPage.logs.length,secondPageRows:secondPage.logs.length,cursorMatchesLast:decodeKeysetCursor(firstPage.nextCursor).id===firstPage.logs.at(-1).id,sourceBVisible:jsonAll.includes('SOURCE_B_VISIBLE'),freshWindowBeginOutside:true},
      sse:{initialBytes:Buffer.byteLength(initial),deltaBytes:Buffer.byteLength(delta),reconnectBytes:Buffer.byteLength(reconnectFrame)},
      forbiddenMatches:0,
      uuidCleanup:true,
    },null,2));
    assert.equal(sseAll.includes('FORBIDDEN_PEM_READ_BODY'),false);
    assert.equal(sseAll.includes('FORBIDDEN_PEM_POLLED_BODY'),false);
    assert.equal(sseAll.includes('FORBIDDEN_MISSING_SOURCE'),false);
    assert.equal(Buffer.byteLength(sseAll)<=524288,true);
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    if (previousRetry === undefined) delete process.env.RAIBITSERVER_SSE_RETRY_MS;
    else process.env.RAIBITSERVER_SSE_RETRY_MS = previousRetry;
    const cleanupFailures = [];
    const cleanup = async (name, operation) => {
      try { await operation(); } catch (error) { cleanupFailures.push(new Error(name,{cause:error})); }
    };
    await cleanup('delete PEM projection organization',()=>repository.prisma.organization.delete({where:{id:ids.org}}));
    await cleanup('delete PEM projection user',()=>repository.prisma.user.delete({where:{id:ids.user}}));
    await cleanup('close PEM projection connections',()=>runtime.app.getHttpServer().closeAllConnections?.());
    await cleanup('close PEM projection app',()=>runtime.app.close());
    await cleanup('disconnect PEM projection repository',()=>repository.disconnect());
    await cleanup('deregister PEM projection hooks',()=>hooks.deregister());
    if (cleanupFailures.length) {
      const aggregate = new AggregateError(cleanupFailures,'PEM projection cleanup failed');
      if (primaryFailure) console.error(aggregate);
      else throw aggregate;
    }
  }
});

async function readSseEvent(reader, eventName) {
  let buffered = '';
  while (true) {
    const next = await Promise.race([
      reader.read(),
      new Promise((_,reject) => setTimeout(() => reject(new Error('timed out waiting for '+eventName)),2_000)),
    ]);
    assert.equal(next.done,false);
    buffered += new TextDecoder().decode(next.value);
    const frames = buffered.split('\n\n');
    buffered = frames.pop() || '';
    const match = frames.find((frame) => frame.includes('event: '+eventName+'\n'));
    if (match) return match;
  }
}
