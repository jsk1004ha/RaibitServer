import fs from 'node:fs/promises';
import path from 'node:path';
import { guardDatabaseQuery, isReadOnlyDatabaseQuery } from './security.ts';
import { can } from './rbac.ts';
import { isProviderOwnedSqlitePath } from './resource-sanitizer.ts';
import { providerConsoleSurface } from './resource-providers.ts';

export async function runDbConsoleQuery(resource: Record<string, any>, query: string, options: Record<string, any> = {}) {
  const engine = String(resource.engine || resource.desiredSpec?.engine || '').toLowerCase();
  if (engine !== 'sqlite' && engine !== 'postgresql' && engine !== 'postgres') return runProviderConsole(resource, query, options);
  const guard = guardDatabaseQuery(query, { role: options.role || 'developer', confirmed: options.confirmed === true || options.confirmed === 'true' });
  if (!guard.allowed) throwGuard(guard);
  if (engine === 'sqlite') return runSqlite(resource, query, options, guard);
  return runPostgres(resource, query, options, guard);
}

async function runSqlite(resource: Record<string, any>, query: string, options: Record<string, any>, guard: Record<string, any>) {
  const sqlite = await import('node:sqlite');
  const dbPath = providerSqlitePath(resource);
  await ensureSqliteDirectory(dbPath);
  const db = new (sqlite as any).DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout=1000');
    if (guard.readOnly === true) db.exec('PRAGMA query_only=ON');
    const text = String(query || '').trim();
    assertSqliteStatementAllowed(text);
    if (/^SELECT\b/i.test(text)) {
      const limited = /\bLIMIT\b/i.test(text) ? text.replace(/;$/, '') : `${text.replace(/;$/, '')} LIMIT ${Math.min(Number(options.limit || 100), 500)}`;
      const stmt = db.prepare(limited);
      const rows = trimResultRows(stmt.all(), options.maxResultBytes);
      return { engine: 'sqlite', dbPath, rows, fields: rows[0] ? Object.keys(rows[0]) : [], rowCount: rows.length, guard };
    }
    if (/^PRAGMA\b/i.test(text)) {
      const stmt = db.prepare(text.replace(/;$/, ''));
      const rows = trimResultRows(stmt.all(), options.maxResultBytes);
      return { engine: 'sqlite', dbPath, rows, fields: rows[0] ? Object.keys(rows[0]) : [], rowCount: rows.length, guard };
    }
    db.exec(text);
    return { engine: 'sqlite', dbPath, rows: [], fields: [], rowCount: 0, changed: true, guard };
  } finally {
    db.close();
  }
}

function assertSqliteStatementAllowed(query: string) {
  const policySql = normalizeSqlForPolicy(query);
  const blocked = /\b(ATTACH|DETACH)\b/.test(policySql.spaced)
    || /\bVACUUM\b.+\bINTO\b/.test(policySql.spaced)
    || policySql.compact.includes('LOAD_EXTENSION(')
    || /^PRAGMA(?:[A-Z_][A-Z0-9_]*\.)?(WRITABLE_SCHEMA|JOURNAL_MODE|TEMP_STORE_DIRECTORY|DATA_STORE_DIRECTORY|TRUSTED_SCHEMA)(?:\b|=|\(|;|$)/.test(policySql.compact);
  if (!blocked) return;
  const error = new Error('sqlite console statement is blocked by filesystem safety policy');
  (error as any).statusCode = 403;
  throw error;
}

function normalizeSqlForPolicy(query: string) {
  const text = String(query || '');
  let output = '';
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quote) {
      if (char === quote && next === quote && quote !== ']') {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      output += ' ';
      continue;
    }
    if (char === '-' && next === '-') {
      output += ' ';
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      output += ' ';
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      if (index < text.length) index += 1;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      output += ' ';
      continue;
    }
    if (char === '[') {
      quote = ']';
      output += ' ';
      continue;
    }
    output += char;
  }
  return {
    spaced: output.replace(/\s+/g, ' ').trim().toUpperCase(),
    compact: output.replace(/\s+/g, '').trim().toUpperCase(),
  };
}

export async function browseDbConsole(resource: Record<string, any>, options: Record<string, any> = {}) {
  const engine = String(resource.engine || '').toLowerCase();
  if (engine === 'postgresql' || engine === 'postgres') return browsePostgres(resource, options);
  if (engine !== 'sqlite') return providerConsoleSurface(resource, options);
  const sqlite = await import('node:sqlite');
  const dbPath = providerSqlitePath(resource);
  await ensureSqliteDirectory(dbPath);
  const db = new (sqlite as any).DatabaseSync(dbPath);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row: any) => row.name);
    return { engine: 'sqlite', dbPath, tables };
  } finally {
    db.close();
  }
}

export async function resourceConsoleView(resource: Record<string, any>, view: string, options: Record<string, any> = {}) {
  const surface = await browseDbConsole(resource, options) as Record<string, any>;
  const engine = surface.engine || String(resource.engine || '').toLowerCase();
  if (view === 'table' || view === 'rows' || view === 'data') {
    const table = String(options.table || options.name || '').trim();
    if (!table) return { engine, rows: [], fields: [], rowCount: 0, warning: 'table view requires a table query parameter', connectionInfo: surface.connectionInfo, mode: surface.mode };
    if (engine === 'sqlite') return runDbConsoleQuery(resource, `SELECT * FROM ${quoteSqlIdentifier(table, 'sqlite')}`, { ...options, role: options.role || 'viewer' });
    if (engine === 'postgresql' || engine === 'postgres') return runDbConsoleQuery(resource, `SELECT * FROM ${quoteSqlIdentifier(table, 'postgresql')}`, { ...options, role: options.role || 'viewer' });
    if (engine === 'mysql' || engine === 'mariadb') return runProviderConsole(resource, `SELECT * FROM ${quoteSqlIdentifier(table, 'mysql')}`, { ...options, role: options.role || 'viewer' });
    return { engine, mode: surface.mode || 'provider-contract', rows: [], fields: [], rowCount: 0, warning: `${engine} table data grid is not available for this resource type`, connectionInfo: surface.connectionInfo };
  }
  if (view === 'schema') {
    return {
      engine,
      schema: {
        schemas: surface.schemas || [],
        tables: surface.tables || [],
        collections: surface.collections || [],
        keys: surface.keys || [],
        buckets: surface.buckets || [],
        objects: surface.objects || [],
        streams: surface.streams || [],
        subjects: surface.subjects || [],
      },
      connectionInfo: surface.connectionInfo,
      warning: surface.warning,
      mode: surface.mode,
    };
  }
  if (view === 'tables') return { engine, schemas: surface.schemas || [], tables: surface.tables || [], connectionInfo: surface.connectionInfo, warning: surface.warning, mode: surface.mode };
  if (view === 'collections') return { engine, collections: surface.collections || [], connectionInfo: surface.connectionInfo, warning: surface.warning, mode: surface.mode };
  if (view === 'keys') return { engine, keys: surface.keys || [], connectionInfo: surface.connectionInfo, warning: surface.warning, mode: surface.mode, command: surface.command };
  return surface;
}

function quoteSqlIdentifier(identifier: string, engine: string) {
  const parts = identifier.split('.').map((part) => part.trim()).filter(Boolean);
  if (!parts.length || parts.length > 2) throw new Error('invalid table identifier');
  const quote = engine === 'mysql' ? '`' : '"';
  return parts.map((part) => {
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(part)) throw new Error('invalid table identifier');
    return `${quote}${part.replaceAll(quote, `${quote}${quote}`)}${quote}`;
  }).join('.');
}

async function ensureSqliteDirectory(dbPath: string) {
  if (!dbPath || dbPath === ':memory:') return;
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
}

function providerSqlitePath(resource: Record<string, any>) {
  const candidate = resource.sqlitePath || resource.desiredSpec?.sqlitePath || ':memory:';
  if (!isProviderOwnedSqlitePath(candidate)) {
    const error = new Error('sqlite console path must be provider-owned');
    (error as any).statusCode = 403;
    throw error;
  }
  return candidate;
}

async function runPostgres(resource: Record<string, any>, query: string, options: Record<string, any>, guard: Record<string, any>) {
  const connectionUrl = resourceConnectionUrl(resource, options, ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRESQL_URL']);
  if (!connectionUrl) return liveConnectionRequired('postgresql', guard);
  const client = await prismaClientFor(connectionUrl);
  try {
    const timeoutMs = clampNumber(options.timeoutMs, 250, 30_000, 5_000);
    const text = String(query || '').trim().replace(/;+\s*$/, '');
    if (guard.readOnly === true && isReadOnlyDatabaseQuery(text)) {
      const limited = limitSqlQuery(text, options.limit);
      const rows = await queryPostgresReadOnly(client, limited, timeoutMs);
      return rowsResult('postgresql', trimResultRows(rows, options.maxResultBytes), guard);
    }
    await client.$executeRawUnsafe(`SET statement_timeout = ${Math.floor(timeoutMs)}`);
    const rowCount = await withTimeout(client.$executeRawUnsafe(text), timeoutMs);
    return { engine: 'postgresql', rows: [], fields: [], rowCount: Number(rowCount || 0), changed: true, guard };
  } finally {
    await client.$disconnect();
  }
}

async function browsePostgres(resource: Record<string, any>, options: Record<string, any> = {}) {
  const connectionUrl = resourceConnectionUrl(resource, options, ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRESQL_URL']);
  if (!connectionUrl) return { engine: 'postgresql', tables: [], schemas: [], connectionInfo: providerConsoleSurface(resource).connectionInfo, warning: 'PostgreSQL browser requires provider-owned live DATABASE_URL/POSTGRES_URL on the resource' };
  const client = await prismaClientFor(connectionUrl);
  try {
    const timeoutMs = clampNumber(options.timeoutMs, 250, 30_000, 5_000);
    const tables = await queryPostgresReadOnly(client, `
      SELECT table_schema AS schema, table_name AS name, table_type AS type
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name
      LIMIT ${clampNumber(options.limit, 1, 500, 100)}
    `, timeoutMs);
    const schemas = [...new Set((tables as Record<string, any>[]).map((table) => table.schema))];
    return { engine: 'postgresql', schemas, tables, connectionInfo: providerConsoleSurface(resource).connectionInfo };
  } finally {
    await client.$disconnect();
  }
}

function runProviderConsole(resource: Record<string, any>, command: string, options: Record<string, any>) {
  const engine = String(resource.engine || resource.desiredSpec?.engine || '').toLowerCase();
  const text = String(command || '').trim();
  const guard = guardProviderCommand(text, options);
  if (!guard.allowed) throwGuard(guard);
  if (engine === 'mysql' || engine === 'mariadb') return runSqlContract(resource, text, options, guard, engine);
  if (engine === 'redis' || engine === 'valkey') return runRedisContract(resource, text, options, guard, engine);
  if (engine === 'mongodb') return runMongoContract(resource, text, options, guard);
  if (engine === 'object-storage') return runObjectStorageContract(resource, text, options, guard);
  if (engine === 'qdrant' || engine === 'vector-db') return runVectorContract(resource, text, options, guard, engine);
  if (engine === 'nats' || engine === 'message-queue') return runQueueContract(resource, text, options, guard, engine);
  const surface = providerConsoleSurface(resource, options);
  return { engine, mode: surface.mode || 'provider-contract', rows: [], fields: [], warning: surface.warning || `${engine} console uses provider-owned adapter contract`, command: surface.command, connectionInfo: surface.connectionInfo, guard };
}

function runSqlContract(resource: Record<string, any>, query: string, options: Record<string, any>, providerGuard: Record<string, any>, engine: string) {
  const sqlGuard = guardDatabaseQuery(query, { role: options.role || 'developer', confirmed: options.confirmed === true || options.confirmed === 'true' });
  if (!sqlGuard.allowed) throwGuard(sqlGuard);
  const surface = providerConsoleSurface(resource, options);
  const upper = query.replace(/;+\s*$/, '').trim().toUpperCase();
  let rows: Record<string, any>[] = [];
  if (/^SELECT\s+1(?:\s+AS\s+([A-Z_][A-Z0-9_]*))?$/.test(upper)) rows = [{ raibitserver_connection_test: 1 }];
  else if (/^SELECT\s+\*\s+FROM\s+[`"A-Z0-9_.-]+/.test(upper)) {
    const tableName = query.match(/FROM\s+([`"a-zA-Z0-9_.-]+)/i)?.[1]?.replace(/[`"]/g, '') || 'table';
    rows = arrayRows((resource.desiredState?.rows || resource.desiredSpec?.rows || resource.rows || {})[tableName] || []);
  }
  else if (/^SHOW\s+TABLES/.test(upper)) rows = (surface.tables || []).map((table: any) => ({ table: typeof table === 'string' ? table : table.name || String(table) }));
  else if (/^SHOW\s+DATABASES|^SHOW\s+SCHEMAS/.test(upper)) rows = (surface.schemas || []).map((schema: any) => ({ schema }));
  return { engine, mode: 'provider-contract', rows, fields: rows[0] ? Object.keys(rows[0]) : [], rowCount: rows.length, warning: surface.warning, connectionInfo: surface.connectionInfo, guard: { ...providerGuard, sql: sqlGuard } };
}

function arrayRows(value: any) {
  return Array.isArray(value) ? value : [];
}

function runRedisContract(resource: Record<string, any>, command: string, options: Record<string, any>, guard: Record<string, any>, engine: string) {
  const state = desired(resource);
  const keys = arrayStrings(state.keys);
  const values = state.values || {};
  const ttl = state.ttl || {};
  const [verb, ...rest] = command.split(/\s+/);
  const upper = String(verb || '').toUpperCase();
  let rows: Record<string, any>[] = [];
  if (['SCAN', 'KEYS'].includes(upper)) rows = keys.slice(0, clampNumber(options.limit, 1, 1000, 100)).map((key) => ({ key }));
  else if (upper === 'GET') {
    const key = rest[0] || keys[0] || 'health:ready';
    rows = [{ key, value: values[key] ?? '<provider-owned-value>' }];
  } else if (upper === 'TTL') {
    const key = rest[0] || keys[0] || 'health:ready';
    rows = [{ key, ttl: Number.isFinite(Number(ttl[key])) ? Number(ttl[key]) : -1 }];
  } else if (upper === 'INFO') rows = [{ section: rest[0] || 'memory', used_memory_human: state.memory || 'provider-managed' }];
  else if (upper === 'DEL') rows = [{ deleted: rest.length, keys: rest }];
  const surface = providerConsoleSurface(resource, options);
  return { engine, mode: surface.mode || 'provider-contract', rows, fields: rows[0] ? Object.keys(rows[0]) : [], rowCount: rows.length, keys, command: surface.command, warning: surface.warning, connectionInfo: surface.connectionInfo, guard };
}

function runMongoContract(resource: Record<string, any>, command: string, options: Record<string, any>, guard: Record<string, any>) {
  const surface = providerConsoleSurface(resource, options);
  const desiredState = desired(resource);
  const collections = arrayStrings(surface.collections || desiredState.collections);
  const match = command.match(/(?:db\.)?([a-zA-Z0-9_-]+)\.find\s*\(/) || command.match(/^find\s+([a-zA-Z0-9_-]+)/i);
  const collection = match?.[1] || collections[0] || 'documents';
  const documents = desiredState.documents?.[collection] || desiredState.documents || [];
  const rows = /getCollectionNames|collections|show\s+collections/i.test(command)
    ? collections.map((name) => ({ collection: name }))
    : (Array.isArray(documents) ? documents : []).slice(0, clampNumber(options.limit, 1, 500, 100));
  return { engine: 'mongodb', mode: surface.mode || 'provider-contract', rows, fields: rows[0] ? Object.keys(rows[0]) : [], rowCount: rows.length, collections, warning: surface.warning, connectionInfo: surface.connectionInfo, guard };
}

function runObjectStorageContract(resource: Record<string, any>, command: string, options: Record<string, any>, guard: Record<string, any>) {
  const surface = providerConsoleSurface(resource, options);
  const buckets = arrayStrings(surface.buckets);
  const objects = Array.isArray(surface.objects) ? surface.objects : [];
  const lower = command.toLowerCase();
  let rows: Record<string, any>[];
  if (/upload|put|cp/.test(lower)) rows = [{ uploaded: true, bucket: buckets[0] || 'bucket', key: options.key || 'object' }];
  else if (/delete|rm/.test(lower)) rows = [{ deleted: true, bucket: buckets[0] || 'bucket', key: options.key || 'object' }];
  else rows = objects.map((object: any) => (typeof object === 'string' ? { key: object } : object));
  return { engine: 'object-storage', mode: surface.mode || 'provider-contract', rows, fields: rows[0] ? Object.keys(rows[0]) : [], rowCount: rows.length, buckets, objects, warning: surface.warning, connectionInfo: surface.connectionInfo, guard };
}

function runVectorContract(resource: Record<string, any>, command: string, options: Record<string, any>, guard: Record<string, any>, engine: string) {
  const surface = providerConsoleSurface(resource, options);
  const collections = arrayStrings(surface.collections);
  const lower = command.toLowerCase();
  const rows = /search/.test(lower)
    ? [{ collection: collections[0] || 'default', score: 1, id: 'contract-vector-1' }]
    : collections.map((collection) => ({ collection }));
  return { engine: engine === 'vector-db' ? 'qdrant' : engine, mode: surface.mode || 'provider-contract', rows, fields: rows[0] ? Object.keys(rows[0]) : [], rowCount: rows.length, collections, warning: surface.warning, connectionInfo: surface.connectionInfo, guard };
}

function runQueueContract(resource: Record<string, any>, command: string, options: Record<string, any>, guard: Record<string, any>, engine: string) {
  const surface = providerConsoleSurface(resource, options);
  const subjects = arrayStrings(surface.subjects);
  const streams = arrayStrings(surface.streams);
  const lower = command.toLowerCase();
  const rows = /publish|pub/.test(lower)
    ? [{ published: true, subject: subjects[0] || 'events' }]
    : [{ connected: true, subjects, streams }];
  return { engine: engine === 'message-queue' ? 'nats' : engine, mode: surface.mode || 'provider-contract', rows, fields: rows[0] ? Object.keys(rows[0]) : [], rowCount: rows.length, subjects, streams, warning: surface.warning, connectionInfo: surface.connectionInfo, guard };
}

function guardProviderCommand(command: string, options: Record<string, any>) {
  const role = options.role || 'developer';
  const readOnly = isProviderReadOnly(command);
  if (!command) return { allowed: false, reason: 'query is required', destructive: false, readOnly: false, providerCommand: true };
  if (readOnly && !can(role, 'db:data:read')) return { allowed: false, reason: `role ${role} requires db:data:read permission for read-only provider commands`, destructive: false, readOnly, providerCommand: true };
  if (!readOnly && !can(role, 'db:query:write')) return { allowed: false, reason: `role ${role} requires db:query:write permission for destructive queries`, destructive: true, readOnly, providerCommand: true };
  if (!readOnly && options.confirmed !== true && options.confirmed !== 'true') return { allowed: false, reason: 'destructive query requires explicit confirmation', destructive: true, readOnly, providerCommand: true };
  return { allowed: true, reason: 'provider console command accepted', destructive: !readOnly, readOnly, providerCommand: true };
}

function isProviderReadOnly(command: string) {
  const text = String(command || '').trim().toUpperCase();
  return /^(SCAN|KEYS|GET|TTL|INFO|SELECT|SHOW|DESCRIBE|EXPLAIN|FIND|LIST|LS|BROWSE|COLLECTIONS|SUBJECTS|STREAMS|DB\.GETCOLLECTIONNAMES|DB\.[A-Z0-9_-]+\.FIND|NATS\s+(STREAM\s+LS|SUB\s+LS|SERVER\s+CHECK)|CURL\s+(-X\s+GET\s+)?)/.test(text)
    && !/\b(DELETE|DEL|DROP|UPDATE|INSERT|CREATE|ALTER|TRUNCATE|FLUSH|PUT|POST|UPLOAD|RM|PUBLISH|PUB)\b/.test(text);
}

function throwGuard(guard: Record<string, any>): never {
  const error = new Error(guard.reason);
  (error as any).statusCode = 403;
  (error as any).guard = guard;
  throw error;
}

async function queryPostgresReadOnly(client: any, sql: string, timeoutMs: number) {
  return withTimeout(client.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);
    return tx.$queryRawUnsafe(sql);
  }, { timeout: timeoutMs + 1000 }), timeoutMs + 1500);
}

async function prismaClientFor(connectionUrl: string) {
  const mod = await import('@prisma/client');
  const PrismaClient = (mod as any).PrismaClient;
  if (!PrismaClient) throw new Error('@prisma/client PrismaClient export is required for live PostgreSQL console queries');
  return new PrismaClient({ datasourceUrl: connectionUrl, log: [] });
}

function resourceConnectionUrl(resource: Record<string, any>, options: Record<string, any>, envKeys: string[]) {
  const providerConnection = resource.providerConnection || {};
  if (providerConnection.live === false || providerConnection.mode === 'provider-contract') return null;
  const candidates = [
    providerConnection.connectionUrl,
    providerConnection.databaseUrl,
    providerConnection.url,
    providerConnection.uri,
    providerConnection.connectionString,
    ...envKeys.map((key) => providerConnection[key]),
  ];
  return candidates.find((value) => typeof value === 'string' && value.trim())?.trim() || null;
}

function liveConnectionRequired(engine: string, guard: Record<string, any>) {
  return {
    engine,
    mode: 'connection-info',
    rows: [],
    fields: [],
    warning: `${engine} console requires a live provider-owned connection URL on the resource`,
    guard,
  };
}

function limitSqlQuery(query: string, limit: any) {
  if (/\bLIMIT\s+\d+\b/i.test(query)) return query;
  if (!/^SELECT\b/i.test(query)) return query;
  return `${query} LIMIT ${clampNumber(limit, 1, 500, 100)}`;
}

function rowsResult(engine: string, rows: any, guard: Record<string, any>) {
  const list = Array.isArray(rows) ? rows : [];
  return { engine, rows: list, fields: list[0] ? Object.keys(list[0]) : [], rowCount: list.length, guard };
}

function trimResultRows(rows: any, maxBytes: any) {
  if (!Array.isArray(rows)) return rows;
  const byteLimit = clampNumber(maxBytes, 1024, 2_000_000, 512_000);
  const kept = [];
  let used = 2;
  for (const row of rows) {
    const serialized = JSON.stringify(row, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
    const bytes = Buffer.byteLength(serialized);
    if (used + bytes > byteLimit) break;
    kept.push(JSON.parse(serialized));
    used += bytes + 1;
  }
  return kept;
}

function desired(resource: Record<string, any>) {
  return { ...(resource.desiredSpec || {}), ...(resource.desiredState || {}) };
}

function arrayStrings(value: any) {
  return Array.isArray(value) ? value.map(String) : [];
}

function clampNumber(value: any, min: number, max: number, defaultValue: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return defaultValue;
  return Math.min(max, Math.max(min, number));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`database console query timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
