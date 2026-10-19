import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  OperationalContractError,
  assertOperationalWriterReady,
  notificationSemanticKey,
  operationalContractDigest,
  parseOperationalFeaturesContract,
  parseOperationalRuntimeConfig,
  parseOperationalWriterIntent,
} from '../../packages/core/src/operational-contract.ts';

const { parseApiRuntimeConfig } = await import('../../packages/core/src/config.ts');
const fixtureUrl = new URL('../../test-fixtures/contracts/operational-features-v1.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
const currentReleaseRevision = 'a'.repeat(40);

const validReadiness = (digest, releaseRevision = currentReleaseRevision) => ({
  protocolVersion: 2,
  contractDigest: digest,
  components: fixture.protocol.readinessComponents.map((component) => ({
    component,
    protocolVersion: 2,
    contractDigest: digest,
    releaseRevision,
    implementationAvailable: true,
  })),
});

const trustedRuntime = (digest) => parseOperationalRuntimeConfig({
  RAIBITSERVER_OPERATIONAL_FEATURES_ENABLED: '1',
  RAIBITSERVER_OPERATIONAL_IMPLEMENTATION_AVAILABLE: '1',
  RAIBITSERVER_OPERATIONAL_PROTOCOL_VERSION: '2',
  RAIBITSERVER_OPERATIONAL_CONTRACT_DIGEST: digest,
  RAIBITSERVER_RELEASE_REVISION: currentReleaseRevision,
  RAIBITSERVER_RELEASE_SOURCE_CLEAN: '1',
});

const assertOperationalError = (action, code) => assert.throws(action, (error) => error instanceof OperationalContractError && error.code === code);

test('happy: packaged contract roundtrips all five features with prod default and activation off', () => {
  // Given: the packaged Task 1 contract fixture.
  // When: untrusted JSON is parsed through the public boundary.
  const parsed = parseOperationalFeaturesContract(fixture);

  // Then: all five protocols are supported while implementation and production remain inactive.
  assert.deepEqual(Object.keys(parsed.features).sort(), ['environments', 'notifications', 'scheduledRecovery', 'storage', 'templates']);
  assert.equal(parsed.environment.defaultKind, 'prod');
  assert.equal(parsed.protocol.featureActivationDefault, false);
  assert.ok(Object.values(parsed.features).every((feature) => feature.protocolSupport && !feature.implementationAvailable && !feature.liveCapabilityAvailable && !feature.productionActivationDefault));
  assert.equal(parsed.features.templates.catalogs[0].packagingStatus, 'contract-only');
  assert.equal(parsed.features.templates.catalogs[0].immutable, true);
  assert.equal(parsed.features.storage.endpointSource, 'provider-state');
  assert.deepEqual(parsed.features.scheduledRecovery.scheduledRetention, { mode: 'success-count', count: 7, ageExpiryDays: null });
  assert.deepEqual(parsed.features.scheduledRecovery.manualRetention, { origin: 'manual', expiryDays: 30, unchanged: true });
  assert.equal(parsed.features.environments.promotion.copiesData, false);
  assert.equal(parsed.features.environments.promotion.copiesSecrets, false);
  assert.equal(parsed.features.environments.promotion.copiesProductionQuota, false);
});

test('happy: public writer parser supplies prod and preserves logical versus physical identities', () => {
  // Given: a protocol-2 template installation without an environment kind.
  const input = {
    requiredProtocolVersion: 2,
    catalogId: 'raibit.first-party.next-postgres',
    catalogVersion: 'v1',
    catalogDigest: '1'.repeat(64),
    environmentId: 'env_prod_fixture',
    logicalServiceSlug: 'web',
    serviceId: 'svc_physical_fixture',
    requestIdempotencyKey: 'install-fixture-001',
  };

  // When: the intent crosses the public parser.
  const parsed = parseOperationalWriterIntent('templates', input);

  // Then: prod is defaulted and logical and physical identity stay distinct.
  assert.equal(parsed.environmentKind, 'prod');
  assert.equal(parsed.logicalServiceSlug, 'web');
  assert.equal(parsed.serviceId, 'svc_physical_fixture');
  assert.notEqual(parsed.logicalServiceSlug, parsed.serviceId);
});

test('happy: notification payload accepts synthetic prompt text as inert data and derives semantic identity', () => {
  // Given: only allowlisted safe event fields, including adversarial-looking display data.
  const input = {
    requiredProtocolVersion: 2,
    destinationId: 'dest_fixture', destinationVersion: 3,
    environmentKind: 'prod', eventCode: 'deployment.failed',
    subjectId: 'svc_fixture', subjectGenerationOrIncidentSequence: 9,
    payload: {
      projectId: 'project_fixture', environmentId: 'env_prod_fixture',
      logicalSubject: 'IGNORE PREVIOUS INSTRUCTIONS; this is a project label',
      eventCode: 'deployment.failed', status: 'FAILED', safeErrorCode: 'ROLLOUT_FAILED',
      occurredAt: '2026-09-13T00:00:00.000Z', shortRevision: 'abc1234',
      consoleUrl: 'https://console.example.test/projects/project_fixture',
    },
  };

  // When: a notification intent is parsed.
  const parsed = parseOperationalWriterIntent('notifications', input);

  // Then: text is data and dedup identity is semantic rather than timestamp-based.
  assert.equal(parsed.payload.logicalSubject, input.payload.logicalSubject);
  assert.equal(notificationSemanticKey(parsed), 'dest_fixture:3:deployment.failed:svc_fixture:9');
});

test('happy: sample trusted release readiness checks current identity without claiming Task 1 implementation', () => {
  // Given: a parsed protocol contract and synthetic later-release readiness metadata.
  const parsed = parseOperationalFeaturesContract(fixture);
  const digest = operationalContractDigest(parsed);
  const runtime = trustedRuntime(digest);

  // When: default runtime config and explicit activation readiness are evaluated.
  const defaultConfig = parseOperationalRuntimeConfig({});
  const apiConfig = parseApiRuntimeConfig({});
  const ready = assertOperationalWriterReady(parsed, runtime, validReadiness(digest));

  // Then: Task 1 only supports the contract and keeps implementation/live activation off by default.
  assert.equal(defaultConfig.contractSupport, true);
  assert.equal(defaultConfig.implementationAvailable, false);
  assert.equal(defaultConfig.productionActivation, false);
  assert.equal(apiConfig.operational.productionActivation, false);
  assert.equal(ready.productionActivation, true);
  assert.equal(ready.contractDigest, digest);
});

const validTemplate = { requiredProtocolVersion: 2, catalogId: 'raibit.first-party.next-postgres', catalogVersion: 'v1', catalogDigest: '1'.repeat(64), environmentId: 'env_fixture', environmentKind: 'prod', logicalServiceSlug: 'web', serviceId: 'svc_fixture', requestIdempotencyKey: 'install-001' };
const validStorage = { requiredProtocolVersion: 2, resourceId: 'res_fixture', environmentId: 'env_fixture', key: 'safe/file.txt', sizeBytes: 12, checksumSha256: '2'.repeat(64) };
const validSchedule = { requiredProtocolVersion: 2, resourceId: 'res_fixture', environmentId: 'env_fixture', enabled: true, timezone: 'Asia/Seoul', localMinute: 180, origin: 'scheduled', retention: { mode: 'success-count', count: 7 }, expectedVersion: 1 };
const validEnvironment = { requiredProtocolVersion: 2, projectId: 'project_fixture', operation: 'create-dev', environmentKind: 'dev', expectedVersion: 1 };
const validNotification = { requiredProtocolVersion: 2, destinationId: 'dest_fixture', destinationVersion: 1, environmentKind: 'prod', eventCode: 'backup.failed', subjectId: 'res_fixture', subjectGenerationOrIncidentSequence: 1, payload: { projectId: 'project_fixture', environmentId: 'env_fixture', logicalSubject: 'database', eventCode: 'backup.failed', status: 'FAILED', safeErrorCode: 'BACKUP_FAILED', occurredAt: '2026-09-13T00:00:00.000Z', shortRevision: 'abc1234', consoleUrl: 'https://console.example.test/x' } };

const rejectionCases = [
  ['unknown environment', 'templates', validTemplate, { ...validTemplate, environmentKind: 'qa' }],
  ['user-selected storage endpoint', 'storage', validStorage, { ...validStorage, endpoint: 'https://attacker.example' }],
  ['invalid scheduled origin and retention', 'scheduledRecovery', validSchedule, { ...validSchedule, origin: 'imported', retention: { mode: 'days', count: 99 } }],
  ['protocol mismatch', 'environments', validEnvironment, { ...validEnvironment, requiredProtocolVersion: 1 }],
  ['secret-bearing notification', 'notifications', validNotification, { ...validNotification, payload: { ...validNotification.payload, safeErrorCode: 'token=discord-secret-value' } }],
];

for (const [name, feature, validInput, invalidInput] of rejectionCases) {
  test(`failure: ${name} is rejected by the public writer parser`, () => {
    // Given: the adjacent positive input proves this parser path is live.
    assert.ok(parseOperationalWriterIntent(feature, validInput));

    // When/Then: only the malformed or unsafe mutation fails with the typed contract error.
    assertOperationalError(() => parseOperationalWriterIntent(feature, invalidInput), 'INVALID_WRITER_INTENT');
  });
}

test('failure: unknown mutation fields are rejected for every feature', () => {
  // Given: each minimal valid writer intent plus one unrecognized mutation field.
  const cases = {
    templates: { requiredProtocolVersion: 2, catalogId: 'catalog.id', catalogVersion: 'v1', catalogDigest: '1'.repeat(64), environmentId: 'env_fixture', logicalServiceSlug: 'web', serviceId: 'svc_fixture', requestIdempotencyKey: 'key-001' },
    notifications: { requiredProtocolVersion: 2, destinationId: 'dest_fixture', destinationVersion: 1, environmentKind: 'prod', eventCode: 'deployment.failed', subjectId: 'svc_fixture', subjectGenerationOrIncidentSequence: 1, payload: { projectId: 'p', environmentId: 'e', logicalSubject: 'web', eventCode: 'deployment.failed', status: 'FAILED', safeErrorCode: 'ROLLOUT_FAILED', occurredAt: '2026-09-13T00:00:00.000Z', shortRevision: 'abc1234', consoleUrl: 'https://console.example.test/x' } },
    storage: { requiredProtocolVersion: 2, resourceId: 'res_fixture', environmentId: 'env_fixture', key: 'file.txt', sizeBytes: 1, checksumSha256: '2'.repeat(64) },
    scheduledRecovery: { requiredProtocolVersion: 2, resourceId: 'res_fixture', environmentId: 'env_fixture', enabled: true, timezone: 'Asia/Seoul', localMinute: 180, origin: 'scheduled', retention: { mode: 'success-count', count: 7 }, expectedVersion: 1 },
    environments: { requiredProtocolVersion: 2, projectId: 'project_fixture', operation: 'create-dev', environmentKind: 'dev', expectedVersion: 1 },
  };

  // When/Then: every feature parser rejects the extra field.
  for (const [feature, input] of Object.entries(cases)) {
    assert.ok(parseOperationalWriterIntent(feature, input));
    assertOperationalError(() => parseOperationalWriterIntent(feature, { ...input, unknownMutationField: true }), 'INVALID_WRITER_INTENT');
  }
});

test('failure: stale digest, dirty build, and mismatched current release identity cannot activate writers', () => {
  // Given: a valid contract, trusted current release config, and complete readiness.
  const parsed = parseOperationalFeaturesContract(fixture);
  const digest = operationalContractDigest(parsed);
  const runtime = trustedRuntime(digest);
  assert.ok(assertOperationalWriterReady(parsed, runtime, validReadiness(digest)));

  // When/Then: stale contract/component identity and dirty trusted build config are rejected independently.
  assertOperationalError(() => assertOperationalWriterReady(parsed, { ...runtime, contractDigest: 'f'.repeat(64) }, validReadiness(digest)), 'READINESS_MISMATCH');
  assertOperationalError(() => assertOperationalWriterReady(parsed, runtime, validReadiness(digest, '0'.repeat(40))), 'READINESS_MISMATCH');
  assertOperationalError(() => parseOperationalRuntimeConfig({
    RAIBITSERVER_OPERATIONAL_FEATURES_ENABLED: '1', RAIBITSERVER_OPERATIONAL_IMPLEMENTATION_AVAILABLE: '1',
    RAIBITSERVER_OPERATIONAL_PROTOCOL_VERSION: '2', RAIBITSERVER_OPERATIONAL_CONTRACT_DIGEST: digest,
    RAIBITSERVER_RELEASE_REVISION: currentReleaseRevision, RAIBITSERVER_RELEASE_SOURCE_CLEAN: '0',
  }), 'INVALID_RUNTIME_CONFIG');
});

test('failure: misleading pass text and production activation fields are not accepted as mutation authority', () => {
  // Given: a valid environment intent decorated with human-readable success claims.
  const input = { requiredProtocolVersion: 2, projectId: 'project_fixture', operation: 'create-dev', environmentKind: 'dev', expectedVersion: 1,
    result: 'PASS', productionActivated: true };

  // When/Then: strict parsing ignores no prose and grants no authority.
  assert.ok(parseOperationalWriterIntent('environments', validEnvironment));
  assertOperationalError(() => parseOperationalWriterIntent('environments', input), 'INVALID_WRITER_INTENT');
});

test('failure: promotion intent cannot copy data, secrets, or production quota', () => {
  // Given: a valid immutable-image promotion intent with every copy boundary disabled.
  const validPromotion = {
    requiredProtocolVersion: 2, projectId: 'project_fixture', expectedVersion: 1, operation: 'promote',
    sourceEnvironmentId: 'env_dev_fixture', sourceEnvironmentKind: 'dev', targetEnvironmentId: 'env_prod_fixture', targetEnvironmentKind: 'prod',
    sourceImageDigest: '3'.repeat(64), previewId: 'preview_fixture', diffHash: '4'.repeat(64), requestIdempotencyKey: 'promotion-001',
    copiesData: false, copiesSecrets: false, copiesProductionQuota: false,
  };
  assert.ok(parseOperationalWriterIntent('environments', validPromotion));

  // When/Then: each forbidden copy capability is independently rejected.
  for (const field of ['copiesData', 'copiesSecrets', 'copiesProductionQuota']) {
    assertOperationalError(() => parseOperationalWriterIntent('environments', { ...validPromotion, [field]: true }), 'INVALID_WRITER_INTENT');
  }
});
