import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parse } from 'yaml';

const source = readFileSync('infra/helm/raibitserver/templates/worker-security.yaml', 'utf8');
const fullname = 'raibitserver';
const identity = `system:serviceaccount:raibitserver-system:${fullname}-provisioner`;
function sourceDocument(name, kind) {
  return source.split(/^---$/m).find(doc => doc.includes(`kind: ${kind}\n`) &&
    doc.includes(`name: {{ include "raibitserver.fullname" . }}-${name}\n`));
}

test('tenant Secret RBAC cannot read an unrelated Secret, including matching reserved names', () => {
  const role = parse(sourceDocument('provisioner-tenant', 'ClusterRole').replaceAll('{{ include "raibitserver.fullname" . }}', fullname));
  for (const name of ['application-token', 'unowned-connection', `recovery-credential-${'a'.repeat(24)}`]) {
    for (const verb of ['get', 'list', 'watch']) {
      const allowed = role.rules.some(rule => rule.apiGroups.includes('') && rule.resources.includes('secrets') &&
        rule.verbs.includes(verb) && (!rule.resourceNames?.length || rule.resourceNames.includes(name)));
      assert.equal(allowed, false, `${verb} ${name} must remain denied by RBAC`);
    }
  }
});

test('worker mutation boundary is selected by identity alone and covers every tenant mutation kind', () => {
  const doc = sourceDocument('provisioner-mutation-boundary', 'ValidatingAdmissionPolicy');
  assert.ok(doc, 'an unconditional provisioner mutation boundary must deny arbitrary names');
  const conditions = doc.split('  matchConditions:')[1].split(/\n  (?:variables|validations):/)[0];
  assert.equal((conditions.match(/- name:/g) ?? []).length, 1);
  assert.match(conditions, /request\.userInfo\.username ==/);
  assert.doesNotMatch(conditions, /object|namespaceObject|startsWith|endsWith|&&|\|\|/);
  assert.doesNotMatch(doc, /objectSelector:|namespaceSelector:/);
  for (const resource of ['secrets', 'jobs', 'networkpolicies', 'services', 'persistentvolumeclaims', 'statefulsets']) {
    assert.ok(doc.includes(`"${resource}"`), resource);
  }
  const binding = sourceDocument('provisioner-mutation-boundary', 'ValidatingAdmissionPolicyBinding');
  assert.match(binding, /validationActions: \["Deny"\]/);
  assert.doesNotMatch(binding, /matchResources:|namespaceSelector:|objectSelector:/);
});

test('the Helm CEL probe fails when its exact inputs are absent and is wired into CI', () => {
  const result = spawnSync(process.execPath, ['tests/fixtures/provisioner-security-cel.mjs'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /render, CEL evaluator and generated recovery fixture are required/);
  assert.ok(readFileSync('scripts/verify-helm.sh', 'utf8').includes('verify-provisioner-admission.sh'));
  assert.ok(readFileSync('.github/workflows/ci.yml', 'utf8').includes('sh scripts/verify-helm.sh'));
});
