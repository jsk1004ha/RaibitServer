import { readFile } from 'node:fs/promises';
import { parseStepRequest } from '../lib/step-contract.mjs';
import { runVerifiedRecovery } from './backup-sql.mjs';

const ENGINES = Object.freeze(['mongodb', 'redis', 'valkey']);
const CAPABILITY_ENGINES = Object.freeze([...ENGINES, 'sqlite']);
const CAPABILITIES_URL = new URL('../../../packages/schemas/src/resource-capabilities-v1.json', import.meta.url);

async function enabled() {
  let value;
  try { value = JSON.parse(await readFile(CAPABILITIES_URL, 'utf8')); } catch { return false; }
  return value?.version === 1 && CAPABILITY_ENGINES.every((engine) => { const row = value.engines?.find((candidate) => candidate.engine === engine); return row?.liveEvidence?.release === 'recorded' && row.release?.backup === true && row.release?.restore === true; });
}

async function output(context, identity, status, reason, inventory = []) {
  const artifact = await context.writeArtifact('resources', 'backup-nosql-not-run-observation.json', { identity, status, reason, capabilitySource: 'packages/schemas/src/resource-capabilities-v1.json', redacted: true });
  return { status, reason, assertions: ['backup_checksum', 'isolated_restore'].map((id) => ({ id, status, artifactPaths: [artifact.path] })), artifacts: [artifact], cleanupInventory: inventory };
}

export function validateCacheRecovery(source, target, observation, baseline = null) {
  if (!source || !target || source.role !== 'source' || target.role !== 'target' || source.engine !== target.engine
    || source.resourceId === target.resourceId || source.secretUid === target.secretUid || source.consumerPodUid === target.consumerPodUid) throw new Error('descriptor_splice');
  const expectedValue = baseline?.valueSha256 ?? observation?.expectedValueSha256;
  const expectedExpiry = baseline ? baseline.serverTimeMs + baseline.ttlMs : observation?.serverTimeMs + observation?.ttlMs;
  if (!observation || observation.authenticated !== true || observation.keyType !== 'string' || observation.valueSha256 !== expectedValue
    || !Number.isSafeInteger(observation.keyCount) || observation.keyCount !== 1 || !Number.isSafeInteger(observation.ttlMs) || observation.ttlMs <= 0
    || !Number.isSafeInteger(observation.serverTimeMs) || !Number.isSafeInteger(expectedExpiry)
    || Math.abs((observation.serverTimeMs + observation.ttlMs) - expectedExpiry) > 1_000) throw new Error('cache_restore_mismatch');
  return true;
}

function validateNoSqlRecovery(source, target, observation, baseline) {
  if (source.engine === 'mongodb') {
    if (observation?.authenticated !== true || observation.schemaSha256 !== baseline?.schemaSha256
      || observation.readSha256 !== baseline?.inputSha256 || observation.recordCount !== baseline?.recordCount || !Number.isSafeInteger(observation.recordCount) || observation.recordCount < 1) throw new Error('document_restore_mismatch');
    return true;
  }
  return validateCacheRecovery(source, target, observation, baseline);
}

export async function execute(request, context) {
  try { parseStepRequest(request, 'backup-nosql'); } catch { return output(context, request?.identity ?? null, 'FAIL', 'invalid_step_contract'); }
  if (!await enabled()) return output(context, request.identity, 'NOT_RUN', 'release_capability_not_verified');
  if (typeof context.controlPlaneJson !== 'function') return output(context, request.identity, 'NOT_RUN', 'authenticated_control_plane_unavailable');
  if (typeof context.resourceProbe !== 'function') return output(context, request.identity, 'NOT_RUN', 'resource_probe_unavailable');
  if (typeof context.waitForState !== 'function') return output(context, request.identity, 'NOT_RUN', 'bounded_watch_unavailable');
  return runVerifiedRecovery(request, context, ENGINES, validateNoSqlRecovery);
}
