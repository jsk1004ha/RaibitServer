import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const updaterPath = new URL('../deploy/production/auto-update.sh', import.meta.url);
const installerPath = new URL('../deploy/production/install-auto-update.sh', import.meta.url);
const updater = readFileSync(updaterPath, 'utf8');
const installer = readFileSync(installerPath, 'utf8');

function bashSyntax(path) {
  // Git stores these scripts with LF. Normalize a Windows checkout before
  // sending the exact script contents to Bash over stdin so no host-path
  // translation is involved.
  const script = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  const result = spawnSync('bash', ['-n'], {
    encoding: 'utf8',
    input: script,
  });
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

test('production updater preserves signing and version-appropriate Helm rollback gates', () => {
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
  assert.match(updater, /HELM_VERSION=.*helm version --template/);
  assert.match(updater, /3\)[\s\S]*HELM_SAFETY_FLAGS=\(--atomic\)/);
  assert.match(updater, /4\)[\s\S]*--rollback-on-failure --wait=watcher --wait-for-jobs/);
  assert.match(updater, /unsupported Helm major version/);
  assert.match(updater, /rollout status deployment\/raibitserver-api/);
  assert.match(updater, /rollout status deployment\/raibitserver-dashboard/);
  assert.doesNotMatch(updater, /docker login/);
  assert.doesNotMatch(updater, /GITHUB_TOKEN/);
});

test('production updater self-refreshes atomically only after rollout succeeds', () => {
  assert.match(updater, /UPDATER_LIBEXEC_PATH=.*\.local\/libexec/);
  assert.match(updater, /libexec directory must be a real directory/);
  assert.match(updater, /must be canonical and contain no symlinks/);
  assert.match(updater, /must not be group\/world writable/);
  assert.match(updater, /regular non-symlink file/);
  assert.match(updater, /bash -n "\$UPDATER_SOURCE"/);
  assert.match(updater, /mktemp "\$\{UPDATER_LIBEXEC_DIR\}\/\.raibitserver-production-auto-update\.XXXXXX"/);
  assert.match(updater, /mv -- "\$UPDATER_TMP" "\$UPDATER_LIBEXEC_PATH"/);

  const rollout = updater.indexOf('rollout status deployment/raibitserver-dashboard');
  const refresh = updater.indexOf('mv -- "$UPDATER_TMP" "$UPDATER_LIBEXEC_PATH"');
  const state = updater.indexOf('deployed-sha.tmp');
  assert.ok(rollout >= 0 && refresh > rollout && state > refresh, 'self-refresh must follow rollout and precede success state');
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
  assert.match(installer, /Environment=RAIBITSERVER_UPDATER_LIBEXEC_PATH=\$\{UPDATER_INSTALLED\}/);
  assert.match(installer, /Refuse user-controlled symlinks/);
  assert.match(installer, /managed path contains a non-directory or symlink/);
  assert.match(installer, /refusing to replace symlinked updater target/);
  assert.match(installer, /runuser -u "\$TARGET_USER" -- install -d -m 700/);
  assert.match(installer, /runuser -u "\$TARGET_USER" -- install -m 0755/);
  assert.match(installer, /runuser -u "\$TARGET_USER" -- sh -c 'umask 077/);
  assert.match(installer, /OnUnitInactiveSec=5min/);
  assert.match(installer, /Persistent=true/);
  assert.match(installer, /systemctl enable --now "\$TIMER_NAME"/);
  assert.match(installer, /systemctl start --no-block "\$SERVICE_NAME"/);
});
