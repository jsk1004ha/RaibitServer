import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { mkdir, writeFile, readFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { EvidenceIdentitySchema, EvidenceFragmentSchema } from '../../../packages/schemas/src/production-evidence.ts';
import { EvidenceError, digest, assertRedacted, readJson } from './operator-inputs.mjs';
import { assertFresh } from './manifest.mjs';

export async function createRun(parent, identity, startedAt = new Date().toISOString()) {
  const parsed = EvidenceIdentitySchema.safeParse(identity);
  if (!parsed.success) throw new EvidenceError('invalid_schema');
  assertFresh(startedAt, startedAt);
  const root = await realpath(parent);
  const directory = path.join(root, parsed.data.runId);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new EvidenceError('reused_directory');
    throw error;
  }
  await writeFile(path.join(directory, 'run.json'), JSON.stringify({ schema: 'raibitserver.evidence-run/v1', identity: parsed.data, startedAt }), { flag: 'wx', mode: 0o600 });
  return directory;
}
export async function checkRun(directory, manifest) {
  const receipt = await readJson(path.join(directory, 'run.json'), 'missing_run');
  if (receipt.schema !== 'raibitserver.evidence-run/v1' || digest(receipt.identity) !== digest(manifest.identity) || receipt.startedAt !== manifest.startedAt || path.basename(directory) !== manifest.identity.runId) throw new EvidenceError('identity_mismatch');
  assertFresh(receipt.startedAt, manifest.observedAt);
}
export async function writeFragment(directory, value) {
  assertRedacted(value);
  const parsed = EvidenceFragmentSchema.safeParse(value);
  if (!parsed.success) throw new EvidenceError('invalid_schema');
  const receipt = await readJson(path.join(directory, 'run.json'), 'missing_run');
  await checkRun(directory, { identity: parsed.data.identity, startedAt: receipt.startedAt, observedAt: parsed.data.observedAt });
  try { await writeFile(path.join(directory, `${parsed.data.component}.json`), JSON.stringify(parsed.data), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new EvidenceError('reused_fragment');
    throw error;
  }
}
export async function verifyArtifacts(directory, manifest) {
  const root = await realpath(directory);
  for (const artifact of manifest.fragments.flatMap(({ artifacts }) => artifacts)) {
    const target = path.resolve(root, artifact.path);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new EvidenceError('invalid_artifact');
    let resolved;
    try { resolved = await realpath(target); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new EvidenceError('missing_artifact');
      throw error;
    }
    if (resolved !== target || !(await lstat(target)).isFile()) throw new EvidenceError('invalid_artifact');
    const bytes = await readFile(target);
    if (!bytes.length || digest(bytes) !== artifact.sha256) throw new EvidenceError('artifact_digest_mismatch');
    assertRedacted(bytes.toString('utf8'));
    if (!manifest.fixture && /"fixture"\s*:\s*true/.test(bytes.toString('utf8'))) throw new EvidenceError('fixture_not_release_evidence');
  }
}

function boundedTimeout(deadlineAt, requested) {
  const remaining = Date.parse(deadlineAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new EvidenceError('step_deadline_exceeded');
  return Math.min(remaining, requested ?? remaining);
}

function safeRelativeArtifact(component, name) {
  if (!['local', 'cluster', 'lifecycle', 'resources', 'operations'].includes(component)
    || !/^[a-z0-9][a-z0-9-]{0,63}\.json$/.test(name)) throw new EvidenceError('invalid_artifact');
  return `artifacts/${component}/${name}`;
}

export function createRunnerContext(runDirectory, deadlineAt, clock = { now: () => new Date() }) {
  const now = () => {
    const value = clock.now();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  };
  return Object.freeze({
    now,
    async executeFile(file, args, options = {}) {
      if (typeof file !== 'string' || !file || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new EvidenceError('invalid_command');
      assertRedacted(args);
      if (options.env !== undefined) assertRedacted(options.env);
      const timeoutMs = boundedTimeout(deadlineAt, options.timeoutMs);
      const startedAt = now();
      const child = spawn(file, args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      const exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => resolve(code ?? 1));
      }).finally(() => clearTimeout(timer));
      assertRedacted(stdout); assertRedacted(stderr);
      return Object.freeze({ exitCode, stdout, stderr, startedAt, observedAt: now() });
    },
    async requestJson(request) {
      const url = new URL(request.url);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new EvidenceError('invalid_request');
      if (request.headers && Object.keys(request.headers).some((name) => /authorization|cookie|token|secret|api-key/i.test(name))) throw new EvidenceError('redaction');
      const body = request.body === undefined ? undefined : Buffer.from(JSON.stringify(request.body));
      if (body) assertRedacted(body.toString('utf8'));
      const timeoutMs = boundedTimeout(deadlineAt, request.timeoutMs);
      return await new Promise((resolve, reject) => {
        const client = url.protocol === 'https:' ? https : http;
        const outgoing = client.request(url, { method: request.method, headers: request.headers, signal: AbortSignal.timeout(timeoutMs) }, (response) => {
          let bytes = '';
          response.setEncoding('utf8'); response.on('data', (chunk) => { bytes += chunk; });
          response.on('end', () => {
            try { assertRedacted(bytes); resolve(Object.freeze({ statusCode: response.statusCode ?? 0, body: bytes ? JSON.parse(bytes) : null, observedAt: now() })); }
            catch (error) { reject(error); }
          });
        });
        outgoing.once('error', reject);
        if (body) outgoing.write(body);
        outgoing.end();
      });
    },
    async writeArtifact(component, name, value) {
      assertRedacted(value);
      const relative = safeRelativeArtifact(component, name);
      const target = path.join(runDirectory, ...relative.split('/'));
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const bytes = `${JSON.stringify(value)}\n`;
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
      return Object.freeze({ path: relative, sha256: digest(bytes), redacted: true });
    },
  });
}
