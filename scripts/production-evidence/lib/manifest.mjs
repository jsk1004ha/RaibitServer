import { ProductionEvidenceSchema, VerifiedBindingJournalSchema } from '../../../packages/schemas/src/production-evidence.ts';
import { RESOURCE_LIFECYCLE_ASSERTIONS } from '../../../packages/schemas/src/resource-lifecycle-evidence.ts';
import resourceCapabilities from '../../../packages/schemas/src/resource-capabilities-v1.json' with { type: 'json' };
import { APPROVED_INPUT_SHA256, OPERATOR_CONTRACT_DIGEST, EvidenceError, assertRedacted, digest } from './operator-inputs.mjs';

export const MAX_RUN_AGE_MS = 4 * 60 * 60 * 1000;
export const REQUIRED_ASSERTIONS = Object.freeze({
  local: ['local_checks'], cluster: ['kind_helm_reconciliation'],
  lifecycle: ['github_source', 'image_digest', 'scan_policy', 'signature', 'rollout', 'https', 'functional_write_read', 'runtime_logs', 'preview_cleanup'],
  resources: ['provision', 'attach_query', 'backup_checksum', 'isolated_restore', 'resource_delete'],
  operations: ['usage_quota_audit', 'trusted_proxy', 'metrics', 'rollback'],
  domains: ['ownership', 'tls_exact_san', 'route', 'revalidation', 'domain_delete'],
});
export const STEP_COMPONENT = Object.freeze({
  'auth-source': 'lifecycle', 'supply-chain': 'lifecycle', runtime: 'lifecycle', observability: 'lifecycle',
  resources: 'resources', 'backup-sql': 'resources', 'backup-nosql': 'resources', preview: 'lifecycle', rollback: 'operations', cleanup: 'operations',
});
const levels = Object.freeze({ local: 'L1', cluster: 'L2', lifecycle: 'L3', resources: 'L3', operations: 'L3', domains: 'L3' });
const provenance = Object.freeze({ L1: 'local', L2: 'kind', L3: 'credentialed' });
const fail = (reason) => ({ valid: false, releaseEligible: false, reason });
export function assertFresh(startedAt, observedAt, now = Date.now()) {
  const start = Date.parse(startedAt), observed = Date.parse(observedAt);
  if (!Number.isFinite(start) || !Number.isFinite(observed) || start > observed || observed > now || now - start > MAX_RUN_AGE_MS) throw new EvidenceError('stale_state');
}
function checkAssertions(assertions, required, artifacts) {
  const ids = assertions.map(({ id }) => id);
  if (new Set(ids).size !== ids.length || required.some((id) => !ids.includes(id))) throw new EvidenceError('missing_assertion');
  if (assertions.some(({ status }) => status === 'NOT_RUN')) throw new EvidenceError('not_run');
  if (assertions.some(({ status }) => status !== 'PASS')) throw new EvidenceError('assertion_failed');
  if (assertions.some(({ artifactPaths }) => artifactPaths.some((path) => !artifacts.includes(path)))) throw new EvidenceError('missing_artifact');
}
const RELEASE_FEATURES = Object.freeze(['provision', 'authenticatedHealth', 'attach', 'query', 'schema', 'backup', 'restore']);
function bindingKey(binding) {
  switch (binding.kind) {
    case 'organization-membership': return `${binding.kind}:${binding.membershipId}`;
    case 'github-repository': return `${binding.kind}:${binding.repositoryId}`;
    case 'tenant-revision': return `${binding.kind}:${binding.tenantRevisionId}`;
    case 'project': return `${binding.kind}:${binding.projectId}`;
    case 'service': return `${binding.kind}:${binding.serviceId}`;
    case 'deployment': return `${binding.kind}:${binding.role}`;
    case 'resource': return `${binding.kind}:${binding.engine}:${binding.role}`;
    case 'backup': return `${binding.kind}:${binding.engine}`;
    case 'restore': return `${binding.kind}:${binding.engine}`;
    default: throw new EvidenceError('invalid_schema');
  }
}
function oneBinding(bindings, kind, predicate = () => true) {
  const matches = bindings.filter((binding) => binding.kind === kind && predicate(binding));
  if (matches.length !== 1) throw new EvidenceError('missing_bindings');
  return matches[0];
}
function readVerifiedBindingJournal(manifest, options) {
  if (!manifest.bindingJournal || !manifest.bindingsDigest || !manifest.capabilitySnapshot || typeof options.verifyBindingJournal !== 'function') throw new EvidenceError('missing_binding_journal');
  const request = Object.freeze({ identityDigest: digest(manifest.identity), journal: manifest.bindingJournal }), parsed = VerifiedBindingJournalSchema.safeParse(options.verifyBindingJournal(request)); if (!parsed.success) throw new EvidenceError('invalid_binding_journal');
  const journal = parsed.data;
  if (digest(journal.journal) !== digest(manifest.bindingJournal) || journal.identityDigest !== digest(manifest.identity)
    || journal.bindingsDigest !== manifest.bindingsDigest || digest(journal.entries) !== journal.bindingsDigest
    || journal.journal.entriesDigest !== journal.bindingsDigest || journal.entries.length !== journal.journal.entryCount
    || manifest.fragments.some((fragment) => fragment.bindingsDigest !== manifest.bindingsDigest)) throw new EvidenceError('binding_journal_mismatch');
  return journal;
}
function verifyBindingGraph(manifest, options, journal) {
  const bindings = journal.entries;
  const assigned = new Map();
  for (const binding of bindings) {
    const key = bindingKey(binding);
    if (assigned.has(key)) throw new EvidenceError(assigned.get(key) === digest(binding) ? 'duplicate_binding' : 'binding_reassigned');
    assigned.set(key, digest(binding));
  }
  const membership = oneBinding(bindings, 'organization-membership');
  const repository = oneBinding(bindings, 'github-repository');
  const candidateRevision = oneBinding(bindings, 'tenant-revision', (binding) => binding.purpose === 'candidate');
  const failureRevision = oneBinding(bindings, 'tenant-revision', (binding) => binding.purpose === 'failure');
  const project = oneBinding(bindings, 'project');
  const service = oneBinding(bindings, 'service');
  if (options.repository && repository.repository !== options.repository) throw new EvidenceError('binding_graph_mismatch');
  if ([candidateRevision, failureRevision].some(({ tenantCommitSha }) => tenantCommitSha === manifest.identity.sourceCommitSha)
    || candidateRevision.tenantCommitSha === failureRevision.tenantCommitSha) throw new EvidenceError('tenant_revision_mismatch');
  if (candidateRevision.repositoryId !== repository.repositoryId || candidateRevision.repository !== repository.repository
    || candidateRevision.branch !== repository.branch || failureRevision.repositoryId !== repository.repositoryId
    || failureRevision.repository !== repository.repository
    || project.organizationId !== membership.organizationId || service.projectId !== project.projectId) throw new EvidenceError('binding_graph_mismatch');
  const observations = new Map(journal.observations.map((observation) => [observation.observationId, observation])); if (observations.size !== journal.observations.length) throw new EvidenceError('binding_provenance_mismatch');
  for (const revision of [candidateRevision, failureRevision]) {
    const observation = observations.get(revision.observationId);
    const expectedKind = revision.purpose === 'candidate' ? 'builder-deployment-observation' : 'github-webhook-observation';
    if (!observation) throw new EvidenceError('missing_binding_provenance');
    if (observation.kind !== expectedKind || observation.identityDigest !== digest(manifest.identity)
      || observation.repositoryId !== revision.repositoryId || observation.repository !== revision.repository
      || observation.branch !== revision.branch || observation.tenantCommitSha !== revision.tenantCommitSha) throw new EvidenceError('binding_provenance_mismatch');
  }
  if (new Set(journal.observations.flatMap(({ receiptPath, artifactPath }) => [receiptPath, artifactPath])).size !== journal.observations.length * 2) throw new EvidenceError('binding_provenance_mismatch');
  const deployments = ['candidate', 'preview', 'failed', 'rollback'].map((role) => oneBinding(bindings, 'deployment', (binding) => binding.role === role));
  if (new Set(deployments.map(({ deploymentId }) => deploymentId)).size !== deployments.length
    || deployments.some((deployment) => deployment.serviceId !== service.serviceId)) throw new EvidenceError('binding_graph_mismatch');
  for (const deployment of deployments) {
    const revision = deployment.role === 'failed' ? failureRevision : candidateRevision;
    if (deployment.tenantRevisionId !== revision.tenantRevisionId || deployment.tenantCommitSha !== revision.tenantCommitSha
      || deployment.repositoryId !== revision.repositoryId || deployment.repository !== revision.repository
      || deployment.branch !== revision.branch) throw new EvidenceError('binding_graph_mismatch');
  }
  for (const engine of manifest.capabilitySnapshot.requiredEngines) {
    const source = oneBinding(bindings, 'resource', (binding) => binding.engine === engine && binding.role === 'source');
    const target = oneBinding(bindings, 'resource', (binding) => binding.engine === engine && binding.role === 'restore-target');
    const backup = oneBinding(bindings, 'backup', (binding) => binding.engine === engine);
    const restore = oneBinding(bindings, 'restore', (binding) => binding.engine === engine);
    if (source.resourceId === target.resourceId || source.projectId !== project.projectId || target.projectId !== project.projectId
      || backup.sourceResourceId !== source.resourceId || restore.backupId !== backup.backupId
      || restore.targetResourceId !== target.resourceId) throw new EvidenceError('binding_graph_mismatch');
  }
}
function verifyCapabilitySnapshot(snapshot) {
  const canonicalRequired = resourceCapabilities.engines.filter(({ runtime }) => runtime === 'dedicated-local').map(({ engine }) => engine);
  if (snapshot.canonicalDigest !== digest(resourceCapabilities)
    || JSON.stringify(snapshot.requiredEngines) !== JSON.stringify(canonicalRequired)) throw new EvidenceError('capability_snapshot_mismatch');
  const required = snapshot.requiredEngines.map((engine) => resourceCapabilities.engines.find((item) => item.engine === engine));
  if (required.some((capability) => !capability)) throw new EvidenceError('capability_snapshot_mismatch');
  return required;
}
function verifyReleaseCapabilities(snapshot) {
  const required = verifyCapabilitySnapshot(snapshot);
  if (required.some((capability) => capability.liveEvidence.release !== 'verified'
    || RELEASE_FEATURES.some((feature) => capability.release[feature] !== true))) throw new EvidenceError('release_capability_not_verified');
}
export function verifyManifest(value, options = {}) {
  try {
    assertRedacted(value);
    if (!value?.identity?.approvedInputSha256) return fail('missing_approved_input');
    if (value.identity.approvedInputSha256 !== APPROVED_INPUT_SHA256 || value.preflight?.approvedInputSha256 !== APPROVED_INPUT_SHA256) return fail('approved_input_digest_mismatch');
    if (Object.hasOwn(value, 'releaseEligible') || Object.hasOwn(value, 'ok')) return fail('misleading_success_output');
    const parsed = ProductionEvidenceSchema.safeParse(value);
    if (!parsed.success) return fail(parsed.error.issues.some(issue => issue.path.includes('resourceScope')) ? 'invalid_resource_scope' : 'invalid_schema');
    const manifest = parsed.data;
    if (manifest.identity.operatorContractDigest !== OPERATOR_CONTRACT_DIGEST) return fail('operator_contract_digest_mismatch');
    for (const key of ['operatorContractDigest', 'operatorInputFingerprint']) if (manifest.preflight[key] !== manifest.identity[key]) return fail('identity_mismatch');
    for (const fragment of manifest.fragments) if (digest(fragment.identity) !== digest(manifest.identity)) return fail('identity_mismatch');
    assertFresh(manifest.startedAt, manifest.observedAt, options.now);
    const components = manifest.fragments.map(({ component }) => component);
    if (new Set(components).size !== components.length) return fail('reused_fragment');
    const profile = options.profile ?? manifest.profile;
    if (!['component', 'train-a', 'final'].includes(profile)) return fail('invalid_profile');
    const selected = options.fragment;
    if (selected && !['resources', 'domains'].includes(selected)) return fail('invalid_component');
    for (const fragment of manifest.fragments) {
      if (fragment.resourceScope && fragment.component !== 'resources') return fail('resource_scope_mismatch');
      switch (fragment.resourceScope?.kind) {
        case undefined: case 'full': break;
        case 'lifecycle-only': {
          if (manifest.profile !== 'component' || profile !== 'component' || (selected && selected !== 'resources') || components.length !== 1) return fail('resource_scope_mismatch');
          const paths = [...fragment.resourceScope.engineReceiptPaths, fragment.resourceScope.sqliteReceiptPath];
          if (new Set(paths).size !== paths.length) return fail('reused_engine_receipt');
          if (paths.some(file => !fragment.artifacts.some(artifact => artifact.path === file))) return fail('missing_artifact');
          for (const assertion of fragment.assertions.filter(assertion => RESOURCE_LIFECYCLE_ASSERTIONS.includes(assertion.id))) {
            if (fragment.resourceScope.engineReceiptPaths.some(file => !assertion.artifactPaths.includes(file))) return fail('missing_artifact');
          }
          if ([...fragment.cleanup.assertions, ...manifest.cleanup.assertions].some(assertion => paths.some(file => !assertion.artifactPaths.includes(file)))) return fail('missing_artifact');
          break;
        }
        default: return fail('resource_scope_mismatch');
      }
    }
    const componentMode = Boolean(selected) || profile === 'component';
    const required = componentMode ? [selected ?? components[0]] : ['local', 'cluster', 'lifecycle', 'resources', 'operations', ...(profile === 'final' ? ['domains'] : [])];
    if (!selected && profile === 'component' && (components.length !== 1 || !['resources', 'domains'].includes(components[0]))) return fail('invalid_component');
    if (required.some((component) => !components.includes(component))) return fail('missing_fragment');
    if (manifest.status === 'NOT_RUN') return fail('not_run');
    if (manifest.status !== 'PASS') return fail('assertion_failed');
    if (!componentMode) {
      verifyCapabilitySnapshot(manifest.capabilitySnapshot);
      verifyBindingGraph(manifest, options, readVerifiedBindingJournal(manifest, options));
    }
    if (manifest.cleanup.status !== 'PASS') return fail('cleanup_failed');
    const allPaths = manifest.fragments.flatMap(({ artifacts }) => artifacts.map(({ path }) => path));
    if (new Set(allPaths).size !== allPaths.length) return fail('reused_artifact');
    if (manifest.cleanup.assertions.some(({ status }) => status !== 'PASS')) return fail('cleanup_failed');
    checkAssertions(manifest.cleanup.assertions, ['run_cleanup'], allPaths);
    for (const fragment of manifest.fragments) {
      assertFresh(fragment.startedAt, fragment.observedAt, options.now);
      if (Date.parse(fragment.startedAt) < Date.parse(manifest.startedAt) || Date.parse(fragment.observedAt) > Date.parse(manifest.observedAt)) return fail('stale_state');
      if (fragment.level !== levels[fragment.component]) return fail('level_mismatch');
      if (fragment.provenance !== (manifest.fixture ? 'fixture' : provenance[fragment.level])) return fail('level_mismatch');
      if (fragment.cleanup.status !== 'PASS') return fail('cleanup_failed');
      if (fragment.cleanup.assertions.some(({ status }) => status !== 'PASS')) return fail('cleanup_failed');
      if (fragment.status === 'NOT_RUN') return fail('not_run');
      if (fragment.status !== 'PASS') return fail('assertion_failed');
      const paths = fragment.artifacts.map(({ path }) => path);
      checkAssertions(fragment.assertions, fragment.resourceScope?.kind === 'lifecycle-only' ? RESOURCE_LIFECYCLE_ASSERTIONS : REQUIRED_ASSERTIONS[fragment.component], paths);
      checkAssertions(fragment.cleanup.assertions, ['component_cleanup'], paths);
    }
    if (!componentMode && manifest.fixture) return fail('fixture_not_release_evidence');
    if (!manifest.fixture && manifest.preflight.status !== 'PASS') return fail('missing_credentials');
    if (!componentMode) verifyReleaseCapabilities(manifest.capabilitySnapshot);
    return { valid: true, releaseEligible: !componentMode, reason: componentMode ? 'component_only' : 'eligible', manifestDigest: digest(manifest) };
  } catch (error) {
    if (error instanceof EvidenceError) return fail(error.reason);
    throw error;
  }
}

function aggregateStatus(statuses) {
  if (statuses.includes('FAIL')) return 'FAIL';
  if (statuses.includes('NOT_RUN')) return 'NOT_RUN';
  return 'PASS';
}

function uniqueArtifacts(artifacts) {
  const byPath = new Map();
  for (const artifact of artifacts) {
    const previous = byPath.get(artifact.path);
    if (previous && previous.sha256 !== artifact.sha256) throw new EvidenceError('reused_artifact');
    byPath.set(artifact.path, artifact);
  }
  return [...byPath.values()];
}

export function assembleManifest(input) {
  const components = ['local', 'cluster', 'lifecycle', 'resources', 'operations'];
  const fragments = components.map((component) => {
    const foundation = input.foundations[component];
    const assertions = REQUIRED_ASSERTIONS[component].map((id) => {
      if (foundation && foundation.assertion === id) return { id, status: foundation.status, artifactPaths: [foundation.artifact.path] };
      const matches = input.steps.flatMap(({ receipt }) => receipt.assertions.filter((assertion) => assertion.id === id));
      const requiredMatches = ['backup_checksum', 'isolated_restore'].includes(id) ? 2 : 1;
      return { id, status: matches.length < requiredMatches ? 'NOT_RUN' : aggregateStatus(matches.map(({ status }) => status)),
        artifactPaths: [...new Set(matches.flatMap(({ artifactPaths }) => artifactPaths))] };
    });
    const referenced = new Set(assertions.flatMap(({ artifactPaths }) => artifactPaths));
    const artifacts = uniqueArtifacts([
      ...(foundation ? [foundation.artifact] : []),
      ...input.steps.flatMap(({ receipt, descriptor }) => [
        ...(STEP_COMPONENT[receipt.step] === component ? [descriptor] : []),
        ...receipt.artifacts.filter(({ path }) => referenced.has(path) || (receipt.step === 'cleanup' && component === 'operations')),
      ]),
      input.cleanup.componentArtifacts[component],
      ...(component === 'operations' ? [input.cleanup.stepDescriptor, input.cleanup.runArtifact] : []),
    ].filter(Boolean));
    const cleanupStatus = aggregateStatus([input.cleanup.status, input.cleanup.componentArtifacts[component] ? 'PASS' : 'NOT_RUN']);
    const fragment = { component, level: component === 'local' ? 'L1' : component === 'cluster' ? 'L2' : 'L3',
      provenance: input.fixture ? 'fixture' : component === 'local' ? 'local' : component === 'cluster' ? 'kind' : 'credentialed',
      identity: input.identity, startedAt: input.startedAt, observedAt: input.observedAt,
      status: aggregateStatus(assertions.map(({ status }) => status)), assertions, artifacts,
      cleanup: { status: cleanupStatus, assertions: [{ id: 'component_cleanup', status: cleanupStatus, artifactPaths: [input.cleanup.componentArtifacts[component].path] }] } };
    if (input.bindingsDigest) fragment.bindingsDigest = input.bindingsDigest;
    return fragment;
  });
  const cleanupStatus = aggregateStatus([input.cleanup.status, input.cleanup.runArtifact ? 'PASS' : 'NOT_RUN']);
  return { schema: 'raibitserver.production-evidence/v1', profile: 'train-a', identity: input.identity,
    startedAt: input.startedAt, observedAt: input.observedAt,
    status: aggregateStatus([...fragments.map(({ status }) => status), cleanupStatus]), preflight: input.preflight,
    fragments, cleanup: { status: cleanupStatus, assertions: [{ id: 'run_cleanup', status: cleanupStatus, artifactPaths: [input.cleanup.runArtifact.path] }] },
    ...(input.capabilitySnapshot ? { capabilitySnapshot: input.capabilitySnapshot } : {}),
    ...(input.bindingJournal && input.bindingsDigest ? { bindingJournal: input.bindingJournal, bindingsDigest: input.bindingsDigest } : {}),
    fixture: input.fixture };
}
