import { resourceCapability } from './resource-capabilities.ts';

const RESOURCE_METADATA = {
  postgresql: {
    type: 'database',
    engine: 'postgresql',
    displayName: 'PostgreSQL',
    defaultVersion: '16',
    priority: 1,
    operator: 'CloudNativePG',
    env: ['DATABASE_URL', 'POSTGRES_URL', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'],
    features: ['shared-provider', 'sql-editor', 'table-browser', 'extensions', 'backup-restore', 'pitr', 'read-replica', 'pooling', 'per-role-limits'],
  },
  mysql: {
    type: 'database',
    engine: 'mysql',
    displayName: 'MySQL',
    defaultVersion: '8',
    priority: 1,
    operator: 'Percona Operator for MySQL',
    env: ['MYSQL_URL', 'MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_DATABASE', 'MYSQL_USER', 'MYSQL_PASSWORD'],
    features: ['shared-provider', 'sql-editor', 'table-browser', 'indexes', 'slow-query-logs', 'backup-restore'],
  },
  mariadb: {
    type: 'database',
    engine: 'mariadb',
    displayName: 'MariaDB',
    defaultVersion: '11',
    priority: 2,
    operator: 'MariaDB Operator or Percona-compatible profile',
    env: ['MARIADB_URL', 'MYSQL_URL', 'MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_DATABASE', 'MYSQL_USER', 'MYSQL_PASSWORD'],
    features: ['shared-provider', 'sql-editor', 'table-browser', 'backup-restore'],
  },
  mongodb: {
    type: 'database',
    engine: 'mongodb',
    displayName: 'MongoDB',
    defaultVersion: '7',
    priority: 2,
    operator: 'MongoDB Kubernetes Operator / Atlas Operator',
    env: ['MONGODB_URI', 'MONGO_URL', 'MONGO_HOST', 'MONGO_DATABASE', 'MONGO_USER', 'MONGO_PASSWORD'],
    features: ['shared-provider', 'collection-browser', 'document-editor', 'index-management', 'backup-restore'],
  },
  sqlite: {
    type: 'database',
    engine: 'sqlite',
    displayName: 'SQLite',
    defaultVersion: '3',
    priority: 3,
    operator: 'PVC-backed file database provider',
    env: ['DATABASE_URL', 'SQLITE_PATH'],
    features: ['sql-editor', 'table-browser', 'pvc-mount', 'single-writer-warning'],
  },
  redis: {
    type: 'cache',
    engine: 'redis',
    displayName: 'Redis',
    defaultVersion: '7',
    priority: 1,
    operator: 'Redis Operator / Redis Enterprise Operator / Upstash adapter',
    env: ['REDIS_URL', 'REDIS_HOST', 'REDIS_PORT', 'REDIS_USERNAME', 'REDIS_PASSWORD', 'REDIS_KEY_PREFIX'],
    features: ['shared-provider', 'acl-key-prefix', 'key-browser', 'ttl', 'memory-usage', 'eviction-policy', 'pubsub-monitoring'],
  },
  valkey: {
    type: 'cache',
    engine: 'valkey',
    displayName: 'Valkey',
    defaultVersion: '8',
    priority: 1,
    operator: 'Valkey/Redis-compatible provider adapter',
    env: ['REDIS_URL', 'VALKEY_URL', 'REDIS_HOST', 'REDIS_PORT', 'REDIS_USERNAME', 'REDIS_PASSWORD', 'REDIS_KEY_PREFIX', 'VALKEY_KEY_PREFIX'],
    features: ['shared-provider', 'acl-key-prefix', 'key-browser', 'ttl', 'memory-usage', 'pubsub-monitoring'],
  },
  'object-storage': {
    type: 'storage',
    engine: 's3-compatible',
    displayName: 'Object Storage',
    defaultVersion: 's3',
    priority: 1,
    operator: 'MinIO / S3-compatible provider adapter',
    env: ['S3_ENDPOINT', 'S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'],
    features: ['bucket-management', 'presigned-url', 'cors', 'public-private-policy', 'cdn-ready'],
  },
  'vector-db': {
    type: 'vector',
    engine: 'qdrant-compatible',
    displayName: 'Vector Database',
    defaultVersion: 'latest',
    priority: 3,
    operator: 'Qdrant/Weaviate/Milvus provider adapter',
    env: ['VECTOR_DB_URL', 'VECTOR_DB_API_KEY', 'VECTOR_DB_COLLECTION'],
    features: ['collection-management', 'embedding-dimensions', 'similarity-search-test', 'usage-monitoring'],
  },
  qdrant: {
    type: 'vector',
    engine: 'qdrant',
    displayName: 'Qdrant',
    defaultVersion: 'latest',
    priority: 2,
    operator: 'Qdrant local/provider adapter',
    env: ['VECTOR_DB_URL', 'VECTOR_DB_API_KEY', 'VECTOR_DB_COLLECTION'],
    features: ['collection-management', 'similarity-search-test', 'usage-monitoring'],
  },
  nats: {
    type: 'queue',
    engine: 'nats',
    displayName: 'NATS',
    defaultVersion: 'latest',
    priority: 2,
    operator: 'NATS local/provider adapter',
    env: ['QUEUE_URL', 'QUEUE_USERNAME', 'QUEUE_PASSWORD', 'QUEUE_TOPIC'],
    features: ['subjects', 'jetstream-connection-info', 'usage-monitoring'],
  },
  'message-queue': {
    type: 'queue',
    engine: 'nats-compatible',
    displayName: 'Message Queue',
    defaultVersion: 'latest',
    priority: 4,
    operator: 'NATS/Kafka/Redpanda/RabbitMQ provider adapter',
    env: ['QUEUE_URL', 'QUEUE_USERNAME', 'QUEUE_PASSWORD', 'QUEUE_TOPIC'],
    features: ['topic-management', 'consumer-lag', 'dead-letter-queue', 'usage-monitoring'],
  },
};

export const RESOURCE_CATALOG = Object.freeze(Object.fromEntries(Object.entries(RESOURCE_METADATA).map(([key, metadata]) => {
  const capabilities = resourceCapability(key);
  return [key, { ...metadata, capabilities, operator: capabilities?.runtime,
    features: Object.entries(capabilities?.local ?? {}).filter(([, enabled]) => enabled).map(([operation]) => operation),
  }];
})));

export function listCatalog() {
  return Object.entries(RESOURCE_CATALOG).map(([key, value]) => ({ key, ...value, capabilities: resourceCapability(key) }));
}

export function getCatalogEntry(engine) {
  const key = normalizeResourceEngine(engine);
  const entry = RESOURCE_CATALOG[key];
  if (!entry) throw new Error(`unsupported resource engine: ${engine}`);
  return { key, ...entry, capabilities: resourceCapability(key) };
}

export function normalizeResourceEngine(engine) {
  const value = String(engine || '').toLowerCase().replace(/_/g, '-');
  if (['postgres', 'postgresql', 'pg'].includes(value)) return 'postgresql';
  if (['mysql'].includes(value)) return 'mysql';
  if (['mariadb'].includes(value)) return 'mariadb';
  if (['mongo', 'mongodb'].includes(value)) return 'mongodb';
  if (['redis'].includes(value)) return 'redis';
  if (['valkey'].includes(value)) return 'valkey';
  if (['sqlite', 'sqlite3'].includes(value)) return 'sqlite';
  if (['s3', 'minio', 'object', 'object-storage', 'storage'].includes(value)) return 'object-storage';
  if (['qdrant'].includes(value)) return 'qdrant';
  if (['vector', 'vector-db', 'weaviate', 'milvus'].includes(value)) return 'vector-db';
  if (['nats'].includes(value)) return 'nats';
  if (['queue', 'message-queue', 'kafka', 'redpanda', 'rabbitmq'].includes(value)) return 'message-queue';
  return value;
}
