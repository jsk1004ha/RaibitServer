import crypto from 'node:crypto';
import type { RecoveryBody, RecoveryProvenance, RecoveryResource, RecoverySpec, RecoveryJson } from './resource-recovery-types.ts';

export class RecoveryError extends Error {
  readonly name = 'RecoveryError';
  readonly code: string;
  readonly statusCode: 400 | 403 | 404 | 409;
  constructor(code: string, statusCode: 400 | 403 | 404 | 409 = 409) { super(code); this.code = code; this.statusCode = statusCode; }
}
export function recoveryRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RecoveryError('RECOVERY_INPUT_INVALID', 400);
  return Object.fromEntries(Object.entries(value));
}
export function recoveryBody(input: unknown, restore: boolean): RecoveryBody {
  const body = recoveryRecord(input);
  if (Object.keys(body).some(key => !['requestIdempotencyKey', 'formatVersion', ...(restore ? ['name'] : [])].includes(key)) ||
    typeof body.requestIdempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.requestIdempotencyKey) || body.formatVersion !== 1 ||
    (restore && (typeof body.name !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(body.name)))) throw new RecoveryError('RECOVERY_INPUT_INVALID', 400);
  return { requestIdempotencyKey: body.requestIdempotencyKey, formatVersion: 1, ...(typeof body.name === 'string' ? { name: body.name } : {}) };
}
export function canonicalRecoveryJson(value: RecoveryJson): string {
  if (Array.isArray(value)) return `[${value.map(canonicalRecoveryJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalRecoveryJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function recoveryHash(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
export function recoverySegment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new RecoveryError('RECOVERY_ID_INVALID', 400);
  return value;
}
export function recoveryObjectKey(identity: { readonly organizationId: string; readonly resourceId: string; readonly id: string }, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 3) throw new RecoveryError('RECOVERY_ATTEMPT_INVALID');
  return `organizations/${recoverySegment(identity.organizationId)}/resources/${recoverySegment(identity.resourceId)}/backups/${recoverySegment(identity.id)}/attempts/${attempt}/artifact.v1`;
}
export function captureRecoveryProvenance(resource: RecoveryResource): { readonly sourceSpec: RecoverySpec; readonly sourceProvenance: RecoveryProvenance; readonly sourceGeneration: string } {
  const state = resource.desiredState;
  let image: Readonly<Record<string, unknown>>;
  let identity: Readonly<Record<string, unknown>>;
  try { image = recoveryRecord(state.providerImageProvenance); identity = recoveryRecord(state.providerIdentity); }
  catch (error) { if (error instanceof RecoveryError) throw new RecoveryError('SOURCE_IMAGE_PROVENANCE_UNAVAILABLE'); throw error; }
  if (image.schema !== 'raibitserver.provider-image/v1' || typeof image.image !== 'string' ||
    !/^[a-z0-9][a-z0-9./_:-]*@sha256:[0-9a-f]{64}$/.test(image.image) || /@sha256:0{64}$/.test(image.image) ||
    typeof image.workloadUid !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(image.workloadUid) ||
    typeof image.workloadGeneration !== 'number' || !Number.isSafeInteger(image.workloadGeneration) || image.workloadGeneration < 1 ||
    typeof image.observedAt !== 'string' || !Number.isFinite(Date.parse(image.observedAt))) throw new RecoveryError('SOURCE_IMAGE_PROVENANCE_UNAVAILABLE');
  if (typeof identity.namespace !== 'string' || typeof identity.name !== 'string' ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(identity.namespace) || !/^[a-z0-9](?:[a-z0-9-]{0,50}[a-z0-9])?$/.test(identity.name) ||
    typeof state.credentialSecretUID !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(state.credentialSecretUID) ||
    typeof state.credentialSecretGeneration !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state.credentialSecretGeneration) ||
    resource.connectionSecretName !== `${identity.name}-connection`) throw new RecoveryError('SOURCE_PROVENANCE_UNAVAILABLE');
  const sourceProvenance: RecoveryProvenance = {
    providerImageProvenance: { schema: image.schema, image: image.image, workloadUid: image.workloadUid, workloadGeneration: image.workloadGeneration, observedAt: image.observedAt },
    providerIdentity: { namespace: identity.namespace, name: identity.name },
    credentialSecretUID: state.credentialSecretUID, credentialSecretGeneration: state.credentialSecretGeneration,
  };
  const desiredSpec = Object.fromEntries(Object.entries(resource.desiredSpec).filter(([key]) => ['storageMb', 'storageGb', 'databaseName', 'database', 'username', 'bucket', 'collection', 'topic'].includes(key)));
  const sourceSpec: RecoverySpec = { type: resource.type, plan: resource.plan, region: resource.region, version: resource.version ?? null, desiredSpec };
  const { observedAt: _observedAt, ...immutableImage } = sourceProvenance.providerImageProvenance;
  const hash = recoveryHash(canonicalRecoveryJson({ resourceId: resource.id, projectId: resource.projectId, engine: resource.engine, provider: resource.provider, sourceSpec, sourceProvenance: { ...sourceProvenance, providerImageProvenance: immutableImage } }));
  return { sourceSpec, sourceProvenance, sourceGeneration: `resource-incarnation/v1:sha256:${hash}` };
}
