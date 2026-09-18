type RuntimeSpec = Record<string, any>;

function reject(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 400 });
}

function cpu(value: unknown): number {
  if (typeof value !== 'string' || !/^(?:[1-9]\d*m|(?:0|[1-9]\d*)(?:\.\d{1,3})?)$/.test(value)) reject('CPU must use cores or integer millicores');
  const result = value.endsWith('m') ? Number(value.slice(0, -1)) : Number(value) * 1000;
  if (!Number.isFinite(result) || result <= 0 || result > 8000) reject('CPU must be between 1m and 8000m');
  return result;
}

function memory(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9]\d*(Mi|Gi)$/.test(value)) reject('Memory must use positive integer Mi or Gi');
  const result = Number(value.slice(0, -2)) * (value.endsWith('Gi') ? 1024 : 1);
  if (!Number.isFinite(result) || result > 16384) reject('Memory cannot exceed 16Gi');
  return result;
}

function record(value: unknown, label: string): asserts value is RuntimeSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject(`${label} must be an object`);
}

export function validateServiceRuntime(service: RuntimeSpec): void {
  const resources = service.resources;
  if (resources !== undefined) {
    record(resources, 'resources');
    if (Object.keys(resources).some(k => !['requests', 'limits'].includes(k))) reject('Unknown resource group');
    for (const name of ['requests', 'limits']) {
      if (resources[name] === undefined) continue;
      record(resources[name], name);
      // Legacy manifests may contain this key; the compiler always clamps it to platform defaults.
      if (Object.keys(resources[name]).some(k => !['cpu', 'memory', 'ephemeral-storage'].includes(k))) reject('Only CPU and memory are configurable');
    }
    if (cpu(resources.requests?.cpu ?? '100m') > cpu(resources.limits?.cpu ?? '500m')) reject('CPU request exceeds limit');
    if (memory(resources.requests?.memory ?? '128Mi') > memory(resources.limits?.memory ?? '512Mi')) reject('Memory request exceeds limit');
  }
  const persistent = service.persistence;
  if (persistent === undefined || persistent === null) return;
  record(persistent, 'persistence');
  if (Object.keys(persistent).some(k => !['sizeGi', 'mountPath'].includes(k))) reject('Unknown persistence option');
  if (!Number.isInteger(persistent.sizeGi) || persistent.sizeGi < 1 || persistent.sizeGi > 100) reject('Persistence sizeGi must be an integer from 1 to 100');
  if (typeof persistent.mountPath !== 'string' || persistent.mountPath.length > 200 || !/^\/data(?:\/[A-Za-z0-9_-]+)*$/.test(persistent.mountPath)) reject('Persistence mountPath must be /data or a safe descendant');
  if (!['web', 'private', 'worker'].includes(String(service.type || 'web').toLowerCase())) reject('Persistence requires a web, private or worker service');
  if (service.sleepPolicy === 'scale-to-zero') reject('Persistent services must remain always-on');
  for (const value of [service.replicas, service.scaling?.minReplicas, service.scaling?.maxReplicas]) {
    if (value !== undefined && value !== 1) reject('Persistent services require exactly one replica');
  }
}

export function validateServiceRuntimeUpdate(current: RuntimeSpec, updates: RuntimeSpec): void {
  const previous = { ...(current.desiredSpec || {}), ...(current.desiredState || {}), ...current };
  const next = { ...previous, ...(updates.desiredSpec || {}), ...(updates.desiredState || {}), ...updates };
  if (next.resources && typeof next.resources === 'object' && !Array.isArray(next.resources)) {
    next.resources = {
      ...next.resources,
      requests: { ...(previous.resources?.requests || {}), ...(next.resources.requests || {}) },
      limits: { ...(previous.resources?.limits || {}), ...(next.resources.limits || {}) },
    };
  }
  validateServiceRuntime(next);
  if (previous.persistence) {
    if (!next.persistence || previous.persistence.sizeGi !== next.persistence.sizeGi || previous.persistence.mountPath !== next.persistence.mountPath || next.name !== previous.name || next.slug !== previous.slug) {
      reject('Existing persistent storage size, path and service identity cannot be changed; use an explicit data migration');
    }
  }
}
