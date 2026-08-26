import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const updaterPath = new URL('../deploy/production/auto-update.sh', import.meta.url);
const installerPath = new URL('../deploy/production/install-auto-update.sh', import.meta.url);
const updater = readFileSync(updaterPath, 'utf8');
const installer = readFileSync(installerPath, 'utf8');

function bashSyntax(path) {
  const result = spawnSync('bash', ['-n', path.pathname], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('production auto-update shell scripts have valid bash syntax', () => {
  bashSyntax(updaterPath);
  bashSyntax(installerPath);
});

test('production updater only deploys the exact main SHA after successful CI', () => {
  assert.match(updater, /git ls-remote[\s\S]*refs\/heads\/\$\{BRANCH\}/);
  assert.match(updater, /actions\/runs\?head_sha=\$\{TARGET_SHA\}&event=push/);
  assert.match(updater, /\.path == "\.github\/workflows\/ci\.yml" or \.name == "CI"/);
  assert.match(updater, /CI_STATUS[\s\S]*completed/);
  assert.match(updater, /CI_CONCLUSION[\s\S]*success/);
  assert.match(updater, /FETCHED_SHA[\s\S]*TARGET_SHA/);
  assert.match(updater, /checkout --detach --force "\$TARGET_SHA"/);
});

test('production updater rebuilds and digest-pins every Helm-managed platform image', () => {
  const expected = [
    ['api', 'apps/api/Dockerfile', 'api'],
    ['dashboard', 'apps/dashboard/Dockerfile', 'dashboard'],
    ['orchestrator', 'services/orchestrator/Dockerfile', 'orchestrator'],
    ['builder', 'services/builder/Dockerfile', 'builder'],
    ['provisioner', 'services/provisioner/Dockerfile', 'provisioner'],
    ['logIngester', 'services/log-ingester/Dockerfile', 'log-ingester'],
    ['metricsIngester', 'services/metrics-ingester/Dockerfile', 'metrics-ingester'],
  ];

  for (const parts of expected) {
    assert.ok(updater.includes(`'${parts.join('|')}'`), `missing auto-update image target ${parts[0]}`);
  }

  assert.match(updater, /containerimage\.digest/);
  assert.match(updater, /sha256:\[0-9a-f\]\{64\}/);
  assert.match(updater, /could not update all image digests/);
});

test('production updater preserves signing and atomic Helm deployment gates', () => {
  for (const flag of [
    '--new-bundle-format=false',
    '--use-signing-config=false',
    '--registry-referrers-mode=legacy',
  ]) {
    assert.ok(updater.includes(flag), `missing cosign compatibility flag ${flag}`);
  }
  assert.match(updater, /cosign sign --yes/);
  assert.match(updater, /helm lint/);
  assert.match(updater, /helm template/);
  assert.match(updater, /helm upgrade --install/);
  assert.match(updater, /--atomic/);
  assert.match(updater, /rollout status deployment\/raibitserver-api/);
  assert.match(updater, /rollout status deployment\/raibitserver-dashboard/);
  assert.doesNotMatch(updater, /docker login/);
  assert.doesNotMatch(updater, /GITHUB_TOKEN/);
});

test('production updater is serialized and records success only after rollout', () => {
  assert.match(updater, /flock -n 9/);
  const helm = updater.indexOf('helm upgrade --install');
  const rollout = updater.indexOf('rollout status deployment/raibitserver-api');
  const state = updater.indexOf('deployed-sha.tmp');
  assert.ok(helm >= 0 && rollout > helm && state > rollout, 'deployed SHA must be recorded after Helm and rollout success');
});

test('systemd installer runs as the server user on a five-minute inactive interval', () => {
  assert.match(installer, /User=\$\{TARGET_USER\}/);
  assert.match(installer, /SupplementaryGroups=docker/);
  assert.match(installer, /EnvironmentFile=-\$\{ENV_FILE\}/);
  assert.match(installer, /OnUnitInactiveSec=5min/);
  assert.match(installer, /Persistent=true/);
  assert.match(installer, /systemctl enable --now "\$TIMER_NAME"/);
  assert.match(installer, /systemctl start --no-block "\$SERVICE_NAME"/);
});
