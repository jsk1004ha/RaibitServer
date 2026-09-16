import { z } from 'zod';
import { PreviewWebhookSchema } from './preview.ts';

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
const WebhookEventIdSchema = z.string().regex(/^(?:c[a-z0-9]{24}|whe-github-[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/).brand('WebhookEventId');
export const EvidenceIdentitySchema = z.strictObject({
  runId: z.uuidv4().brand('EvidenceRunId'),
  environmentFingerprint: Sha256Schema,
  sourceCommitSha: z.string().regex(/^[a-f0-9]{40}$/).brand('SourceCommitSha'),
  migrationDigest: Sha256Schema,
  approvedInputSha256: z.literal(APPROVED_INPUT_SHA256),
  operatorContractDigest: Sha256Schema,
  operatorInputFingerprint: Sha256Schema,
  domainInputDigest: Sha256Schema.optional(),
}).readonly();
const RepositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(256);
const BranchSchema = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/);
const TenantCommitShaSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).brand('TenantCommitSha');
const ResourceEngineSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
export const EvidenceBindingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('organization-membership'), organizationId: IdentifierSchema,
    membershipId: IdentifierSchema, userId: IdentifierSchema, role: IdentifierSchema }).readonly(),
  z.strictObject({ kind: z.literal('github-repository'), installationId: IdentifierSchema,
    repositoryId: IdentifierSchema, repository: RepositorySchema, branch: BranchSchema }).readonly(),
  z.strictObject({ kind: z.literal('github-webhook-event'), webhookEventId: WebhookEventIdSchema,
    provider: z.literal('github'), eventType: z.literal('pull_request'), deliveryId: PreviewWebhookSchema.shape.deliveryId,
    handled: z.literal(true), event: PreviewWebhookSchema }).refine((value) => value.deliveryId === value.event.deliveryId).readonly(),
  z.strictObject({ kind: z.literal('tenant-revision'), tenantRevisionId: IdentifierSchema,
    purpose: z.enum(['candidate', 'preview', 'failure']), observationId: IdentifierSchema, repositoryId: IdentifierSchema,
    repository: RepositorySchema, branch: BranchSchema, tenantCommitSha: TenantCommitShaSchema,
    pullRequestNumber: z.number().int().positive().optional() }).readonly(),
  z.strictObject({ kind: z.literal('project'), projectId: IdentifierSchema, organizationId: IdentifierSchema }).readonly(),
  z.strictObject({ kind: z.literal('service'), serviceId: IdentifierSchema, projectId: IdentifierSchema }).readonly(),
  z.strictObject({ kind: z.literal('deployment'), role: z.enum(['candidate', 'preview', 'failed', 'rollback']),
    deploymentId: IdentifierSchema, serviceId: IdentifierSchema, tenantRevisionId: IdentifierSchema,
    tenantCommitSha: TenantCommitShaSchema, repositoryId: IdentifierSchema, repository: RepositorySchema, branch: BranchSchema }).readonly(),
  z.strictObject({ kind: z.literal('resource'), role: z.enum(['source', 'restore-target']), engine: ResourceEngineSchema,
    resourceId: IdentifierSchema, projectId: IdentifierSchema }).readonly(),
  z.strictObject({ kind: z.literal('backup'), engine: ResourceEngineSchema,
    backupId: IdentifierSchema, sourceResourceId: IdentifierSchema }).readonly(),
  z.strictObject({ kind: z.literal('restore'), engine: ResourceEngineSchema,
    restoreId: IdentifierSchema, backupId: IdentifierSchema, targetResourceId: IdentifierSchema }).readonly(),
]);
export const EvidenceBindingsSchema = z.array(EvidenceBindingSchema).readonly();
export const EvidenceCapabilitySnapshotSchema = z.strictObject({
  schema: z.literal('raibitserver.resource-capability-snapshot/v1'),
  canonicalDigest: Sha256Schema,
  requiredEngines: z.array(ResourceEngineSchema).min(1).readonly(),
}).readonly();
export const EvidenceArtifactPathSchema = z.string().regex(/^[a-zA-Z0-9_-][a-zA-Z0-9_./-]*$/).refine((v) => !v.split('/').includes('..'));
export const EvidenceArtifactSchema = z.strictObject({
  path: EvidenceArtifactPathSchema,
  sha256: Sha256Schema,
  redacted: z.literal(true),
}).readonly();
const DomainEvidenceHostnameSchema = z.string().min(3).max(253).regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/);
const DomainEvidenceAddressSchema = z.string().regex(/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$|^[0-9a-f:]+$/i);
export const DomainEvidenceProofSchema = z.strictObject({
  schema: z.literal('raibitserver.production-domain-proof/v1'),
  domainInputDigest: Sha256Schema.optional(),
  fixtureZone: DomainEvidenceHostnameSchema,
  hostname: DomainEvidenceHostnameSchema,
  domainId: IdentifierSchema, organizationId: IdentifierSchema, projectId: IdentifierSchema,
  serviceId: IdentifierSchema, deploymentId: IdentifierSchema,
  verificationVersion: z.number().int().positive(), desiredGeneration: z.number().int().positive(),
  controllerLeaseGeneration: z.number().int().positive(),
  ownership: z.strictObject({ externalRecursive: z.literal(true), authoritative: z.literal(true), version: z.number().int().positive() }).readonly(),
  resolution: z.strictObject({ addresses: z.array(DomainEvidenceAddressSchema).min(1).readonly(),
    reboundAddresses: z.array(DomainEvidenceAddressSchema).min(1).readonly(), stable: z.literal(true) }).readonly(),
  certificate: z.strictObject({ chainVerified: z.literal(true), configuredIssuer: IdentifierSchema, issuer: IdentifierSchema,
    dnsNames: z.array(DomainEvidenceHostnameSchema).length(1).readonly() }).readonly(),
  https: z.strictObject({ host: DomainEvidenceHostnameSchema, servername: DomainEvidenceHostnameSchema,
    statusCode: z.number().int().min(200).max(299), responseMarkerSha256: Sha256Schema,
    serviceId: IdentifierSchema, deploymentId: IdentifierSchema }).readonly(),
  revalidation: z.strictObject({ dailySimulationObserved: z.literal(true), failuresObserved: z.literal(3),
    disabledAfterFailures: z.literal(true), ownershipRecovered: z.literal(true) }).readonly(),
  cleanup: z.strictObject({ txtAbsent: z.literal(true), dnsAbsent: z.literal(true), certificateAbsent: z.literal(true),
    routeAbsent: z.literal(true), generatedFallbackStatusCode: z.number().int().min(200).max(299),
    generatedFallbackMarkerSha256: Sha256Schema }).readonly(),
}).superRefine((value, context) => {
  const exactHost = value.hostname.endsWith(`.${value.fixtureZone}`) && value.hostname !== value.fixtureZone;
  const sameAddresses = JSON.stringify([...value.resolution.addresses].sort()) === JSON.stringify([...value.resolution.reboundAddresses].sort());
  if (!exactHost || value.ownership.version !== value.verificationVersion || !sameAddresses
    || value.certificate.dnsNames[0] !== value.hostname || value.certificate.issuer !== value.certificate.configuredIssuer
    || value.https.host !== value.hostname || value.https.servername !== value.hostname
    || value.https.serviceId !== value.serviceId || value.https.deploymentId !== value.deploymentId) {
    context.addIssue({ code: 'custom', message: 'domain proof bindings do not match' });
  }
}).readonly();
export const BindingJournalSnapshotSchema = z.strictObject({
  schema: z.literal('raibitserver.production-evidence-binding-journal-snapshot/v1'),
  runIdentitySha256: Sha256Schema,
  entryCount: z.number().int().positive(),
  entriesSha256: Sha256Schema,
}).readonly();
const BindingObservationFields = {
  observationId: IdentifierSchema,
  receiptPath: EvidenceArtifactPathSchema, receiptSha256: Sha256Schema, artifactPath: EvidenceArtifactPathSchema,
  artifactSha256: Sha256Schema, identityDigest: Sha256Schema, repositoryId: IdentifierSchema,
  repository: RepositorySchema, branch: BranchSchema, tenantCommitSha: TenantCommitShaSchema,
};
export const BindingObservationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...BindingObservationFields, kind: z.literal('builder-deployment-observation') }).readonly(),
  z.strictObject({ ...BindingObservationFields, kind: z.literal('github-webhook-observation') }).readonly(),
  z.strictObject({ ...BindingObservationFields, kind: z.literal('controlled-fixture-observation'), deploymentId: IdentifierSchema,
    controlledFault: z.strictObject({ kind: z.literal('readiness-path'), originalReadinessPath: z.string().nullable(),
      failingPath: z.string().startsWith('/'), deploymentReadinessPath: z.string().startsWith('/'),
      probeStatusCode: z.number().int().min(400).max(599), snapshotVersion: z.literal(1), failedStatus: z.literal('FAILED'),
      errorCode: z.literal('ROLLOUT_FAILED'), rolloutEventId: IdentifierSchema, restoredReadinessPath: z.string().nullable() })
      .refine((value) => value.failingPath === value.deploymentReadinessPath && value.failingPath !== value.originalReadinessPath
        && value.restoredReadinessPath === value.originalReadinessPath) }).readonly(),
  z.strictObject({ ...BindingObservationFields, kind: z.literal('github-pull-request-observation'),
    webhookEventId: WebhookEventIdSchema, deploymentId: IdentifierSchema, lineageId: IdentifierSchema,
    event: PreviewWebhookSchema }).refine((value) => value.repositoryId === value.event.repositoryId
      && value.repository === value.event.repository && value.branch === value.event.headRef
      && value.tenantCommitSha === value.event.headSha && value.event.action !== 'closed').readonly(),
]);
export const EvidenceJournalPayloadSchema = z.union([EvidenceBindingSchema, BindingObservationSchema]);
export const VerifiedBindingJournalSchema = z.strictObject({
  schema: z.literal('raibitserver.verified-binding-journal/v1'), journal: BindingJournalSnapshotSchema,
  identityDigest: Sha256Schema, bindingsDigest: Sha256Schema, entries: EvidenceBindingsSchema,
  observations: z.array(BindingObservationSchema).min(1).readonly(),
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
export const ResourceEvidenceScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('full') }).readonly(),
  z.strictObject({ kind: z.literal('lifecycle-only'),
    engineReceiptPaths: z.array(EvidenceArtifactPathSchema).length(6).readonly(),
    sqliteReceiptPath: EvidenceArtifactPathSchema,
  }).readonly(),
]);
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
  resourceScope: ResourceEvidenceScopeSchema.optional(),
  bindingsDigest: Sha256Schema.optional(),
  domainProof: DomainEvidenceProofSchema.optional(),
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
  capabilitySnapshot: EvidenceCapabilitySnapshotSchema.optional(),
  bindingJournal: BindingJournalSnapshotSchema.optional(),
  bindingsDigest: Sha256Schema.optional(),
  fixture: z.boolean(),
}).readonly();
export type ProductionEvidence = z.infer<typeof ProductionEvidenceSchema>;
export type EvidenceIdentity = z.infer<typeof EvidenceIdentitySchema>;
export type EvidenceFragment = z.infer<typeof EvidenceFragmentSchema>;
export type EvidenceProfile = z.infer<typeof EvidenceProfileSchema>;
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;
export type EvidenceBinding = z.infer<typeof EvidenceBindingSchema>;
