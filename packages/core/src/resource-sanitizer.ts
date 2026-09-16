import path from 'node:path';
import crypto from 'node:crypto';
import { requireResourceCapability } from './resource-capabilities.ts';
import { isSecretKey } from './secrets.ts';

const SAFE_RESOURCE_KEYS = new Set([
  'projectId',
  'name',
  'slug',
  'type',
  'engine',
  'provider',
  'plan',
  'region',
  'version',
  'status',
  'storageMb',
  'storageGb',
  'databaseName',
  'database',
  'username',
  'bucket',
  'collection',
  'topic',
  'backup',
  'desiredSpec',
]);

const BLOCKED_CONNECTION_KEYS = new Set([
  'providerconnection',
  'providercredentials',
  'providercredential',
  'connection',
  'credentials',
  'credential',
  'connectionurl',
  'connectionsecretname',
  'connectionstring',
  'dsn',
  'databaseurl',
  'databaseuri',
  'dburl',
  'dburi',
  'pgurl',
  'pguri',
  'pgdsn',
  'pgconnectionstring',
  'pgconnectionurl',
  'pgconnectionuri',
  'jdbcurl',
  'odbcurl',
  'postgresurl',
  'postgresqlurl',
  'postgresuri',
  'postgresqluri',
  'sqlitepath',
  'mysqlurl',
  'mysqluri',
  'mariadburl',
  'mariadburi',
  'mongodburi',
  'mongouri',
  'mongoconnectionuri',
  'redisurl',
  'redisuri',
  'valkeyurl',
  'valkeyuri',
  'url',
  'uri',
  'password',
  'token',
  'secret',
  'apikey',
  'accesskey',
  'secretkey',
]);

const PROVIDER_SPEC_KEYS = new Set(['storageMb', 'storageGb', 'databaseName', 'database', 'username', 'bucket', 'collection', 'topic']);
const CONSOLE_SPEC_KEYS_BY_ENGINE: Record<string, Set<string>> = {
  postgresql: new Set(['schemas', 'tables']),
  mysql: new Set(['schemas', 'tables']),
  mariadb: new Set(['schemas', 'tables']),
  mongodb: new Set(['collections', 'documents']),
  redis: new Set(['keys', 'values', 'ttl']),
  valkey: new Set(['keys', 'values', 'ttl']),
  'object-storage': new Set(['buckets', 'objects']),
  qdrant: new Set(['collections']),
  nats: new Set(['subjects']),
};

export function canonicalizeProviderDesiredSpec(
  input: Record<string, any> = {},
  { baseSpec = {}, rejectUnknown = false }: { baseSpec?: Record<string, any>; rejectUnknown?: boolean } = {},
) {
  if (rejectUnknown && input.engine !== undefined) requireResourceCapability(String(input.engine), 'provision');
  const nested = input.desiredSpec === undefined ? {} : input.desiredSpec;
  if (!isPlainRecord(nested)) throw badResourceRequest('desiredSpec must be an object');
  if (!isPlainRecord(baseSpec)) throw badResourceRequest('stored desiredSpec is invalid');
  if (Object.prototype.hasOwnProperty.call(input, 'backup') || Object.prototype.hasOwnProperty.call(nested, 'backup')) {
    throw badResourceRequest('managed resource backup configuration is not implemented');
  }
  const consoleSpecKeys = CONSOLE_SPEC_KEYS_BY_ENGINE[canonicalEngine(input.engine)] || new Set<string>();
  if (rejectUnknown) {
    for (const key of Object.keys(nested)) {
      if (!PROVIDER_SPEC_KEYS.has(key) && !consoleSpecKeys.has(key)) throw badResourceRequest(`unsupported managed resource desiredSpec field: ${key}`);
    }
  }

  const desiredSpec = sanitizeResourceValue(baseSpec);
  if (!rejectUnknown) {
    for (const [key, value] of Object.entries(nested)) desiredSpec[key] = sanitizeResourceValue(value);
  }

  const storageSources: Array<{ label: string; mb: number }> = [];
  collectStorage(storageSources, 'storageMb', input.storageMb, 1);
  collectStorage(storageSources, 'storageGb', input.storageGb, 1024);
  collectStorage(storageSources, 'desiredSpec.storageMb', nested.storageMb, 1);
  collectStorage(storageSources, 'desiredSpec.storageGb', nested.storageGb, 1024);
  if (storageSources.length > 0) {
    const storageMb = storageSources[0].mb;
    if (storageSources.some((source) => source.mb !== storageMb)) throw badResourceRequest('storageMb and storageGb values conflict');
    if (storageMb > 1024 * 1024) throw badResourceRequest('managed resource storage cannot exceed 1024 GiB');
    desiredSpec.storageMb = storageMb;
    delete desiredSpec.storageGb;
  } else if (desiredSpec.storageGb !== undefined || desiredSpec.storageMb !== undefined) {
    const inherited: Array<{ label: string; mb: number }> = [];
    collectStorage(inherited, 'stored storageMb', desiredSpec.storageMb, 1);
    collectStorage(inherited, 'stored storageGb', desiredSpec.storageGb, 1024);
    if (inherited.length > 0) desiredSpec.storageMb = inherited[0].mb;
    delete desiredSpec.storageGb;
  }

  const databaseName = canonicalStringValue([
    ['databaseName', input.databaseName],
    ['database', input.database],
    ['desiredSpec.databaseName', nested.databaseName],
    ['desiredSpec.database', nested.database],
  ], 'databaseName');
  if (databaseName !== undefined) desiredSpec.databaseName = databaseName;
  delete desiredSpec.database;
  for (const key of ['username', 'bucket', 'collection', 'topic']) {
    const value = canonicalStringValue([[key, input[key]], [`desiredSpec.${key}`, nested[key]]], key);
    if (value !== undefined) desiredSpec[key] = value;
  }
  if (rejectUnknown) {
    for (const key of consoleSpecKeys) {
      if (nested[key] !== undefined) desiredSpec[key] = canonicalConsoleValue(key, nested[key]);
    }
  }
  return desiredSpec;
}

export function sanitizeTenantResourceInput(input: Record<string, any> = {}) {
  const output: Record<string, any> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!SAFE_RESOURCE_KEYS.has(key)) continue;
    if (isBlockedConnectionKey(key)) continue;
    output[key] = sanitizeResourceValue(value);
  }
  return output;
}

export function resourceNameFallback(name: unknown): string | undefined {
  if (typeof name !== 'string' || !name.trim() || /[a-z0-9]/i.test(name)) return undefined;
  return `resource-${crypto.createHash('sha256').update(name).digest('hex').slice(0, 20)}`;
}

export function providerOwnedSqlitePath(resourceId: string) {
  const name = String(resourceId || 'resource').replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 120) || 'resource';
  return path.join(providerOwnedSqliteRoot(), `${name}.sqlite`);
}

export function providerOwnedSqliteRoot() {
  return path.resolve('.raibitserver-work', 'sqlite');
}

export function isProviderOwnedSqlitePath(candidate: string) {
  if (!candidate || candidate === ':memory:') return true;
  const resolved = path.resolve(candidate);
  const root = providerOwnedSqliteRoot();
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

export function sanitizeResourceValue(value: any): any {
  if (Array.isArray(value)) return value.map((item) => sanitizeResourceValue(item));
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, any> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isBlockedConnectionKey(key)) continue;
    output[key] = sanitizeResourceValue(child);
  }
  return output;
}

function isBlockedConnectionKey(key: string) {
  const raw = String(key || '');
  const normalized = raw.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  if (BLOCKED_CONNECTION_KEYS.has(normalized) || isSecretKey(raw) || isSecretKey(normalized)) return true;
  const hasConnectionPrefix = /(?:^|database|db|postgres|postgresql|mysql|mariadb|mongo|mongodb|redis|valkey|sqlite|jdbc|odbc)connection/.test(normalized)
    || normalized.startsWith('connection');
  const hasConnectionSuffix = /(url|uri|dsn|string|connstr|connectionstring)$/.test(normalized);
  const hasProviderPrefix = /^(database|db|pg|postgres|postgresql|mysql|mariadb|mongo|mongodb|redis|valkey|sqlite|jdbc|odbc)/.test(normalized);
  return (hasConnectionPrefix && hasConnectionSuffix)
    || (hasProviderPrefix && hasConnectionSuffix)
    || /^connection.*(url|uri|dsn|string)$/.test(normalized);
}

function collectStorage(target: Array<{ label: string; mb: number }>, label: string, value: any, multiplier: number) {
  if (value === undefined) return;
  const numeric = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() ? Number(value) : Number.NaN);
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric <= 0) throw badResourceRequest(`${label} must be a positive integer`);
  const mb = numeric * multiplier;
  if (!Number.isSafeInteger(mb)) throw badResourceRequest(`${label} is outside the supported range`);
  target.push({ label, mb });
}

function canonicalStringValue(sources: Array<[string, any]>, field: string) {
  const values = sources.filter(([, value]) => value !== undefined).map(([label, value]) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw badResourceRequest(`${label} must be a non-empty string of at most 128 characters`);
    }
    return value.trim();
  });
  if (values.length > 1 && values.some((value) => value !== values[0])) throw badResourceRequest(`${field} values conflict`);
  return values[0];
}

function canonicalEngine(value: any) {
  const engine = String(value || '').trim().toLowerCase();
  if (['postgres', 'pg'].includes(engine)) return 'postgresql';
  if (['mongo'].includes(engine)) return 'mongodb';
  if (['s3', 'minio'].includes(engine)) return 'object-storage';
  if (['vector-db', 'weaviate', 'milvus'].includes(engine)) return 'qdrant';
  if (['message-queue', 'rabbitmq', 'kafka', 'redpanda'].includes(engine)) return 'nats';
  return engine;
}

function canonicalConsoleValue(key: string, value: any) {
  if (['keys', 'schemas', 'tables', 'collections', 'buckets', 'subjects'].includes(key)) return canonicalStringList(value, key);
  if (['values', 'ttl', 'documents'].includes(key)) return canonicalJsonRecord(value, key);
  if (key === 'objects') {
    if (!Array.isArray(value) || value.length > 128) throw badResourceRequest('objects must be an array of at most 128 entries');
    return value.map((entry, index) => {
      if (!isPlainRecord(entry) || Object.keys(entry).some((field) => !['key', 'size'].includes(field))) throw badResourceRequest(`objects[${index}] has unsupported fields`);
      if (entry.key === undefined) throw badResourceRequest(`objects[${index}].key is required`);
      const objectKey = canonicalStringValue([[`objects[${index}].key`, entry.key]], 'key');
      const size = Number(entry.size);
      if (!Number.isSafeInteger(size) || size < 0) throw badResourceRequest(`objects[${index}].size must be a non-negative integer`);
      return { key: objectKey, size };
    });
  }
  throw badResourceRequest(`unsupported managed resource desiredSpec field: ${key}`);
}

function canonicalStringList(value: any, field: string) {
  if (!Array.isArray(value) || value.length > 128) throw badResourceRequest(`${field} must be an array of at most 128 strings`);
  return value.map((entry, index) => canonicalStringValue([[`${field}[${index}]`, entry]], field));
}

function canonicalJsonRecord(value: any, field: string) {
  if (!isPlainRecord(value) || Object.keys(value).length > 128) throw badResourceRequest(`${field} must be an object with at most 128 entries`);
  validateBoundedJson(value, field, 0);
  return sanitizeResourceValue(value);
}

function validateBoundedJson(value: any, field: string, depth: number) {
  if (depth > 6) throw badResourceRequest(`${field} exceeds the maximum nesting depth`);
  if (typeof value === 'string') {
    if (value.length > 4096 || /[\u0000\u007f]/.test(value)) throw badResourceRequest(`${field} contains an invalid string`);
    return;
  }
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (Array.isArray(value)) {
    if (value.length > 128) throw badResourceRequest(`${field} contains too many entries`);
    for (const entry of value) validateBoundedJson(entry, field, depth + 1);
    return;
  }
  if (isPlainRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > 128) throw badResourceRequest(`${field} contains too many fields`);
    for (const [key, entry] of entries) {
      if (!key || key.length > 256 || /[\u0000-\u001f\u007f]/.test(key)) throw badResourceRequest(`${field} contains an invalid key`);
      validateBoundedJson(entry, field, depth + 1);
    }
    return;
  }
  throw badResourceRequest(`${field} contains an unsupported value`);
}

function isPlainRecord(value: any): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function badResourceRequest(message: string) {
  const error = new Error(message);
  (error as any).statusCode = 400;
  return error;
}
