import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const rootLockUrl = new URL('../../test-fixtures/contracts/object-storage-provider-lock.json', import.meta.url);
const helmLockUrl = new URL('../../infra/helm/raibitserver/files/object-storage-provider-lock.json', import.meta.url);
const helmTemplateUrl = new URL('../../infra/helm/raibitserver/templates/object-storage-provider-lock.yaml', import.meta.url);

test('happy: packaged SeaweedFS provenance is immutable and honest about later gates', async () => {
  // Given
  const lock = JSON.parse(await readFile(rootLockUrl, 'utf8'));

  // When
  const image = lock.artifact.image;

  // Then
  assert.equal(lock.schemaVersion, 1);
  assert.equal(lock.provider, 'seaweedfs');
  assert.equal(lock.release.version, '4.46');
  assert.equal(lock.release.sourceCommit, 'd997fba1575583a89cf0cc50dc0150642286c86d');
  assert.equal(lock.artifact.ociIndexDigest, 'sha256:08d516132314207d10c8e37cbffc1f32b147d870169688734cc61c6231625b62');
  assert.equal(lock.artifact.platforms['linux/amd64'], 'sha256:6a602956ac4915057199a5271343e9c86c403a561db7c21033362f6791aa29c9');
  assert.equal(image, 'chrislusf/seaweedfs@sha256:08d516132314207d10c8e37cbffc1f32b147d870169688734cc61c6231625b62');
  assert.equal(lock.conformance.packageRender, true);
  assert.equal(lock.conformance.runtimeAuthentication, false);
  assert.equal(lock.conformance.runtimeNetworkIsolation, false);
  assert.equal(lock.conformance.hardByteQuota, false);
  assert.equal(lock.conformance.providerAvailable, false);
  assert.equal(lock.runtimeContract.tenantPath, 'trusted-tls-admission-gateway-only');
  assert.equal(lock.runtimeContract.providerEndpoint, 'private-cluster-service');
  assert.equal(lock.runtimeContract.managementPortsExternallyExposed, false);
});

test('happy: Helm packages the exact provider lock without activating storage', async () => {
  // Given
  const [rootLock, helmLock, template] = await Promise.all([
    readFile(rootLockUrl, 'utf8'),
    readFile(helmLockUrl, 'utf8'),
    readFile(helmTemplateUrl, 'utf8'),
  ]);

  // When/Then
  assert.equal(helmLock, rootLock);
  assert.match(template, /object-storage-provider-lock\.json/);
  assert.doesNotMatch(template, /providerAvailable:\s*true|enabled:\s*true/);
});

test('failure: mutable or misleading provider locks are rejected by the conformance predicate', async () => {
  // Given
  const valid = JSON.parse(await readFile(rootLockUrl, 'utf8'));
  const exactKeys = (value, expected) =>
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
  const conforms = (lock) =>
    exactKeys(lock, ['schemaVersion', 'provider', 'release', 'artifact', 'runtimeContract', 'conformance', 'quotaRisk']) &&
    exactKeys(lock.artifact, ['repository', 'image', 'ociIndexDigest', 'platforms', 'provenanceSource', 'resolvedAt']) &&
    exactKeys(lock.artifact.platforms, ['linux/amd64']) &&
    exactKeys(lock.conformance, ['packageRender', 'runtimeAuthentication', 'runtimeNetworkIsolation', 'hardByteQuota', 'providerAvailable']) &&
    lock.artifact.image === 'chrislusf/seaweedfs@' + lock.artifact.ociIndexDigest &&
    !lock.artifact.image.includes(':latest') &&
    !lock.artifact.image.includes(':4.46@') &&
    lock.conformance.packageRender === true &&
    Object.values(lock.conformance).filter(Boolean).length === 1;

  // When/Then
  assert.equal(conforms(valid), true);
  assert.equal(conforms({ ...valid, artifact: { ...valid.artifact, image: 'chrislusf/seaweedfs:4.46' } }), false);
  assert.equal(conforms({ ...valid, conformance: { ...valid.conformance, providerAvailable: true } }), false);
  assert.equal(conforms({ ...valid, conformance: { ...valid.conformance, hardByteQuota: true } }), false);
  assert.equal(conforms({ ...valid, result: 'PASS' }), false);
  assert.equal(conforms({ ...valid, artifact: { ...valid.artifact, platforms: {} } }), false);
});
