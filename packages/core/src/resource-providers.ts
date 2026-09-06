import path from 'node:path';
import { requireResourceCapability } from './resource-capabilities.ts';
import { runCommand, commandToString, type CommandSpec } from './command-runner.ts';
import { connectionEnvForResource } from './env-injection.ts';
import { normalizeResourceEngine } from './catalog.ts';
import { providerOwnedSqlitePath } from './resource-sanitizer.ts';
import { secureRandomSecret } from './secret-vault.ts';
import { maskSecretValue, maskSecrets } from './secrets.ts';
import { slugify } from './ids.ts';

const SQL_IDENTIFIER_RE = /^[a-z_][a-z0-9_]{0,62}$/;

type AnyRecord = Record<string, any>;

export function buildPostgresProviderPlan(resource: AnyRecord = {}, options: AnyRecord = {}) {
  const capabilities = requireResourceCapability('postgresql', 'provision');
  const databaseName = safeSqlIdentifier(resource.databaseName || resource.database || tenantResourceName(resource, 'db', uniqueTenantScope(resource, options)));
  const username = safeSqlIdentifier(resource.username || `${databaseName}_app`);
  const password = String(options.password || resource.generatedPassword || resource.password || (options.generatePassword === true ? secureRandomSecret(24) : '<generated-provider-password>'));
  const providerHost = options.providerHost || resource.providerHost || resource.sharedHost || resource.host || resource.internalHost || 'postgresql.shared-providers.svc.cluster.local';
  const host = options.poolerHost || resource.poolerHost || process.env.RAIBITSERVER_POSTGRES_POOLER_HOST || providerHost.replace(/^postgresql\./, 'pgbouncer.');
  const port = Number(options.port || resource.port || 5432);
  const limits = postgresTenantLimits(resource, options);
  const databaseUrl = `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${databaseName}`;
  const adminUrl = options.adminUrl || options.providerAdminUrl || process.env.RAIBITSERVER_POSTGRES_PROVIDER_URL || process.env.POSTGRES_PROVIDER_URL || null;
  const sqlStatements = [
    `CREATE USER ${quoteIdent(username)} WITH PASSWORD ${quoteLiteral(password)}`,
    `ALTER ROLE ${quoteIdent(username)} CONNECTION LIMIT ${limits.connectionLimit}`,
    `CREATE DATABASE ${quoteIdent(databaseName)} OWNER ${quoteIdent(username)}`,
    `GRANT ALL PRIVILEGES ON DATABASE ${quoteIdent(databaseName)} TO ${quoteIdent(username)}`,
    `ALTER ROLE ${quoteIdent(username)} IN DATABASE ${quoteIdent(databaseName)} SET statement_timeout = ${quoteLiteral(`${limits.statementTimeoutMs}ms`)}`,
    `ALTER ROLE ${quoteIdent(username)} IN DATABASE ${quoteIdent(databaseName)} SET idle_in_transaction_session_timeout = ${quoteLiteral(`${limits.idleInTransactionSessionTimeoutMs}ms`)}`,
    `ALTER ROLE ${quoteIdent(username)} IN DATABASE ${quoteIdent(databaseName)} SET lock_timeout = ${quoteLiteral(`${limits.lockTimeoutMs}ms`)}`,
  ];
  const sql = `${sqlStatements.join(';\n')};\n`;
  const adminCommand = psqlCommand(adminUrl || '<provider-admin-url>', ['--set', 'ON_ERROR_STOP=1'], sql);
  const testCommand = psqlCommand(databaseUrl, ['--command', 'SELECT 1 AS raibitserver_connection_test'], '');
  const backupPath = options.backupPath || path.posix.join('/backups', `${slugify(resource.name || databaseName)}-${new Date(0).toISOString().slice(0, 10)}.dump`);
  const backupCommand = { executable: 'pg_dump', args: ['--dbname', databaseUrl, '--format=custom', '--file', backupPath], redacted: `pg_dump --dbname ${maskSecretValue(databaseUrl)} --format=custom --file ${backupPath}` } satisfies CommandSpec;
  const restoreCommand = { executable: 'pg_restore', args: ['--dbname', databaseUrl, '--clean', '--if-exists', backupPath], redacted: `pg_restore --dbname ${maskSecretValue(databaseUrl)} --clean --if-exists ${backupPath}` } satisfies CommandSpec;
  const env = {
    DATABASE_URL: databaseUrl,
    POSTGRES_URL: databaseUrl,
    PGHOST: host,
    PGPORT: String(port),
    PGDATABASE: databaseName,
    PGUSER: username,
    PGPASSWORD: password,
  };
  const plan = {
    engine: 'postgresql',
    capabilities,
    provider: options.provider || resource.provider || 'postgresql-direct',
    sharedProvider: {
      model: 'shared-postgresql-cluster',
      providerHost,
      connectionPath: 'service -> PgBouncer -> PostgreSQL',
      tenantPrimitive: 'database + cluster-level role',
      namingWarning: 'PostgreSQL roles are cluster-level; keep generated usernames globally unique per provider.',
      memoryGuidance: ['cap max_connections at the provider and prefer PgBouncer transaction pooling', 'reduce shared_buffers/work_mem/hash_mem_multiplier when OOM pressure appears', 'set per-role statement_timeout and idle_in_transaction_session_timeout for shared-small tenants'],
    },
    tenantLimits: limits,
    databaseName,
    username,
    host,
    port,
    databaseUrlMasked: maskSecretValue(databaseUrl),
    sqlStatements: sqlStatements.map((statement) => statement.replace(quoteLiteral(password), quoteLiteral('****'))),
    commands: {
      create: commandToString(adminCommand),
      test: commandToString(testCommand),
      backup: commandToString(backupCommand),
      restore: commandToString(restoreCommand),
      delete: `psql ${maskSecretValue(adminUrl || '<provider-admin-url>')} --set ON_ERROR_STOP=1 --command "DROP DATABASE IF EXISTS ${databaseName}; DROP USER IF EXISTS ${username};"`,
    },
    secret: { key: 'DATABASE_URL', valueMasked: maskSecretValue(databaseUrl), providerOwned: true },
    connectionSecret: connectionSecretSummary(env),
    riskControls: sharedProviderRiskControls('postgresql'),
    lifecycle: ['shared-provider-select', 'create-user', 'set-role-limits', 'create-database', 'grant-privileges', 'store-provider-secret', 'connection-pooler', 'connection-test', 'backup-plan', 'restore-plan', 'delete-plan'],
  } as AnyRecord;
  Object.defineProperty(plan, 'internal', { value: { adminUrl, sql, databaseUrl, env, adminCommand, testCommand, backupCommand, restoreCommand }, enumerable: false });
  return plan;
}

export async function provisionPostgresProvider(resource: AnyRecord = {}, options: AnyRecord = {}) {
	  if (options.execute === true || options.dryRun === false) throw new Error('live provider execution is handled exclusively by the authoritative Go provisioner');
  const sanitized: AnyRecord = {
    ...options,
    providerHost: undefined,
    host: undefined,
    poolerHost: undefined,
    port: undefined,
    adminUrl: undefined,
    providerAdminUrl: undefined,
  };
  const plan = buildPostgresProviderPlan(resource, { generatePassword: true, ...sanitized });
	  const dryRun = true;
  const steps = [];
  steps.push({ type: 'postgres-create-user-database-grants', ...(await runCommand(plan.internal.adminCommand, { dryRun, timeoutMs: sanitized.timeoutMs || 30_000 })) });
  steps.push({ type: 'postgres-connection-test', ...(await runCommand(plan.internal.testCommand, { dryRun, timeoutMs: sanitized.timeoutMs || 10_000 })) });
  const result = {
    engine: 'postgresql',
    provider: plan.provider,
	    status: 'provisioning',
    dryRun,
    databaseName: plan.databaseName,
    username: plan.username,
    databaseUrlMasked: plan.databaseUrlMasked,
    connectionSecret: plan.connectionSecret,
    backup: { command: plan.commands.backup },
    restore: { command: plan.commands.restore },
    steps: steps.map((step) => maskSecrets(step)),
    plan: publicProviderPlan(plan),
  } as AnyRecord;
  Object.defineProperty(result, 'databaseUrl', { value: plan.internal.databaseUrl, enumerable: false });
  Object.defineProperty(result, 'connectionEnv', { value: plan.internal.env, enumerable: false });
  return result;
}

export function buildResourceProviderPlan(resource: AnyRecord = {}, options: AnyRecord = {}) {
  const engine = normalizedEngine(resource.engine || resource.type);
  const capabilities = requireResourceCapability(engine, 'provision');
  if (engine === 'postgresql') return buildPostgresProviderPlan(resource, { generatePassword: true, ...options });
  const prepared = prepareResourceForEnv(resource, options);
  const env = providerConnectionEnvForResource(prepared, options);
  const name = slugify(prepared.name || engine || 'resource');
  const database = slugify(prepared.databaseName || prepared.database || prepared.name || 'app').replace(/-/g, '_');
  const username = slugify(prepared.username || prepared.name || engine || 'app').replace(/-/g, '_');
  const keyPrefix = redisLike(engine) ? safeRedisKeyPrefix(prepared.keyPrefix || `${slugify(prepared.projectSlug || resource.project || 'project')}:${name}:`) : undefined;
  const bucket = slugify(prepared.bucket || prepared.name || 'bucket');
  const collection = slugify(prepared.collection || prepared.name || 'collection');
  const topic = slugify(prepared.topic || prepared.name || 'events');
  const backupPath = options.backupPath || path.posix.join('/backups', `${name}-${new Date(0).toISOString().slice(0, 10)}`);
  const commands = providerCommands(engine, { env, name, database, username, keyPrefix, bucket, collection, topic, backupPath, sqlitePath: prepared.sqlitePath });
  const plan = {
    engine,
    capabilities,
    provider: options.provider || resource.provider || defaultProvider(engine),
    sharedProvider: sharedProviderModelFor(engine, { keyPrefix }),
    resourceName: name,
    databaseName: database,
    username: databaseLike(engine) || engine === 'nats' || engine === 'message-queue' ? username : undefined,
    keyPrefix,
    bucket: engine === 'object-storage' ? bucket : undefined,
    collection: ['qdrant', 'vector-db', 'mongodb'].includes(engine) ? collection : undefined,
    topic: ['nats', 'message-queue'].includes(engine) ? topic : undefined,
    sqlitePath: engine === 'sqlite' ? prepared.sqlitePath : undefined,
    connectionSecret: connectionSecretSummary(env),
    commands: Object.fromEntries(Object.entries(commands).map(([key, command]) => [key, commandToString(command)])),
    consoleSurface: providerConsoleSurface({ ...resource, engine, desiredSpec: { ...(resource.desiredSpec || {}), ...defaultConsoleSeed(engine, { bucket, collection, topic }) } }),
    riskControls: sharedProviderRiskControls(engine),
    lifecycle: lifecycleFor(engine),
  } as AnyRecord;
  Object.defineProperty(plan, 'internal', { value: { env, commands }, enumerable: false });
  return plan;
}

export async function provisionResourceProvider(resource: AnyRecord = {}, options: AnyRecord = {}) {
	  if (options.execute === true || options.dryRun === false) throw new Error('live provider execution is handled exclusively by the authoritative Go provisioner');
  const engine = normalizedEngine(resource.engine || resource.type);
  if (engine === 'postgresql') return provisionPostgresProvider(resource, options);
  const plan = buildResourceProviderPlan(resource, { generatePassword: true, ...options });
	  const dryRun = true;
  const steps = [];
  if (plan.internal.commands.create) steps.push({ type: `${engine}-create`, ...(await runCommand(plan.internal.commands.create, { dryRun, timeoutMs: options.timeoutMs || 30_000 })) });
  if (plan.internal.commands.test) steps.push({ type: `${engine}-connection-test`, ...(await runCommand(plan.internal.commands.test, { dryRun, timeoutMs: options.timeoutMs || 10_000 })) });
  const result = {
    engine,
    provider: plan.provider,
	    status: 'provisioning',
    dryRun,
    connectionSecret: plan.connectionSecret,
    backup: { command: plan.commands.backup },
    restore: { command: plan.commands.restore },
    steps: steps.map((step) => maskSecrets(step)),
    plan: publicResourceProviderPlan(plan),
  } as AnyRecord;
  Object.defineProperty(result, 'connectionEnv', { value: plan.internal.env, enumerable: false });
  Object.defineProperty(result, 'databaseUrl', { value: primaryConnectionValue(plan.internal.env, engine), enumerable: false });
  return result;
}

export function providerConnectionEnvForResource(resource: AnyRecord = {}, options: AnyRecord = {}) {
  const prepared = prepareResourceForEnv(resource, options);
  return connectionEnvForResource(prepared, prepared.projectSlug || options.projectSlug || 'project');
}

export function providerConsoleSurface(resource: AnyRecord = {}, options: AnyRecord = {}) {
  const engine = normalizedEngine(resource.engine || resource.type);
  const desired = { ...(resource.desiredSpec || {}), ...(resource.desiredState || {}) };
  const connectionInfo = maskedProviderConnection(resource.providerConnection || {}, engine);
  if (engine === 'redis' || engine === 'valkey') {
    const keys = Array.isArray(options.keys) ? options.keys : Array.isArray(desired.keys) ? desired.keys : [];
    return { engine, keys: keys.map(String).slice(0, clamp(options.limit, 1, 1000, 100)), connectionInfo, mode: keys.length ? 'deterministic-adapter' : 'provider-contract', command: 'SCAN 0 MATCH * COUNT 100', warning: keys.length ? undefined : `${engine} key browser requires provider-owned REDIS_URL/VALKEY_URL or adapter-supplied keys` };
  }
  if (engine === 'mysql' || engine === 'mariadb') {
    return { engine, tables: desired.tables || [], schemas: desired.schemas || [], connectionInfo, mode: 'provider-contract', command: 'mysql --batch --execute "SHOW TABLES"', warning: `${engine} console uses provider-owned MYSQL_URL/MARIADB_URL with mysql CLI adapter when configured` };
  }
  if (engine === 'mongodb') {
    return { engine, collections: desired.collections || [], documents: desired.documents || {}, connectionInfo, mode: 'provider-contract', command: 'mongosh --eval "db.getCollectionNames()"', warning: 'MongoDB collection browser uses provider-owned MONGODB_URI when configured' };
  }
  if (engine === 'object-storage') {
    return { engine, buckets: desired.buckets || (desired.bucket ? [desired.bucket] : []), objects: desired.objects || [], connectionInfo, mode: 'provider-contract', command: 'mc ls <alias>/<bucket>', warning: 'MinIO/S3 bucket browser uses provider-owned endpoint credentials when configured' };
  }
  if (engine === 'qdrant' || engine === 'vector-db') {
    return { engine: engine === 'vector-db' ? 'qdrant' : engine, collections: desired.collections || (desired.collection ? [desired.collection] : []), connectionInfo, mode: 'provider-contract', command: 'GET /collections', warning: 'Qdrant collection/search uses provider-owned QDRANT_URL/API key when configured' };
  }
  if (engine === 'nats' || engine === 'message-queue') {
    return { engine: engine === 'message-queue' ? 'nats' : engine, streams: desired.streams || [], subjects: desired.subjects || (desired.topic ? [desired.topic] : []), connectionInfo, mode: 'provider-contract', command: 'nats stream ls', warning: 'NATS browser uses provider-owned QUEUE_URL/NATS_URL when configured' };
  }
  return { engine, connectionInfo, mode: 'provider-contract', warning: `${engine} provider console adapter is not configured` };
}

export function publicProviderPlan(plan: AnyRecord) {
  const { internal: _internal, secret: _secret, ...rest } = plan;
  return maskSecrets(rest);
}

export function publicResourceProviderPlan(plan: AnyRecord) {
  const { internal: _internal, ...rest } = plan;
  return maskSecrets(rest);
}

function providerCommands(engine: string, context: AnyRecord): Record<string, CommandSpec> {
  const { env, database, username, keyPrefix, bucket, collection, topic, backupPath, sqlitePath } = context;
  const primary = primaryConnectionValue(env, engine) || '<provider-owned-connection>';
  switch (engine) {
    case 'mysql':
    case 'mariadb':
      return {
        create: shellCommand(`mysql --execute "CREATE DATABASE IF NOT EXISTS ${database}; CREATE USER IF NOT EXISTS '${username}'@'%' IDENTIFIED BY '<provider-password>'; GRANT ALL PRIVILEGES ON ${database}.* TO '${username}'@'%';"`),
        test: shellCommand(`mysql ${maskSecretValue(primary)} --execute "SELECT 1 AS raibitserver_connection_test"`),
        backup: shellCommand(`mysqldump ${maskSecretValue(primary)} > ${backupPath}.sql`),
        restore: shellCommand(`mysql ${maskSecretValue(primary)} < ${backupPath}.sql`),
        delete: shellCommand(`mysql --execute "DROP DATABASE IF EXISTS ${database}; DROP USER IF EXISTS '${username}'@'%';"`),
      };
    case 'mongodb':
      return {
        create: shellCommand(`mongosh ${maskSecretValue(primary)} --eval "db = db.getSiblingDB('${database}'); db.createUser({ user: '${username}', pwd: '<provider-password>', roles: [{ role: 'readWrite', db: '${database}' }] }); db.createCollection('health')"`),
        test: shellCommand(`mongosh ${maskSecretValue(primary)} --eval "db.runCommand({ ping: 1 })"`),
        backup: shellCommand(`mongodump --uri ${maskSecretValue(primary)} --db ${database} --out ${backupPath}`),
        restore: shellCommand(`mongorestore --uri ${maskSecretValue(primary)} --db ${database} ${backupPath}/${database}`),
        delete: shellCommand(`mongosh ${maskSecretValue(primary)} --eval "db = db.getSiblingDB('${database}'); db.dropDatabase()"`),
      };
    case 'redis':
    case 'valkey':
      return {
        create: shellCommand(`redis-cli -u ${maskSecretValue(primary)} ACL SETUSER ${username} on \\>'<provider-password>' '~${keyPrefix}*' +@read +@write +@connection +@pubsub +@transaction -@admin -@dangerous -FLUSHALL -FLUSHDB && redis-cli -u ${maskSecretValue(primary)} PING`),
        test: shellCommand(`redis-cli -u ${maskSecretValue(primary)} PING`),
        backup: shellCommand(`redis-cli -u ${maskSecretValue(primary)} --scan --pattern '${keyPrefix}*' > ${backupPath}.keys`),
        restore: shellCommand(`redis-cli -u ${maskSecretValue(primary)} --pipe < ${backupPath}.resp # prefix-scoped restore only for keys under ${keyPrefix}`),
        delete: shellCommand(`cursor=0; while :; do reply=$(redis-cli -u ${maskSecretValue(primary)} SCAN "$cursor" MATCH '${keyPrefix}*' COUNT 500); cursor=$(printf '%s\\n' "$reply" | sed -n '1p'); keys=$(printf '%s\\n' "$reply" | sed '1d'); [ -n "$keys" ] && printf '%s\\n' "$keys" | xargs -r redis-cli -u ${maskSecretValue(primary)} UNLINK; [ "$cursor" = "0" ] && break; done`),
      };
    case 'sqlite':
      return {
        create: shellCommand(`mkdir -p ${path.dirname(sqlitePath)} && touch ${sqlitePath}`),
        test: shellCommand(`sqlite3 ${sqlitePath} "SELECT 1"`),
        backup: shellCommand(`cp ${sqlitePath} ${backupPath}.sqlite`),
        restore: shellCommand(`cp ${backupPath}.sqlite ${sqlitePath}`),
        delete: shellCommand(`rm -f ${sqlitePath}`),
      };
    case 'object-storage':
      return {
        create: shellCommand(`mc mb --ignore-existing raibit/${bucket}`),
        test: shellCommand(`mc ls raibit/${bucket}`),
        backup: shellCommand(`mc mirror raibit/${bucket} ${backupPath}`),
        restore: shellCommand(`mc mirror ${backupPath} raibit/${bucket}`),
        delete: shellCommand(`mc rm --recursive --force raibit/${bucket}`),
      };
    case 'qdrant':
    case 'vector-db':
      return {
        create: shellCommand(`curl -X PUT ${maskSecretValue(env.VECTOR_DB_URL || '<qdrant-url>')}/collections/${collection}`),
        test: shellCommand(`curl ${maskSecretValue(env.VECTOR_DB_URL || '<qdrant-url>')}/collections`),
        backup: shellCommand(`curl ${maskSecretValue(env.VECTOR_DB_URL || '<qdrant-url>')}/collections/${collection}/snapshots`),
        restore: shellCommand(`curl -X POST ${maskSecretValue(env.VECTOR_DB_URL || '<qdrant-url>')}/collections/${collection}/snapshots/recover`),
        delete: shellCommand(`curl -X DELETE ${maskSecretValue(env.VECTOR_DB_URL || '<qdrant-url>')}/collections/${collection}`),
      };
    case 'nats':
    case 'message-queue':
      return {
        create: shellCommand(`nats stream add ${topic} --subjects ${topic}.>`),
        test: shellCommand(`nats server check connection`),
        backup: shellCommand(`nats stream backup ${topic} ${backupPath}`),
        restore: shellCommand(`nats stream restore ${backupPath}`),
        delete: shellCommand(`nats stream rm ${topic} --force`),
      };
    default:
      return { create: shellCommand(`echo reconcile ${engine}`), test: shellCommand(`echo test ${engine}`) };
  }
}

function prepareResourceForEnv(resource: AnyRecord, options: AnyRecord) {
  const engine = normalizedEngine(resource.engine || resource.type);
  const name = slugify(resource.name || engine || 'resource');
  const tenantScope = uniqueTenantScope(resource, options);
  const tenantName = tenantResourceName(resource, name, tenantScope);
  const generatedPassword = options.password || resource.password || resource.generatedPassword || secureRandomSecret(24);
  const prepared: AnyRecord = {
    ...resource,
    engine,
    password: generatedPassword,
    apiKey: options.apiKey || resource.apiKey || secureRandomSecret(24),
    accessKey: options.accessKey || resource.accessKey || `ak-${name}`,
    secretKey: options.secretKey || resource.secretKey || secureRandomSecret(24),
    databaseName: resource.databaseName || resource.database || tenantName,
    username: resource.username || `${tenantName}_app`.slice(0, 63),
    keyPrefix: safeRedisKeyPrefix(resource.keyPrefix || `${tenantScope}:${name}:`),
    bucket: resource.bucket || tenantName.replace(/_/g, '-'),
    collection: resource.collection || tenantName.replace(/_/g, '-'),
    topic: resource.topic || tenantName.replace(/_/g, '-'),
  };
  if (engine === 'sqlite') prepared.sqlitePath = resource.sqlitePath || resource.desiredSpec?.sqlitePath || providerOwnedSqlitePath(resource.id || name);
  return prepared;
}

function sharedProviderModelFor(engine: string, context: AnyRecord = {}) {
  if (['postgresql', 'mysql', 'mariadb'].includes(engine)) return { model: `shared-${engine}-server`, tenantPrimitive: 'database + user', isolation: 'shared process, WAL/binlog, buffer pool/cache, disk I/O, and backup substrate' };
  if (engine === 'mongodb') return { model: 'shared-mongodb-server', tenantPrimitive: 'database + user', isolation: 'shared process, cache, journal, disk I/O, and backup substrate' };
  if (redisLike(engine)) return { model: `shared-${engine}-server`, tenantPrimitive: 'ACL user + key prefix', keyPrefix: context.keyPrefix, isolation: 'shared event loop, memory, eviction policy, persistence, and network I/O' };
  if (engine === 'object-storage') return { model: 'shared-object-storage-provider', tenantPrimitive: 'bucket + IAM-style credentials' };
  if (engine === 'qdrant' || engine === 'vector-db') return { model: 'shared-vector-provider', tenantPrimitive: 'collection + API key' };
  if (engine === 'nats' || engine === 'message-queue') return { model: 'shared-queue-provider', tenantPrimitive: 'stream/subject + credentials' };
  return { model: `${engine}-provider`, tenantPrimitive: 'provider-owned resource' };
}

function sharedProviderRiskControls(engine: string) {
  const controls = ['plan quotas and per-resource usage metering', 'provider-owned credentials only', 'backup/restore scoped to the tenant primitive', 'monitor noisy-neighbor saturation before promoting tenants to dedicated plans'];
  if (engine === 'postgresql') return [...controls, 'PgBouncer in front of PostgreSQL to reduce connection memory', 'per-role timeouts and connection limits', 'pg_dump -Fc per database for project-level restore'];
  if (engine === 'mysql' || engine === 'mariadb') return [...controls, 'per-user grants scoped to one database', 'database-level dumps for project-level restore'];
  if (engine === 'mongodb') return [...controls, 'per-database users and mongodump --db for restore boundaries'];
  if (redisLike(engine)) return [...controls, 'Redis ACL key patterns must match REDIS_KEY_PREFIX', 'delete uses SCAN MATCH prefix + UNLINK, never FLUSHDB/FLUSHALL', 'prefix restore is best-effort and must be tested before production'];
  return controls;
}

function postgresTenantLimits(resource: AnyRecord, options: AnyRecord) {
  const spec = { ...(resource.desiredSpec || {}), ...(resource.desiredState || {}), ...resource, ...options };
  return {
    connectionLimit: clampInteger(spec.connectionLimit ?? spec.maxConnections, 1, 100, 20),
    statementTimeoutMs: clampInteger(spec.statementTimeoutMs, 1_000, 300_000, 30_000),
    idleInTransactionSessionTimeoutMs: clampInteger(spec.idleInTransactionSessionTimeoutMs, 1_000, 300_000, 30_000),
    lockTimeoutMs: clampInteger(spec.lockTimeoutMs, 500, 120_000, 5_000),
  };
}

function clampInteger(value: any, min: number, max: number, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.trunc(Math.min(max, Math.max(min, number)));
}

function connectionSecretSummary(env: AnyRecord) {
  return {
    providerOwned: true,
    keys: Object.keys(env),
    valuesMasked: Object.fromEntries(Object.entries(env).map(([key, value]) => [key, maskSecretValue(String(value))])),
  };
}

function primaryConnectionValue(env: AnyRecord, engine: string) {
  if (engine === 'postgresql') return env.DATABASE_URL || env.POSTGRES_URL;
  if (engine === 'mysql') return env.MYSQL_URL;
  if (engine === 'mariadb') return env.MARIADB_URL || env.MYSQL_URL;
  if (engine === 'mongodb') return env.MONGODB_URI || env.MONGO_URL;
  if (engine === 'redis') return env.REDIS_URL;
  if (engine === 'valkey') return env.VALKEY_URL || env.REDIS_URL;
  if (engine === 'sqlite') return env.DATABASE_URL || env.SQLITE_PATH;
  if (engine === 'object-storage') return env.S3_ENDPOINT;
  if (engine === 'qdrant' || engine === 'vector-db') return env.VECTOR_DB_URL;
  if (engine === 'nats' || engine === 'message-queue') return env.QUEUE_URL;
  return Object.values(env).find((value) => typeof value === 'string');
}

function defaultProvider(engine: string) {
  if (engine === 'sqlite') return 'local-pvc';
  if (engine === 'object-storage') return 'minio-s3';
  if (engine === 'valkey') return 'valkey-operator';
  if (engine === 'qdrant' || engine === 'vector-db') return 'qdrant-provider';
  if (engine === 'nats' || engine === 'message-queue') return 'nats-provider';
  return `${engine}-operator`;
}

function defaultConsoleSeed(engine: string, context: AnyRecord) {
  if (engine === 'redis' || engine === 'valkey') return { keys: ['health:ready'], values: { 'health:ready': 'ok' }, ttl: { 'health:ready': -1 } };
  if (engine === 'object-storage') return { bucket: context.bucket, buckets: [context.bucket], objects: [] };
  if (engine === 'mongodb') return { collections: [context.collection], documents: { [context.collection]: [] } };
  if (engine === 'qdrant' || engine === 'vector-db') return { collection: context.collection, collections: [context.collection] };
  if (engine === 'nats' || engine === 'message-queue') return { topic: context.topic, subjects: [`${context.topic}.>`] };
  if (engine === 'mysql' || engine === 'mariadb') return { schemas: [context.database], tables: [] };
  return {};
}

function lifecycleFor(engine: string) {
  if (engine === 'sqlite') return ['create-provider-path', 'store-provider-secret', 'connection-test', 'file-backup', 'file-restore', 'delete-cleanup'];
  if (['mysql', 'mariadb', 'postgresql'].includes(engine)) return ['create-database', 'create-user', 'grant-privileges', 'store-provider-secret', 'connection-test', 'backup-plan', 'restore-plan', 'delete-cleanup'];
  if (engine === 'mongodb') return ['create-database', 'create-user', 'store-provider-secret', 'ping-test', 'collection-browser', 'backup-plan', 'delete-cleanup'];
  if (engine === 'redis' || engine === 'valkey') return ['create-cache', 'store-provider-secret', 'ping-test', 'key-browser', 'ttl-view', 'backup-plan', 'delete-cleanup'];
  if (engine === 'object-storage') return ['create-bucket', 'store-provider-secret', 'object-browser', 'upload-download-delete', 'backup-plan', 'delete-cleanup'];
  if (engine === 'qdrant' || engine === 'vector-db') return ['create-collection', 'store-provider-secret', 'collection-browser', 'search-test', 'delete-cleanup'];
  if (engine === 'nats' || engine === 'message-queue') return ['create-stream-or-subject', 'store-provider-secret', 'connection-info', 'publish-subscribe-smoke', 'delete-cleanup'];
  return ['desired-state-write', 'provider-reconcile'];
}

function databaseLike(engine: string) {
  return ['postgresql', 'mysql', 'mariadb', 'mongodb', 'sqlite'].includes(engine);
}

function redisLike(engine: string) {
  return engine === 'redis' || engine === 'valkey';
}

function maskedProviderConnection(connection: AnyRecord, engine: string) {
  const entries = Object.entries(connection || {}).filter(([key]) => key !== 'live' && key !== 'mode');
  if (!entries.length) return undefined;
  return {
    engine,
    live: connection.live === true,
    mode: connection.live === true ? 'live-provider' : 'provider-contract',
    values: Object.fromEntries(entries.map(([key, value]) => [key, maskSecretValue(String(value))])),
  };
}

function psqlCommand(databaseUrl: string, args: string[], stdin: string): CommandSpec {
  return { executable: 'psql', args: [databaseUrl, ...args], stdin, redacted: `psql ${maskSecretValue(databaseUrl)} ${args.join(' ')}` };
}

function shellCommand(redacted: string): CommandSpec {
  return { executable: 'sh', args: ['-lc', redacted], redacted };
}

function safeSqlIdentifier(value: any) {
  const normalized = slugify(String(value || 'app')).replace(/-/g, '_').slice(0, 63) || 'app';
  const withPrefix = /^[a-z_]/.test(normalized) ? normalized : `r_${normalized}`;
  if (!SQL_IDENTIFIER_RE.test(withPrefix)) throw new Error(`unsafe PostgreSQL identifier: ${value}`);
  return withPrefix;
}

function tenantResourceName(resource: AnyRecord, fallback: string, tenantScope: string) {
  const project = slugify(tenantScope || resource.projectSlug || resource.project || 'project').replace(/-/g, '_');
  const name = slugify(resource.name || fallback || 'resource').replace(/-/g, '_');
  return `${project}_${name}`.slice(0, 55);
}

function uniqueTenantScope(resource: AnyRecord = {}, options: AnyRecord = {}) {
  const explicit = options.projectSlug || resource.projectSlug || resource.project;
  if (explicit) return slugify(explicit);
  const parts = [resource.organizationId, resource.projectId, resource.id].filter((value) => value !== undefined && value !== null && String(value).length > 0).map((value) => slugify(value));
  if (parts.length) return parts.join('-').slice(0, 48);
  return 'project';
}

function safeRedisKeyPrefix(value: any) {
  const raw = String(value || 'project:cache:').replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 128) || 'project:cache:';
  return raw.endsWith(':') ? raw : `${raw}:`;
}

function quoteIdent(value: string) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function normalizedEngine(value: any) {
  return normalizeResourceEngine(value);
}

function clamp(value: any, min: number, max: number, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
