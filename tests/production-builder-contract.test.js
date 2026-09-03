import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const helm = process.env.HELM_BINARY || 'helm';
const chart = 'infra/helm/raibitserver';
function render(settings) {
  return spawnSync(helm, ['template', 'policy-fixture', chart, '--namespace', 'platform',
    '--show-only', 'templates/builder-deployment.yaml',
    ...Object.entries(settings).flatMap(([key, value]) => ['--set-string', `${key}=${value}`])], { encoding: 'utf8', timeout: 30_000 });
}

test('builder public trust projection reuses only the same namespace admission key', () => {
  // Given / When.
  const result = render({ 'security.imageVerification.trustRoot.namespace': 'platform',
    'security.imageVerification.trustRoot.existingSecret': 'admission-trust',
    'security.imageVerification.trustRoot.key': 'approved.pub' });
  // Then: actual rendered executor mounts the selected key read-only.
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /name: RAIBITSERVER_VERIFICATION_KEY\s+value: \/var\/run\/secrets\/raibitserver\/verification\/cosign.pub/);
  assert.match(result.stdout, /name: verification-key, mountPath: \/var\/run\/secrets\/raibitserver\/verification, readOnly: true/);
  assert.match(result.stdout, /secretName: "admission-trust"\s+defaultMode: 0440\s+items:\s+- \{ key: "approved.pub", path: cosign.pub \}/);
});

test('builder foreign admission namespace requires explicit local projection', () => {
  // Given / When.
  const result = render({ 'security.imageVerification.trustRoot.namespace': 'admission',
    'security.imageVerification.trustRoot.existingSecret': 'admission-trust' });
  // Then.
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /explicit release-namespace public trust key Secret projection/);
});

test('builder explicit local projection preserves the separate admission reference', () => {
  // Given / When.
  const result = render({ 'security.imageVerification.trustRoot.namespace': 'admission',
    'security.imageVerification.trustRoot.existingSecret': 'remote-trust',
    'builder.verification.existingSecret': 'local-trust', 'builder.verification.key': 'local.pub' });
  // Then.
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /secretName: "local-trust"\s+defaultMode: 0440\s+items:\s+- \{ key: "local.pub", path: cosign.pub \}/);
  assert.doesNotMatch(result.stdout, /secretName: "remote-trust"/);
});

test('builder projection rejects an empty Secret data key', () => {
  // Given / When.
  const result = render({ 'builder.verification.existingSecret': 'local-trust', 'builder.verification.key': '' });
  // Then.
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /valid public trust Secret data key/);
});
