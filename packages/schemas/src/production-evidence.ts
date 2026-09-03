import { z } from 'zod';

export const APPROVED_INPUT_SHA256 = '0EC3728F53E872561F78D2A4849EBB11C037FF65529439AD5E55DAD49EB9AEE2';
export const OPERATOR_CONTRACT_DIGEST = '9018b7e14c139b64ce0df686901624c4238db4f8d60d987ef46b72ea0b0a4a6c';
export const DnsLabelSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
export const OperatorInputValuesSchema = z.strictObject({
  schema: z.literal('raibitserver.operator-input-values/v1'),
  approvedInputSha256: z.literal(APPROVED_INPUT_SHA256), operatorContractDigest: z.literal(OPERATOR_CONTRACT_DIGEST),
  selectors: z.record(z.string(), z.string().min(1).max(512)).readonly(),
  secretRefs: z.array(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('helm-existingSecret'), role: z.string(), binding: z.string(), namespace: DnsLabelSchema,
      existingSecret: DnsLabelSchema, keys: z.array(z.string().regex(/^[A-Za-z0-9_.-]+$/)).min(1).readonly() }).readonly(),
    z.strictObject({ kind: z.literal('worker-secretKeyRef'), role: z.string(), binding: z.string(), namespace: DnsLabelSchema,
      secretKeyRef: z.strictObject({ name: DnsLabelSchema, key: z.string().regex(/^[A-Za-z0-9_.-]+$/), optional: z.literal(false) }).readonly() }).readonly(),
  ])).readonly(),
}).readonly();
export const ClusterFingerprintSchema = z.strictObject({
  clusterUid: z.string().min(1), apiServer: z.url(), baseDomain: z.string().min(1),
  registryHost: z.string().min(1), namespacePrefix: DnsLabelSchema,
}).readonly();
export const EvidenceStatusSchema = z.enum(['PASS', 'FAIL', 'NOT_RUN']);
export const EvidenceComponentSchema = z.enum(['local', 'cluster', 'lifecycle', 'resources', 'operations', 'domains']);
export const EvidenceProfileSchema = z.enum(['component', 'train-a', 'final']);
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/).brand('Sha256');
const IdentifierSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
export const EvidenceIdentitySchema = z.strictObject({
  runId: z.uuidv4().brand('EvidenceRunId'),
  environmentFingerprint: Sha256Schema,
  sourceCommitSha: z.string().regex(/^[a-f0-9]{40}$/).brand('SourceCommitSha'),
  migrationDigest: Sha256Schema,
  approvedInputSha256: z.literal(APPROVED_INPUT_SHA256),
  operatorContractDigest: Sha256Schema,
  operatorInputFingerprint: Sha256Schema,
  organizationId: IdentifierSchema, projectId: IdentifierSchema, serviceId: IdentifierSchema,
  deploymentId: IdentifierSchema, resourceId: IdentifierSchema,
}).readonly();
export const EvidenceArtifactSchema = z.strictObject({
  path: z.string().regex(/^[a-zA-Z0-9_-][a-zA-Z0-9_./-]*$/).refine((v) => !v.split('/').includes('..')),
  sha256: Sha256Schema,
  redacted: z.literal(true),
}).readonly();
export const EvidenceAssertionSchema = z.strictObject({
  id: IdentifierSchema,
  status: EvidenceStatusSchema,
  artifactPaths: z.array(z.string()).min(1).readonly(),
}).readonly();
export const EvidenceCleanupSchema = z.strictObject({
  status: EvidenceStatusSchema,
  assertions: z.array(EvidenceAssertionSchema).min(1).readonly(),
}).readonly();
export const EvidenceFragmentSchema = z.strictObject({
  component: EvidenceComponentSchema,
  level: z.enum(['L1', 'L2', 'L3']),
  provenance: z.enum(['local', 'kind', 'credentialed', 'fixture']),
  identity: EvidenceIdentitySchema,
  startedAt: z.iso.datetime(), observedAt: z.iso.datetime(),
  status: EvidenceStatusSchema,
  assertions: z.array(EvidenceAssertionSchema).min(1).readonly(),
  artifacts: z.array(EvidenceArtifactSchema).min(1).readonly(),
  cleanup: EvidenceCleanupSchema,
}).readonly();
export const ProductionEvidenceSchema = z.strictObject({
  schema: z.literal('raibitserver.production-evidence/v1'),
  profile: EvidenceProfileSchema,
  identity: EvidenceIdentitySchema,
  startedAt: z.iso.datetime(), observedAt: z.iso.datetime(),
  status: EvidenceStatusSchema,
  preflight: z.strictObject({
    status: EvidenceStatusSchema,
    approvedInputSha256: z.literal(APPROVED_INPUT_SHA256),
    operatorContractDigest: Sha256Schema,
    operatorInputFingerprint: Sha256Schema,
  }).readonly(),
  fragments: z.array(EvidenceFragmentSchema).min(1).readonly(),
  cleanup: EvidenceCleanupSchema,
  fixture: z.boolean(),
}).readonly();
export type ProductionEvidence = z.infer<typeof ProductionEvidenceSchema>;
export type EvidenceIdentity = z.infer<typeof EvidenceIdentitySchema>;
export type EvidenceFragment = z.infer<typeof EvidenceFragmentSchema>;
export type EvidenceProfile = z.infer<typeof EvidenceProfileSchema>;
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;
