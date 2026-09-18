const RUNTIME_FIELDS = [
  'cpuRequest',
  'cpuLimit',
  'memoryRequest',
  'memoryLimit',
  'persistenceSizeGi',
  'persistenceMountPath',
];

const RESOURCE_FIELDS = ['cpuRequest', 'cpuLimit', 'memoryRequest', 'memoryLimit'];
const PERSISTENCE_FIELDS = ['persistenceSizeGi', 'persistenceMountPath'];
const QUANTITY_PATTERN = /^[+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+|[numkKMGTPE]|[KMGTPE]i)?$/;

export function serviceRuntimeFormDefaults(serviceSettings = {}) {
  const desiredSpec = objectValue(serviceSettings.desiredSpec);
  const resources = objectValue(serviceSettings.resources ?? desiredSpec.resources);
  const requests = objectValue(resources.requests);
  const limits = objectValue(resources.limits);
  const persistence = objectValue(serviceSettings.persistence ?? desiredSpec.persistence);

  return {
    cpuRequest: stringValue(requests.cpu, '100m'),
    cpuLimit: stringValue(limits.cpu, '500m'),
    memoryRequest: stringValue(requests.memory, '128Mi'),
    memoryLimit: stringValue(limits.memory, '512Mi'),
    persistenceSizeGi: persistence.sizeGi === undefined || persistence.sizeGi === null ? '0' : String(persistence.sizeGi),
    persistenceMountPath: stringValue(persistence.mountPath, '/data/flyfight'),
  };
}

export function serviceRuntimePayloadFromForm(input) {
  const body = { ...input };
  const hasResources = RESOURCE_FIELDS.some((field) => hasOwn(body, field));
  const hasPersistence = PERSISTENCE_FIELDS.some((field) => hasOwn(body, field));

  if (hasResources) {
    requireAll(body, RESOURCE_FIELDS, 'service_runtime_resources_incomplete');
    const cpuRequest = quantity(body.cpuRequest, 'invalid_cpu_request');
    const cpuLimit = quantity(body.cpuLimit, 'invalid_cpu_limit');
    const memoryRequest = quantity(body.memoryRequest, 'invalid_memory_request');
    const memoryLimit = quantity(body.memoryLimit, 'invalid_memory_limit');
    body.resources = {
      requests: { cpu: cpuRequest, memory: memoryRequest },
      limits: { cpu: cpuLimit, memory: memoryLimit },
    };
  }

  if (hasPersistence) {
    if (!hasOwn(body, 'persistenceSizeGi')) throw new Error('persistence_size_required');
    const sizeText = singleString(body.persistenceSizeGi, 'invalid_persistence_size').trim();
    if (!/^\d+$/.test(sizeText) || !Number.isSafeInteger(Number(sizeText))) throw new Error('invalid_persistence_size');
    const sizeGi = Number(sizeText);
    if (sizeGi === 0) {
      body.persistence = null;
    } else {
      if (!hasOwn(body, 'persistenceMountPath')) throw new Error('persistence_mount_path_required');
      const mountPath = singleString(body.persistenceMountPath, 'invalid_persistence_mount_path').trim();
      if (!validMountPath(mountPath)) throw new Error('invalid_persistence_mount_path');
      body.persistence = { sizeGi, mountPath };
    }
  }

  for (const field of RUNTIME_FIELDS) delete body[field];
  return body;
}

function quantity(value, code) {
  const text = singleString(value, code).trim();
  if (!text || !QUANTITY_PATTERN.test(text)) throw new Error(code);
  return text;
}

function validMountPath(value) {
  if (!value.startsWith('/') || value.length > 240 || value.includes('\0') || value.includes('\\')) return false;
  return !value.split('/').some((part) => part === '..');
}

function requireAll(body, fields, code) {
  if (!fields.every((field) => hasOwn(body, field))) throw new Error(code);
}

function singleString(value, code) {
  if (typeof value !== 'string') throw new Error(code);
  return value;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stringValue(value, fallback) {
  return typeof value === 'string' && value ? value : fallback;
}
