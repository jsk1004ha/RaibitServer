import { z } from 'zod';
import { EvidenceArtifactSchema, EvidenceCleanupSchema, EvidenceIdentitySchema, EvidenceStatusSchema, Sha256Schema } from '../packages/schemas/src/production-evidence.ts';
import capabilities from '../packages/schemas/src/resource-capabilities-v1.json' with { type: 'json' };
import roles from '../test-fixtures/contracts/organization-roles-v1.json' with { type: 'json' };
import { APPROVED_INPUT_SHA256, OPERATOR_CONTRACT_DIGEST, EvidenceError, assertRedacted, digest } from './production-evidence/lib/operator-inputs.mjs';

export const COMPONENTS = Object.freeze(['C1', 'C2', 'C3', 'C4', 'C5', 'C6']);
export const PR_SLICES = Object.freeze(['A0', 'A1', 'A2', 'A3', 'B1', 'B2', 'B3']);
const component = z.enum(COMPONENTS);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const path = z.string().min(1).max(512).regex(/^[a-zA-Z0-9_.@/\[\]-]+$/)
  .refine((value) => !value.startsWith('/') && !value.split('/').some((part) => ['', '.', '..', '.git', '.omo'].includes(part)));
const pending = z.array(z.string().regex(/^[a-z0-9_]+$/)).readonly();
const mapping = {
  id: z.number().int().min(1).max(51), components: z.array(component).min(1).readonly(),
  prSlice: z.enum(PR_SLICES).nullable(),
};
const CatalogSchema = z.strictObject({
  schema: z.literal('raibitserver.platform-completion-catalog/v1'), claim: z.literal('capability-references-only'),
  approvedInputSha256: z.string(), components: z.array(component).readonly(), prSlices: z.array(z.enum(PR_SLICES)).readonly(),
  truth: z.strictObject({
    generatedRouteTenant: z.string(), grantableRoles: z.array(z.string()).readonly(),
    tenantEngines: z.array(z.string()).readonly(), resourceCapabilityDigest: Sha256Schema,
    localLevel: z.string(), clusterLevel: z.string(), releaseLevel: z.string(),
  }).readonly(),
  tasks: z.array(z.strictObject({ ...mapping, capability: z.string().min(1).max(160),
    code: z.array(path).readonly(), tests: z.array(path).readonly(),
    evidence: z.array(z.enum(['command-receipts', 'cleanup-artifacts', 'gate-a', 'domain-evidence'])).readonly(), pending }).readonly()).readonly(),
}).readonly();
export const GateReferenceSchema = z.strictObject({
  artifact: EvidenceArtifactSchema, ciExecution: EvidenceArtifactSchema, identity: EvidenceIdentitySchema, manifestDigest: Sha256Schema,
}).readonly();
const RuntimeSchema = z.strictObject({
  schema: z.literal('raibitserver.platform-completion-attempt/v1'),
  sourceCommitSha: sha, sourceTreeSha: sha, approvedInputSha256: z.string(), operatorContractDigest: Sha256Schema,
  catalogSha256: Sha256Schema, components: z.array(component).readonly(), fixture: z.boolean(),
  unresolvedLiveCriteria: pending,
  tasks: z.array(z.strictObject({ ...mapping, receipt: EvidenceArtifactSchema }).readonly()).readonly(),
  prSlices: z.array(z.strictObject({ id: z.enum(PR_SLICES), baseCommitSha: sha, headCommitSha: sha,
    mergedCommitSha: sha, artifact: EvidenceArtifactSchema }).readonly()).readonly(),
  gateA: GateReferenceSchema, gateB: GateReferenceSchema.optional(),
  domainEvidence: z.strictObject({ artifact: EvidenceArtifactSchema, identity: EvidenceIdentitySchema, manifestDigest: Sha256Schema }).readonly(),
}).readonly();
const TaskReceiptSchema = z.strictObject({
  schema: z.literal('raibitserver.platform-task-receipt/v1'), taskId: z.number().int().min(1).max(51),
  sourceCommitSha: sha, sourceTreeSha: sha, status: EvidenceStatusSchema, fixture: z.boolean(),
  commands: z.array(z.strictObject({
    command: z.string().min(1).max(2048), exitCode: z.number().int(), assertionCount: z.number().int().nonnegative(),
    skippedCount: z.number().int().nonnegative(), artifact: EvidenceArtifactSchema,
  }).readonly()).min(1).readonly(),
  artifacts: z.array(EvidenceArtifactSchema).min(1).readonly(), cleanup: EvidenceCleanupSchema,
}).readonly();

export function componentsForTask(id) {
  if ([27, 48, 50, 51].includes(id)) return [...COMPONENTS];
  if (id === 49) return COMPONENTS.slice(1);
  if (id <= 7) return ['C1'];
  if ((id >= 8 && id <= 10) || (id >= 29 && id <= 35)) return ['C2'];
  if ([21, 38].includes(id)) return ['C3', 'C4'];
  if (id === 42) return ['C3', 'C5'];
  if ([17, 19, 20].includes(id)) return ['C4'];
  if ([13, 14, 22, 23, 24, 25, 26].includes(id)) return ['C5'];
  if (id === 28 || id >= 43) return ['C6'];
  return ['C3'];
}
export function sliceForTask(id) {
  if (id === 1) return null;
  return PR_SLICES[id <= 7 ? 0 : id <= 14 ? 1 : id <= 21 ? 2 : id <= 28 ? 3 : id <= 35 ? 4 : id <= 42 ? 5 : 6];
}
function same(actual, expected, reason) {
  if (digest(actual) !== digest(expected)) throw new EvidenceError(reason);
}
function parsed(schema, value) {
  assertRedacted(value);
  const result = schema.safeParse(value);
  if (!result.success) throw new EvidenceError('completion_invalid_schema');
  return result.data;
}
function checkMappings(tasks, count) {
  const ids = tasks.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new EvidenceError('completion_duplicate_task');
  if (ids.some((id) => id > count)) throw new EvidenceError('completion_unsupported_task');
  if (ids.length !== count || Array.from({ length: count }, (_, i) => i + 1).some((id) => !ids.includes(id))) throw new EvidenceError('completion_missing_task');
  for (const row of tasks) {
    same(row.components, componentsForTask(row.id), 'completion_component_mismatch');
    if (row.prSlice !== sliceForTask(row.id)) throw new EvidenceError('completion_slice_mismatch');
  }
}
export function parseCatalog(value) {
  const catalog = parsed(CatalogSchema, value);
  if (catalog.approvedInputSha256 !== APPROVED_INPUT_SHA256) throw new EvidenceError('approved_input_digest_mismatch');
  same(catalog.components, COMPONENTS, 'completion_component_mismatch');
  same(catalog.prSlices, PR_SLICES, 'completion_slice_mismatch');
  checkMappings(catalog.tasks, 50);
  if (catalog.truth.generatedRouteTenant !== 'organizationSlug') throw new EvidenceError('completion_route_tenant_drift');
  same(catalog.truth.grantableRoles, roles.grantableRoles, 'completion_role_drift');
  same(catalog.truth.tenantEngines, capabilities.engines.filter(({ runtime }) => runtime !== 'unavailable').map(({ engine }) => engine), 'completion_unsupported_engine');
  if (catalog.truth.resourceCapabilityDigest !== digest(capabilities)) throw new EvidenceError('completion_capability_digest_drift');
  if (catalog.truth.localLevel !== 'L1' || catalog.truth.clusterLevel !== 'L2' || catalog.truth.releaseLevel !== 'L3') throw new EvidenceError('level_mismatch');
  for (const row of catalog.tasks) {
    const evidence = ['command-receipts', 'cleanup-artifacts', ...([14, 16, 17, 18, 19, 24, 25, 27, 28].includes(row.id)
      ? ['gate-a'] : row.id === 47 ? ['domain-evidence'] : [])];
    same(row.evidence, evidence, 'completion_evidence_mapping_mismatch');
    if (row.id !== 1 && (!row.code.length || !row.tests.length)) throw new EvidenceError('completion_missing_reference');
    if (new Set([...row.code, ...row.tests]).size !== row.code.length + row.tests.length) throw new EvidenceError('completion_duplicate_reference');
  }
  return catalog;
}
export function parseCompletionAttempt(value, options = {}) {
  const matrix = parsed(RuntimeSchema, value);
  if (matrix.approvedInputSha256 !== APPROVED_INPUT_SHA256) throw new EvidenceError('approved_input_digest_mismatch');
  if (matrix.operatorContractDigest !== OPERATOR_CONTRACT_DIGEST) throw new EvidenceError('operator_contract_digest_mismatch');
  same(matrix.components, COMPONENTS, 'completion_component_mismatch');
  checkMappings(matrix.tasks, options.final ? 51 : 50);
  same(matrix.prSlices.map(({ id }) => id), PR_SLICES, 'completion_slice_mismatch');
  if (matrix.fixture) throw new EvidenceError('fixture_not_release_evidence');
  if (matrix.unresolvedLiveCriteria.length) throw new EvidenceError('completion_unresolved_live_criteria');
  const paths = matrix.tasks.map(({ receipt }) => receipt.path);
  if (new Set(paths).size !== paths.length) throw new EvidenceError('completion_reused_receipt');
  if (matrix.gateA.identity.sourceCommitSha !== matrix.prSlices[3].headCommitSha) throw new EvidenceError('completion_gate_a_source_mismatch');
  if (matrix.sourceCommitSha !== matrix.prSlices[6].mergedCommitSha) throw new EvidenceError('completion_final_source_mismatch');
  if (options.final && !matrix.gateB) throw new EvidenceError('completion_missing_gate_b');
  if (!options.final && matrix.gateB) throw new EvidenceError('completion_future_gate_b');
  if (matrix.gateB) {
    if (matrix.gateB.identity.sourceCommitSha !== matrix.sourceCommitSha) throw new EvidenceError('completion_mixed_sha');
    if (matrix.gateB.identity.runId === matrix.gateA.identity.runId || matrix.gateB.identity.runId === matrix.domainEvidence.identity.runId
      || matrix.gateB.manifestDigest === matrix.gateA.manifestDigest || matrix.gateB.manifestDigest === matrix.domainEvidence.manifestDigest
      || matrix.gateB.artifact.sha256 === matrix.gateA.artifact.sha256 || matrix.gateB.artifact.path === matrix.gateA.artifact.path) throw new EvidenceError('completion_reused_gate');
  }
  return matrix;
}
export function parseTaskReceipt(value, expected) {
  const receipt = parsed(TaskReceiptSchema, value);
  if (receipt.taskId !== expected.taskId) throw new EvidenceError('completion_receipt_task_mismatch');
  if (receipt.sourceCommitSha !== expected.sourceCommitSha || receipt.sourceTreeSha !== expected.sourceTreeSha) throw new EvidenceError('completion_mixed_sha');
  if (receipt.fixture) throw new EvidenceError('fixture_not_release_evidence');
  if (receipt.status !== 'PASS') throw new EvidenceError(receipt.status === 'NOT_RUN' ? 'not_run' : 'assertion_failed');
  if (receipt.commands.some(({ exitCode, assertionCount, skippedCount }) => exitCode !== 0 || assertionCount < 1 || skippedCount !== 0)) throw new EvidenceError('completion_command_failed');
  if (receipt.cleanup.status !== 'PASS' || receipt.cleanup.assertions.some(({ status }) => status !== 'PASS')) throw new EvidenceError('cleanup_failed');
  const artifacts = new Map(receipt.artifacts.map((artifact) => [artifact.path, artifact]));
  if (artifacts.size !== receipt.artifacts.length) throw new EvidenceError('reused_artifact');
  for (const { artifact } of receipt.commands) {
    if (!artifacts.has(artifact.path)) throw new EvidenceError('missing_artifact');
    same(artifact, artifacts.get(artifact.path), 'missing_artifact');
  }
  if (receipt.cleanup.assertions.some(({ artifactPaths }) => artifactPaths.some((file) => !artifacts.has(file)))) throw new EvidenceError('missing_artifact');
  return receipt;
}
