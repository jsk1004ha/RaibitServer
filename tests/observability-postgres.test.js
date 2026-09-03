import test from 'node:test';
import assert from 'node:assert/strict';
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
