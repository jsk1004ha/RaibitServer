import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const updaterPath = new URL('../deploy/production/auto-update.sh', import.meta.url);
const installerPath = new URL('../deploy/production/install-auto-update.sh', import.meta.url);
const registryBootstrapPath = new URL('../deploy/production/bootstrap-workload-registry.sh', import.meta.url);
const registryGatewayReconcilerPath = new URL('../deploy/production/reconcile-workload-registry-gateway.sh', import.meta.url);
const registryGatewayCheckerPath = new URL('../deploy/production/check-workload-registry-gateway.sh', import.meta.url);
const hostPostgresConfiguratorPath = new URL('../deploy/production/configure-host-postgres-access.sh', import.meta.url);
const updater = readFileSync(updaterPath, 'utf8');
const installer = readFileSync(installerPath, 'utf8');
const registryBootstrap = readFileSync(registryBootstrapPath, 'utf8');
const registryGatewayReconciler = readFileSync(registryGatewayReconcilerPath, 'utf8');
const registryGatewayChecker = readFileSync(registryGatewayCheckerPath, 'utf8');
const hostPostgresConfigurator = readFileSync(hostPostgresConfiguratorPath, 'utf8');

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
  bashSyntax(registryBootstrapPath);
  bashSyntax(registryGatewayReconcilerPath);
  bashSyntax(registryGatewayCheckerPath);
  bashSyntax(hostPostgresConfiguratorPath);
});

test('production updater checks control-plane DB reachability before expensive image builds', () => {
  assert.match(updater, /control_plane_database_reachable\(\)/);
  assert.match(updater, /app\.kubernetes\.io\/component=api/);
  assert.match(updater, /process\.env\.DATABASE_URL/);
  assert.match(updater, /control-plane database is not reachable from a ready API Pod/);
  assert.match(updater, /configure-host-postgres-access\.sh/);
  assert.doesNotMatch(updater, /console\.log\(process\.env\.DATABASE_URL\)/);

  const preflight = updater.indexOf('control_plane_database_reachable ||');
  const firstBuild = updater.indexOf('log "building ${digest_key}');
  assert.ok(preflight >= 0 && firstBuild > preflight, 'DB connectivity must be checked before the first image build');
});

test('host PostgreSQL configurator exposes only the private node endpoint to validated Pod CIDRs', () => {
  assert.match(hostPostgresConfigurator, /run this script as the server user, without sudo bash/);
  assert.match(hostPostgresConfigurator, /raibitserver-control-plane-database/);
  assert.match(hostPostgresConfigurator, /postgresql|postgres/);
  assert.match(hostPostgresConfigurator, /InternalIP/);
  assert.match(hostPostgresConfigurator, /podCIDRs|podCIDR/);
  assert.match(hostPostgresConfigurator, /is_private/);
  assert.match(hostPostgresConfigurator, /scram-sha-256/);
  assert.match(hostPostgresConfigurator, /BEGIN RAIBITSERVER MANAGED K3S POD ACCESS/);
  assert.match(hostPostgresConfigurator, /pg_hba_file_rules/);
  assert.match(hostPostgresConfigurator, /contains a wildcard host rule; refusing to open the private listener/);
  assert.match(hostPostgresConfigurator, /listxattr/);
  assert.match(hostPostgresConfigurator, /ALTER SYSTEM SET listen_addresses/);
  assert.match(hostPostgresConfigurator, /systemctl restart/);
  assert.match(hostPostgresConfigurator, /rolling back PostgreSQL network configuration/);
  assert.match(hostPostgresConfigurator, /TCP_OK/);
  assert.doesNotMatch(hostPostgresConfigurator, /echo\s+"?\$\{?DATABASE_URL/);
  assert.doesNotMatch(hostPostgresConfigurator, /listen_addresses\s*=\s*['"]\*/);
  assert.doesNotMatch(hostPostgresConfigurator, /0\.0\.0\.0\/0/);
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
    ['registryBroker', 'services/registry-broker/Dockerfile', 'registry-broker'],
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

test('production updater prevalidates then reconciles the digest-pinned registry gateway', () => {
  assert.match(updater, /REGISTRY_RECONCILER=.*reconcile-workload-registry-gateway\.sh/);
  assert.match(updater, /REGISTRY_RECONCILE_REQUIRED=1/);
  assert.match(updater, /TARGET_SHA.*DEPLOYED_SHA.*CURRENT_INPUT_DIGEST.*DEPLOYED_INPUT_DIGEST.*REGISTRY_RECONCILE_REQUIRED/s);
  assert.match(updater, /REGISTRY_BROKER_IMAGE=.*DIGESTS\[registryBroker\]/);
  assert.match(updater, /bash "\$REGISTRY_RECONCILER" --render-values/);
  assert.match(updater, /snapshot_registry_values.*workload-registry-values\.reconciled\.yaml/s);
  assert.match(updater, /reconciled registry overlay differs from its validated candidate/);

  const render = updater.indexOf('bash "$REGISTRY_RECONCILER" --render-values');
  const preflight = updater.indexOf('validating the registry gateway Helm overlay before cluster mutation');
  const reconcile = updater.indexOf('reconciling the dedicated workload registry gateway');
  const finalHelm = updater.indexOf('validating Helm release candidate');
  const state = updater.indexOf('deployed-sha.tmp');
  assert.ok(
    render >= 0 && preflight > render && reconcile > preflight && finalHelm > reconcile && state > finalHelm,
    'Helm preflight must precede gateway mutation, final Helm validation, and success state',
  );
});

test('registry gateway reconciler uses exact TLS identities without a shared ingress exception', () => {
  assert.ok(registryGatewayReconciler.includes("'/registry-broker@sha256:') + r'[0-9a-f]{64}'"));
  assert.match(registryGatewayReconciler, /relativeurls: true/);
  assert.match(registryGatewayReconciler, /name: raibit-registry-ingress[\s\S]*podSelector:[\s\S]*app: raibit-registry-auth[\s\S]*port: 5000/);
  assert.match(registryGatewayReconciler, /for attempt in \$\(seq 1 15\)[\s\S]*REGISTRY_STATUS[\s\S]*REGISTRY_REQUEST_OK[\s\S]*sleep 2/);
  assert.match(registryGatewayReconciler, /name: internal-tls[\s\S]*port: 443[\s\S]*targetPort: 8443/);
  assert.match(registryGatewayReconciler, /BROKER_HOST[\s\S]*INTERNAL_TLS_PORT[\s\S]*REGISTRY_UPSTREAM_URL/);
  assert.match(registryGatewayReconciler, /kubernetes\.io\/metadata\.name: \$\{APP_NS\}[\s\S]*app\.kubernetes\.io\/name: raibitserver-builder-executor[\s\S]*port: 8443/);
  assert.match(registryGatewayReconciler, /GATEWAY_CLUSTER_IP_RAW=.*service raibit-registry-auth/);
  assert.ok(registryGatewayReconciler.includes(
    "output.append(f'{gateway_ip} {registry_host} {auth_host}')",
  ));
  assert.match(registryGatewayReconciler, /privateGateway:[\s\S]*enabled: true[\s\S]*servicePort: 443[\s\S]*port: 8443/);
  assert.match(registryGatewayReconciler, /rollout status deployment\/raibit-registry-auth/);
  assert.match(registryGatewayReconciler, /https:\/\/\$\{AUTH_HOST\}\/broker/);
  assert.match(registryGatewayReconciler, /builder and broker token Secrets do not match/);
  assert.match(registryGatewayReconciler, /registry credential broker issuance smoke test failed/);
  assert.match(registryGatewayReconciler, /REGISTRY_STATUS.*!= 401/s);
  assert.match(registryGatewayReconciler, /www-authenticate:/i);
  assert.match(registryGatewayReconciler, /--rawfile old "\$NODEHOSTS_CURRENT_FILE" --rawfile new "\$NODEHOSTS_NEW_FILE"/);
  assert.match(registryGatewayReconciler, /rollback_coredns_nodehosts/);
  assert.match(registryGatewayReconciler, /rollback_registry_state/);
  assert.match(registryGatewayReconciler, /rollback_gateway_resources/);
  assert.match(registryGatewayReconciler, /capture_gateway_applied_state/);
  assert.match(registryGatewayReconciler, /registry-statefulset\.applied\.json/);
  assert.match(registryGatewayReconciler, /"path":"\/metadata\/uid"/);
  assert.match(registryGatewayReconciler, /registry StatefulSet could not be refreshed before mutation/);
  assert.match(registryGatewayReconciler, /--slurpfile previous "\$REGISTRY_STATEFULSET_PREVIOUS"[\s\S]*"path":"\/metadata\/uid"[\s\S]*"path":"\/spec\/template"/);
  assert.match(registryGatewayReconciler, /REGISTRY_STATEFULSET_APPLIED="\$REGISTRY_STATEFULSET_DESIRED"/);
  assert.match(registryGatewayReconciler, /\.metadata\.uid == \$expected\[0\]\.metadata\.uid[\s\S]*\.spec\.template == \$expected\[0\]\.spec\.template/);
  assert.match(registryGatewayReconciler, /registry-restarted-at/);
  assert.doesNotMatch(registryGatewayReconciler, /rollout restart statefulset\/raibit-registry/);
  const gatewayRestoreStart = registryGatewayReconciler.indexOf('restore_gateway_spec()');
  const gatewayRestoreEnd = registryGatewayReconciler.indexOf('rollback_gateway_resources()', gatewayRestoreStart);
  const gatewayRestore = registryGatewayReconciler.slice(gatewayRestoreStart, gatewayRestoreEnd);
  assert.doesNotMatch(gatewayRestore, /metadata\/annotations/);
  assert.match(registryGatewayReconciler, /exactly one authentication challenge/);
  assert.match(registryGatewayReconciler, /duplicate parameter/);
  assert.match(registryGatewayReconciler, /registry overlay installation failed and exact full rollback also failed/);
  assert.doesNotMatch(registryGatewayReconciler, /NODEHOSTS_(?:CURRENT|NEW)="\$\(/);
  assert.doesNotMatch(registryGatewayReconciler, /egressCIDRs|NODE_CIDR|\/32|sudo|docker login/);
});

test('production updater detects live registry gateway drift before its early exit', () => {
  assert.match(updater, /REGISTRY_MANAGED=0/);
  assert.match(updater, /get statefulset raibit-registry[\s\S]*--ignore-not-found -o name/);
  assert.match(updater, /could not determine whether the workload registry is installed/);
  assert.match(updater, /if \[\[ "\$REGISTRY_MANAGED" == 1 \]\]; then/);
  assert.match(updater, /registry_state_digest\(\)/);
  assert.match(updater, /availableReplicas/);
  assert.match(updater, /readyReplicas/);
  assert.match(updater, /registry config checksum does not match the StatefulSet/);
  assert.match(updater, /CoreDNS registry split DNS is not exact/);
  assert.match(updater, /registry-reconciled-state-digest/);
  assert.match(updater, /REGISTRY_OBSERVED_STATE_DIGEST.*REGISTRY_RECONCILED_STATE_DIGEST/s);
  assert.match(updater, /registry_runtime_healthy/);
  assert.match(updater, /check-workload-registry-gateway\.sh/);
  assert.match(updater, /git -C "\$WORKTREE" diff --quiet "\$TARGET_SHA" -- "\$REGISTRY_CHECKER_REPOSITORY_PATH"/);
  assert.match(updater, /token parity, or live broker probe is unhealthy; scheduling repair/);
  assert.match(registryGatewayChecker, /builder and broker token Secrets do not match/);
  assert.match(registryGatewayChecker, /https:\/\/\$\{AUTH_HOST\}\/broker/);
  assert.match(registryGatewayChecker, /registry credential broker issuance smoke test failed/);
  assert.match(registryGatewayChecker, /REGISTRY_STATUS.*== 401/s);
  assert.match(registryGatewayChecker, /exactly one authentication challenge/);
  assert.match(registryGatewayChecker, /CoreDNS registry split DNS is not exact/);

  const observedState = updater.indexOf('REGISTRY_OBSERVED_STATE_DIGEST="$(registry_state_digest)"');
  const liveProbe = updater.indexOf('&& registry_runtime_healthy', observedState);
  const earlyExit = updater.indexOf('already running ${TARGET_SHA}');
  assert.ok(
    observedState >= 0 && liveProbe > observedState && earlyExit > liveProbe,
    'the updater must run a live broker probe before its unchanged-release early exit',
  );
});

test('production updater applies the generated workload registry overlay through every Helm gate', () => {
  assert.match(updater, /REGISTRY_VALUES_FILE=.*workload-registry-values\.yaml/);
  assert.match(updater, /workload registry values must be a regular non-symlink file/);
  assert.match(updater, /workload registry values are not owned by the updater user/);
  assert.match(updater, /workload registry values must not be group\/world writable/);
  assert.match(updater, /workload registry values parent must not be group\/world writable/);
  assert.match(updater, /O_NOFOLLOW/);
  assert.match(updater, /os\.open\(source, open_flags\)/);
  assert.match(updater, /workload registry values exceed the 1 MiB limit/);
  assert.match(updater, /REGISTRY_VALUES_SNAPSHOT=.*RUN_DIR/);
  assert.match(updater, /HELM_VALUES_ARGS=\(-f "\$CANDIDATE_VALUES"\)/);
  assert.match(updater, /HELM_VALUES_ARGS\+=\(-f "\$REGISTRY_VALUES_SNAPSHOT"\)/);
  assert.equal((updater.match(/"\$\{HELM_VALUES_ARGS\[@\]\}"/g) || []).length, 3, 'lint, template, and upgrade must consume the same values list');
  assert.doesNotMatch(installer, /RAIBITSERVER_REGISTRY_VALUES_FILE/);
});

test('production updater reconciles values changes even when the main SHA is unchanged', () => {
  assert.match(updater, /deployment_input_digest\(\)/);
  assert.match(updater, /CURRENT_INPUT_DIGEST=.*deployment_input_digest/);
  assert.match(updater, /DEPLOYED_INPUT_DIGEST=.*deployed-input-digest/);
  assert.match(updater, /TARGET_SHA.*DEPLOYED_SHA.*CURRENT_INPUT_DIGEST.*DEPLOYED_INPUT_DIGEST/);
  assert.match(updater, /deployment inputs changed.*reconciling the existing commit/);
  assert.match(updater, /APPLIED_INPUT_DIGEST=.*deployment_input_digest/);
  assert.match(updater, /deployed-input-digest\.tmp/);
  assert.match(updater, /--arg inputDigest "\$APPLIED_INPUT_DIGEST"/);
});

test('workload registry bootstrap emits a dedicated TLS gateway and a secure Helm overlay', () => {
  assert.match(registryBootstrap, /imagetools inspect[\s\S]*awk '\$1=="Digest:" && !digest \{digest=\$2\} END \{print digest\}'/);
  assert.doesNotMatch(registryBootstrap, /Digest:[^'\n]*exit/);
  assert.match(registryBootstrap, /SESSION_HMAC_KEY=""[\s\S]*session-hmac-key[\s\S]*\^\[0-9a-f\]\{64\}\$[\s\S]*openssl rand -hex 32/);
  assert.match(registryBootstrap, /name: raibit-registry-ingress[\s\S]*podSelector:[\s\S]*app: raibit-registry-auth[\s\S]*port: 5000/);
  assert.match(registryBootstrap, /for attempt in \$\(seq 1 15\)[\s\S]*GATEWAY_REGISTRY_STATUS[\s\S]*sleep 2/);
  assert.match(registryBootstrap, /name: internal-tls[\s\S]*port: 443[\s\S]*targetPort: 8443/);
  assert.match(registryBootstrap, /BROKER_HOST[\s\S]*INTERNAL_TLS_PORT[\s\S]*INTERNAL_TLS_CERT_FILE[\s\S]*INTERNAL_TLS_KEY_FILE[\s\S]*REGISTRY_UPSTREAM_URL/);
  assert.match(registryBootstrap, /http:[\s\S]*addr: :5000[\s\S]*relativeurls: true/);
  assert.match(registryBootstrap, /app\.kubernetes\.io\/name: raibit-registry-auth/);
  assert.match(registryBootstrap, /kubernetes\.io\/metadata\.name: \$\{APP_NS\}[\s\S]*app\.kubernetes\.io\/name: raibitserver-builder-executor[\s\S]*port: 8443/);
  assert.match(registryBootstrap, /GATEWAY_CLUSTER_IP=.*service raibit-registry-auth/);
  assert.match(registryBootstrap, /GATEWAY_CLUSTER_IP\} \$\{REGISTRY_HOST\} \$\{AUTH_HOST\}/);
  assert.match(registryBootstrap, /workload-registry-values\.yaml/);
  assert.doesNotMatch(registryBootstrap, /REGISTRY_VALUES_FILE="\$\{RAIBITSERVER_REGISTRY_VALUES_FILE:-/);
  assert.match(registryBootstrap, /privateGateway:[\s\S]*enabled: true[\s\S]*namespace: "\$\{INFRA_NS\}"[\s\S]*podName: "raibit-registry-auth"[\s\S]*servicePort: 443[\s\S]*port: 8443/);
  assert.doesNotMatch(registryBootstrap, /egressCIDRs|NODE_CIDR|\/32/);
  assert.match(registryBootstrap, /chmod 600 "\$REGISTRY_VALUES_TMP"[\s\S]*mv -f -- "\$REGISTRY_VALUES_TMP"/);
  assert.match(registryBootstrap, /REGISTRY_VALUES_FILE=\$\{REGISTRY_VALUES_FILE\}/);
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
