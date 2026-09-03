import { LIFECYCLE_CONTRACT } from './lifecycle.ts';

export const HEALTH_PATH_FIELDS = ['healthCheckPath', 'livenessPath', 'readinessPath', 'publicHealthPath'] as const;
export const HEALTH_FAILURE_CODES = ['PUBLIC_HEALTH_INVALID_TARGET', 'PUBLIC_HEALTH_DNS_FAILED', 'PUBLIC_HEALTH_UNSAFE_ADDRESS', 'PUBLIC_HEALTH_CONNECT_FAILED', 'PUBLIC_HEALTH_TLS_FAILED', 'PUBLIC_HEALTH_TIMEOUT', 'PUBLIC_HEALTH_REDIRECT', 'PUBLIC_HEALTH_HTTP_STATUS', 'PUBLIC_HEALTH_RESPONSE_TOO_LARGE', 'PUBLIC_HEALTH_CANCELLED'] as const;
export const INITIAL_DEPLOYMENT_HEALTH = Object.freeze({ publicHealthStatus: LIFECYCLE_CONTRACT.machines.health.initial, healthCheckedAt: null, healthFailureCode: null, observedGeneration: null });
export function publicDeploymentHealth<T extends Readonly<Record<string, unknown>>>(row: T) {
  return { ...INITIAL_DEPLOYMENT_HEALTH, ...row, publicHealthStatus: row.publicHealthStatus ?? INITIAL_DEPLOYMENT_HEALTH.publicHealthStatus };
}

export class HealthPathError extends Error {
  readonly name = 'HealthPathError';
  readonly statusCode = 400;
  readonly code = 'INVALID_HEALTH_PATH';
  readonly field: string;
  constructor(field: string) { super(`INVALID_HEALTH_PATH: ${field}`); this.field = field; }
}

export function isSafeHealthPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 1024 || new TextEncoder().encode(value).length > 1024 || !/^\/(?!\/)/.test(value) || /[\\\s?#\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value)) return false;
  if (/%(?![0-9a-f]{2})/i.test(value) || /%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f|3f|23|25)/i.test(value)) return false;
  try {
    const decoded = decodeURIComponent(value);
    return !/[\\\s?#\u0000-\u001f\u007f-\u009f]/u.test(decoded) && !decoded.split('/').some(part => part === '.' || part === '..');
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    return false;
  }
}

export function parseHealthPaths(input: Readonly<Record<string, unknown>>) {
  const result: Record<string, string | null | { readonly path: string }> = {};
  for (const field of HEALTH_PATH_FIELDS) if (Object.hasOwn(input, field)) {
    const value = input[field];
    if (value === null) result[field] = null;
    else if (isSafeHealthPath(value)) result[field] = value;
    else throw new HealthPathError(field);
  }
  if (Object.hasOwn(input, 'healthCheck')) {
    const alias = input.healthCheck;
    if (alias === null) { result.healthCheck = null; if (!Object.hasOwn(input, 'healthCheckPath')) result.healthCheckPath = null; }
    else {
      if (!alias || typeof alias !== 'object' || Array.isArray(alias) || Object.keys(alias).length !== 1 || !('path' in alias) || !isSafeHealthPath(alias.path)) throw new HealthPathError('healthCheck.path');
      result.healthCheck = { path: alias.path };
      if (typeof result.healthCheckPath === 'string' && result.healthCheckPath !== alias.path) throw new HealthPathError('healthCheckPath');
      if (!Object.hasOwn(input, 'healthCheckPath')) result.healthCheckPath = alias.path;
    }
  }
  if (Object.hasOwn(input, 'healthCheckPath')) result.healthCheck = typeof result.healthCheckPath === 'string' ? { path: result.healthCheckPath } : null;
  if (input.publicHealthPath != null && input.type !== undefined && String(input.type).toLowerCase() !== 'web') throw new HealthPathError('publicHealthPath');
  return result;
}

export function serviceHealthInput(input: Readonly<Record<string, unknown>>) {
  const nested = input.desiredSpec && typeof input.desiredSpec === 'object' && !Array.isArray(input.desiredSpec) ? Object.fromEntries(Object.entries(input.desiredSpec)) : {};
  parseHealthPaths(nested);
  const paths = parseHealthPaths({ ...nested, ...input });
  return { ...paths, ...(input.desiredSpec ? { desiredSpec: { ...nested, ...paths } } : {}) };
}

export function serviceHealthProbes(service: Readonly<Record<string, unknown>>, port: number) {
  if (String(service.type || 'web').toLowerCase() !== 'web') return {};
  const paths = parseHealthPaths(service);
  const common = paths.healthCheckPath;
  const probe = (path: unknown, failureThreshold: number) => ({ ...(typeof path === 'string' ? { httpGet: { path, port } } : { tcpSocket: { port } }), initialDelaySeconds: 5, periodSeconds: 10, timeoutSeconds: 2, failureThreshold });
  return { startupProbe: probe(common || paths.readinessPath, 30), readinessProbe: probe(paths.readinessPath || common, 3), livenessProbe: probe(paths.livenessPath || common, 3) };
}
