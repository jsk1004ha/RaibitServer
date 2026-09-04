import { assertRedacted, digest, EvidenceError } from './operator-inputs.mjs';
import { EvidenceBindingSchema } from '../../../packages/schemas/src/production-evidence.ts';

const SAFE_PART = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/;
const SAFE_CONTEXT = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ROUTE = /^\/apis?\/[A-Za-z0-9._~:/-]+$/;
export const MUTATION_CONTRACT = Object.freeze({
  'control-plane-create-project': Object.freeze(['POST', '/api/projects']),
  'control-plane-import-repository': Object.freeze(['POST', '/api/github/repositories/import']),
  'control-plane-create-deployment': Object.freeze(['POST', '/api/projects/:projectId/services/:serviceId/deployments']),
  'control-plane-create-resource': Object.freeze(['POST', '/api/projects/:projectId/resources']),
  'control-plane-rollback': Object.freeze(['POST', '/api/deployments/:deploymentId/rollback']),
  'control-plane-preview-cleanup': Object.freeze(['POST', '/api/deployments/:deploymentId/preview-cleanup']),
  'control-plane-delete-project': Object.freeze(['DELETE', '/api/projects/:projectId']),
  'control-plane-delete-resource': Object.freeze(['DELETE', '/api/resources/:resourceId']),
  'control-plane-create-backup': Object.freeze(['POST', '/api/resources/:resourceId/backups']),
  'control-plane-create-restore': Object.freeze(['POST', '/api/backups/:backupId/restores']),
  'control-plane-delete-backup': Object.freeze(['DELETE', '/api/backups/:backupId']),
  'control-plane-delete-restore-target': Object.freeze(['DELETE', '/api/resources/:resourceId']),
  'kubernetes-apply-pod': Object.freeze(['APPLY', '/api/v1/namespaces/:namespace/pods']),
  'kubernetes-apply-network-policy': Object.freeze(['APPLY', '/apis/networking.k8s.io/v1/namespaces/:namespace/networkpolicies']),
});

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
function fail(reason = 'invalid_binding_graph') { throw new EvidenceError(reason); }
function immutable(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutable));
  if (isRecord(value)) return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, immutable(item)])));
  return value;
}
const isIso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const validSelector = (value) => isRecord(value) && Object.keys(value).length > 0 && Object.entries(value).every(([key, item]) => SAFE_ID.test(key)
  && (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') && String(item).length > 0 && String(item).length <= 256);
const validRoute = (value) => typeof value === 'string' && ROUTE.test(value) && !value.includes('//') && !value.includes('%')
  && !value.includes('?') && !value.includes('#') && value.split('/').every((segment) => segment !== '.' && segment !== '..');

export function parseCleanupIntentRecord(record, expectedIdentityDigest) {
  const keys = ['schema', 'entryType', 'sequence', 'runIdentitySha256', 'intentId', 'mutationKind', 'bindingEntryCount', 'bindingsDigest',
    'bindingRefs', 'approvedRuntimeSelectorSha256', 'resourceName', 'method', 'routeTemplate', 'relativeRoute', 'recoverySelector',
    'createdAt', 'deadlineAt', 'selectorSha256', 'entrySha256'];
  if (!exactKeys(record, keys) || record.schema !== 'raibitserver.production-evidence-cleanup-journal/v1' || record.entryType !== 'intent'
    || !Number.isSafeInteger(record.sequence) || record.sequence < 1 || record.runIdentitySha256 !== expectedIdentityDigest
    || !SAFE_NAME.test(record.intentId) || !Object.hasOwn(MUTATION_CONTRACT, record.mutationKind)
    || !Number.isSafeInteger(record.bindingEntryCount) || record.bindingEntryCount < 1 || !SHA256.test(record.bindingsDigest)
    || !Array.isArray(record.bindingRefs) || record.bindingRefs.length === 0
    || !(record.approvedRuntimeSelectorSha256 === null || SHA256.test(record.approvedRuntimeSelectorSha256))
    || !SAFE_NAME.test(record.resourceName) || !['POST', 'DELETE', 'APPLY'].includes(record.method)
    || !validRoute(record.routeTemplate) || !validRoute(record.relativeRoute) || !validSelector(record.recoverySelector)
    || !isIso(record.createdAt) || !isIso(record.deadlineAt) || Date.parse(record.deadlineAt) <= Date.parse(record.createdAt)
    || !SHA256.test(record.selectorSha256) || record.selectorSha256 !== digest(record.recoverySelector) || !SHA256.test(record.entrySha256)) fail('invalid_journal');
  const [method, routeTemplate] = MUTATION_CONTRACT[record.mutationKind];
  const { entrySha256, ...unsigned } = record;
  if (record.method !== method || record.routeTemplate !== routeTemplate) fail('invalid_mutation_contract');
  if (entrySha256 !== digest(unsigned)) fail('journal_digest_mismatch');
  assertRedacted(record);
  return immutable(record);
}

export function parseCleanupOutcomeRecord(record, expectedIdentityDigest) {
  const keys = ['schema', 'entryType', 'sequence', 'runIdentitySha256', 'intentId', 'intentEntrySha256', 'actualId', 'actualUid',
    'responseSha256', 'resolvedAt', 'entrySha256'];
  if (!exactKeys(record, keys) || record.schema !== 'raibitserver.production-evidence-cleanup-journal/v1' || record.entryType !== 'outcome'
    || !Number.isSafeInteger(record.sequence) || record.sequence < 1 || record.runIdentitySha256 !== expectedIdentityDigest
    || !SAFE_NAME.test(record.intentId) || !SHA256.test(record.intentEntrySha256) || !SAFE_ID.test(record.actualId)
    || !(record.actualUid === null || SAFE_ID.test(record.actualUid)) || !SHA256.test(record.responseSha256)
    || !isIso(record.resolvedAt) || !SHA256.test(record.entrySha256)) fail('invalid_journal');
  const { entrySha256, ...unsigned } = record;
  if (entrySha256 !== digest(unsigned)) fail('journal_digest_mismatch');
  assertRedacted(record);
  return immutable(record);
}
function primaryId(binding) {
  switch (binding.kind) {
    case 'organization-membership': return binding.membershipId;
    case 'github-repository': return binding.repositoryId;
    case 'tenant-revision': return binding.tenantRevisionId;
    case 'project': return binding.projectId;
    case 'service': return binding.serviceId;
    case 'deployment': return binding.deploymentId;
    case 'resource': return binding.resourceId;
    case 'backup': return binding.backupId;
    case 'restore': return binding.restoreId;
    default: fail();
  }
}

export function parseEvidenceBindingPayload(value) {
  const parsed = EvidenceBindingSchema.safeParse(value);
  if (!parsed.success) fail('invalid_journal');
  return immutable(parsed.data);
}

export function resolveBindingGraph(entries, references) {
  if (!Array.isArray(entries) || !Array.isArray(references) || references.length === 0) fail();
  const bindingKeys = ['schema', 'sequence', 'runIdentitySha256', 'role', 'bindingId', 'payload', 'payloadSha256', 'createdAt', 'entrySha256'];
  const normalizedEntries = entries.map((entry, index) => {
    if (!exactKeys(entry, bindingKeys) || entry.schema !== 'raibitserver.production-evidence-binding/v1'
      || entry.sequence !== index + 1 || !SHA256.test(entry.runIdentitySha256) || !SAFE_PART.test(entry.role)
      || !SAFE_PART.test(entry.bindingId) || !SHA256.test(entry.payloadSha256) || entry.payloadSha256 !== digest(entry.payload)
      || !isIso(entry.createdAt) || !SHA256.test(entry.entrySha256)) fail('invalid_journal');
    const { entrySha256, ...unsigned } = entry;
    if (entrySha256 !== digest(unsigned)) fail('journal_digest_mismatch');
    return immutable({ ...entry, payload: parseEvidenceBindingPayload(entry.payload) });
  });
  if (normalizedEntries.some((entry, index) => index > 0
    && (entry.runIdentitySha256 !== normalizedEntries[0].runIdentitySha256
      || Date.parse(entry.createdAt) <= Date.parse(normalizedEntries[index - 1].createdAt)))) fail('invalid_journal');
  const logical = new Map(); const domain = new Map();
  for (const entry of normalizedEntries) {
    if (!isRecord(entry) || !SAFE_PART.test(entry.role) || !SAFE_PART.test(entry.bindingId) || !SHA256.test(entry.entrySha256) || !isRecord(entry.payload)) fail();
    const logicalId = `${entry.role}:${entry.bindingId}`; const domainId = `${entry.payload.kind}:${primaryId(entry.payload)}`;
    if (logical.has(logicalId) || domain.has(domainId)) fail();
    logical.set(logicalId, entry); domain.set(domainId, entry.payload);
  }
  for (const { payload: binding } of normalizedEntries) {
    switch (binding.kind) {
      case 'organization-membership': case 'github-repository': break;
      case 'tenant-revision': {
        const repository = domain.get(`github-repository:${binding.repositoryId}`);
        if (!repository || repository.repository !== binding.repository || repository.branch !== binding.branch) fail();
        break;
      }
      case 'project': if (entries.filter(({ payload }) => payload.kind === 'organization-membership' && payload.organizationId === binding.organizationId).length !== 1) fail(); break;
      case 'service': if (!domain.has(`project:${binding.projectId}`)) fail(); break;
      case 'deployment': {
        const revision = domain.get(`tenant-revision:${binding.tenantRevisionId}`);
        if (!domain.has(`service:${binding.serviceId}`) || !revision || revision.tenantCommitSha !== binding.tenantCommitSha
          || revision.repositoryId !== binding.repositoryId || revision.repository !== binding.repository || revision.branch !== binding.branch) fail();
        break;
      }
      case 'resource': if (!domain.has(`project:${binding.projectId}`)) fail(); break;
      case 'backup': if (domain.get(`resource:${binding.sourceResourceId}`)?.engine !== binding.engine) fail(); break;
      case 'restore': if (domain.get(`backup:${binding.backupId}`)?.engine !== binding.engine
        || domain.get(`resource:${binding.targetResourceId}`)?.engine !== binding.engine) fail(); break;
      default: fail();
    }
  }
  const seen = new Set();
  const referenced = references.map((reference) => {
    if (!exactKeys(reference, ['role', 'bindingId', 'entrySha256']) || !SAFE_PART.test(reference.role)
      || !SAFE_PART.test(reference.bindingId) || !SHA256.test(reference.entrySha256)) fail('invalid_binding_reference');
    const id = `${reference.role}:${reference.bindingId}`; const entry = logical.get(id);
    if (seen.has(id) || !entry || entry.entrySha256 !== reference.entrySha256) fail('invalid_binding_reference');
    seen.add(id); return entry.payload;
  });
  return immutable({ bindingEntryCount: normalizedEntries.length, bindingsDigest: digest(normalizedEntries), referenced });
}

export function deriveRunResourceName(identity, intentId) {
  if (!isRecord(identity) || !SAFE_NAME.test(identity.runId) || !SAFE_NAME.test(intentId)) fail('invalid_journal');
  return `raibit-${intentId}-${digest(identity).slice(0, 12)}`;
}
function one(bindings, kind, predicate = () => true) {
  const matches = bindings.filter((binding) => binding.kind === kind && predicate(binding));
  if (matches.length !== 1) fail();
  return matches[0];
}
function tenant(graph) {
  const membership = one(graph.referenced, 'organization-membership');
  const project = one(graph.referenced, 'project', (binding) => binding.organizationId === membership.organizationId);
  return { membership, project };
}

function expectedSelector(options, graph) {
  const runIdentitySha256 = digest(options.identity);
  const membership = one(graph.referenced, 'organization-membership');
  switch (options.mutationKind) {
    case 'control-plane-create-project': return { kind: 'Project', organizationId: membership.organizationId, slug: options.resourceName, runIdentitySha256 };
    case 'control-plane-import-repository': {
      const { project } = tenant(graph); const repository = one(graph.referenced, 'github-repository');
      return { kind: 'RepositoryImport', projectId: project.projectId, repositoryId: repository.repositoryId, name: options.resourceName, runIdentitySha256 };
    }
    case 'control-plane-create-deployment': {
      const { project } = tenant(graph); const service = one(graph.referenced, 'service', (item) => item.projectId === project.projectId);
      return { kind: 'Deployment', projectId: project.projectId, serviceId: service.serviceId, name: options.resourceName, runIdentitySha256 };
    }
    case 'control-plane-rollback': case 'control-plane-preview-cleanup': {
      const { project } = tenant(graph); const service = one(graph.referenced, 'service', (item) => item.projectId === project.projectId);
      const deployment = one(graph.referenced, 'deployment', (item) => item.serviceId === service.serviceId);
      return { kind: 'Deployment', projectId: project.projectId, serviceId: service.serviceId, deploymentId: deployment.deploymentId, name: options.resourceName, runIdentitySha256 };
    }
    case 'control-plane-create-resource': return { kind: 'Resource', projectId: tenant(graph).project.projectId, name: options.resourceName, runIdentitySha256 };
    case 'control-plane-delete-resource': case 'control-plane-delete-restore-target': {
      const { project } = tenant(graph); const role = options.mutationKind.endsWith('restore-target') ? 'restore-target' : undefined;
      const resource = one(graph.referenced, 'resource', (item) => item.projectId === project.projectId && (!role || item.role === role));
      return { kind: 'Resource', projectId: project.projectId, resourceId: resource.resourceId, role: resource.role, engine: resource.engine, name: options.resourceName, runIdentitySha256 };
    }
    case 'control-plane-create-backup': {
      const { project } = tenant(graph); const resource = one(graph.referenced, 'resource', (item) => item.projectId === project.projectId && item.role === 'source');
      return { kind: 'Backup', projectId: project.projectId, resourceId: resource.resourceId, engine: resource.engine, name: options.resourceName, runIdentitySha256 };
    }
    case 'control-plane-delete-backup': {
      const { project } = tenant(graph); const resource = one(graph.referenced, 'resource', (item) => item.projectId === project.projectId && item.role === 'source');
      const backup = one(graph.referenced, 'backup', (item) => item.sourceResourceId === resource.resourceId);
      return { kind: 'Backup', projectId: project.projectId, resourceId: resource.resourceId, backupId: backup.backupId,
        engine: resource.engine, name: options.resourceName, runIdentitySha256 };
    }
    case 'control-plane-create-restore': {
      const { project } = tenant(graph); const source = one(graph.referenced, 'resource', (item) => item.projectId === project.projectId && item.role === 'source');
      if (graph.referenced.filter((item) => item.kind === 'resource').length !== 1) fail('invalid_recovery_selector');
      const backup = one(graph.referenced, 'backup', (item) => item.sourceResourceId === source.resourceId);
      return { kind: 'Restore', projectId: project.projectId, backupId: backup.backupId,
        engine: source.engine, name: options.resourceName, runIdentitySha256 };
    }
    case 'control-plane-delete-project': {
      const { project } = tenant(graph); return { kind: 'Project', organizationId: membership.organizationId, projectId: project.projectId, name: options.resourceName, runIdentitySha256 };
    }
    case 'kubernetes-apply-pod': case 'kubernetes-apply-network-policy': {
      const runtime = options.approvedRuntimeSelector;
      if (!exactKeys(runtime, ['context', 'namespace']) || !SAFE_CONTEXT.test(runtime.context) || !SAFE_NAME.test(runtime.namespace)) fail('invalid_runtime_selector');
      const pod = options.mutationKind === 'kubernetes-apply-pod';
      const name = `raibit-evidence-client-${options.identity.runId}${pod ? '' : '-egress'}`;
      if (options.resourceName !== name) fail('invalid_recovery_selector');
      return { kind: pod ? 'Pod' : 'NetworkPolicy', namespace: runtime.namespace, name, runLabel: options.identity.runId,
        runIdentitySha256, runtimeSelectorSha256: digest(runtime) };
    }
    default: fail('invalid_recovery_selector');
  }
}

export function validateIntentScope(options, entries) {
  if (!Object.hasOwn(MUTATION_CONTRACT, options.mutationKind)) fail('invalid_mutation_contract');
  if (!options.mutationKind.startsWith('kubernetes-') && options.resourceName !== deriveRunResourceName(options.identity, options.intentId)) fail('invalid_recovery_selector');
  const graph = resolveBindingGraph(entries, options.bindingRefs);
  const selector = expectedSelector(options, graph);
  const runtimeDigest = options.mutationKind.startsWith('kubernetes-') ? digest(options.approvedRuntimeSelector) : null;
  const [method, routeTemplate] = MUTATION_CONTRACT[options.mutationKind];
  let relativeRoute = routeTemplate;
  for (const key of ['projectId', 'serviceId', 'deploymentId', 'resourceId', 'backupId', 'namespace']) {
    relativeRoute = relativeRoute.replace(`:${key}`, selector[key] ?? '');
  }
  if (options.method !== method || options.routeTemplate !== routeTemplate || relativeRoute.includes(':') || options.relativeRoute !== relativeRoute) fail('invalid_mutation_contract');
  if (digest(options.recoverySelector) !== digest(selector)) fail('invalid_recovery_selector');
  return immutable({ graph, selector, runtimeDigest });
}
