import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const securityPath = new URL('../infra/helm/raibitserver/templates/worker-security.yaml', import.meta.url);

function policyBlock(source, name) {
  const marker = `kind: ValidatingAdmissionPolicy\nmetadata:\n  name: {{ include "raibitserver.fullname" . }}-${name}`;
  const start = source.indexOf(marker);
  const end = source.indexOf('\n---\napiVersion: admissionregistration.k8s.io/v1\nkind: ValidatingAdmissionPolicyBinding', start);
  assert.ok(start >= 0 && end > start, `${name} policy must be a bounded document`);
  return source.slice(start, end);
}

test('orchestrator may retain compiler-owned service PVCs but cannot delete them', async () => {
  const source = (await fs.readFile(securityPath, 'utf8')).replace(/\r/g, '');
  const role = source.match(
    /kind: ClusterRole\nmetadata:\n\s+name: .*?-orchestrator\nrules:[\s\S]*?(?=\n---\napiVersion: rbac\.authorization\.k8s\.io\/v1\nkind: ClusterRoleBinding)/,
  )?.[0];
  assert.ok(role, 'orchestrator ClusterRole must exist');
  const pvcRule = role.match(/resources: \["persistentvolumeclaims"\]\n\s+verbs: \[([^\]]+)\]/)?.[1] ?? '';
  for (const verb of ['get', 'list', 'watch', 'create', 'patch', 'update']) assert.match(pvcRule, new RegExp(`"${verb}"`));
  assert.doesNotMatch(pvcRule, /"delete"/, 'service data must survive deployment cleanup and redeploy');

  const pvc = policyBlock(source, 'orchestrator-service-pvc-boundary');
  assert.match(pvc, /operations: \["CREATE", "UPDATE"\]/);
  assert.doesNotMatch(pvc, /operations: \[[^\]]*"DELETE"/);
  assert.match(pvc, /resources: \["persistentvolumeclaims"\]/);
});

test('service PVC admission pins identity, dynamic provisioning shape, size, and immutable binding', async () => {
  const source = (await fs.readFile(securityPath, 'utf8')).replace(/\r/g, '');
  const pvc = policyBlock(source, 'orchestrator-service-pvc-boundary');

  assert.match(pvc, /metadata\.labels\.size\(\) in \[7, 10\]/);
  assert.match(pvc, /!\('raibitserver\.io\/deployment' in variables\.target\.metadata\.labels\)/);
  assert.match(pvc, /!\('raibitserver\.io\/deployment-id' in variables\.target\.metadata\.labels\)/);
  assert.match(pvc, /metadata\.name == variables\.appName \+ '-data'/);
  assert.match(pvc, /metadata\.name\.matches\('\^\[a-z0-9\].*\[a-f0-9\]\{12\}\$'\)/);
  assert.match(pvc, /spec\.accessModes == \['ReadWriteOnce'\]/);
  assert.match(pvc, /spec\.volumeMode == 'Filesystem'/);
  assert.match(pvc, /storageClassName != ''/, 'an empty class must not bypass default dynamic provisioning');
  for (const field of ['selector', 'dataSource', 'dataSourceRef']) assert.match(pvc, new RegExp(`!has\\(variables\\.target\\.spec\\.${field}\\)`));
  assert.match(pvc, /request\.operation != 'CREATE' \|\| !has\(variables\.target\.spec\.volumeName\)/);
  assert.match(pvc, /quantity\(variables\.storage\)\.compareTo\(quantity\('1Gi'\)\) >= 0/);
  assert.match(pvc, /quantity\(variables\.storage\)\.compareTo\(quantity\('100Gi'\)\) <= 0/);
  assert.match(pvc, /oldObject\.metadata\.labels == object\.metadata\.labels/);
  assert.ok(pvc.includes('oldObject.spec.resources.requests.storage == object.spec.resources.requests.storage'));
  assert.match(pvc, /oldObject\.spec\.storageClassName == object\.spec\.storageClassName/);
  assert.match(pvc, /oldObject\.spec\.volumeName == object\.spec\.volumeName/);
});

test('workload admission allows bounded compute and only an optional safe data mount', async () => {
  const source = (await fs.readFile(securityPath, 'utf8')).replace(/\r/g, '');
  const workload = policyBlock(source, 'orchestrator-workload-boundary');

  for (const bound of ['8000m', '16384Mi']) assert.match(workload, new RegExp(`quantity\\('${bound}'\\)`));
  assert.match(workload, /requests\['cpu'\][\s\S]*limits\['cpu'\][\s\S]*compareTo\(quantity\(variables\.container\.resources\.limits\['cpu'\]\)\) <= 0/);
  assert.match(workload, /requests\['memory'\][\s\S]*limits\['memory'\][\s\S]*compareTo\(quantity\(variables\.container\.resources\.limits\['memory'\]\)\) <= 0/);
  assert.match(workload, /requests\['ephemeral-storage'\] == '64Mi'/);
  assert.match(workload, /limits\['ephemeral-storage'\] == '256Mi'/);
  assert.match(workload, /volume\.name == 'tmp'[\s\S]*emptyDir\.sizeLimit == '128Mi'/);
  assert.match(workload, /volume\.name == 'data'[\s\S]*has\(volume\.persistentVolumeClaim\)/);
  assert.match(workload, /mount\.mountPath\.matches\('\^\/data\(\/\[A-Za-z0-9_-\]\+\)\*\$'\)/);
  assert.match(workload, /!has\(mount\.subPath\)[\s\S]*!has\(mount\.subPathExpr\)/);
  assert.match(workload, /securityContext\.fsGroup == 10001/);
  assert.match(workload, /variables\.target\.kind == 'Deployment'/);
  assert.match(workload, /spec\.replicas == 1[\s\S]*spec\.strategy\.type == 'Recreate'/);
  assert.match(workload, /terminationGracePeriodSeconds == 300/);
});
