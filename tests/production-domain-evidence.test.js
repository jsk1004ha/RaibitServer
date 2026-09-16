import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { verifyEvidenceFile } from '../scripts/verify-production-evidence.mjs';
import { digest, loadOperatorContract, OPERATOR_CONTRACT_DIGEST, APPROVED_INPUT_SHA256 } from '../scripts/production-evidence/lib/operator-inputs.mjs';
import {
  parseDomainArguments,
  parseDomainFaultMatrix,
  runDomainEvidence,
} from '../scripts/production-evidence/lib/domain-runner.mjs';
import {
  createCloudflareFixtureDnsAdapter,
  parseDomainEvidenceInputs,
} from '../scripts/production-evidence/lib/cloudflare-domain-evidence.mjs';

const contract = await loadOperatorContract();
function inputs() {
  const values = ['fixture-context', 'fixture-prefix', 'apps.example.test', 'registry.example/fixture', 'fixture/repository', '123', 'https://backup.example', 'fixture-backups'];
  return { schema: 'raibitserver.operator-input-values/v1', approvedInputSha256: APPROVED_INPUT_SHA256, operatorContractDigest: OPERATOR_CONTRACT_DIGEST,
    selectors: Object.fromEntries(contract.selectors.map(({ name }, index) => [name, values[index]])),
    secretRefs: contract.secretBindings.map(({ role, binding, kind, keyFields }) => kind === 'helm-existingSecret'
      ? { role, binding, kind, namespace: 'fixture-system', existingSecret: `fixture-${role}`, keys: Object.values(keyFields).length ? Object.values(keyFields) : ['fixture-key'] }
      : { role, binding, kind, namespace: 'fixture-system', secretKeyRef: { name: `fixture-${role}`, key: 'fixture-key', optional: false } }) };
}
async function sandbox(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'raibit-domain-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const validProof = () => ({
  schema: 'raibitserver.production-domain-proof/v1', fixtureZone: 'domains-fixture.example.test', hostname: 'run-123.domains-fixture.example.test',
  domainId: 'domain-1', organizationId: 'org-1', projectId: 'project-1', serviceId: 'service-1', deploymentId: 'deployment-1',
  verificationVersion: 2, desiredGeneration: 2, controllerLeaseGeneration: 7,
  ownership: { externalRecursive: true, authoritative: true, version: 2 },
  resolution: { addresses: ['203.0.113.10'], reboundAddresses: ['203.0.113.10'], stable: true },
  certificate: { chainVerified: true, configuredIssuer: 'letsencrypt-production', issuer: 'letsencrypt-production', dnsNames: ['run-123.domains-fixture.example.test'] },
  https: { host: 'run-123.domains-fixture.example.test', servername: 'run-123.domains-fixture.example.test', statusCode: 200,
    responseMarkerSha256: 'a'.repeat(64), serviceId: 'service-1', deploymentId: 'deployment-1' },
  revalidation: { dailySimulationObserved: true, failuresObserved: 3, disabledAfterFailures: true, ownershipRecovered: true },
  cleanup: { txtAbsent: true, dnsAbsent: true, certificateAbsent: true, routeAbsent: true,
    generatedFallbackStatusCode: 200, generatedFallbackMarkerSha256: 'b'.repeat(64) },
});

test('production domain evidence happy path binds a fixture proof to one fresh identity but never makes it release eligible', async (t) => {
  const attemptDir = await sandbox(t); const now = new Date();
  const result = await runDomainEvidence({ profile: 'component', scenario: 'happy', faultCase: null, attemptDir, inputs: inputs(),
    fixture: true, clock: { now: () => now }, uuid: randomUUID, execute: async () => ({ status: 'PASS', reason: null, proof: validProof() }) });
  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  const verification = await verifyEvidenceFile(result.manifestPath, { fragment: 'domains', now: now.getTime() });
  assert.equal(manifest.fragments[0].identity.sourceCommitSha, manifest.identity.sourceCommitSha);
  assert.equal(manifest.fragments[0].identity.migrationDigest, manifest.identity.migrationDigest);
  assert.equal(manifest.fragments[0].domainProof.hostname, validProof().hostname);
  assert.equal(verification.valid, true);
  assert.equal(verification.releaseEligible, false);
  assert.equal(manifest.fixture, true);
  assert.equal(JSON.stringify(manifest).includes('challengeToken'), false);

  const finalResult = await runDomainEvidence({ profile: 'final', scenario: 'happy', faultCase: null, attemptDir, inputs: inputs(),
    fixture: true, clock: { now: () => now }, uuid: randomUUID, execute: async () => ({ status: 'PASS', reason: null, proof: validProof() }) });
  const finalVerification = await verifyEvidenceFile(finalResult.manifestPath, { fragment: 'domains', profile: 'final', now: now.getTime() });
  assert.equal(finalVerification.valid, true);
  assert.equal(finalVerification.releaseEligible, false);
  assert.notEqual(finalResult.runId, result.runId);
});

test('production domain evidence adversarial matrix is strict and every declared takeover boundary stays ineligible with cleanup', async (t) => {
  const matrix = parseDomainFaultMatrix(JSON.parse(await readFile('test-fixtures/production-evidence/domain-fault-matrix-v1.json', 'utf8')));
  assert.equal(matrix.cases.length, 7);
  for (const faultCase of matrix.cases) {
    const attemptDir = await sandbox(t);
    const result = await runDomainEvidence({ profile: 'component', scenario: null, faultCase, attemptDir, inputs: inputs(), fixture: true,
      clock: { now: () => new Date() }, uuid: randomUUID,
      execute: async () => ({ status: faultCase.id === 'cleanup-failure' ? 'FAIL' : 'NOT_RUN', reason: faultCase.expectedReason, proof: null }) });
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    assert.equal(result.releaseEligible, false);
    assert.equal(result.reason, faultCase.expectedReason);
    assert.equal(manifest.cleanup.status, 'PASS');
    assert.equal(existsSync(path.join(result.runDirectory, 'cleanup', 'domains.json')), true);
    assert.equal(JSON.stringify(manifest).includes('challengeToken'), false);
  }
});

test('production domain evidence without an approved fixture-zone/provider contract is NOT_RUN before provider mutation', async (t) => {
  const attemptDir = await sandbox(t); let calls = 0;
  const result = await runDomainEvidence({ profile: 'final', scenario: 'happy', faultCase: null, attemptDir, inputs: inputs(), fixture: false,
    clock: { now: () => new Date() }, uuid: randomUUID, execute: async () => { calls++; return { status: 'PASS', reason: null, proof: validProof() }; } });
  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  assert.equal(calls, 0);
  assert.equal(result.status, 'NOT_RUN');
  assert.equal(result.reason, 'domain_provider_contract_unavailable');
  assert.equal(result.releaseEligible, false);
  assert.equal(manifest.preflight.status, 'NOT_RUN');
  assert.equal(manifest.cleanup.status, 'PASS');
});

test('production domain evidence public arguments accept component and final only and prohibit mixed scenario modes', () => {
  const attempt = path.resolve('attempt');
  assert.deepEqual(parseDomainArguments(['--profile', 'component', '--scenario', 'happy', '--attempt-dir', attempt]), { profile: 'component', attemptDir: attempt, scenario: 'happy', faultPath: undefined });
  assert.deepEqual(parseDomainArguments(['--profile', 'final', '--fault-matrix', path.resolve('fault.json'), '--attempt-dir', attempt]), { profile: 'final', attemptDir: attempt, scenario: undefined, faultPath: path.resolve('fault.json') });
  for (const args of [
    ['--profile', 'train-a', '--scenario', 'happy', '--attempt-dir', attempt],
    ['--profile', 'component', '--scenario', 'happy', '--fault-matrix', path.resolve('fault.json'), '--attempt-dir', attempt],
    ['--profile', 'component', '--unknown', 'x', '--attempt-dir', attempt],
  ]) assert.throws(() => parseDomainArguments(args));
});

test('production domain evidence shell entrypoint disabled gate performs no attempt I/O', async (t) => {
  const parent = await sandbox(t); const attempt = path.join(parent, 'not-created'); const environment = { ...process.env };
  delete environment.RAIBITSERVER_PRODUCTION_EVIDENCE;
  await assert.rejects(promisify(execFile)('bash', ['scripts/production-evidence/domains.sh', '--profile', 'component', '--scenario', 'happy', '--attempt-dir', attempt],
    { env: environment, timeout: 10_000 }), (error) => {
    assert.equal(error.code, 1);
    assert.deepEqual(JSON.parse(error.stdout), { status: 'NOT_RUN', releaseEligible: false, reason: 'production_evidence_not_enabled' });
    return true;
  });
  assert.equal(existsSync(attempt), false);
});

test('production domain extension and Cloudflare adapter fence every mutation to one dedicated zone and run-owned record', async () => {
  const extension = parseDomainEvidenceInputs({ schema: 'raibitserver.production-domain-inputs/v1', approvedInputSha256: APPROVED_INPUT_SHA256,
    provider: 'cloudflare', fixtureZone: 'domains-fixture.example.test', zoneId: '1'.repeat(32), expectedClusterIssuer: 'letsencrypt-production',
    hostname: 'run-123.domains-fixture.example.test', projectId: 'project-1', serviceId: 'service-1', deploymentId: 'deployment-1',
    generatedFallbackUrl: 'https://apps--org--project.apps.example.test', expectedResponseMarkerSha256: 'a'.repeat(64),
    tokenSecretRef: { namespace: 'fixture-system', name: 'cloudflare-domain-evidence', key: 'api-token' } }, 'apps.example.test');
  const calls = [];
  const adapter = createCloudflareFixtureDnsAdapter({ extension, apiToken: 'fixture-api-value', request: async (request) => {
    calls.push(request);
    if (request.method === 'POST') return { success: true, result: { id: '2'.repeat(32), name: `_raibit-challenge.${extension.hostname}`, type: 'TXT', content: request.body.content } };
    if (request.method === 'GET') return { success: true, result: { id: '2'.repeat(32), name: `_raibit-challenge.${extension.hostname}`, type: 'TXT', content: 'raibit-verification=one-time' } };
    return { success: true, result: { id: '2'.repeat(32) } };
  } });
  const record = await adapter.createTxt({ hostname: extension.hostname, content: 'raibit-verification=one-time', runId: 'run-1' });
  await adapter.readTxt({ hostname: extension.hostname, recordId: record.recordId });
  await adapter.deleteTxt({ hostname: extension.hostname, recordId: record.recordId });
  assert.deepEqual(calls.map(({ method, url }) => [method, url]), [
    ['POST', `https://api.cloudflare.com/client/v4/zones/${extension.zoneId}/dns_records`],
    ['GET', `https://api.cloudflare.com/client/v4/zones/${extension.zoneId}/dns_records/${record.recordId}`],
    ['DELETE', `https://api.cloudflare.com/client/v4/zones/${extension.zoneId}/dns_records/${record.recordId}`],
  ]);
  await assert.rejects(adapter.createTxt({ hostname: 'outside.example.test', content: 'raibit-verification=no', runId: 'run-1' }), { reason: 'fixture_zone_escape' });
  await assert.rejects(adapter.deleteTxt({ hostname: extension.hostname, recordId: '3'.repeat(32) }), { reason: 'dns_record_not_owned' });
});

test('production domain input extension digest is bound into the run identity and proof', async (t) => {
  const extension = parseDomainEvidenceInputs({ schema: 'raibitserver.production-domain-inputs/v1', approvedInputSha256: APPROVED_INPUT_SHA256,
    provider: 'cloudflare', fixtureZone: 'domains-fixture.example.test', zoneId: '1'.repeat(32), expectedClusterIssuer: 'letsencrypt-production',
    hostname: validProof().hostname, projectId: 'project-1', serviceId: 'service-1', deploymentId: 'deployment-1',
    generatedFallbackUrl: 'https://apps--org--project.apps.example.test', expectedResponseMarkerSha256: 'a'.repeat(64),
    tokenSecretRef: { namespace: 'fixture-system', name: 'cloudflare-domain-evidence', key: 'api-token' } }, 'apps.example.test');
  const result = await runDomainEvidence({ profile: 'component', scenario: 'happy', faultCase: null, attemptDir: await sandbox(t), inputs: inputs(),
    fixture: true, clock: { now: () => new Date() }, uuid: randomUUID, extension,
    execute: async () => ({ status: 'PASS', reason: null, proof: validProof() }) });
  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  assert.equal(manifest.identity.domainInputDigest, digest(extension));
  assert.equal(manifest.fragments[0].domainProof.domainInputDigest, digest(extension));
  assert.notEqual(manifest.identity.environmentFingerprint, '');
});
