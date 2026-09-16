import crypto from 'node:crypto';
import {
  EnvironmentWriterIntentSchema,
  NotificationWriterIntentSchema,
  OperationalFeaturesContractSchema,
  OperationalReadinessSchema,
  OperationalSha256Schema,
  OperationalSourceRevisionSchema,
  ScheduledRecoveryWriterIntentSchema,
  StorageWriterIntentSchema,
  TemplateWriterIntentSchema,
  type NotificationWriterIntent,
  type OperationalFeature,
  type OperationalFeaturesContract,
  type OperationalSha256,
  type OperationalSourceRevision,
  type OperationalWriterIntent,
} from '@raibitserver/schemas/operational';

export type OperationalContractErrorCode =
  | 'INVALID_CONTRACT'
  | 'INVALID_WRITER_INTENT'
  | 'INVALID_RUNTIME_CONFIG'
  | 'ACTIVATION_DISABLED'
  | 'READINESS_MISMATCH';

export class OperationalContractError extends Error {
  readonly name = 'OperationalContractError';
  readonly code: OperationalContractErrorCode;
  readonly details: readonly string[];

  constructor(
    code: OperationalContractErrorCode,
    details: readonly string[] = [],
  ) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

export type OperationalRuntimeConfig = {
  readonly contractSupport: true;
  readonly implementationAvailable: boolean;
  readonly productionActivation: boolean;
  readonly protocolVersion: 2;
  readonly contractDigest: OperationalSha256 | null;
  readonly releaseIdentity: { readonly revision: OperationalSourceRevision; readonly clean: true } | null;
};

export function parseOperationalFeaturesContract(input: unknown): OperationalFeaturesContract {
  const result = OperationalFeaturesContractSchema.safeParse(input);
  if (!result.success) {
    throw new OperationalContractError('INVALID_CONTRACT', result.error.issues.map((issue) => `${issue.path.join('.')}:${issue.code}`));
  }
  return result.data;
}

export function parseOperationalWriterIntent(feature: OperationalFeature, input: unknown): OperationalWriterIntent {
  switch (feature) {
    case 'templates': return parseWriter(TemplateWriterIntentSchema, input);
    case 'notifications': return parseWriter(NotificationWriterIntentSchema, input);
    case 'storage': return parseWriter(StorageWriterIntentSchema, input);
    case 'scheduledRecovery': return parseWriter(ScheduledRecoveryWriterIntentSchema, input);
    case 'environments': return parseWriter(EnvironmentWriterIntentSchema, input);
    default: return assertNever(feature);
  }
}

export function notificationSemanticKey(intent: NotificationWriterIntent): string {
  return [intent.destinationId, intent.destinationVersion, intent.eventCode, intent.subjectId, intent.subjectGenerationOrIncidentSequence].join(':');
}

export function operationalContractDigest(contract: OperationalFeaturesContract) {
  return OperationalSha256Schema.parse(crypto.createHash('sha256').update(canonicalJson(contract)).digest('hex'));
}

export function parseOperationalRuntimeConfig(env: Readonly<Record<string, string | undefined>> = process.env): OperationalRuntimeConfig {
  const activationValue = env.RAIBITSERVER_OPERATIONAL_FEATURES_ENABLED;
  if (activationValue !== undefined && activationValue !== '0' && activationValue !== '1') {
    throw new OperationalContractError('INVALID_RUNTIME_CONFIG', ['RAIBITSERVER_OPERATIONAL_FEATURES_ENABLED']);
  }
  const productionActivation = activationValue === '1';
  const availabilityValue = env.RAIBITSERVER_OPERATIONAL_IMPLEMENTATION_AVAILABLE;
  if (availabilityValue !== undefined && availabilityValue !== '0' && availabilityValue !== '1') {
    throw new OperationalContractError('INVALID_RUNTIME_CONFIG', ['RAIBITSERVER_OPERATIONAL_IMPLEMENTATION_AVAILABLE']);
  }
  const implementationAvailable = availabilityValue === '1';
  if (productionActivation && (!implementationAvailable || env.RAIBITSERVER_OPERATIONAL_PROTOCOL_VERSION !== '2')) {
    throw new OperationalContractError('INVALID_RUNTIME_CONFIG', ['RAIBITSERVER_OPERATIONAL_PROTOCOL_VERSION']);
  }
  const contractDigest = productionActivation
    ? OperationalSha256Schema.safeParse(env.RAIBITSERVER_OPERATIONAL_CONTRACT_DIGEST)
    : null;
  if (contractDigest && !contractDigest.success) {
    throw new OperationalContractError('INVALID_RUNTIME_CONFIG', ['RAIBITSERVER_OPERATIONAL_CONTRACT_DIGEST']);
  }
  const releaseRevision = productionActivation
    ? OperationalSourceRevisionSchema.safeParse(env.RAIBITSERVER_RELEASE_REVISION)
    : null;
  if (releaseRevision && (!releaseRevision.success || env.RAIBITSERVER_RELEASE_SOURCE_CLEAN !== '1')) {
    throw new OperationalContractError('INVALID_RUNTIME_CONFIG', ['RAIBITSERVER_RELEASE_REVISION', 'RAIBITSERVER_RELEASE_SOURCE_CLEAN']);
  }
  return Object.freeze({
    contractSupport: true,
    implementationAvailable,
    productionActivation,
    protocolVersion: 2,
    contractDigest: contractDigest?.data ?? null,
    releaseIdentity: releaseRevision?.success ? Object.freeze({ revision: releaseRevision.data, clean: true as const }) : null,
  });
}

export function assertOperationalWriterReady(contract: OperationalFeaturesContract, runtimeConfig: OperationalRuntimeConfig, input: unknown) {
  const readinessResult = OperationalReadinessSchema.safeParse(input);
  if (!readinessResult.success) {
    throw new OperationalContractError('READINESS_MISMATCH', readinessResult.error.issues.map((issue) => issue.path.join('.')));
  }
  const readiness = readinessResult.data;
  if (!runtimeConfig.productionActivation || !runtimeConfig.implementationAvailable || !runtimeConfig.releaseIdentity) {
    throw new OperationalContractError('ACTIVATION_DISABLED');
  }
  const expectedDigest = operationalContractDigest(contract);
  const releaseRevision = runtimeConfig.releaseIdentity.revision;
  const mismatch = runtimeConfig.contractDigest !== expectedDigest
    || readiness.contractDigest !== expectedDigest
    || readiness.components.some((component) => component.contractDigest !== expectedDigest || component.releaseRevision !== releaseRevision);
  if (mismatch) throw new OperationalContractError('READINESS_MISMATCH');
  return Object.freeze({ productionActivation: true, protocolVersion: 2, contractDigest: expectedDigest });
}

export function operationalIdentityProjection(contract: OperationalFeaturesContract) {
  return Object.freeze({
    approvalBaselineRevision: contract.approvalBaselineRevision,
    environment: contract.environment.bindingIdentity,
    catalogs: contract.features.templates.catalogs.map(({ id, version, catalogDigest, sourceDigest }) => ({ id, version, catalogDigest, sourceDigest })),
    storageEndpointSource: contract.features.storage.endpointSource,
    scheduledRetention: contract.features.scheduledRecovery.scheduledRetention,
    promotionCopies: contract.features.environments.promotion,
  });
}

function parseWriter<T>(schema: { readonly safeParse: (value: unknown) => { readonly success: true; readonly data: T } | { readonly success: false; readonly error: { readonly issues: readonly { readonly path: readonly PropertyKey[] }[] } } }, input: unknown): T {
  const result = schema.safeParse(input);
  if ('error' in result) {
    throw new OperationalContractError('INVALID_WRITER_INTENT', result.error.issues.map((issue) => issue.path.join('.')));
  }
  return result.data;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  throw new OperationalContractError('INVALID_CONTRACT', ['unsupported-value']);
}

function assertNever(value: never): never {
  throw new OperationalContractError('INVALID_WRITER_INTENT', [String(value)]);
}
