import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertDedicatedFixtureHostname,
  validateDomainProof,
} from '../scripts/production-evidence/lib/domain-runner.mjs';

const proof = () => ({
  schema: 'raibitserver.production-domain-proof/v1',
  fixtureZone: 'domains-fixture.example.test',
  hostname: 'run-123.domains-fixture.example.test',
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

test('custom domain evidence happy path accepts only an exact dedicated-zone lifecycle proof', () => {
  assert.equal(assertDedicatedFixtureHostname(proof().hostname, proof().fixtureZone, 'apps.example.test'), proof().hostname);
  assert.deepEqual(validateDomainProof(proof(), { baseDomain: 'apps.example.test' }), proof());
});

test('custom domain evidence adversarial matrix rejects zone escape and forged DNS TLS route generation or cleanup observations', () => {
  const invalidHosts = ['domains-fixture.example.test', 'outside.example.test', '*.domains-fixture.example.test', '127.0.0.1'];
  for (const hostname of invalidHosts) assert.throws(() => assertDedicatedFixtureHostname(hostname, proof().fixtureZone, 'apps.example.test'));
  assert.throws(() => assertDedicatedFixtureHostname(proof().hostname, 'example.test', 'apps.example.test'));

  const mutations = [
    (value) => { value.resolution.stable = false; },
    (value) => { value.resolution.addresses = ['127.0.0.1']; },
    (value) => { value.certificate.dnsNames = ['*.domains-fixture.example.test']; },
    (value) => { value.certificate.issuer = 'foreign-issuer'; },
    (value) => { value.https.servername = 'outside.example.test'; },
    (value) => { value.https.serviceId = 'foreign-service'; },
    (value) => { value.ownership.version = 1; },
    (value) => { value.revalidation.failuresObserved = 2; },
    (value) => { value.cleanup.routeAbsent = false; },
  ];
  for (const mutate of mutations) {
    const value = proof(); mutate(value);
    assert.throws(() => validateDomainProof(value, { baseDomain: 'apps.example.test' }));
  }
});

test('custom domain evidence rejects raw challenge material instead of serializing it', () => {
  assert.throws(() => validateDomainProof({ ...proof(), challengeToken: 'x'.repeat(43) }, { baseDomain: 'apps.example.test' }));
});
