import { normalizeResourceEngine } from './catalog.ts';
import { maskedObservationRows } from './observability-projection.ts';
import { providerConnectionEnvForResource } from './resource-providers.ts';

type AnyRecord = Record<string, any>;
type KeysetCursor = { v: 1; at: string; id: string; date: Date; legacy?: boolean };

export function resourceTypeForEngine(engine: string) {
  if (['redis', 'valkey'].includes(engine)) return 'cache';
  if (engine === 'object-storage') return 'storage';
  if (['qdrant', 'vector-db'].includes(engine)) return 'vector';
  if (['nats', 'message-queue'].includes(engine)) return 'queue';
  return 'database';
}

export function prefixEnv(env: AnyRecord, envPrefix: any) {
  const prefix = String(envPrefix || '').trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  if (!prefix) return { ...env };
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [`${prefix}_${key}`, value]));
}

export function providerSecretEnvRefs(resource: AnyRecord, envPrefix: any = null) {
  if (String(resource?.status || '').toUpperCase() !== 'READY') throw conflict('resource must be READY before attachment');
  const connection = resource?.desiredState?.providerConnection;
  const secretName = String(connection?.secretName || resource?.connectionSecretName || '').trim();
  const keys = Array.isArray(connection?.environmentKeys) ? connection.environmentKeys.map(String) : [];
  if (!/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(secretName) || secretName.length > 63) throw conflict('READY resource is missing a valid Kubernetes connection Secret reference');
  if (resource?.connectionSecretName && String(resource.connectionSecretName) !== secretName) throw conflict('resource connection Secret metadata is inconsistent');
  if (!keys.length || keys.length > 64 || keys.some((key) => !/^[A-Z_][A-Z0-9_]{0,127}$/.test(key))) throw conflict('READY resource is missing valid connection environment keys');
  const refs = Object.fromEntries([...new Set(keys)].map((key) => [key, { valueFrom: { secretKeyRef: { name: secretName, key } } }]));
  return prefixEnv(refs, envPrefix);
}

export function kubernetesExternalSecretRef(reference: AnyRecord) {
  const secretKeyRef = reference?.valueFrom?.secretKeyRef;
  if (!secretKeyRef?.name || !secretKeyRef?.key) throw conflict('invalid Kubernetes Secret reference');
  return `k8s:${secretKeyRef.name}#${secretKeyRef.key}`;
}

export function providerEnvFromConnection(consoleResource: AnyRecord, resource: AnyRecord) {
  const providerConnection = consoleResource.providerConnection || {};
  const env = Object.fromEntries(Object.entries(providerConnection).filter(([key, value]) => /^[A-Z0-9_]+$/.test(key) && typeof value === 'string'));
  if (Object.keys(env).length) return env;
  return providerConnectionEnvForResource(resource);
}

export function providerConnectionFromEnv(env: Record<string, string>, engine: any, live: boolean) {
  const normalized = normalizeResourceEngine(engine);
  const connection: AnyRecord = { ...env, live, mode: live ? 'live-provider' : 'provider-contract' };
  const first = (...keys: string[]) => keys.map((key) => env[key]).find(Boolean);
  if (normalized === 'postgresql') connection.databaseUrl = first('DATABASE_URL', 'POSTGRES_URL', 'POSTGRESQL_URL');
  else if (normalized === 'mysql') connection.url = first('MYSQL_URL');
  else if (normalized === 'mariadb') connection.url = first('MARIADB_URL', 'MYSQL_URL');
  else if (normalized === 'mongodb') connection.uri = first('MONGODB_URI', 'MONGO_URL');
  else if (normalized === 'redis') connection.url = first('REDIS_URL');
  else if (normalized === 'valkey') connection.url = first('VALKEY_URL', 'REDIS_URL');
  else if (normalized === 'sqlite') connection.databaseUrl = first('DATABASE_URL');
  else if (normalized === 'object-storage') connection.url = first('S3_ENDPOINT');
  else if (normalized === 'qdrant' || normalized === 'vector-db') connection.url = first('VECTOR_DB_URL', 'QDRANT_URL');
  else if (normalized === 'nats' || normalized === 'message-queue') connection.url = first('QUEUE_URL', 'NATS_URL');
  return connection;
}

export function isProviderConnectionSecret(secret: any, resourceId: string) {
  return secret
    && secret.scopeType === 'resource-provider-connection'
    && String(secret.scopeId) === String(resourceId)
    && Boolean(secret.key);
}

export function resourceQuotaMetric(resource: AnyRecord) {
  return String(resource?.type || '').toLowerCase() === 'storage' || String(resource?.engine || '').toLowerCase().includes('object') ? 'maxObjectStorageMb' : 'maxDbStorageMb';
}

export function resourceStorageMb(resource: AnyRecord, { includeDesiredState = false } = {}) {
  const spec = includeDesiredState ? { ...(resource.desiredSpec || {}), ...(resource.desiredState || {}), ...resource } : resource;
  if (spec.storageMb !== undefined) return Number(spec.storageMb || 0);
  if (spec.storageGb !== undefined) return Number(spec.storageGb || 0) * 1024;
  return 1;
}

export function usageMetricSum(records: AnyRecord[], aliases: string[]) {
  const names = new Set(aliases.map((alias) => alias.toLowerCase()));
  return records
    .filter((record) => names.has(String(record.metric || '').toLowerCase()))
    .reduce((sum, record) => sum + Number(record.value || 0), 0);
}

export function deploymentBuildMinutes(deployment: AnyRecord) {
  const start = dateMs(deployment.buildStartedAt || deployment.startedAt);
  const end = dateMs(deployment.buildFinishedAt || deployment.finishedAt);
  return start && end && end > start ? (end - start) / 60_000 : 0;
}

export function deploymentRuntimeHours(deployment: AnyRecord) {
  const start = dateMs(deployment.deployedAt);
  const end = dateMs(deployment.finishedAt) || Date.now();
  return start && end > start ? (end - start) / 3_600_000 : 0;
}

export function utcMonthBounds(value: any = Date.now()) {
  const current = new Date(value);
  const start = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1);
  const end = Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1);
  return { start, end, startDate: new Date(start), endDate: new Date(end) };
}

export function deploymentBuildMinutesWithin(deployment: AnyRecord, start: number, end: number) {
  const rawStart = dateMs(deployment.buildStartedAt || deployment.startedAt);
  const rawEnd = dateMs(deployment.buildFinishedAt || deployment.finishedAt);
  const clippedStart = Math.max(rawStart, start);
  const clippedEnd = Math.min(rawEnd, end);
  return rawStart && rawEnd && clippedEnd > clippedStart ? (clippedEnd - clippedStart) / 60_000 : 0;
}

export function deploymentRuntimeHoursWithin(deployment: AnyRecord, start: number, end: number) {
  const rawStart = dateMs(deployment.deployedAt);
  const rawEnd = dateMs(deployment.finishedAt) || Math.min(Date.now(), end);
  const clippedStart = Math.max(rawStart, start);
  const clippedEnd = Math.min(rawEnd, end);
  return rawStart && clippedEnd > clippedStart ? (clippedEnd - clippedStart) / 3_600_000 : 0;
}

export function boundedActivityRows(rows: AnyRecord[], options: AnyRecord = {}) {
  const limit = activityLimit(options.limit);
  const cursor = resolveKeysetCursor(options);
  const sorted = [...rows]
    .filter((row) => !cursor || (cursor.legacy ? dateMs(row.timestamp) > dateMs(cursor.at) : compareKeysetRow(row, cursor, 'timestamp') > 0))
    .sort((left, right) => compareKeysetRows(left, right, 'timestamp'));
  return maskedObservationRows(cursor ? sorted.slice(0, limit) : sorted.slice(-limit));
}

export function boundedKeysetRows(rows: AnyRecord[], options: AnyRecord = {}, timestampField = 'createdAt') {
  const limit = activityLimit(options.limit);
  const cursor = resolveKeysetCursor(options);
  return [...rows]
    .filter((row) => !cursor || (cursor.legacy ? dateMs(row[timestampField]) < dateMs(cursor.at) : compareKeysetRow(row, cursor, timestampField) < 0))
    .sort((left, right) => compareKeysetRows(right, left, timestampField))
    .slice(0, limit);
}

export function encodeKeysetCursor(row: AnyRecord | null | undefined, timestampField = 'timestamp') {
  if (!row) return null;
  const at = canonicalTimestamp(row[timestampField]);
  const id = String(row.id || '').trim();
  if (!at || !id) return null;
  return Buffer.from(JSON.stringify({ v: 1, at, id }), 'utf8').toString('base64url');
}

export function keysetCursorForRows(rows: AnyRecord[], timestampField = 'timestamp') {
  return encodeKeysetCursor(rows.at(-1), timestampField);
}

export function decodeKeysetCursor(value: any): KeysetCursor {
  const text = String(value || '').trim();
  if (!text || text.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(text)) throw invalidCursor();
  try {
    const decoded = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    const keys = decoded && typeof decoded === 'object' ? Object.keys(decoded).sort() : [];
    if (decoded?.v !== 1 || keys.join(',') !== 'at,id,v' || typeof decoded.at !== 'string' || typeof decoded.id !== 'string') throw invalidCursor();
    const at = canonicalTimestamp(decoded.at);
    const id = String(decoded.id).trim();
    if (!at || !id || id.length > 512) throw invalidCursor();
    return { v: 1 as const, at, id, date: new Date(at) };
  } catch (error) {
    if ((error as any)?.statusCode === 400) throw error;
    throw invalidCursor();
  }
}

export function resolveKeysetCursor(options: AnyRecord = {}): KeysetCursor | null {
  if (options.cursor !== undefined && options.cursor !== null && String(options.cursor).trim()) return decodeKeysetCursor(options.cursor);
  if (options.after === undefined || options.after === null || !String(options.after).trim()) return null;
  const after = canonicalTimestamp(options.after);
  if (!after) throw invalidCursor();
  return { v: 1 as const, at: after, id: '', date: new Date(after), legacy: true };
}

export function prismaKeysetFilter(options: AnyRecord = {}, timestampField = 'createdAt', direction: 'asc' | 'desc' = 'desc') {
  const cursor = resolveKeysetCursor(options);
  if (!cursor) return null;
  const operator = direction === 'asc' ? 'gt' : 'lt';
  if (cursor.legacy) return { [timestampField]: { [operator]: cursor.date } };
  return {
    OR: [
      { [timestampField]: { [operator]: cursor.date } },
      { [timestampField]: cursor.date, id: { [operator]: cursor.id } },
    ],
  };
}

export function activityLimit(value: any, fallback = 200) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(1000, parsed));
}

export function serviceCpuMillicores(service: AnyRecord) {
  const spec = service.desiredSpec || service.desiredState || service;
  return parseCpuMillicores(spec.cpu || spec.cpuRequest || spec.resources?.requests?.cpu || spec.resources?.limits?.cpu);
}

export function serviceMemoryMb(service: AnyRecord) {
  const spec = service.desiredSpec || service.desiredState || service;
  return parseMemoryMb(spec.memory || spec.memoryMb || spec.memoryRequest || spec.resources?.requests?.memory || spec.resources?.limits?.memory);
}

export function dateMs(value: any) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function canonicalTimestamp(value: any) {
  if (value === null || value === undefined || value === '') return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function compareKeysetRows(left: AnyRecord, right: AnyRecord, timestampField: string) {
  const timeDifference = dateMs(left[timestampField]) - dateMs(right[timestampField]);
  if (timeDifference) return timeDifference;
  return String(left.id || '').localeCompare(String(right.id || ''));
}

function compareKeysetRow(row: AnyRecord, cursor: { at: string; id: string }, timestampField: string) {
  const timeDifference = dateMs(row[timestampField]) - dateMs(cursor.at);
  if (timeDifference) return timeDifference;
  return String(row.id || '').localeCompare(cursor.id);
}

function invalidCursor() {
  const error = new Error('invalid versioned keyset cursor');
  (error as any).statusCode = 400;
  return error;
}

function parseCpuMillicores(value: any) {
  if (value === null || value === undefined || value === '') return 0;
  const text = String(value).trim();
  if (text.endsWith('m')) return Number(text.slice(0, -1)) || 0;
  const number = Number(text);
  return Number.isFinite(number) ? number * 1000 : 0;
}

function parseMemoryMb(value: any) {
  if (value === null || value === undefined || value === '') return 0;
  const text = String(value).trim().toLowerCase();
  const number = Number(text.replace(/[a-z]+$/, ''));
  if (!Number.isFinite(number)) return 0;
  if (text.endsWith('gi') || text.endsWith('gib')) return number * 1024;
  if (text.endsWith('gb')) return number * 1000;
  if (text.endsWith('ki') || text.endsWith('kib')) return number / 1024;
  if (text.endsWith('kb')) return number / 1000;
  return number;
}

function conflict(message: string) {
  const error = new Error(message);
  (error as any).statusCode = 409;
  return error;
}
