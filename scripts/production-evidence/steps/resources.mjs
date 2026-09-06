import { readFile } from 'node:fs/promises';
import { parseStepRequest } from '../lib/step-contract.mjs';
import { ResourceLifecycleReceiptSchema, SqliteLifecycleReceiptSchema } from '../../../packages/schemas/src/resource-lifecycle-evidence.ts';
import { trustedBindingGraph } from './backup-sql.mjs';
import { assertJournalAuthority } from '../lib/journal-authority.mjs';

const ENGINES = Object.freeze(['postgresql', 'mysql', 'mariadb', 'mongodb', 'redis', 'valkey']);
const CAPABILITIES_URL = new URL('../../../packages/schemas/src/resource-capabilities-v1.json', import.meta.url);
const REQUIRED = Object.freeze(['provision', 'authenticatedHealth', 'attach', 'query', 'schema']);

class StepFault extends Error {
  constructor(reason, status = 'FAIL') { super(reason); this.reason = reason; this.status = status; }
}

async function capabilities() {
  let value;
  try { value = JSON.parse(await readFile(CAPABILITIES_URL, 'utf8')); } catch { throw new StepFault('capability_contract_invalid', 'NOT_RUN'); }
  if (value?.version !== 1 || !Array.isArray(value.engines)) throw new StepFault('capability_contract_invalid', 'NOT_RUN');
  return value;
}

export function releaseCapabilitiesVerified(contract, engines = [...ENGINES, 'sqlite'], required = REQUIRED) {
  return engines.every((engine) => {
    const row = contract.engines.find((candidate) => candidate.engine === engine);
    return row && row.liveEvidence?.release === 'recorded' && required.every((name) => row.release?.[name] === true);
  });
}

async function result(context, identity, status, reason, artifacts = [], cleanupInventory = []) {
  if (artifacts.length === 0) artifacts.push(await context.writeArtifact('resources', 'resources-not-run-observation.json', {
    identity, status, reason, capabilitySource: 'packages/schemas/src/resource-capabilities-v1.json', redacted: true,
  }));
  const paths = artifacts.map(({ path }) => path);
  return { status, reason, assertions: ['provision', 'attach_query', 'resource_delete'].map((id) => ({ id, status, artifactPaths: paths })), artifacts, cleanupInventory };
}

function descriptorFor(receipt, resourceId) {
  return Object.freeze({ role: 'source', resourceId, namespace: receipt.namespace,
    providerPodUid: receipt.objects.podUid, consumerPodUid: receipt.attachment.consumerPodUid,
    secretUid: receipt.objects.secretUid, secretName: receipt.objects.secretName, secretKey: receipt.attachment.key });
}

function assertProbe(probe, receipt, resourceId, nonce, phase) {
  const descriptor = descriptorFor(receipt, resourceId);
  if (!probe || probe.engine !== receipt.engine || probe.phase !== phase || probe.nonce !== nonce || probe.authenticated !== true || probe.healthExitCode !== 0
    || probe.namespace !== descriptor.namespace || probe.providerPodUid !== descriptor.providerPodUid || probe.consumerPodUid !== descriptor.consumerPodUid
    || probe.secretUid !== descriptor.secretUid || probe.secretName !== descriptor.secretName || probe.secretKey !== descriptor.secretKey) throw new StepFault('descriptor_splice');
  if (phase === 'sentinel' && (probe.writeExitCode !== 0 || probe.readExitCode !== 0 || probe.inputSha256 !== receipt.native.inputSha256
    || probe.readSha256 !== receipt.native.readSha256)) throw new StepFault('probe_mismatch');
}

function sameRunIdentity(receiptIdentity, requestIdentity) {
  return ['runId', 'environmentFingerprint', 'sourceCommitSha', 'migrationDigest', 'approvedInputSha256', 'operatorContractDigest', 'operatorInputFingerprint']
    .every((key) => receiptIdentity[key] === requestIdentity[key]);
}

export async function emitVerifiedLifecycleReceipts(request, context, lifecycleReceipts, resourceIds = {}, graph = null) {
  if (typeof context.resourceProbe !== 'function') throw new StepFault('resource_probe_unavailable', 'NOT_RUN');
  if (!Array.isArray(lifecycleReceipts) || lifecycleReceipts.length !== 7) throw new StepFault('lifecycle_descriptor_missing', 'NOT_RUN');
  const managed = lifecycleReceipts.filter(({ engine }) => engine !== 'sqlite');
  const sqlite = lifecycleReceipts.find(({ engine }) => engine === 'sqlite');
  if (new Set(managed.map(({ engine }) => engine)).size !== ENGINES.length || ENGINES.some((engine) => !managed.some((value) => value.engine === engine))) throw new StepFault('engine_identity_conflated');
  const artifacts = [];
  for (const candidate of managed) {
    const parsed = ResourceLifecycleReceiptSchema.safeParse(candidate);
    if (!parsed.success || !sameRunIdentity(parsed.data.identity, request.identity)
      || (graph && (parsed.data.attachment.serviceId !== graph.serviceId || parsed.data.attachment.deploymentId !== graph.deploymentId))) throw new StepFault('lifecycle_descriptor_invalid');
    const receipt = parsed.data;
    const resourceId = resourceIds[receipt.engine];
    if (typeof resourceId !== 'string' || !resourceId) throw new StepFault('lifecycle_descriptor_invalid');
    const descriptor = descriptorFor(receipt, resourceId);
    const health = await context.resourceProbe({ descriptor, engine: receipt.engine, phase: 'provider-health', nonce: receipt.native.nonce, timeoutMs: 60_000 });
    const sentinel = await context.resourceProbe({ descriptor, engine: receipt.engine, phase: 'sentinel', nonce: receipt.native.nonce, timeoutMs: 60_000 });
    assertProbe(health, receipt, resourceId, receipt.native.nonce, 'provider-health');
    assertProbe(sentinel, receipt, resourceId, receipt.native.nonce, 'sentinel');
    artifacts.push(await context.writeArtifact('resources', `${receipt.engine}-resource-lifecycle.json`, receipt));
  }
  const local = SqliteLifecycleReceiptSchema.safeParse(sqlite);
  if (!local.success || !sameRunIdentity(local.data.identity, request.identity)) throw new StepFault('sqlite_lifecycle_invalid');
  artifacts.push(await context.writeArtifact('resources', 'sqlite-resource-lifecycle.json', local.data));
  return artifacts;
}

export async function execute(request, context) {
  try {
    parseStepRequest(request, 'resources');
    if (!releaseCapabilitiesVerified(await capabilities())) return result(context, request.identity, 'NOT_RUN', 'release_capability_not_verified');
    let authority;
    try { authority = assertJournalAuthority(context.journalAuthority); }
    catch { return result(context, request.identity, 'NOT_RUN', 'recovery_evidence_adapter_unavailable'); }
    let graph;
    try { graph = await trustedBindingGraph(request, ENGINES, authority); }
    catch (error) { return result(context, request.identity, error.message === 'recovery_bindings_missing' ? 'NOT_RUN' : 'FAIL', error.message); }
    if (typeof context.controlPlaneJson !== 'function') return result(context, request.identity, 'NOT_RUN', 'authenticated_control_plane_unavailable');
    const artifacts = await emitVerifiedLifecycleReceipts(request, context, request.state.resourceLifecycleReceipts, graph.resources, graph);
    return result(context, request.identity, 'PASS', null, artifacts);
  } catch (error) {
    const fault = error instanceof StepFault ? error : new StepFault('invalid_step_contract');
    return result(context, request?.identity ?? null, fault.status, fault.reason);
  }
}
