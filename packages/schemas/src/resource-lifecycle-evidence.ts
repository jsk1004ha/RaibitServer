import { z } from 'zod';
import { DnsLabelSchema, EvidenceIdentitySchema, EvidenceStatusSchema, Sha256Schema } from './production-evidence.ts';

export const RESOURCE_LIFECYCLE_ENGINES = ['postgresql', 'mysql', 'mariadb', 'mongodb', 'redis', 'valkey'] as const;
export const RESOURCE_LIFECYCLE_ASSERTIONS = ['provision', 'authenticated_health', 'attach_query', 'detach', 'resource_delete'] as const;
const ObjectIdentitySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const ResourceLifecycleReceiptSchema = z.strictObject({
  schema: z.literal('raibitserver.resource-lifecycle/v1'), engine: z.enum(RESOURCE_LIFECYCLE_ENGINES),
  level: z.literal('L3'), provenance: z.enum(['credentialed', 'fixture']), identity: EvidenceIdentitySchema,
  providerImage: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/), namespace: DnsLabelSchema,
  objects: z.strictObject({
    workloadUid: ObjectIdentitySchema, podUid: ObjectIdentitySchema, pvcUid: ObjectIdentitySchema, secretUid: ObjectIdentitySchema,
    secretName: DnsLabelSchema, secretImmutable: z.literal(true), storageBound: z.literal(true), workloadReady: z.literal(true),
  }).readonly(),
  attachment: z.strictObject({
    id: ObjectIdentitySchema, serviceId: ObjectIdentitySchema, deploymentId: ObjectIdentitySchema, namespace: DnsLabelSchema, consumerPodUid: ObjectIdentitySchema,
    secretName: DnsLabelSchema, key: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/), secretUid: ObjectIdentitySchema,
  }).readonly(),
  native: z.strictObject({
    kind: z.literal('engine-native'), client: z.enum(['psql', 'mysql', 'mariadb', 'mongosh', 'redis-cli', 'valkey-cli']),
    namespace: DnsLabelSchema, consumerPodUid: ObjectIdentitySchema, secretUid: ObjectIdentitySchema,
    authenticated: z.literal(true), healthExitCode: z.literal(0), writeExitCode: z.literal(0), readExitCode: z.literal(0),
    nonce: z.uuidv4(), inputSha256: Sha256Schema, readSha256: Sha256Schema,
  }).readonly(),
  providerHealth: z.strictObject({
    kind: z.literal('engine-native'), client: z.enum(['psql', 'mysql', 'mariadb', 'mongosh', 'redis-cli', 'valkey-cli']),
    namespace: DnsLabelSchema, providerPodUid: ObjectIdentitySchema, secretUid: ObjectIdentitySchema,
    authenticated: z.literal(true), healthExitCode: z.literal(0),
  }).readonly(),
  times: z.strictObject({
    createdAt: z.iso.datetime(), providerHealthAt: z.iso.datetime(), readyAt: z.iso.datetime(), attachedAt: z.iso.datetime(), healthAt: z.iso.datetime(),
    sentinelAt: z.iso.datetime(), detachedAt: z.iso.datetime(), consumerRemovedAt: z.iso.datetime(),
    providerDeleteStartedAt: z.iso.datetime(), objectsDeletedAt: z.iso.datetime(), rowDeletedAt: z.iso.datetime(), cleanupAt: z.iso.datetime(),
  }).readonly(),
  deletion: z.strictObject({
    attachmentsRemaining: z.literal(0), injectedRefsRemaining: z.literal(0), consumerRemoved: z.literal(true),
    providerObjectsRemaining: z.literal(0), resourceRowsRemaining: z.literal(0),
  }).readonly(),
  cleanup: EvidenceStatusSchema,
}).readonly();
export const SqliteLifecycleReceiptSchema = z.strictObject({
  schema: z.literal('raibitserver.sqlite-lifecycle/v1'), engine: z.literal('sqlite'), level: z.literal('L1'), provenance: z.literal('local'),
  identity: EvidenceIdentitySchema, databaseId: z.uuidv4(), inputSha256: Sha256Schema, readSha256: Sha256Schema,
  times: z.strictObject({ createdAt: z.iso.datetime(), writtenAt: z.iso.datetime(), readAt: z.iso.datetime(), removedAt: z.iso.datetime() }).readonly(),
  writeCount: z.literal(1), readCount: z.literal(1), cleanup: EvidenceStatusSchema, fileRemoved: z.literal(true),
}).readonly();
export type ResourceLifecycleReceipt = z.infer<typeof ResourceLifecycleReceiptSchema>;
export type SqliteLifecycleReceipt = z.infer<typeof SqliteLifecycleReceiptSchema>;
