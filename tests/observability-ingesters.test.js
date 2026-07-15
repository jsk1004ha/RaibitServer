import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('log ingester polls Kubernetes with stable workload identity and bounded persistence', async () => {
  const [main, worker, kube, store] = await Promise.all([
    read('../services/log-ingester/cmd/log-ingester/main.go'),
    read('../services/log-ingester/internal/ingester/ingester.go'),
    read('../services/log-ingester/internal/kube/client.go'),
    read('../services/log-ingester/internal/store/postgres.go'),
  ]);
  assert.doesNotMatch(main, /action=stream-build-runtime-db-audit-logs/);
  assert.match(main, /RAIBITSERVER_INGEST_MAX_PODS/);
	assert.match(main, /RAIBITSERVER_INGEST_MAX_RECORDS/);
	assert.match(main, /RAIBITSERVER_INGEST_MAX_DURATION/);
  assert.match(main, /RAIBITSERVER_LOG_RETENTION/);
  assert.match(worker, /raibitserver\.io\/service-id/);
  assert.match(worker, /MaxLinesPerContainer/);
  assert.match(worker, /MaxLineBytes/);
  assert.match(worker, /DeleteOlderThan/);
  assert.match(kube, /\/api\/v1\/pods/);
  assert.match(kube, /limitBytes/);
  assert.match(kube, /sinceTime/);
	assert.match(kube, /tokenFile/);
	assert.match(kube, /SkipContainer/);
	assert.match(store, /ON CONFLICT \("sourceKey"\) DO NOTHING/);
	assert.match(store, /const batchSize = 100/);
	assert.match(store, /ORDER BY timestamp LIMIT/);
  assert.match(store, /SetMaxOpenConns/);
  assert.match(store, /cursor::timestamptz/);
});

test('metrics ingester stores only Kubernetes CPU and memory observations with bounded cardinality', async () => {
  const [main, worker, kube, store] = await Promise.all([
    read('../services/metrics-ingester/cmd/metrics-ingester/main.go'),
    read('../services/metrics-ingester/internal/ingester/ingester.go'),
    read('../services/metrics-ingester/internal/kube/client.go'),
    read('../services/metrics-ingester/internal/store/postgres.go'),
  ]);
  assert.doesNotMatch(main, /action=collect-cpu-memory-network-request-db-metrics/);
  assert.match(main, /RAIBITSERVER_INGEST_MAX_PODS/);
	assert.match(main, /RAIBITSERVER_INGEST_MAX_SAMPLES/);
  assert.match(main, /RAIBITSERVER_METRIC_RETENTION/);
  assert.match(worker, /raibitserver\.io\/service-id/);
  assert.match(worker, /"cpu", cpu, "cores"/);
  assert.match(worker, /"memory", memory, "bytes"/);
  assert.doesNotMatch(worker, /network|request_count|response_time/);
  assert.match(kube, /\/apis\/metrics\.k8s\.io\/v1beta1\/pods/);
	assert.match(kube, /tokenFile/);
	assert.match(store, /ON CONFLICT \("sourceKey"\) DO NOTHING/);
	assert.match(store, /const batchSize = 100/);
	assert.match(store, /ORDER BY timestamp LIMIT/);
  assert.match(store, /SetMaxOpenConns/);
});

test('Prisma schema and migration provide dedupe, cursor, metric, and retention query indexes', async () => {
  const [schema, migration] = await Promise.all([
    read('../prisma/schema.prisma'),
    read('../prisma/migrations/000006_observability_ingestion/migration.sql'),
  ]);
  assert.match(schema, /model RuntimeLog[\s\S]*sourceKey\s+String\?\s+@unique/);
  assert.match(schema, /model RuntimeMetric[\s\S]*sourceKey\s+String\s+@unique/);
  assert.match(schema, /@@index\(\[serviceId, metric, timestamp\]\)/);
	assert.match(schema, /model RuntimeLog[\s\S]*@@index\(\[timestamp\]\)/);
	assert.match(schema, /model RuntimeMetric[\s\S]*@@index\(\[timestamp\]\)/);
	assert.match(schema, /model IngestionCursor[\s\S]*@@index\(\[updatedAt\]\)/);
  assert.match(schema, /model IngestionCursor[\s\S]*cursor\s+String/);
  assert.match(migration, /RuntimeLog_sourceKey_key/);
  assert.match(migration, /RuntimeMetric_serviceId_metric_timestamp_idx/);
  assert.match(migration, /IngestionCursor_pkey/);
});
