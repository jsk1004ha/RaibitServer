import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ResourceLifecycleReceiptSchema, SqliteLifecycleReceiptSchema, RESOURCE_LIFECYCLE_ENGINES } from '../../../packages/schemas/src/resource-lifecycle-evidence.ts';
import { EvidenceError, digest, assertRedacted } from './operator-inputs.mjs';

const nativeClients = Object.freeze({ postgresql: 'psql', mysql: 'mysql', mariadb: 'mariadb', mongodb: 'mongosh', redis: 'redis-cli', valkey: 'valkey-cli' });
const connectionKeys = Object.freeze({ postgresql: 'DATABASE_URL', mysql: 'MYSQL_URL', mariadb: 'MARIADB_URL', mongodb: 'MONGODB_URI', redis: 'REDIS_URL', valkey: 'VALKEY_URL' });
const stages = ['createdAt', 'providerHealthAt', 'readyAt', 'attachedAt', 'healthAt', 'sentinelAt', 'detachedAt', 'consumerRemovedAt', 'providerDeleteStartedAt', 'objectsDeletedAt', 'rowDeletedAt', 'cleanupAt'];
function unique(values) {
  if (new Set(values).size !== values.length) throw new EvidenceError('reused_engine_receipt');
}
async function boundJson(directory, artifact) {
  const bytes = await readFile(path.join(directory, artifact.path));
  if (digest(bytes) !== artifact.sha256) throw new EvidenceError('artifact_digest_mismatch');
  assertRedacted(bytes.toString('utf8'));
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) { if (error instanceof SyntaxError) throw new EvidenceError('invalid_engine_receipt'); throw error; }
}
// Called only after the public verifier's structural, run and physical-artifact guards.
export async function verifyResourceLifecycle(directory, manifest) {
  for (const fragment of manifest.fragments) {
    if (fragment.resourceScope?.kind !== 'lifecycle-only') continue;
    const scope = fragment.resourceScope;
    const paths = [...scope.engineReceiptPaths, scope.sqliteReceiptPath];
    unique(paths);
    const artifacts = paths.map(file => fragment.artifacts.find(artifact => artifact.path === file));
    if (artifacts.some(artifact => !artifact)) throw new EvidenceError('missing_artifact');
    unique(artifacts.map(artifact => artifact.sha256));
    const values = await Promise.all(artifacts.map(artifact => boundJson(directory, artifact)));
    const receipts = values.slice(0, 6).map(value => {
      const parsed = ResourceLifecycleReceiptSchema.safeParse(value);
      if (!parsed.success) throw new EvidenceError('invalid_engine_receipt');
      return parsed.data;
    });
    unique(receipts.map(receipt => receipt.engine));
    if (RESOURCE_LIFECYCLE_ENGINES.some(engine => !receipts.some(receipt => receipt.engine === engine))) throw new EvidenceError('missing_engine_receipt');
    unique(receipts.map(receipt => receipt.identity.resourceId));
    unique(receipts.map(receipt => receipt.attachment.id));
    unique(receipts.map(receipt => receipt.native.nonce));
    unique(receipts.flatMap(receipt => [receipt.objects.workloadUid, receipt.objects.podUid, receipt.objects.pvcUid, receipt.objects.secretUid]));
    for (const receipt of receipts) {
      const { identity, attachment, objects, providerHealth, native } = receipt;
      if (digest({ ...identity, resourceId: manifest.identity.resourceId }) !== digest(manifest.identity)) throw new EvidenceError('identity_mismatch');
      if (receipt.provenance !== (manifest.fixture ? 'fixture' : 'credentialed')) throw new EvidenceError('level_mismatch');
      if (receipt.cleanup !== 'PASS') throw new EvidenceError('cleanup_failed');
      if (attachment.serviceId !== identity.serviceId || attachment.deploymentId !== identity.deploymentId || attachment.namespace !== receipt.namespace || attachment.secretUid !== objects.secretUid || attachment.secretName !== objects.secretName || attachment.key !== connectionKeys[receipt.engine]) throw new EvidenceError('attachment_identity_mismatch');
      const expected = digest({ runId: identity.runId, engine: receipt.engine, resourceId: identity.resourceId, nonce: native.nonce });
      if (native.namespace !== receipt.namespace || native.consumerPodUid !== attachment.consumerPodUid || native.secretUid !== objects.secretUid || native.client !== nativeClients[receipt.engine] || native.inputSha256 !== expected || native.readSha256 !== expected) throw new EvidenceError('native_evidence_mismatch');
      if (providerHealth.namespace !== receipt.namespace || providerHealth.providerPodUid !== objects.podUid || providerHealth.secretUid !== objects.secretUid || providerHealth.client !== nativeClients[receipt.engine]) throw new EvidenceError('native_evidence_mismatch');
      const times = stages.map(stage => Date.parse(receipt.times[stage]));
      if (times.some(time => time < Date.parse(fragment.startedAt) || time > Date.parse(fragment.observedAt))) throw new EvidenceError('stale_state');
      if (times.some((time, index) => index > 0 && time < times[index - 1])) throw new EvidenceError('lifecycle_order_mismatch');
    }
    const sqlite = SqliteLifecycleReceiptSchema.safeParse(values.at(-1));
    if (!sqlite.success) throw new EvidenceError('invalid_sqlite_receipt');
    if (digest(sqlite.data.identity) !== digest(manifest.identity)) throw new EvidenceError('identity_mismatch');
    if (sqlite.data.cleanup !== 'PASS') throw new EvidenceError('cleanup_failed');
    const expected = digest({ databaseId: sqlite.data.databaseId, engine: 'sqlite', runId: manifest.identity.runId });
    if (sqlite.data.inputSha256 !== expected || sqlite.data.readSha256 !== expected) throw new EvidenceError('native_evidence_mismatch');
    const times = ['createdAt', 'writtenAt', 'readAt', 'removedAt'].map(stage => Date.parse(sqlite.data.times[stage]));
    if (times[0] < Date.parse(fragment.startedAt) || times.at(-1) > Date.parse(fragment.observedAt)) throw new EvidenceError('stale_state');
    if (times.some((time, index) => index > 0 && time < times[index - 1])) throw new EvidenceError('lifecycle_order_mismatch');
  }
}
