import { assertJournalAuthority } from '../lib/journal-authority.mjs';
import { deriveRunResourceName, MUTATION_CONTRACT } from '../lib/binding-graph.mjs';
import { digest, EvidenceError } from '../lib/operator-inputs.mjs';
import { CleanupError, CleanupNotRunError, controlPath, itemKey, nowIso } from './cleanup-helpers.mjs';

const CREATE_KIND = Object.freeze({
  preview: 'control-plane-create-deployment', resource: 'control-plane-create-resource',
  'restore-target': 'control-plane-create-resource', backup: 'control-plane-create-backup', project: 'control-plane-create-project',
});
const DELETE_KIND = Object.freeze({
  preview: 'control-plane-preview-cleanup', resource: 'control-plane-delete-resource',
  'restore-target': 'control-plane-delete-restore-target', backup: 'control-plane-delete-backup', project: 'control-plane-delete-project',
});

function failure(error, fallback = 'cleanup_binding_mismatch') {
  return error instanceof EvidenceError ? fallback : 'cleanup_command_failure';
}
function ref(entry) { return { role: entry.role, bindingId: entry.bindingId, entrySha256: entry.entrySha256 }; }
function one(entries, predicate) {
  const matches = entries.filter(predicate);
  return matches.length === 1 ? matches[0] : null;
}
function targetBinding(entries, item) {
  switch (item.resourceType) {
    case 'project': return one(entries, ({ payload }) => payload.kind === 'project' && payload.projectId === item.id);
    case 'resource': return one(entries, ({ payload }) => payload.kind === 'resource' && payload.role === 'source' && payload.resourceId === item.id);
    case 'restore-target': return one(entries, ({ payload }) => payload.kind === 'resource' && payload.role === 'restore-target' && payload.resourceId === item.id);
    case 'backup': return one(entries, ({ payload }) => payload.kind === 'backup' && payload.backupId === item.id);
    case 'preview': return one(entries, ({ payload }) => payload.kind === 'deployment' && payload.role === 'preview' && payload.deploymentId === item.id);
    default: return null;
  }
}
function owningProject(entries, binding) {
  let projectId;
  switch (binding.payload.kind) {
    case 'project': case 'resource': projectId = binding.payload.projectId; break;
    case 'backup': projectId = one(entries, ({ payload }) => payload.kind === 'resource' && payload.resourceId === binding.payload.sourceResourceId)?.payload.projectId; break;
    case 'deployment': projectId = one(entries, ({ payload }) => payload.kind === 'service' && payload.serviceId === binding.payload.serviceId)?.payload.projectId; break;
    default: projectId = undefined;
  }
  if (!projectId) return null;
  return one(entries, ({ payload }) => payload.kind === 'project' && payload.projectId === projectId);
}
function requiredRefs(entries, binding, item) {
  const project = owningProject(entries, binding);
  if (!project) return null;
  const member = one(entries, ({ payload }) => payload.kind === 'organization-membership' && payload.organizationId === project.payload.organizationId);
  if (!member) return null;
  if (item.resourceType === 'project') return [member, project];
  if (item.resourceType === 'resource' || item.resourceType === 'restore-target') return [member, project, binding];
  if (item.resourceType === 'backup') {
    const source = one(entries, ({ payload }) => payload.kind === 'resource' && payload.role === 'source' && payload.resourceId === binding.payload.sourceResourceId);
    return source ? [member, project, source, binding] : null;
  }
  const service = one(entries, ({ payload }) => payload.kind === 'service' && payload.projectId === project.payload.projectId && payload.serviceId === binding.payload.serviceId);
  return service ? [member, project, service, binding] : null;
}
function creationRoute(item, binding, refs) {
  const project = refs.find(({ payload }) => payload.kind === 'project')?.payload;
  if (!project) return null;
  switch (item.resourceType) {
    case 'project': return '/api/projects';
    case 'resource': case 'restore-target': return `/api/projects/${project.projectId}/resources`;
    case 'backup': return `/api/resources/${binding.payload.sourceResourceId}/backups`;
    case 'preview': return `/api/projects/${project.projectId}/services/${binding.payload.serviceId}/deployments`;
    default: return null;
  }
}
function ownsCreatedTarget(journal, entries, binding, item, route) {
  if (journal.resolved.some(({ intent, outcome }) => intent.mutationKind === CREATE_KIND[item.resourceType]
    && intent.method === 'POST' && intent.relativeRoute === route && outcome.actualId === item.id)) return true;
  if (item.resourceType !== 'restore-target') return false;
  const restore = one(entries, ({ payload }) => payload.kind === 'restore' && payload.targetResourceId === item.id && payload.engine === binding.payload.engine)?.payload;
  if (!restore) return false;
  const backup = one(entries, ({ payload }) => payload.kind === 'backup' && payload.backupId === restore.backupId && payload.engine === restore.engine)?.payload;
  if (!backup || !one(entries, ({ payload }) => payload.kind === 'resource' && payload.role === 'source'
    && payload.resourceId === backup.sourceResourceId && payload.projectId === item.projectId && payload.engine === restore.engine)) return false;
  return journal.resolved.some(({ intent, outcome }) => intent.mutationKind === 'control-plane-create-restore' && intent.method === 'POST'
    && intent.relativeRoute === `/api/backups/${restore.backupId}/restores` && outcome.actualId === restore.restoreId
    && intent.recoverySelector.projectId === item.projectId && intent.recoverySelector.backupId === restore.backupId && intent.recoverySelector.engine === restore.engine);
}
function deleteSelector(identity, item, binding, refs, resourceName) {
  const project = refs.find(({ payload }) => payload.kind === 'project').payload;
  const membership = refs.find(({ payload }) => payload.kind === 'organization-membership').payload;
  const runIdentitySha256 = digest(identity);
  switch (item.resourceType) {
    case 'project': return { kind: 'Project', organizationId: membership.organizationId, projectId: project.projectId, name: resourceName, runIdentitySha256 };
    case 'resource': case 'restore-target': return { kind: 'Resource', projectId: project.projectId, resourceId: binding.payload.resourceId, role: binding.payload.role, engine: binding.payload.engine, name: resourceName, runIdentitySha256 };
    case 'backup': return { kind: 'Backup', projectId: project.projectId, resourceId: binding.payload.sourceResourceId, backupId: binding.payload.backupId, engine: binding.payload.engine, name: resourceName, runIdentitySha256 };
    case 'preview': return { kind: 'Deployment', projectId: project.projectId, serviceId: binding.payload.serviceId, deploymentId: binding.payload.deploymentId, name: resourceName, runIdentitySha256 };
    default: throw new CleanupError('cleanup_unsupported');
  }
}
function deleteRoute(item) { return item.resourceType === 'preview' ? `${controlPath(item)}/preview-cleanup` : controlPath(item); }
async function appendDeleteIntent(authority, request, context, item, binding, refs, journal) {
  const intentId = `cleanup-${item.resourceType}-${digest(itemKey(item)).slice(0, 16)}`;
  const existing = journal.entries.find((entry) => entry.entryType === 'intent' && entry.intentId === intentId);
  if (existing) return existing;
  const mutationKind = DELETE_KIND[item.resourceType];
  if (!mutationKind) throw new CleanupError('cleanup_unsupported');
  const resourceName = deriveRunResourceName(request.identity, intentId);
  const [method, routeTemplate] = MUTATION_CONTRACT[mutationKind];
  try {
    return await authority.appendCleanupIntent({ intentId, mutationKind, bindingRefs: refs.map(ref), resourceName, method, routeTemplate,
      relativeRoute: deleteRoute(item), recoverySelector: deleteSelector(request.identity, item, binding, refs, resourceName),
      approvedRuntimeSelector: null, createdAt: nowIso(context), deadlineAt: request.deadlineAt });
  } catch (error) { throw new CleanupError(failure(error)); }
}

export async function prepareCleanupAuthority(context, request, items) {
  let authority;
  try { authority = assertJournalAuthority(context.journalAuthority); }
  catch { throw new CleanupNotRunError('cleanup_journal_capability_missing'); }
  let entries; let journal;
  try { [entries, journal] = await Promise.all([authority.loadBindings(), authority.loadCleanup({ approvedRuntimeSelector: null })]); }
  catch (error) { throw new CleanupNotRunError(failure(error, 'cleanup_journal_capability_invalid')); }
  if (!entries.length || entries.some((entry) => entry.runIdentitySha256 !== digest(request.identity))) throw new CleanupError('cleanup_binding_mismatch');
  const proofs = new Map();
  for (const item of items) {
    if (item.resourceType === 'attachment') { proofs.set(itemKey(item), { error: 'cleanup_unsupported' }); continue; }
    try {
      const binding = targetBinding(entries, item); const refs = binding && requiredRefs(entries, binding, item);
      const route = binding && refs && creationRoute(item, binding, refs);
      const project = refs?.find(({ payload }) => payload.kind === 'project')?.payload;
      if (!binding || !refs || !route || project?.projectId !== item.projectId || project.organizationId !== item.organizationId
        || !ownsCreatedTarget(journal, entries, binding, item, route)) throw new CleanupError('cleanup_binding_mismatch');
      const deleteIntent = await appendDeleteIntent(authority, request, context, item, binding, refs, journal);
      const deleteResolved = journal.resolved.find(({ intent }) => intent.intentId === deleteIntent.intentId) ?? null;
      proofs.set(itemKey(item), { authority, binding, project: refs.find(({ payload }) => payload.kind === 'project').payload, deleteIntent, deleteResolved });
    } catch (error) { proofs.set(itemKey(item), { error: error instanceof EvidenceError ? error.reason : 'cleanup_binding_mismatch' }); }
  }
  return proofs;
}

export async function recordCleanupOutcome(proof, request, context, item, response) {
  if (!proof?.authority || !proof.deleteIntent) throw new CleanupError('cleanup_binding_mismatch');
  if (proof.deleteResolved !== null) return;
  try {
    await proof.authority.appendOutcome({ intentId: proof.deleteIntent.intentId, actualId: item.id, actualUid: null,
      responseSha256: digest(response), resolvedAt: nowIso(context), approvedRuntimeSelector: null });
  } catch (error) { throw new CleanupError(failure(error)); }
}
