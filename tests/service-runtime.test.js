import test from 'node:test';
import assert from 'node:assert/strict';
import { validateServiceRuntime, validateServiceRuntimeUpdate } from '../packages/core/src/service-runtime.ts';
import { sanitizeTenantServiceInput } from '../packages/core/src/security.ts';
import { ServiceUpdateSchema } from '../packages/schemas/src/desired-state-mutations.ts';
import { previewServiceSettings } from '../packages/core/src/service-settings.ts';
import { previewRuntimePlan } from '../packages/core/src/preview-deployments.ts';

const valid = { name:'trainer',type:'worker',persistence:{sizeGi:10,mountPath:'/data/flyfight'},resources:{requests:{cpu:'1',memory:'2Gi'},limits:{cpu:'2',memory:'4Gi'}} };
test('persistent service accepts bounded runtime and retains safe input',()=>{
  validateServiceRuntime(valid);
  assert.deepEqual(sanitizeTenantServiceInput(valid).persistence,valid.persistence);
});
test('blocks unsafe mounts, arbitrary claims, autoscaling and out-of-range resources',()=>{
  for(const persistence of [{sizeGi:0,mountPath:'/data'},{sizeGi:1,mountPath:'/'},{sizeGi:1,mountPath:'/data/../etc'},{sizeGi:1,mountPath:'/data',claimName:'other'}])
    assert.throws(()=>validateServiceRuntime({...valid,persistence}));
  assert.throws(()=>validateServiceRuntime({...valid,scaling:{maxReplicas:2}}));
  assert.throws(()=>validateServiceRuntime({...valid,type:'cron'}));
  for(const limits of [{cpu:'9000m',memory:'4Gi'},{cpu:'2',memory:'17Gi'},{cpu:'2',memory:'4Gi','nvidia.com/gpu':'1'}])
    assert.throws(()=>validateServiceRuntime({...valid,resources:{limits}}));
  assert.throws(()=>validateServiceRuntime({...valid,resources:{requests:{cpu:'3'},limits:{cpu:'2'}}}));
});
test('persistent updates cannot silently detach storage or rename its claim identity',()=>{
  for(const update of [{persistence:null},{name:'new'},{persistence:{sizeGi:9,mountPath:'/data/flyfight'}},{desiredSpec:{persistence:null}}])
    assert.throws(()=>validateServiceRuntimeUpdate(valid,update));
  validateServiceRuntimeUpdate(valid,{resources:{limits:{cpu:'2',memory:'4Gi'}}});
  validateServiceRuntimeUpdate(valid,{resources:{requests:{cpu:'1.5'}}});
  assert.throws(() => validateServiceRuntimeUpdate(valid,{resources:{limits:{cpu:'0.5'}}}));
});
test('settings schema and preview preserve and validate persistent storage', () => {
  assert.deepEqual(ServiceUpdateSchema.parse({persistence:valid.persistence}).persistence, valid.persistence);
  assert.equal(ServiceUpdateSchema.safeParse({persistence:{...valid.persistence, claimName:'foreign'}}).success, false);
  const current = {...valid, id:'s1', projectId:'p1', updatedAt:'2026-09-18T00:00:00.000Z'};
  const preview = previewServiceSettings(current, {expectedUpdatedAt:current.updatedAt, changes:{branch:'main'}}, {deployed:false});
  assert.deepEqual(preview.settings.persistence, valid.persistence);
  assert.throws(() => previewServiceSettings(current, {expectedUpdatedAt:current.updatedAt, changes:{persistence:null}}, {deployed:false}));
});
test('persistent previews cannot create unaccounted volumes or duplicate trainers', () => {
  assert.throws(() => previewRuntimePlan({service:valid, pullRequestNumber:1}), /do not support preview/);
  assert.equal(previewRuntimePlan({service:valid, pullRequestNumber:1, action:'delete'}).action, 'delete');
});
