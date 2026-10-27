import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const recovery = readFileSync(new URL('../deploy/production/boot-recovery.sh', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const installer = readFileSync(new URL('../deploy/production/install-auto-update.sh', import.meta.url), 'utf8');
const linuxBashAvailable = process.platform !== 'win32'
  || spawnSync('bash', ['-lc', 'command -v wslpath >/dev/null'], { encoding: 'utf8' }).status === 0;

test('installer makes boot recovery a prerequisite for production updates', () => {
  assert.match(installer, /RECOVERY_SOURCE=.*boot-recovery\.sh/);
  assert.match(installer, /WantedBy=multi-user\.target/);
  assert.match(installer, /Restart=on-failure/);
  assert.match(installer, /TimeoutStartSec=30min/);
  assert.match(installer, /Requires=\$\{RECOVERY_SERVICE_NAME\}/);
  assert.match(installer, /Wants=network-online.target \$\{HOST_RECOVERY_SERVICE_NAME\}/);
  assert.doesNotMatch(installer, /ExecStart(?:Pre|Post)?=\+/);
  assert.match(installer, /systemctl enable "\$RECOVERY_SERVICE_NAME"/);
  assert.match(installer, /systemctl start --no-block "\$RECOVERY_SERVICE_NAME"/);
});

function renderUnits(t, optionalService = 'postgresql@16-main.service') {
  const directory = mkdtempSync(join(tmpdir(), 'raibit-boot-units-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const systemctl = join(directory, 'systemctl');
  writeFileSync(systemctl, '#!/usr/bin/env bash\nif [[ "$1" == show ]]; then printf "loaded\\n"; fi\n');
  chmodSync(systemctl, 0o755);
  const units = Object.fromEntries(['HOST_RECOVERY', 'RECOVERY', 'SERVICE', 'TIMER'].map((name) => [name, join(directory, `${name}.service`)]));
  // Execute the installer's actual unit renderer against temporary destinations;
  // no system service is installed or started by this fixture.
  const start = installer.indexOf('HOST_SERVICES=(docker.service k3s.service)');
  const end = installer.indexOf('chown root:root "$SERVICE_PATH"');
  assert.ok(start >= 0 && end > start);
  const result = spawnSync('bash', ['-s'], {
    input: `set -Eeuo pipefail\nfail() { printf '%s\\n' "$*" >&2; exit 1; }\n${installer.slice(start, end)}`,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      TARGET_USER: 'fixture-user', TARGET_GROUP: 'fixture-user', TARGET_HOME: '/home/fixture-user',
      ENV_FILE: '/home/fixture-user/user-controlled.env', KUBECONFIG_FILE: '/home/fixture-user/.kube/config',
      RECOVERY_INSTALLED: '/home/fixture-user/recovery', UPDATER_INSTALLED: '/home/fixture-user/updater',
      SERVICE_NAME: 'raibitserver-auto-update.service', RECOVERY_SERVICE_NAME: 'raibitserver-boot-recovery.service',
      HOST_RECOVERY_SERVICE_NAME: 'raibitserver-host-recovery.service',
      SERVICE_PATH: units.SERVICE, TIMER_PATH: units.TIMER,
      RECOVERY_SERVICE_PATH: units.RECOVERY, HOST_RECOVERY_SERVICE_PATH: units.HOST_RECOVERY,
      RAIBITSERVER_BOOT_POSTGRES_SERVICE: optionalService, RAIBITSERVER_BOOT_TUNNEL_SERVICE: 'none',
    },
  });
  return { result, units, systemctl };
}

test('privileged host startup never loads the user-controlled environment or scripts', { skip: process.platform === 'win32' }, (t) => {
  const { result, units, systemctl } = renderUnits(t);
  assert.equal(result.status, 0, result.stderr);
  const host = readFileSync(units.HOST_RECOVERY, 'utf8');
  const verifier = readFileSync(units.RECOVERY, 'utf8');
  assert.match(host, /^User=root$/m);
  assert.doesNotMatch(host, /Environment(?:File)?=|\/home\/fixture-user|ExecStartPre=\+/);
  const starts = host.split('\n').filter((line) => line.startsWith('ExecStart='));
  assert.deepEqual(starts, ['docker.service', 'k3s.service', 'postgresql@16-main.service'].flatMap((service) => [
    `ExecStart=${systemctl} reset-failed ${service}`,
    `ExecStart=${systemctl} start ${service}`,
  ]));
  assert.match(verifier, /^User=fixture-user$/m);
  assert.match(verifier, /^EnvironmentFile=-\/home\/fixture-user\/user-controlled.env$/m);
  assert.match(verifier, /^Wants=network-online.target raibitserver-host-recovery.service$/m);
  assert.doesNotMatch(verifier, /^Requires=raibitserver-host-recovery.service$/m);
  assert.match(verifier, /^Restart=on-failure$/m);
  assert.match(readFileSync(units.SERVICE, 'utf8'), /^Requires=raibitserver-boot-recovery.service$/m);
  assert.match(readFileSync(units.TIMER, 'utf8'), /^OnCalendar=\*-\*-\* \*:0\/5:00$/m);
});

test('unit generation rejects option-like names and systemd substitutions', { skip: process.platform === 'win32' }, (t) => {
  for (const service of ['--host=remote.service', '-bad.service', 'custom%H.service', 'docker.service\nExecStart=/bin/false']) {
    const { result } = renderUnits(t, service);
    assert.notEqual(result.status, 0, service);
    assert.match(result.stderr, /invalid boot recovery service name/);
  }
});

function runRecovery(t, extraEnv = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'raibit-boot-recovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const writeExecutable = (name, content) => {
    const path = join(directory, name);
    writeFileSync(path, `#!/usr/bin/env bash\n${content}`);
    chmodSync(path, 0o755);
  };
  writeExecutable('systemctl', `
printf 'systemctl %s\\n' "$*" >>"$TRACE"
if [[ "\u0024{FAIL_SERVICE:-}" != "" && "$*" == *"$FAIL_SERVICE"* ]]; then exit 1; fi
`);
  writeExecutable('kubectl', `
printf 'kubectl %s\\n' "$*" >>"$TRACE"
if [[ "$*" == *'get --raw=/readyz'* && "\u0024{FAIL_READY_ONCE:-}" == 1 && ! -e "$READY_MARKER" ]]; then
  touch "$READY_MARKER"
  exit 1
fi
if [[ "$*" == *'get pods -l app.kubernetes.io/component=api -o json'* ]]; then
  printf '%s\\n' '{"items":[{"metadata":{"name":"api-terminating","deletionTimestamp":"2026-10-27T00:00:00Z"},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}},{"metadata":{"name":"api-ready"},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}'
fi
if [[ "$*" == *'wait --for=condition=Available'* && "\u0024{FAIL_DEPLOYMENT:-}" == 1 ]]; then exit 1; fi
if [[ "$*" == *' exec '* ]]; then
  if [[ "\u0024{FAIL_DB:-}" == 1 ]]; then exit 1; fi
  printf 'DB_QUERY_OK\\n'
fi
`);
  writeExecutable('sleep', `printf 'sleep %s\\n' "$*" >>"$TRACE"\n`);
  const kubeconfig = join(directory, 'kubeconfig');
  const trace = join(directory, 'trace');
  writeFileSync(kubeconfig, 'mock');
  writeFileSync(trace, '');
  const windows = process.platform === 'win32';
  const result = spawnSync('bash', windows
    ? ['-lc', 'PATH="$RAIBIT_TEST_DIR:/usr/bin:/bin" KUBECONFIG="$RAIBIT_TEST_DIR/kubeconfig" TRACE="$RAIBIT_TEST_DIR/trace" READY_MARKER="$RAIBIT_TEST_DIR/ready-marker" bash -s']
    : ['-s'], {
    input: recovery,
    encoding: 'utf8',
    env: windows ? {
      ...process.env,
      ...extraEnv,
      RAIBIT_TEST_DIR: directory,
      WSLENV: [process.env.WSLENV, 'RAIBIT_TEST_DIR/pu', 'FAIL_SERVICE/u', 'FAIL_READY_ONCE/u', 'FAIL_DB/u', 'FAIL_DEPLOYMENT/u'].filter(Boolean).join(':'),
    } : {
      ...process.env,
      ...extraEnv,
      PATH: `${directory}:${process.env.PATH}`,
      KUBECONFIG: kubeconfig,
      TRACE: trace,
      READY_MARKER: join(directory, 'ready-marker'),
    },
  });
  return { result, trace: readFileSync(trace, 'utf8') };
}

test('boot recovery waits through a transient API outage and checks DB after deployments', { skip: !linuxBashAvailable }, (t) => {
  const { result, trace } = runRecovery(t, { FAIL_READY_ONCE: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DB_QUERY_OK/);
  assert.equal((trace.match(/get --raw=\/readyz/g) || []).length, 2);
  assert.ok(trace.indexOf('wait --for=condition=Available') < trace.indexOf('exec api-ready'));
  assert.doesNotMatch(trace, /exec api-terminating/);
});

test('boot recovery fails closed when a host service or DB query is unavailable', { skip: !linuxBashAvailable }, (t) => {
  const service = runRecovery(t, { FAIL_SERVICE: 'k3s.service' });
  assert.notEqual(service.result.status, 0);
  assert.doesNotMatch(service.trace, /kubectl/);

  const database = runRecovery(t, { FAIL_DB: '1' });
  assert.notEqual(database.result.status, 0);
  assert.match(database.result.stderr, /database is not reachable/);
});

test('boot recovery does not query the database when deployments are unavailable', { skip: !linuxBashAvailable }, (t) => {
  const { result, trace } = runRecovery(t, { FAIL_DEPLOYMENT: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /deployments did not become available/);
  assert.doesNotMatch(trace, /exec api-/);
});
