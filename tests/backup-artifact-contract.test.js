import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const helm = process.env.HELM_BINARY || 'helm';
const chart = 'infra/helm/raibitserver';
const provisionerName = 'task23-backup-raibitserver-provisioner';
const backupEnvironmentNames = [
  'RAIBITSERVER_PROVISIONER_BACKUP_ENABLED',
  'RAIBITSERVER_PROVISIONER_BACKUP_ENDPOINT',
  'RAIBITSERVER_PROVISIONER_BACKUP_BUCKET',
  'RAIBITSERVER_PROVISIONER_BACKUP_CONFIG_FILE',
];

function render(settings = {}) {
  return spawnSync(helm, [
    'template',
    'task23-backup',
    chart,
    '--namespace',
    'task23',
    ...Object.entries(settings).flatMap(([key, value]) => [key.endsWith('.enabled') ? '--set' : '--set-string', `${key}=${value}`]),
  ], { encoding: 'utf8', timeout: 30_000 });
}

function documents(rendered) {
  const parsed = YAML.parseAllDocuments(rendered);
  assert.deepEqual(parsed.flatMap((document) => document.errors), [], 'Helm output must be valid YAML');
  return parsed.map((document) => document.toJSON()).filter(Boolean);
}

function provisioner(documents) {
  const deployment = documents.find((document) => document.kind === 'Deployment' && document.metadata?.name === provisionerName);
  assert.ok(deployment, 'render must include the existing provisioner Deployment');
  return deployment;
}

test('operator backup configuration is disabled by default and securely projects only an explicit existing Secret', () => {
  // Given: default chart values and a complete, fake same-namespace Secret reference.
  const disabled = render();
  const enabledSettings = {
    'provisioner.backups.enabled': 'true',
    'provisioner.backups.endpoint': 'https://s3.example.invalid',
    'provisioner.backups.bucket': 'task23-artifacts',
    'provisioner.backups.existingSecret': 'task23-backup-config',
    'provisioner.backups.secretKey': 'config.json',
  };
  const enabled = render(enabledSettings);

  // When: Helm renders disabled and explicitly-enabled provisioner settings.
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(enabled.status, 0, enabled.stderr);
  const disabledDocuments = documents(disabled.stdout);
  const enabledDocuments = documents(enabled.stdout);
  const disabledProvisioner = provisioner(disabledDocuments);
  const enabledProvisioner = provisioner(enabledDocuments);

  // Then: defaults add no backup environment or credential projection.
  const disabledContainer = disabledProvisioner.spec.template.spec.containers.find((container) => container.name === 'provisioner');
  assert.ok(disabledContainer);
  assert.deepEqual(
    disabledContainer.env.filter((entry) => backupEnvironmentNames.includes(entry.name)),
    [],
    'disabled rendering must expose no backup environment variables',
  );
  assert.deepEqual(
    disabledProvisioner.spec.template.spec.volumes.filter((volume) => volume.name === 'backup-config'),
    [],
    'disabled rendering must expose no backup credential volume',
  );

  // Then: the existing provisioner alone receives the four non-secret values and readonly single-key projection.
  const enabledContainer = enabledProvisioner.spec.template.spec.containers.find((container) => container.name === 'provisioner');
  assert.ok(enabledContainer);
  const backupEnvironment = enabledContainer.env.filter((entry) => backupEnvironmentNames.includes(entry.name));
  assert.deepEqual(backupEnvironment, [
    { name: 'RAIBITSERVER_PROVISIONER_BACKUP_ENABLED', value: 'true' },
    { name: 'RAIBITSERVER_PROVISIONER_BACKUP_ENDPOINT', value: 'https://s3.example.invalid' },
    { name: 'RAIBITSERVER_PROVISIONER_BACKUP_BUCKET', value: 'task23-artifacts' },
    { name: 'RAIBITSERVER_PROVISIONER_BACKUP_CONFIG_FILE', value: '/var/run/secrets/raibitserver/backup/config.json' },
  ]);
  assert.deepEqual(enabledContainer.volumeMounts.filter((mount) => mount.name === 'backup-config'), [{
    name: 'backup-config',
    mountPath: '/var/run/secrets/raibitserver/backup',
    readOnly: true,
  }]);
  assert.equal(enabledProvisioner.spec.template.spec.securityContext.fsGroup, 10001);
  assert.match(enabled.stdout, /defaultMode: 0440/, 'Secret key projection must retain Kubernetes mode 0440');
  assert.deepEqual(enabledProvisioner.spec.template.spec.volumes.filter((volume) => volume.name === 'backup-config'), [{
    name: 'backup-config',
    secret: {
      secretName: 'task23-backup-config',
      defaultMode: 440,
      items: [{ key: 'config.json', path: 'config.json' }],
    },
  }]);
  const backupReferences = enabledDocuments.flatMap((document) => JSON.stringify(document).match(/task23-backup-config/g) || []);
  assert.equal(backupReferences.length, 1, 'backup Secret reference must be projected only into the provisioner');
  assert.doesNotMatch(enabled.stdout, /accessKeyId|secretAccessKey|sessionToken|currentKeyVersion/, 'chart must never render backup Secret data');
});

test('operator backup configuration fails Helm rendering when any enabled selector is absent', () => {
  // Given: each enabled rendering omits exactly one required operator-selected field.
  const complete = {
    'provisioner.backups.enabled': 'true',
    'provisioner.backups.endpoint': 'https://s3.example.invalid',
    'provisioner.backups.bucket': 'task23-artifacts',
    'provisioner.backups.existingSecret': 'task23-backup-config',
    'provisioner.backups.secretKey': 'config.json',
  };
  const omissions = [
    ['endpoint', 'provisioner.backups.endpoint'],
    ['bucket', 'provisioner.backups.bucket'],
    ['existing Secret', 'provisioner.backups.existingSecret'],
    ['Secret data key', 'provisioner.backups.secretKey'],
  ];

  // When / Then: no partial configuration can render.
  for (const [label, omittedKey] of omissions) {
    const settings = { ...complete, [omittedKey]: '' };
    const result = render(settings);
    assert.notEqual(result.status, 0, `enabled backup rendering without ${label} must fail`);
    assert.match(result.stderr, new RegExp(`backup.*${label}|${label}.*backup`, 'i'));
  }
});
