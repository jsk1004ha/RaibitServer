import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { EvidenceError } from '../lib/operator-inputs.mjs';
import { parseStepResult } from '../lib/step-contract.mjs';
import { cleanupControlPlane, requireControlPlaneCapabilities } from './cleanup-control-plane.mjs';
import { prepareCleanupAuthority, recordCleanupOutcome } from './cleanup-authority.mjs';
import {
  CleanupError, CleanupNotRunError, RUN_LABEL, assertRunLabels, authenticatedClient, callTimeout,
  cleanupOrder, isNotFound, isRecord, itemKey, nowIso, nowMs, parseBaseRequest, parseInventoryItems,
  parseJson,
} from './cleanup-helpers.mjs';

const KUBERNETES_RESOURCES = new Map([
  ['v1:Pod', { resource: 'pod', path: 'pods' }],
  ['v1:Service', { resource: 'service', path: 'services' }],
  ['v1:ConfigMap', { resource: 'configmap', path: 'configmaps' }],
  ['v1:Secret', { resource: 'secret', path: 'secrets' }],
  ['v1:ServiceAccount', { resource: 'serviceaccount', path: 'serviceaccounts' }],
  ['v1:PersistentVolumeClaim', { resource: 'persistentvolumeclaim', path: 'persistentvolumeclaims' }],
  ['apps/v1:Deployment', { resource: 'deployment', path: 'deployments' }],
  ['apps/v1:DaemonSet', { resource: 'daemonset', path: 'daemonsets' }],
  ['apps/v1:ReplicaSet', { resource: 'replicaset', path: 'replicasets' }],
  ['apps/v1:StatefulSet', { resource: 'statefulset', path: 'statefulsets' }],
  ['batch/v1:Job', { resource: 'job', path: 'jobs' }],
  ['batch/v1:CronJob', { resource: 'cronjob', path: 'cronjobs' }],
  ['networking.k8s.io/v1:NetworkPolicy', { resource: 'networkpolicy', path: 'networkpolicies' }],
  ['rbac.authorization.k8s.io/v1:Role', { resource: 'role', path: 'roles' }],
  ['rbac.authorization.k8s.io/v1:RoleBinding', { resource: 'rolebinding', path: 'rolebindings' }],
]);

function kubernetesResource(item) {
  const mapped = KUBERNETES_RESOURCES.get(`${item.apiVersion}:${item.kind}`);
  if (!mapped) throw new CleanupError('cleanup_unsupported');
  const base = item.apiVersion === 'v1' ? '/api/v1' : `/apis/${item.apiVersion}`;
  return { ...mapped, apiPath: `${base}/namespaces/${encodeURIComponent(item.namespace)}/${mapped.path}/${encodeURIComponent(item.name)}` };
}

async function cleanupKubernetes(item, request, context) {
  if (item.type !== 'kubernetes' || typeof item.apiVersion !== 'string' || typeof item.kind !== 'string' || typeof item.namespace !== 'string'
    || typeof item.name !== 'string' || typeof item.uid !== 'string' || !item.uid || !/^[A-Za-z][A-Za-z0-9.-]*$/.test(item.kind)
    || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(item.namespace) || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/i.test(item.name)) throw new CleanupError('cleanup_invalid_state');
  if (item.namespace !== request.state.cleanupNamespace && !authenticatedClient(item, request.state)) throw new CleanupError('cleanup_identity_mismatch');
  assertRunLabels(item.labels, request.identity);
  const get = ['--namespace', item.namespace, 'get', item.kind, item.name, '--output=json'];
  const before = await context.executeFile('kubectl', get, { cwd: request.runDirectory, timeoutMs: callTimeout(request, context) });
  if (isNotFound(before)) return;
  if (before.exitCode !== 0) throw new CleanupError('cleanup_command_failure');
  const metadata = parseJson(before.stdout, 'cleanup_identity_mismatch').metadata;
  if (!isRecord(metadata) || metadata.uid !== item.uid || metadata.namespace !== item.namespace || metadata.labels?.[RUN_LABEL] !== request.identity.runId
    || metadata.resourceVersion !== item.resourceVersion) throw new CleanupError('cleanup_identity_mismatch');
  const target = kubernetesResource(item);
  const stdin = `${JSON.stringify({ apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: item.uid, resourceVersion: metadata.resourceVersion } })}\n`;
  const deleted = await context.executeFile('kubectl', ['delete', '--raw', target.apiPath, '-f', '-'], { cwd: request.runDirectory, timeoutMs: callTimeout(request, context), stdin });
  if (deleted.exitCode !== 0) throw new CleanupError('cleanup_command_failure');
  const timeoutMs = callTimeout(request, context);
  const waitSeconds = Math.max(1, Math.floor(timeoutMs / 1_000));
  const waited = await context.executeFile('kubectl', ['wait', '--for=delete', `${target.resource}/${item.name}`, '--namespace', item.namespace, `--timeout=${waitSeconds}s`], { cwd: request.runDirectory, timeoutMs });
  if (waited.exitCode !== 0) throw new CleanupError('cleanup_command_failure');
  const after = await context.executeFile('kubectl', get, { cwd: request.runDirectory, timeoutMs: callTimeout(request, context) });
  if (!isNotFound(after)) throw new CleanupError(after.exitCode === 0 ? 'cleanup_leak' : 'cleanup_command_failure');
}
async function cleanupProcess(item, request, context) {
  if (item.type !== 'process' || !Number.isSafeInteger(item.pid) || item.pid < 2 || !/^[a-f0-9]{64}$/.test(item.commandSha256) || !Number.isFinite(Date.parse(item.startedAt))) throw new CleanupError('cleanup_invalid_state');
  const inspect = ['inspect', String(item.pid)];
  const before = await context.executeFile('raibit-evidence-process', inspect, { cwd: request.runDirectory, timeoutMs: callTimeout(request, context) });
  if (isNotFound(before)) return;
  if (before.exitCode !== 0) throw new CleanupError('cleanup_command_failure');
  const live = parseJson(before.stdout, 'cleanup_identity_mismatch');
  if (!isRecord(live) || live.pid !== item.pid || live.startedAt !== item.startedAt || live.commandSha256 !== item.commandSha256) throw new CleanupError('cleanup_identity_mismatch');
  const stopped = await context.executeFile('raibit-evidence-process', ['terminate', String(item.pid), item.startedAt, item.commandSha256], { cwd: request.runDirectory, timeoutMs: callTimeout(request, context) });
  if (stopped.exitCode !== 0) throw new CleanupError('cleanup_command_failure');
  const after = await context.executeFile('raibit-evidence-process', inspect, { cwd: request.runDirectory, timeoutMs: callTimeout(request, context) });
  if (!isNotFound(after)) throw new CleanupError(after.exitCode === 0 ? 'cleanup_leak' : 'cleanup_command_failure');
}
async function cleanupItem(item, request, context, proof) {
  switch (item.type) {
    case 'kubernetes': return cleanupKubernetes(item, request, context);
    case 'control-plane': {
      if (proof?.error) throw new CleanupError(proof.error);
      const response = await cleanupControlPlane(item, request, context, proof);
      await recordCleanupOutcome(proof, request, context, item, response);
      return;
    }
    case 'process': return cleanupProcess(item, request, context);
    case 'file': throw new CleanupError('cleanup_file_ownership_missing');
    default: throw new CleanupError('cleanup_invalid_state');
  }
}
async function assertWorkEmpty(runDirectory) {
  const work = path.resolve(runDirectory, 'work');
  try { if ((await readdir(work)).length !== 0) throw new CleanupError('cleanup_leak'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function resultReason(error) { return error instanceof EvidenceError ? error.reason : 'cleanup_command_failure'; }

export async function execute(value, context) {
  const { request, rawInventory } = parseBaseRequest(value);
  const startedAt = nowIso(context);
  const { inventory, failures } = parseInventoryItems(rawInventory, request);
  const controls = inventory.filter((item) => item.type === 'control-plane');
  const results = [...failures];
  let failureReason = failures[0]?.reason ?? (Object.hasOwn(request.state, 'controlPlaneBaseUrl') ? 'cleanup_invalid_state' : null);
  let controlPreflightFailure = Object.hasOwn(request.state, 'controlPlaneBaseUrl') ? 'cleanup_invalid_state' : null;
  let notRunReason = null;
  let proofs = new Map();
  let clientPodRemoved = false;
  if (Object.hasOwn(request.state, 'controlPlaneBaseUrl')) results.push({ target: 'state:controlPlaneBaseUrl', status: 'FAIL', reason: failureReason });
  if (controls.length > 0) {
    try {
      requireControlPlaneCapabilities(context);
      proofs = await prepareCleanupAuthority(context, request, controls);
    } catch (error) {
      if (error instanceof CleanupNotRunError) notRunReason = error.reason;
      else controlPreflightFailure ??= resultReason(error);
    }
  }
  for (const item of cleanupOrder(inventory, request.state)) {
    try {
      if (nowMs(context) >= Date.parse(request.deadlineAt)) throw new CleanupError('cleanup_timeout');
      if (item.type === 'control-plane' && notRunReason !== null) {
        results.push({ target: itemKey(item), status: 'NOT_RUN', reason: notRunReason });
        continue;
      }
      if (item.type === 'control-plane' && controlPreflightFailure !== null) {
        results.push({ target: itemKey(item), status: 'FAIL', reason: controlPreflightFailure });
        failureReason ??= controlPreflightFailure;
        continue;
      }
      if (authenticatedClient(item, request.state) && item.kind === 'NetworkPolicy' && !clientPodRemoved) throw new CleanupError('cleanup_identity_mismatch');
      await cleanupItem(item, request, context, proofs.get(itemKey(item)));
      if (authenticatedClient(item, request.state) && item.kind === 'Pod') clientPodRemoved = true;
      results.push({ target: itemKey(item), status: 'PASS', reason: null });
    } catch (error) {
      const reason = resultReason(error);
      if (error instanceof CleanupNotRunError) {
        results.push({ target: itemKey(item), status: 'NOT_RUN', reason });
        notRunReason ??= reason;
        continue;
      }
      results.push({ target: itemKey(item), status: 'FAIL', reason });
      failureReason ??= reason;
    }
  }
  try { await assertWorkEmpty(request.runDirectory); }
  catch (error) { failureReason ??= resultReason(error); }
  const status = failureReason !== null ? 'FAIL' : notRunReason !== null ? 'NOT_RUN' : 'PASS';
  const reason = failureReason ?? notRunReason;
  const artifact = await context.writeArtifact('cleanup', 'cleanup-observation.json', {
    schema: 'raibitserver.production-evidence-cleanup/v1', identity: request.identity, startedAt, observedAt: nowIso(context), status, reason,
    cleanupInventory: inventory, cleanupResults: results, workDirectory: path.join(request.runDirectory, 'work'), immutableEvidencePreserved: true,
  });
  const returnedInventory = inventory.filter((item) => item.type !== 'control-plane');
  return parseStepResult({ status, reason, assertions: ['component_cleanup', 'run_cleanup'].map((id) => ({ id, status, artifactPaths: [artifact.path] })), artifacts: [artifact], cleanupInventory: returnedInventory }, 'cleanup', request);
}
