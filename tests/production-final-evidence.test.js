import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProductionEvidence } from '../scripts/production-evidence/lib/orchestrator.mjs';
import { APPROVED_INPUT_SHA256, OPERATOR_CONTRACT_DIGEST, digest, loadOperatorContract } from '../scripts/production-evidence/lib/operator-inputs.mjs';
import { FINAL_STEP_NAMES, STEP_ASSERTIONS, STEP_NAMES, stepNamesForIdentity } from '../scripts/production-evidence/lib/step-contract.mjs';

const contract = await loadOperatorContract();
function inputs() {
  const values = ['fixture-context', 'fixture-prefix', 'apps.example.test', 'registry.example/fixture', 'fixture/repository', '123', 'https://backup.example', 'fixture-backups'];
  return { schema: 'raibitserver.operator-input-values/v1', approvedInputSha256: APPROVED_INPUT_SHA256, operatorContractDigest: OPERATOR_CONTRACT_DIGEST,
    selectors: Object.fromEntries(contract.selectors.map(({ name }, index) => [name, values[index]])),
    secretRefs: contract.secretBindings.map(({ role, binding, kind, keyFields }) => kind === 'helm-existingSecret'
      ? { role, binding, kind, namespace: 'fixture-system', existingSecret: `fixture-${role}`, keys: Object.values(keyFields).length ? Object.values(keyFields) : ['fixture-key'] }
      : { role, binding, kind, namespace: 'fixture-system', secretKeyRef: { name: `fixture-${role}`, key: 'fixture-key', optional: false } }) };
}
const domainInputs = Object.freeze({ schema: 'raibitserver.production-domain-inputs/v1', approvedInputSha256: APPROVED_INPUT_SHA256,
  provider: 'cloudflare', fixtureZone: 'domains-fixture.example.test', zoneId: '1'.repeat(32), expectedClusterIssuer: 'letsencrypt-production',
  hostname: 'run-123.domains-fixture.example.test', projectId: 'project-1', serviceId: 'service-1', deploymentId: 'deployment-1',
  generatedFallbackUrl: 'https://apps--org--project.apps.example.test', expectedResponseMarkerSha256: 'a'.repeat(64),
  tokenSecretRef: { namespace: 'fixture-system', name: 'cloudflare-domain-evidence', key: 'api-token' } });

function domainProof(domainInputDigest) {
  return { schema: 'raibitserver.production-domain-proof/v1', domainInputDigest,
    fixtureZone: domainInputs.fixtureZone, hostname: domainInputs.hostname, domainId: 'domain-1', organizationId: 'org-1',
    projectId: domainInputs.projectId, serviceId: domainInputs.serviceId, deploymentId: domainInputs.deploymentId,
    verificationVersion: 2, desiredGeneration: 2, controllerLeaseGeneration: 7,
    ownership: { externalRecursive: true, authoritative: true, version: 2 },
    resolution: { addresses: ['203.0.113.10'], reboundAddresses: ['203.0.113.10'], stable: true },
    certificate: { chainVerified: true, configuredIssuer: domainInputs.expectedClusterIssuer, issuer: domainInputs.expectedClusterIssuer, dnsNames: [domainInputs.hostname] },
    https: { host: domainInputs.hostname, servername: domainInputs.hostname, statusCode: 200, responseMarkerSha256: 'a'.repeat(64), serviceId: domainInputs.serviceId, deploymentId: domainInputs.deploymentId },
    revalidation: { dailySimulationObserved: true, failuresObserved: 3, disabledAfterFailures: true, ownershipRecovered: true },
    cleanup: { txtAbsent: true, dnsAbsent: true, certificateAbsent: true, routeAbsent: true, generatedFallbackStatusCode: 200, generatedFallbackMarkerSha256: 'b'.repeat(64) } };
}

async function pass(request, context) {
  const component = request.step === 'cleanup' ? 'cleanup' : request.step === 'domains' ? 'domains'
    : ['resources', 'backup-sql', 'backup-nosql'].includes(request.step) ? 'resources'
      : request.step === 'rollback' ? 'operations' : 'lifecycle';
  const artifact = await context.writeArtifact(component, `${request.step}-observation.json`,
    { schema: 'raibitserver.final-profile-fixture/v1', step: request.step, status: 'PASS', redacted: true, fixture: true });
  return { status: 'PASS', reason: null,
    assertions: STEP_ASSERTIONS[request.step].map((id) => ({ id, status: 'PASS', artifactPaths: [artifact.path] })),
    artifacts: [artifact], cleanupInventory: [],
    ...(request.step === 'domains' ? { domainProof: domainProof(request.identity.domainInputDigest) } : {}) };
}

test('final profile inserts one fixed domains step before cleanup and binds its proof to the extension digest', async (t) => {
  const attemptDir = await mkdtemp(path.join(tmpdir(), 'raibit-final-profile-'));
  t.after(() => rm(attemptDir, { recursive: true, force: true }));
  const result = await runProductionEvidence({ profile: 'final', scenario: 'happy', faultMatrix: null, attemptDir, inputs: inputs(),
    domainInputs, executeStep: pass, clock: { now: () => new Date() }, uuid: randomUUID, fixture: true });
  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  assert.deepEqual(FINAL_STEP_NAMES, [...STEP_NAMES.slice(0, -1), 'domains', 'cleanup']);
  assert.deepEqual(stepNamesForIdentity(manifest.identity), FINAL_STEP_NAMES);
  assert.equal(manifest.profile, 'final');
  assert.equal(manifest.identity.domainInputDigest, digest(domainInputs));
  assert.equal(manifest.fragments.find(({ component }) => component === 'domains').domainProof.domainInputDigest, digest(domainInputs));
  assert.equal(existsSync(path.join(result.runDirectory, 'receipts', '000010--domains.json')), true);
  assert.equal(existsSync(path.join(result.runDirectory, 'receipts', '000011--cleanup.json')), true);
  assert.equal(result.verification.releaseEligible, false);
});

test('final profile rejects a missing domain extension while train-a retains its ten-step identity', async () => {
  assert.deepEqual(stepNamesForIdentity({}), STEP_NAMES);
  await assert.rejects(runProductionEvidence({ profile: 'final', scenario: 'happy', faultMatrix: null,
    attemptDir: path.resolve('attempt'), inputs: inputs(), executeStep: null, clock: { now: () => new Date() }, uuid: randomUUID, fixture: false }),
  { reason: 'invalid_arguments' });
});
