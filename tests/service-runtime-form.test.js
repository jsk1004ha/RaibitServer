import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  serviceRuntimeFormDefaults,
  serviceRuntimePayloadFromForm,
} from '../apps/dashboard/lib/service-runtime-form.js';

test('runtime form defaults read resources and persistence from service settings', () => {
  assert.deepEqual(serviceRuntimeFormDefaults({
    resources: { requests: { cpu: '250m', memory: '256Mi' }, limits: { cpu: '2', memory: '2Gi' } },
    persistence: { sizeGi: 20, mountPath: '/data/model' },
  }), {
    cpuRequest: '250m',
    cpuLimit: '2',
    memoryRequest: '256Mi',
    memoryLimit: '2Gi',
    persistenceSizeGi: '20',
    persistenceMountPath: '/data/model',
  });
});

test('runtime form defaults fall back to desiredSpec and safe platform defaults', () => {
  assert.deepEqual(serviceRuntimeFormDefaults({
    desiredSpec: { resources: { requests: { cpu: '300m' } }, persistence: { sizeGi: 5 } },
  }), {
    cpuRequest: '300m',
    cpuLimit: '500m',
    memoryRequest: '128Mi',
    memoryLimit: '512Mi',
    persistenceSizeGi: '5',
    persistenceMountPath: '/data/flyfight',
  });
});

test('service form maps flat runtime controls to canonical service fields', () => {
  assert.deepEqual(serviceRuntimePayloadFromForm({
    name: 'trainer',
    cpuRequest: '250m',
    cpuLimit: '2',
    memoryRequest: '512Mi',
    memoryLimit: '4Gi',
    persistenceSizeGi: '25',
    persistenceMountPath: '/data/flyfight',
  }), {
    name: 'trainer',
    resources: {
      requests: { cpu: '250m', memory: '512Mi' },
      limits: { cpu: '2', memory: '4Gi' },
    },
    persistence: { sizeGi: 25, mountPath: '/data/flyfight' },
  });
});

test('zero persistence disables storage and removes flat fields', () => {
  assert.deepEqual(serviceRuntimePayloadFromForm({ persistenceSizeGi: '0', persistenceMountPath: '/data/flyfight' }), {
    persistence: null,
  });
});

test('absent runtime fields preserve the existing service runtime configuration', () => {
  assert.deepEqual(serviceRuntimePayloadFromForm({ name: 'renamed' }), { name: 'renamed' });
});

test('partial and malformed runtime controls return stable validation errors', () => {
  assert.throws(() => serviceRuntimePayloadFromForm({ cpuRequest: '100m' }), /service_runtime_resources_incomplete/);
  assert.throws(() => serviceRuntimePayloadFromForm({
    cpuRequest: 'many', cpuLimit: '1', memoryRequest: '128Mi', memoryLimit: '512Mi',
  }), /invalid_cpu_request/);
  assert.throws(() => serviceRuntimePayloadFromForm({ persistenceMountPath: '/data' }), /persistence_size_required/);
  assert.throws(() => serviceRuntimePayloadFromForm({ persistenceSizeGi: '1.5', persistenceMountPath: '/data' }), /invalid_persistence_size/);
  assert.throws(() => serviceRuntimePayloadFromForm({ persistenceSizeGi: '1', persistenceMountPath: '../data' }), /invalid_persistence_mount_path/);
});

test('latest service settings flow previews and saves persistence through canonical changes', async () => {
  const source = await readFile(new URL('../apps/dashboard/components/project-hub/service-settings.tsx', import.meta.url), 'utf8');
  assert.match(source, /persistenceSizeGi: string; persistenceMountPath: string/);
  assert.match(source, /changes\.persistence = nextPersistence/);
  assert.match(source, /FieldLegend>영구 저장소<\/FieldLegend>/);
  assert.match(source, /서비스 삭제 시 저장소 데이터는 자동 삭제되지 않습니다/);
});
