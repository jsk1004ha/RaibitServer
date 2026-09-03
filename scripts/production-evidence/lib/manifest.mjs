import { ProductionEvidenceSchema } from '../../../packages/schemas/src/production-evidence.ts';
import { APPROVED_INPUT_SHA256, OPERATOR_CONTRACT_DIGEST, EvidenceError, assertRedacted, digest } from './operator-inputs.mjs';

export const MAX_RUN_AGE_MS = 4 * 60 * 60 * 1000;
export const REQUIRED_ASSERTIONS = Object.freeze({
  local: ['local_checks'], cluster: ['kind_helm_reconciliation'],
  lifecycle: ['github_source', 'image_digest', 'scan_policy', 'signature', 'rollout', 'https', 'functional_write_read', 'runtime_logs', 'preview_cleanup'],
  resources: ['provision', 'attach_query', 'backup_checksum', 'isolated_restore', 'resource_delete'],
  operations: ['usage_quota_audit', 'trusted_proxy', 'metrics', 'rollback'],
  domains: ['ownership', 'tls_exact_san', 'route', 'revalidation', 'domain_delete'],
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
export function verifyManifest(value, options = {}) {
  try {
    assertRedacted(value);
    if (!value?.identity?.approvedInputSha256) return fail('missing_approved_input');
    if (value.identity.approvedInputSha256 !== APPROVED_INPUT_SHA256 || value.preflight?.approvedInputSha256 !== APPROVED_INPUT_SHA256) return fail('approved_input_digest_mismatch');
    if (Object.hasOwn(value, 'releaseEligible') || Object.hasOwn(value, 'ok')) return fail('misleading_success_output');
    const parsed = ProductionEvidenceSchema.safeParse(value);
    if (!parsed.success) return fail('invalid_schema');
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
    const componentMode = Boolean(selected) || profile === 'component';
    const required = componentMode ? [selected ?? components[0]] : ['local', 'cluster', 'lifecycle', 'resources', 'operations', ...(profile === 'final' ? ['domains'] : [])];
    if (!selected && profile === 'component' && (components.length !== 1 || !['resources', 'domains'].includes(components[0]))) return fail('invalid_component');
    if (required.some((component) => !components.includes(component))) return fail('missing_fragment');
    if (manifest.status === 'NOT_RUN') return fail('not_run');
    if (manifest.status !== 'PASS') return fail('assertion_failed');
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
      checkAssertions(fragment.assertions, REQUIRED_ASSERTIONS[fragment.component], paths);
      checkAssertions(fragment.cleanup.assertions, ['component_cleanup'], paths);
    }
    if (!componentMode && manifest.fixture) return fail('fixture_not_release_evidence');
    if (!manifest.fixture && manifest.preflight.status !== 'PASS') return fail('missing_credentials');
    return { valid: true, releaseEligible: !componentMode, reason: componentMode ? 'component_only' : 'eligible', manifestDigest: digest(manifest) };
  } catch (error) {
    if (error instanceof EvidenceError) return fail(error.reason);
    throw error;
  }
}
