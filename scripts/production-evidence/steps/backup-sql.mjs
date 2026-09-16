import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseStepRequest } from '../lib/step-contract.mjs';
import { ResourceBackupListViewSchema, ResourceBackupViewSchema, ResourceRestoreViewSchema } from '../../../packages/schemas/src/resource-recovery.ts';
import { EvidenceBindingSchema, EvidenceBindingsSchema } from '../../../packages/schemas/src/production-evidence.ts';
import { digest } from '../lib/operator-inputs.mjs';
import { Deletion } from '../../../packages/schemas/src/api-models.ts';
import { deriveRunResourceName } from '../lib/cleanup-intent-journal.mjs';
import { MUTATION_CONTRACT } from '../lib/binding-graph.mjs';
import { assertJournalAuthority } from '../lib/journal-authority.mjs';

const ENGINES = Object.freeze(['postgresql', 'mysql', 'mariadb']);
const CAPABILITIES_URL = new URL('../../../packages/schemas/src/resource-capabilities-v1.json', import.meta.url);
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_REASONS = new Set(['resource_descriptor_invalid', 'descriptor_splice', 'invalid_public_recovery_view', 'recovery_transition_missing', 'control_plane_failure', 'recovery_bindings_missing', 'binding_journal_invalid', 'binding_journal_mismatch', 'binding_graph_mismatch', 'recovery_evidence_unbound', 'backup_provenance_unverified', 'backup_cleanup_unverified', 'target_cleanup_unverified', 'mutation_journal_failed', 'mutation_binding_invalid', 'backup_identity_mismatch', 'backup_not_ready', 'restore_identity_mismatch', 'restore_not_ready', 'restore_probe_mismatch', 'cache_restore_mismatch', 'document_restore_mismatch']);

async function enabled(engineList = ENGINES) {
  let value;
  try { value = JSON.parse(await readFile(CAPABILITIES_URL, 'utf8')); } catch { return false; }
  return value?.version === 1 && engineList.every((engine) => { const row = value.engines?.find((candidate) => candidate.engine === engine); return row?.liveEvidence?.release === 'recorded' && row.release?.backup === true && row.release?.restore === true; });
}

async function output(context, request, status, reason, inventory = [], existing = []) {
  const artifacts = [...existing];
  if (artifacts.length === 0 || status !== 'PASS') artifacts.push(await context.writeArtifact('resources', `${request.step}-observation.json`, { identity: request.identity, status, reason, redacted: true }));
  const paths = artifacts.map(({ path }) => path);
  return { status, reason, assertions: ['backup_checksum', 'isolated_restore'].map((id) => ({ id, status, artifactPaths: paths })), artifacts, cleanupInventory: inventory };
}

function exactDescriptor(value, engine, role, resourceId) {
  const keys = ['engine', 'role', 'resourceId', 'namespace', 'providerPodUid', 'consumerPodUid', 'secretUid', 'secretName', 'secretKey', 'attachment'];
  const attachmentKeys = ['id', 'serviceId', 'deploymentId', 'namespace', 'consumerPodUid', 'secretUid', 'secretName', 'key'];
  if (!value || Object.keys(value).length !== keys.length || value.engine !== engine || value.role !== role || value.resourceId !== resourceId
    || keys.slice(3, 9).some((key) => typeof value[key] !== 'string' || !value[key]) || !value.attachment || Object.keys(value.attachment).length !== attachmentKeys.length
    || attachmentKeys.some((key) => typeof value.attachment[key] !== 'string' || !value.attachment[key])
    || value.attachment.namespace !== value.namespace || value.attachment.consumerPodUid !== value.consumerPodUid || value.attachment.secretUid !== value.secretUid
    || value.attachment.secretName !== value.secretName || value.attachment.key !== value.secretKey) throw new Error('resource_descriptor_invalid');
  return value;
}

export function validateRecoveryDescriptors(source, target, engine) {
  if (!source || !target || source.engine !== engine || target.engine !== engine || source.role !== 'source' || target.role !== 'target'
    || ['resourceId', 'providerPodUid', 'consumerPodUid', 'secretUid'].some((field) => source[field] === target[field])) throw new Error('descriptor_splice');
  return true;
}

function boundView(value, expected, kind) {
  const fields = kind === 'backup' ? ['id', 'organizationId', 'projectId', 'resourceId', 'engine']
    : ['id', 'organizationId', 'projectId', 'backupId', 'sourceResourceId', 'targetResourceId', 'engine'];
  return fields.every((field) => value[field] === expected[field]);
}
function parseWait(value, schema, requiredStates, expected, kind) {
  const view = schema.safeParse(value?.view);
  if (!view.success || !Array.isArray(value.observations) || !value.observations.every((item) => { const parsed = schema.safeParse(item); return parsed.success && boundView(parsed.data, expected, kind); })
    || !boundView(view.data, expected, kind)) throw new Error('invalid_public_recovery_view');
  const observed = new Set(value.observations.map(({ status }) => status));
  const expectedStates = view.data.status === 'READY' ? requiredStates : ['QUEUED', view.data.status];
  if (!expectedStates.every((state) => observed.has(state))) throw new Error('recovery_transition_missing');
  return view.data;
}
function publicBody(response, expectedStatus, schema) {
  if (response?.statusCode !== expectedStatus) throw new Error('control_plane_failure');
  const parsed = schema.safeParse(response.body);
  if (!parsed.success) throw new Error('invalid_public_recovery_view');
  return parsed.data;
}
async function proveBackupAbsent(request, context, client, scope, item) {
  const cursors = new Set(); let cursor;
  for (let page = 0; page < 1000; page += 1) {
    const remaining = Date.parse(request.deadlineAt) - Date.parse(context.now());
    if (remaining <= 0) throw new Error('backup_cleanup_unverified');
    const listed = publicBody(await context.controlPlaneJson({ client, method: 'GET', path: `/api/resources/${encodeURIComponent(item.sourceId)}/backups`,
      ...(cursor ? { query: { cursor } } : {}), timeoutMs: Math.min(60_000, remaining) }), 200, ResourceBackupListViewSchema);
    if (listed.backups.some((backup) => backup.id === item.backupId || backup.organizationId !== scope.organizationId || backup.projectId !== scope.projectId
      || backup.resourceId !== item.sourceId || backup.engine !== item.engine)) throw new Error('backup_cleanup_unverified');
    if (listed.nextCursor === null) return;
    if (cursors.has(listed.nextCursor)) throw new Error('backup_cleanup_unverified');
    cursors.add(listed.nextCursor); cursor = listed.nextCursor;
  }
  throw new Error('backup_cleanup_unverified');
}

function probeBound(value, descriptor, engine, phase, nonce) {
  return value?.authenticated === true && value.engine === engine && value.phase === phase && value.nonce === nonce
    && ['resourceId', 'namespace', 'providerPodUid', 'consumerPodUid', 'secretUid', 'secretName', 'secretKey'].every((key) => value[key] === descriptor[key]);
}

function sameAttachment(left, right) { return JSON.stringify(left?.attachment) === JSON.stringify(right?.attachment); }
export async function trustedBindingGraph(request, engineList, authority) {
  const state = request.state;
  const parsed = EvidenceBindingsSchema.safeParse(state.bindings);
  if (!parsed.success || !/^[a-f0-9]{64}$/.test(state.bindingsDigest ?? '') || digest(parsed.data) !== state.bindingsDigest) throw new Error('recovery_bindings_missing');
  let entries, snapshot;
  try {
    entries = await authority.loadBindings();
    snapshot = await authority.bindingSnapshot();
  } catch { throw new Error('binding_journal_invalid'); }
  if (digest(entries.map(({ payload }) => payload)) !== state.bindingsDigest || JSON.stringify(snapshot) !== JSON.stringify(state.bindingJournalSnapshot)) throw new Error('binding_journal_mismatch');
  const one = (kind, predicate = () => true) => { const matches = parsed.data.filter((value) => value.kind === kind && predicate(value)); if (matches.length !== 1) throw new Error('binding_graph_mismatch'); return matches[0]; };
  const membership = one('organization-membership'), project = one('project'), service = one('service');
  const deployment = one('deployment', (value) => value.role === 'candidate');
  if (project.organizationId !== membership.organizationId || service.projectId !== project.projectId || deployment.serviceId !== service.serviceId) throw new Error('binding_graph_mismatch');
  const resources = Object.fromEntries(engineList.map((engine) => { const resource = one('resource', (value) => value.role === 'source' && value.engine === engine); if (resource.projectId !== project.projectId) throw new Error('binding_graph_mismatch'); return [engine, resource.resourceId]; }));
  const ref = (kind, predicate = () => true) => { const matches = entries.filter(({ payload }) => payload.kind === kind && predicate(payload)); if (matches.length !== 1) throw new Error('binding_graph_mismatch'); const entry = matches[0]; return { role: entry.role, bindingId: entry.bindingId, entrySha256: entry.entrySha256 }; };
  return Object.freeze({ organizationId: membership.organizationId, projectId: project.projectId, serviceId: service.serviceId, deploymentId: deployment.deploymentId, resources,
    refs: { membership: ref('organization-membership'), project: ref('project'), sources: Object.fromEntries(engineList.map((engine) => [engine, ref('resource', (value) => value.role === 'source' && value.engine === engine)])) } });
}
function inventoryItem(scope, type, id) { return { type: 'control-plane', resourceType: type, id, organizationId: scope.organizationId, projectId: scope.projectId }; }
function safeReason(error) { return SAFE_REASONS.has(error?.message) ? error.message : 'recovery_runner_failed'; }

function verifyProof(value, request, operationId, kind) {
  const keys = kind === 'backup-provenance' ? ['kind', 'runId', 'operationId', 'verified']
    : kind === 'backup-delete' ? ['kind', 'runId', 'operationId', 'artifactDeleted']
      : ['kind', 'runId', 'operationId', 'resourceRowsRemaining', 'attachmentsRemaining', 'injectedRefsRemaining', 'providerObjectsRemaining'];
  if (!value || Object.keys(value).length !== keys.length || value.kind !== kind || value.runId !== request.identity.runId || value.operationId !== operationId) throw new Error('recovery_evidence_unbound');
  if (kind === 'backup-provenance' && value.verified !== true) throw new Error('backup_provenance_unverified');
  if (kind === 'backup-delete' && value.artifactDeleted !== true) throw new Error('backup_cleanup_unverified');
  if (kind === 'target-delete' && keys.slice(3).some((key) => value[key] !== 0)) throw new Error('target_cleanup_unverified');
}

function durableEntry(value, expected, entryType) {
  const entry = value?.entry ?? value;
  if (!entry || entry.schema !== (entryType === 'binding' ? 'raibitserver.production-evidence-binding/v1' : 'raibitserver.production-evidence-cleanup-journal/v1')
    || (entryType !== 'binding' && entry.entryType !== entryType) || !SHA256.test(entry.entrySha256 ?? '')
    || Object.entries(expected).some(([key, item]) => (key === 'kind' ? entry.payload?.kind : entry[key]) !== item)) throw new Error('mutation_journal_failed');
  const { entrySha256, ...unsigned } = entry;
  if (entrySha256 !== digest(unsigned) || (entryType === 'binding' && (!SHA256.test(value.sha256 ?? '') || typeof value.path !== 'string'))) throw new Error('mutation_journal_failed');
  return entry;
}
async function journaled(operation, expected, entryType) {
  try { return durableEntry(await operation(), expected, entryType); }
  catch { throw new Error('mutation_journal_failed'); }
}

async function mutationIntent(request, authority, { intentId, mutationKind, bindingRefs, relativeRoute, recoverySelector }, at) {
  const resourceName = deriveRunResourceName(request.identity, intentId), [method, routeTemplate] = MUTATION_CONTRACT[mutationKind];
  const written = { intentId, mutationKind, bindingRefs, resourceName, method, routeTemplate, relativeRoute,
    recoverySelector: { ...recoverySelector, name: resourceName, runIdentitySha256: digest(request.identity) }, approvedRuntimeSelector: null,
    createdAt: at(), deadlineAt: request.deadlineAt };
  return journaled(() => authority.appendCleanupIntent(written), { intentId }, 'intent');
}

async function bindMutation(request, authority, { role, bindingId, payload }, at) {
  const parsed = EvidenceBindingSchema.safeParse(payload);
  if (!parsed.success) throw new Error('mutation_binding_invalid');
  const written = { role, bindingId, payload: parsed.data, createdAt: at() };
  return journaled(() => authority.appendBinding(written), { bindingId, kind: parsed.data.kind }, 'binding');
}

async function mutationOutcome(request, authority, intent, actualId, response, at) {
  const written = { intentId: intent.intentId,
    actualId, actualUid: null, responseSha256: digest(response), resolvedAt: at() };
  return journaled(() => authority.appendOutcome({ ...written, approvedRuntimeSelector: null }), { intentId: intent.intentId }, 'outcome');
}

export async function runVerifiedRecovery(request, context, engineList, verifyTarget = () => true) {
  if (![context.controlPlaneJson, context.waitForState, context.resourceProbe, context.resolveResourceDescriptor, context.recoveryEvidenceProbe, context.postDeleteProbe].every((method) => typeof method === 'function'))
    return output(context, request, 'NOT_RUN', 'recovery_evidence_adapter_unavailable');
  let authority;
  try { authority = assertJournalAuthority(context.journalAuthority); }
  catch { return output(context, request, 'NOT_RUN', 'recovery_evidence_adapter_unavailable'); }
  let scope;
  try { scope = await trustedBindingGraph(request, engineList, authority); }
  catch (error) { return output(context, request, error.message === 'recovery_bindings_missing' ? 'NOT_RUN' : 'FAIL', error.message); }
  const client = request.state.authenticatedClient;
  let journalSequence = 0;
  const journalBase = Date.parse(context.now());
  const journalAt = () => new Date(journalBase + (++journalSequence)).toISOString();
  const created = [], artifacts = [], inventory = [];
  let fault = null;
  try {
    for (const engine of engineList) {
      const sourceId = scope.resources[engine];
      const source = exactDescriptor(await context.resolveResourceDescriptor({ client, engine, role: 'source', resourceId: sourceId, runId: request.identity.runId }), engine, 'source', sourceId);
      if (source.attachment.serviceId !== scope.serviceId || source.attachment.deploymentId !== scope.deploymentId) throw new Error('binding_graph_mismatch');
      const nonce = randomUUID();
      const sourceBefore = await context.resourceProbe({ descriptor: source, engine, phase: 'source-before', nonce, timeoutMs: 60_000 });
      const backupBody = { requestIdempotencyKey: `${request.identity.runId}:${engine}:backup`, formatVersion: 1 };
      const baseRefs = [scope.refs.membership, scope.refs.project, scope.refs.sources[engine]];
      const backupIntent = await mutationIntent(request, authority, { intentId: `backup-create-${engine}-${request.identity.runId.slice(0, 8)}`, mutationKind: 'control-plane-create-backup', bindingRefs: baseRefs,
        relativeRoute: `/api/resources/${sourceId}/backups`, recoverySelector: { kind: 'Backup', projectId: scope.projectId, resourceId: sourceId, engine } }, journalAt);
      const backupCreated = publicBody(await context.controlPlaneJson({ client, method: 'POST', path: `/api/resources/${encodeURIComponent(sourceId)}/backups`, body: backupBody, timeoutMs: 30_000 }), 202, ResourceBackupViewSchema);
      if (backupCreated.organizationId !== scope.organizationId || backupCreated.projectId !== scope.projectId || backupCreated.engine !== engine || backupCreated.resourceId !== sourceId || backupCreated.status !== 'QUEUED') throw new Error('backup_identity_mismatch');
      created.push({ engine, sourceId, backupId: backupCreated.id, targetId: null, backupRef: null, targetRef: null });
      const backupBinding = await bindMutation(request, authority, { role: 'backup', bindingId: `${engine}-${backupCreated.id}`, payload: { kind: 'backup', engine, backupId: backupCreated.id, sourceResourceId: sourceId } }, journalAt);
      created.at(-1).backupRef = { role: backupBinding.role, bindingId: backupBinding.bindingId, entrySha256: backupBinding.entrySha256 };
      await mutationOutcome(request, authority, backupIntent, backupCreated.id, backupCreated, journalAt);
      const backupExpected = { id: backupCreated.id, organizationId: scope.organizationId, projectId: scope.projectId, resourceId: sourceId, engine };
      const backup = parseWait(await context.waitForState({ client, path: `/api/resources/${encodeURIComponent(sourceId)}/backups`, id: backupCreated.id, terminal: ['READY', 'FAILED', 'EXPIRED'], timeoutMs: 30 * 60_000 }), ResourceBackupViewSchema, ['QUEUED', 'RUNNING', 'VERIFYING', 'READY'], backupExpected, 'backup');
      if (backup.organizationId !== scope.organizationId || backup.projectId !== scope.projectId || backup.status !== 'READY' || !backup.recoverable || Date.parse(backup.expiresAt) <= Date.parse(context.now())) throw new Error('backup_not_ready');
      verifyProof(await context.recoveryEvidenceProbe({ client, kind: 'backup-provenance', runId: request.identity.runId, operationId: backup.id, timeoutMs: 60_000 }), request, backup.id, 'backup-provenance');
      const restoreBody = { requestIdempotencyKey: `${request.identity.runId}:${engine}:restore`, formatVersion: 1, name: `restore-${request.identity.runId.slice(0, 8)}-${engine}` };
      const restoreIntent = await mutationIntent(request, authority, { intentId: `restore-create-${engine}-${request.identity.runId.slice(0, 8)}`, mutationKind: 'control-plane-create-restore', bindingRefs: [...baseRefs, created.at(-1).backupRef],
        relativeRoute: `/api/backups/${backup.id}/restores`, recoverySelector: { kind: 'Restore', projectId: scope.projectId, backupId: backup.id, engine } }, journalAt);
      const restoreCreated = publicBody(await context.controlPlaneJson({ client, method: 'POST', path: `/api/backups/${encodeURIComponent(backup.id)}/restores`, body: restoreBody, timeoutMs: 30_000 }), 202, ResourceRestoreViewSchema);
      if (restoreCreated.organizationId !== scope.organizationId || restoreCreated.projectId !== scope.projectId || restoreCreated.engine !== engine || restoreCreated.backupId !== backup.id || restoreCreated.sourceResourceId !== sourceId || restoreCreated.targetResourceId === sourceId || restoreCreated.status !== 'QUEUED') throw new Error('restore_identity_mismatch');
      created.at(-1).targetId = restoreCreated.targetResourceId;
      const targetBinding = await bindMutation(request, authority, { role: 'resource', bindingId: `${engine}-${restoreCreated.targetResourceId}`, payload: { kind: 'resource', role: 'restore-target', engine, resourceId: restoreCreated.targetResourceId, projectId: scope.projectId } }, journalAt);
      created.at(-1).targetRef = { role: targetBinding.role, bindingId: targetBinding.bindingId, entrySha256: targetBinding.entrySha256 };
      await bindMutation(request, authority, { role: 'restore', bindingId: `${engine}-${restoreCreated.id}`, payload: { kind: 'restore', engine, restoreId: restoreCreated.id, backupId: backup.id, targetResourceId: restoreCreated.targetResourceId } }, journalAt);
      await mutationOutcome(request, authority, restoreIntent, restoreCreated.id, restoreCreated, journalAt);
      const restoreExpected = { id: restoreCreated.id, organizationId: scope.organizationId, projectId: scope.projectId, backupId: backup.id, sourceResourceId: sourceId, targetResourceId: restoreCreated.targetResourceId, engine };
      const restore = parseWait(await context.waitForState({ client, path: `/api/restores/${encodeURIComponent(restoreCreated.id)}`, id: restoreCreated.id, terminal: ['READY', 'FAILED'], timeoutMs: 30 * 60_000 }), ResourceRestoreViewSchema, ['QUEUED', 'RUNNING', 'VERIFYING', 'READY'], restoreExpected, 'restore');
      if (restore.organizationId !== scope.organizationId || restore.projectId !== scope.projectId || restore.status !== 'READY' || restore.targetResourceId !== restoreCreated.targetResourceId) throw new Error('restore_not_ready');
      const target = exactDescriptor(await context.resolveResourceDescriptor({ client, engine, role: 'target', resourceId: restore.targetResourceId, runId: request.identity.runId }), engine, 'target', restore.targetResourceId);
      if (target.attachment.serviceId !== scope.serviceId || target.attachment.deploymentId !== scope.deploymentId) throw new Error('binding_graph_mismatch');
      validateRecoveryDescriptors(source, target, engine);
      const targetProbe = await context.resourceProbe({ descriptor: target, engine, phase: 'target', nonce, timeoutMs: 60_000 });
      const sourceAfter = await context.resourceProbe({ descriptor: source, engine, phase: 'source-after', nonce, timeoutMs: 60_000 });
      const sourceReadback = exactDescriptor(await context.resolveResourceDescriptor({ client, engine, role: 'source', resourceId: sourceId, runId: request.identity.runId }), engine, 'source', sourceId);
      if (!sameAttachment(source, sourceReadback) || !probeBound(sourceBefore, source, engine, 'source-before', nonce) || !probeBound(targetProbe, target, engine, 'target', nonce)
        || !probeBound(sourceAfter, source, engine, 'source-after', nonce) || sourceBefore.inputSha256 !== targetProbe.readSha256 || sourceBefore.readSha256 !== sourceAfter.readSha256
        || sourceBefore.schemaSha256 !== targetProbe.schemaSha256 || sourceBefore.recordCount !== targetProbe.recordCount
        || ![sourceBefore.inputSha256, sourceBefore.readSha256, targetProbe.readSha256, sourceAfter.readSha256, sourceBefore.schemaSha256, targetProbe.schemaSha256].every((value) => SHA256.test(value ?? ''))) throw new Error('restore_probe_mismatch');
      verifyTarget(source, target, targetProbe, sourceBefore);
      artifacts.push(await context.writeArtifact('resources', `${request.step}-${engine}-observation.json`, { identity: request.identity, engine, backup: { id: backup.id, status: backup.status, size: backup.size, expiresAt: backup.expiresAt, recoverable: true }, restore: { id: restore.id, sourceResourceId: sourceId, targetResourceId: target.resourceId, status: restore.status }, sourceUnchanged: true, attachmentsUnchanged: true, redacted: true }));
    }
  } catch (error) { fault = new Error(safeReason(error)); }
  finally {
    for (const item of [...created].reverse()) {
      try {
        const intent = await mutationIntent(request, authority, { intentId: `backup-delete-${item.engine}-${request.identity.runId.slice(0, 8)}`, mutationKind: 'control-plane-delete-backup', bindingRefs: [scope.refs.membership, scope.refs.project, scope.refs.sources[item.engine], item.backupRef],
          relativeRoute: `/api/backups/${item.backupId}`, recoverySelector: { kind: 'Backup', projectId: scope.projectId, resourceId: item.sourceId, backupId: item.backupId, engine: item.engine } }, journalAt);
        const deletion = publicBody(await context.controlPlaneJson({ client, method: 'DELETE', path: `/api/backups/${encodeURIComponent(item.backupId)}`, body: { confirmed: true }, timeoutMs: 30_000 }), 200, ResourceBackupViewSchema);
        if (!boundView(deletion, { id: item.backupId, organizationId: scope.organizationId, projectId: scope.projectId, resourceId: item.sourceId, engine: item.engine }, 'backup')
          || !['DELETING', 'DELETED'].includes(deletion.status) || deletion.recoverable) throw new Error('backup_cleanup_unverified');
        await mutationOutcome(request, authority, intent, item.backupId, deletion, journalAt);
        await proveBackupAbsent(request, context, client, scope, item);
        verifyProof(await context.postDeleteProbe({ client, kind: 'backup-delete', runId: request.identity.runId, operationId: item.backupId, timeoutMs: 60_000 }), request, item.backupId, 'backup-delete');
      } catch { inventory.push(inventoryItem(scope, 'backup', item.backupId)); }
      if (item.targetId) try {
        const intent = await mutationIntent(request, authority, { intentId: `target-delete-${item.engine}-${request.identity.runId.slice(0, 8)}`, mutationKind: 'control-plane-delete-restore-target', bindingRefs: [scope.refs.membership, scope.refs.project, item.targetRef],
          relativeRoute: `/api/resources/${item.targetId}`, recoverySelector: { kind: 'Resource', projectId: scope.projectId, resourceId: item.targetId, role: 'restore-target', engine: item.engine } }, journalAt);
        const deleted = await context.controlPlaneJson({ client, method: 'DELETE', path: `/api/resources/${encodeURIComponent(item.targetId)}`, timeoutMs: 30_000 });
        const deletion = Deletion.safeParse(deleted?.body);
        const deletionKeys = deletion.success ? Object.keys(deletion.data).sort() : [];
        const immediate = deletion.success && deletion.data.deleted === true && deletion.data.resourceId === item.targetId
          && JSON.stringify(deletionKeys) === JSON.stringify(['deleted', 'resourceId']);
        const requested = deletion.success && deletion.data.deletionRequested === true && ['DELETE_REQUESTED', 'DELETING'].includes(deletion.data.status)
          && deletion.data.resourceId === item.targetId && JSON.stringify(deletionKeys) === JSON.stringify(['deletionRequested', 'resourceId', 'status']);
        if (deleted?.statusCode !== 200 || !deletion.success || deletion.data.resourceId !== item.targetId || Number(immediate) + Number(requested) !== 1) throw new Error('target_delete_failed');
        await mutationOutcome(request, authority, intent, item.targetId, deletion.data, journalAt);
        verifyProof(await context.postDeleteProbe({ client, kind: 'target-delete', runId: request.identity.runId, operationId: item.targetId, timeoutMs: 60_000 }), request, item.targetId, 'target-delete');
      } catch { inventory.push(inventoryItem(scope, 'restore-target', item.targetId)); }
    }
  }
  if (inventory.length) fault = new Error('cleanup_failed');
  return output(context, request, fault ? 'FAIL' : 'PASS', fault?.message ?? null, inventory, artifacts);
}

export function runVerifiedSqlRecovery(request, context) { return runVerifiedRecovery(request, context, ENGINES); }

export async function execute(request, context) {
  try { parseStepRequest(request, 'backup-sql'); } catch { return output(context, request ?? { step: 'backup-sql', identity: null }, 'FAIL', 'invalid_step_contract'); }
  if (!await enabled()) return output(context, request, 'NOT_RUN', 'release_capability_not_verified');
  return runVerifiedSqlRecovery(request, context);
}
