import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { APPROVED_INPUT_SHA256, OPERATOR_CONTRACT_DIGEST, assertRedacted, digest, environmentFingerprint, EvidenceError } from './operator-inputs.mjs';

const exec = promisify(execFile);

export async function immutableJson(runDirectory, relative, value) {
  assertRedacted(value);
  const target = path.join(runDirectory, ...relative.split('/'));
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const bytes = `${JSON.stringify(value)}\n`;
  await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  return Object.freeze({ path: relative, sha256: digest(bytes), redacted: true });
}

async function command(file, args, cwd) {
  try {
    const result = await exec(file, args, { cwd, encoding: 'utf8', timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 });
    return result.stdout.trim();
  } catch (error) {
    if (error instanceof Error) throw new EvidenceError('environment_preflight_failed');
    throw error;
  }
}

async function migrationDigest(root) {
  const base = path.join(root, 'prisma', 'migrations');
  const names = (await readdir(base, { withFileTypes: true })).filter((item) => item.isDirectory()).map(({ name }) => name).sort();
  const parts = [];
  for (const name of names) {
    const file = path.join(base, name, 'migration.sql');
    parts.push(name, await readFile(file, 'utf8'));
  }
  return digest(parts);
}

export async function buildIdentity({ inputs, runId, root, fixture }) {
  const sourceCommitSha = await command('git', ['rev-parse', 'HEAD'], root);
  if (!/^[a-f0-9]{40}$/.test(sourceCommitSha)) throw new EvidenceError('environment_preflight_failed');
  const context = inputs.selectors.RAIBITSERVER_RELEASE_KUBE_CONTEXT;
  let clusterUid = `fixture-${runId}`;
  let apiServer = 'https://fixture.invalid';
  if (!fixture) {
    clusterUid = await command('kubectl', ['--context', context, 'get', 'namespace', 'kube-system', '-o', 'jsonpath={.metadata.uid}'], root);
    apiServer = await command('kubectl', ['config', 'view', '--raw', '--minify', '--context', context, '-o', 'jsonpath={.clusters[0].cluster.server}'], root);
  }
  const registry = inputs.selectors.RAIBITSERVER_RELEASE_REGISTRY_REPOSITORY;
  const fingerprint = environmentFingerprint({ clusterUid, apiServer,
    baseDomain: inputs.selectors.RAIBITSERVER_RELEASE_BASE_DOMAIN,
    registryHost: registry.slice(0, registry.indexOf('/')),
    namespacePrefix: inputs.selectors.RAIBITSERVER_RELEASE_NAMESPACE_PREFIX });
  return Object.freeze({ runId, environmentFingerprint: fingerprint, sourceCommitSha, migrationDigest: await migrationDigest(root),
    approvedInputSha256: APPROVED_INPUT_SHA256, operatorContractDigest: OPERATOR_CONTRACT_DIGEST,
    operatorInputFingerprint: digest(inputs) });
}

export async function inspectSecretReference(reference, inputs, root) {
  const context = inputs.selectors.RAIBITSERVER_RELEASE_KUBE_CONTEXT;
  const name = reference.kind === 'helm-existingSecret' ? reference.existingSecret : reference.secretKeyRef.name;
  const requiredKeys = reference.kind === 'helm-existingSecret' ? reference.keys : [reference.secretKeyRef.key];
  const uid = await command('kubectl', ['--context', context, '--namespace', reference.namespace, 'get', 'secret', name, '-o', 'jsonpath={.metadata.uid}'], root);
  const keysText = await command('kubectl', ['--context', context, '--namespace', reference.namespace, 'get', 'secret', name,
    '-o', 'go-template={{range $key, $value := .data}}{{$key}}{{"\\n"}}{{end}}'], root);
  const keys = new Set(keysText.split(/\r?\n/).filter(Boolean));
  return Object.freeze({ available: uid.length > 0, uid, keysPresent: requiredKeys.every((key) => keys.has(key)) });
}

export async function executeFoundation(name, context, root) {
  const commands = name === 'local'
    ? [['pnpm', ['test']], ['pnpm', ['typecheck']], ['pnpm', ['lint']], ['pnpm', ['prisma:validate']],
      ['node', ['scripts/check-structure.js']], ['node', ['src/cli.js', 'validate', 'examples/project.json']],
      ['node', ['src/cli.js', 'manifest', 'examples/project.json']], ['node', ['src/cli.js', 'compose', 'examples/docker-compose.yml']],
      ['pnpm', ['e2e:dry']], ...['builder', 'orchestrator', 'provisioner', 'log-ingester', 'metrics-ingester', 'registry-broker']
        .flatMap((service) => [['go', ['test', './...'], path.join(root, 'services', service)], ['go', ['build', './...'], path.join(root, 'services', service)]])]
    : [['bash', ['scripts/live-helm-e2e.sh']]];
  const observations = [];
  for (const [file, args, cwd = root] of commands) {
    try {
      const result = await context.executeFile(file, args, { cwd, timeoutMs: name === 'local' ? 30 * 60_000 : 60 * 60_000 });
      observations.push({ command: [file, ...args], exitCode: result.exitCode, stdoutSha256: digest(result.stdout), stderrSha256: digest(result.stderr), startedAt: result.startedAt, observedAt: result.observedAt });
      if (result.exitCode !== 0) break;
    } catch (error) {
      observations.push({ command: [file, ...args], exitCode: null, reason: error instanceof EvidenceError ? error.reason : 'command_failed', observedAt: context.now() });
      break;
    }
  }
  const status = observations.length === commands.length && observations.every(({ exitCode }) => exitCode === 0) ? 'PASS' : 'FAIL';
  const artifact = await context.writeArtifact(name, name === 'local' ? 'baseline.json' : 'live-helm.json', { schema: 'raibitserver.production-evidence-foundation/v1', name, status, observations, redacted: true });
  return Object.freeze({ status, reason: status === 'PASS' ? null : `${name}_checks_failed`, assertion: name === 'local' ? 'local_checks' : 'kind_helm_reconciliation', artifact });
}
