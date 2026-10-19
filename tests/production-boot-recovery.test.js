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
  assert.match(installer, /ExecStartPre=\+%s reset-failed %s/);
  assert.match(installer, /ExecStartPre=\+%s start %s/);
  assert.match(installer, /Requires=\$\{RECOVERY_SERVICE_NAME\}/);
  assert.match(installer, /systemctl enable "\$RECOVERY_SERVICE_NAME"/);
  assert.match(installer, /systemctl start --no-block "\$RECOVERY_SERVICE_NAME"/);
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
  printf '%s\\n' '{"items":[{"metadata":{"name":"api-ready"},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}'
fi
if [[ "$*" == *' exec '* ]]; then
  if [[ "\u0024{FAIL_DB:-}" == 1 ]]; then exit 1; fi
  printf 'DB_QUERY_OK\\n'
fi
`);
  writeExecutable('sleep', `printf 'sleep %s\\n' "$*" >>"$TRACE"\n`);
  const kubeconfig = join(directory, 'kubeconfig');
  const trace = join(directory, 'trace');
  writeFileSync(kubeconfig, 'mock');
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
      WSLENV: [process.env.WSLENV, 'RAIBIT_TEST_DIR/pu', 'FAIL_SERVICE/u', 'FAIL_READY_ONCE/u', 'FAIL_DB/u'].filter(Boolean).join(':'),
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
});

test('boot recovery fails closed when a host service or DB query is unavailable', { skip: !linuxBashAvailable }, (t) => {
  const service = runRecovery(t, { FAIL_SERVICE: 'k3s.service' });
  assert.notEqual(service.result.status, 0);
  assert.doesNotMatch(service.trace, /kubectl/);

  const database = runRecovery(t, { FAIL_DB: '1' });
  assert.notEqual(database.result.status, 0);
  assert.match(database.result.stderr, /database is not reachable/);
});
