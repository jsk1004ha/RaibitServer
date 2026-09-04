import { digest, EvidenceError } from './operator-inputs.mjs';

const SAFE_PART = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/;
const SAFE_CONTEXT = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
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
  'control-plane-create-restore': Object.freeze(['POST', '/api/backups/:backupId/restore']),
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
function primaryId(binding) {
  switch (binding.kind) {
    case 'organization-membership': return binding.membershipId;
    case 'github-repository': return binding.repositoryId;
    case 'tenant-revision': return binding.tenantCommitSha;
    case 'project': return binding.projectId;
    case 'service': return binding.serviceId;
    case 'deployment': return binding.deploymentId;
    case 'resource': return binding.resourceId;
    case 'backup': return binding.backupId;
    case 'restore': return binding.restoreId;
    default: fail();
  }
}

export function resolveBindingGraph(entries, references) {
  if (!Array.isArray(entries) || !Array.isArray(references) || references.length === 0) fail();
  const logical = new Map(); const domain = new Map();
  for (const entry of entries) {
    if (!isRecord(entry) || !SAFE_PART.test(entry.role) || !SAFE_PART.test(entry.bindingId) || !SHA256.test(entry.entrySha256) || !isRecord(entry.payload)) fail();
    const logicalId = `${entry.role}:${entry.bindingId}`; const domainId = `${entry.payload.kind}:${primaryId(entry.payload)}`;
    if (logical.has(logicalId) || domain.has(domainId)) fail();
    logical.set(logicalId, entry); domain.set(domainId, entry.payload);
  }
  for (const { payload: binding } of entries) {
    switch (binding.kind) {
      case 'organization-membership': case 'github-repository': break;
      case 'tenant-revision': if (!domain.has(`github-repository:${binding.repositoryId}`)) fail(); break;
      case 'project': if (entries.filter(({ payload }) => payload.kind === 'organization-membership' && payload.organizationId === binding.organizationId).length !== 1) fail(); break;
      case 'service': if (!domain.has(`project:${binding.projectId}`)) fail(); break;
      case 'deployment': if (!domain.has(`service:${binding.serviceId}`)) fail(); break;
      case 'resource': if (!domain.has(`project:${binding.projectId}`)) fail(); break;
      case 'backup': if (!domain.has(`resource:${binding.sourceResourceId}`)) fail(); break;
      case 'restore': if (!domain.has(`backup:${binding.backupId}`) || !domain.has(`resource:${binding.targetResourceId}`)) fail(); break;
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
  return immutable({ bindingEntryCount: entries.length, bindingsDigest: digest(entries), referenced });
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
      const backup = one(graph.referenced, 'backup', (item) => item.sourceResourceId === source.resourceId);
      const target = one(graph.referenced, 'resource', (item) => item.projectId === project.projectId && item.role === 'restore-target');
      return { kind: 'Restore', projectId: project.projectId, backupId: backup.backupId, targetResourceId: target.resourceId, engine: source.engine, name: options.resourceName, runIdentitySha256 };
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
