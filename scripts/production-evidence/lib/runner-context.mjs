import { spawn } from 'node:child_process';
import https from 'node:https';
import { checkServerIdentity, rootCertificates } from 'node:tls';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertRedacted, digest, EvidenceError } from './operator-inputs.mjs';
import { resolvePublicHttpsTarget } from './public-endpoint.mjs';
import { AUTH_BOOTSTRAP } from './authenticated-client.mjs';
import { KUBE_PROJECTIONS } from './authenticated-client-kubernetes.mjs';

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_TIMEOUT_MS = 30_000;
const MAX_STDIN_BYTES = 256 * 1024;

function commandStdin(file, args, input) {
  if (input === undefined) {
    if (args.some((arg, index) => arg === '-f' && args[index + 1] === '-')) throw new EvidenceError('invalid_command');
    return undefined;
  }
  const create = args.length === 3 || (args.length === 5 && args[3] === '-o' && args[4] === KUBE_PROJECTIONS.identity);
  const creating = create && args[0] === 'create' && args[1] === '-f' && args[2] === '-';
  const resourceUri = /^\/(?:api\/v1\/namespaces\/[^/]+\/(?:pods|services|configmaps|secrets|serviceaccounts|persistentvolumeclaims)|apis\/apps\/v1\/namespaces\/[^/]+\/(?:deployments|daemonsets|replicasets|statefulsets)|apis\/batch\/v1\/namespaces\/[^/]+\/(?:jobs|cronjobs)|apis\/networking\.k8s\.io\/v1\/namespaces\/[^/]+\/networkpolicies|apis\/rbac\.authorization\.k8s\.io\/v1\/namespaces\/[^/]+\/(?:roles|rolebindings))\/[^/]+$/;
  const deleting = args.length === 5 && args[0] === 'delete' && args[1] === '--raw' && args[3] === '-f' && args[4] === '-'
    && resourceUri.test(args[2]) && args[2].split('/').slice(-3).filter((_, index) => index !== 1)
      .every((segment) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(segment));
  if (file !== 'kubectl' || (!creating && !deleting) || (typeof input !== 'string' && !Buffer.isBuffer(input))
    || Buffer.byteLength(input) === 0 || Buffer.byteLength(input) > MAX_STDIN_BYTES) throw new EvidenceError('invalid_command');
  const bytes = Buffer.from(input);
  const text = bytes.toString('utf8');
  let value;
  try { value = JSON.parse(text); } catch { throw new EvidenceError('invalid_command'); }
  const json = JSON.stringify(value);
  if (!Buffer.from(text).equals(bytes) || (text !== json && text !== `${json}\n`) || !value || Array.isArray(value)
    || typeof value !== 'object') throw new EvidenceError('invalid_command');
  if (deleting) {
    if (Object.keys(value).length !== 3 || value.apiVersion !== 'v1' || value.kind !== 'DeleteOptions'
      || !value.preconditions || Object.keys(value.preconditions).length !== 2
      || !['uid', 'resourceVersion'].every((key) => typeof value.preconditions[key] === 'string'
        && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value.preconditions[key]))) throw new EvidenceError('invalid_command');
  } else if (!((value.kind === 'Pod' && value.apiVersion === 'v1')
    || (value.kind === 'NetworkPolicy' && value.apiVersion === 'networking.k8s.io/v1'))) throw new EvidenceError('invalid_command');
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === 'string') { if (current !== AUTH_BOOTSTRAP) assertRedacted(current); continue; }
    if (!current || typeof current !== 'object') continue;
    for (const [key, child] of Object.entries(current)) {
      if (/^(?:data|stringData|environment)$/i.test(key) || (key === 'kind' && child === 'Secret')) throw new EvidenceError('redaction');
      if (/password|token|secret|credential|authorization|cookie|api.?key|private.?key/i.test(key)
        && key !== 'secretKeyRef' && !(key === 'automountServiceAccountToken' && child === false)) throw new EvidenceError('redaction');
      if (key === 'env' && (!Array.isArray(child) || child.some((entry) => !entry || Object.keys(entry).length !== 2
        || typeof entry.name !== 'string' || !entry.valueFrom || Object.keys(entry.valueFrom).length !== 1
        || !entry.valueFrom.secretKeyRef || Object.keys(entry.valueFrom.secretKeyRef).some((name) => !['name', 'key', 'optional'].includes(name))
        || typeof entry.valueFrom.secretKeyRef.name !== 'string' || typeof entry.valueFrom.secretKeyRef.key !== 'string'
        || (entry.valueFrom.secretKeyRef.optional !== undefined && typeof entry.valueFrom.secretKeyRef.optional !== 'boolean')))) throw new EvidenceError('redaction');
      pending.push(child);
    }
  }
  return bytes;
}

function boundedTimeout(deadlineAt, requested, now) {
  const remaining = Date.parse(deadlineAt) - Date.parse(now());
  if (!Number.isFinite(remaining) || remaining <= 0) throw new EvidenceError('step_deadline_exceeded');
  return Math.min(remaining, requested ?? remaining);
}

function safeRelativeArtifact(component, name) {
  if (!['local', 'cluster', 'lifecycle', 'resources', 'operations', 'domains', 'cleanup'].includes(component)
    || !/^[a-z0-9][a-z0-9-]{0,63}\.json$/.test(name)) throw new EvidenceError('invalid_artifact');
  return component === 'cleanup' ? `cleanup/${name}` : `artifacts/${component}/${name}`;
}

function safeHeaders(value) {
  if (value === undefined) return {};
  if (value === null || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length > 32) throw new EvidenceError('invalid_request');
  const headers = {};
  for (const [name, entry] of Object.entries(value)) {
    const lower = name.toLowerCase();
    if (/authorization|cookie|token|secret|api-key/.test(lower)) throw new EvidenceError('redaction');
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(lower) || /^(?:host|content-length|connection|transfer-encoding|upgrade|proxy-)/.test(lower)
      || typeof entry !== 'string' || entry.length > 4096 || /[\r\n]/.test(entry)) throw new EvidenceError('invalid_request');
    assertRedacted(entry);
    headers[lower] = entry;
  }
  return headers;
}

function jsonBody(value) {
  if (value === undefined) return undefined;
  let text;
  try { text = JSON.stringify(value); }
  catch (error) { if (error instanceof TypeError) throw new EvidenceError('invalid_request'); throw error; }
  if (text === undefined || Buffer.byteLength(text) > MAX_REQUEST_BYTES) throw new EvidenceError('invalid_request');
  assertRedacted(text);
  return Buffer.from(text);
}

function assertPublicResponseSafe(value) {
  assertRedacted(value);
  const text = JSON.stringify(value);
  if (/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(text)
    || /\b(?:sk|pk)_(?:live|prod)_[A-Za-z0-9_-]{12,}\b/i.test(text)) throw new EvidenceError('redaction');
}

export function createRunnerContext(runDirectory, deadlineAt, clock = { now: () => new Date() }, adapters = {}) {
  if ((adapters.lookup !== undefined && typeof adapters.lookup !== 'function')
    || (adapters.request !== undefined && typeof adapters.request !== 'function')
    || (adapters.spawn !== undefined && typeof adapters.spawn !== 'function')) throw new EvidenceError('invalid_request');
  const requestAdapter = adapters.request ?? https.request;
  const spawnAdapter = adapters.spawn ?? spawn;
  const inheritedNames = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL'];
  const inherited = Object.fromEntries(inheritedNames.filter((name) => typeof process.env[name] === 'string').map((name) => [name, process.env[name]]));
  const now = () => {
    const value = clock.now();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  };
  return Object.freeze({
    now,
    async executeFile(file, args, options = {}) {
      if (typeof file !== 'string' || !file || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new EvidenceError('invalid_command');
      if (!options || typeof options !== 'object' || Array.isArray(options)
        || Object.keys(options).some((key) => !['cwd', 'env', 'timeoutMs', 'stdin'].includes(key))
        || (options.cwd !== undefined && typeof options.cwd !== 'string')
        || (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1))) throw new EvidenceError('invalid_command');
      assertRedacted(args);
      const stdin = commandStdin(file, args, options.stdin);
      if (options.env !== undefined) {
        if (!options.env || typeof options.env !== 'object' || Array.isArray(options.env)
          || Object.values(options.env).some((value) => typeof value !== 'string')) throw new EvidenceError('invalid_command');
        if (Object.keys(options.env).some((name) => /password|token|secret|credential|authorization|api[_-]?key|private[_-]?key/i.test(name))) throw new EvidenceError('redaction');
        assertRedacted(options.env);
      }
      const timeoutMs = boundedTimeout(deadlineAt, options.timeoutMs, now);
      const startedAt = now();
      const child = spawnAdapter(file, args, { cwd: options.cwd, env: { ...inherited, ...(options.env ?? {}) }, shell: false, windowsHide: true, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      let outputExceeded = false;
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      const append = (target, chunk) => {
        const combined = target + chunk;
        if (Buffer.byteLength(combined) > 4 * 1024 * 1024) { outputExceeded = true; child.kill('SIGKILL'); }
        return combined.slice(0, 4 * 1024 * 1024);
      };
      child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
      child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
      const exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => resolve(code ?? 1));
        if (stdin !== undefined) {
          child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') { child.kill('SIGKILL'); reject(error); } });
          child.stdin.end(stdin);
        }
      }).finally(() => clearTimeout(timer));
      if (timedOut) throw new EvidenceError('command_timeout');
      if (outputExceeded) throw new EvidenceError('command_output_limit');
      assertRedacted(stdout); assertRedacted(stderr);
      return Object.freeze({ exitCode, stdout, stderr, startedAt, observedAt: now() });
    },
    async requestJson(request) {
      const allowedKeys = ['method', 'url', 'headers', 'body', 'timeoutMs'];
      if (!request || Array.isArray(request) || typeof request !== 'object' || Object.keys(request).some((key) => !allowedKeys.includes(key))
        || !['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method)
        || (request.method === 'GET' && request.body !== undefined)
        || (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > MAX_REQUEST_TIMEOUT_MS))) {
        throw new EvidenceError('invalid_request');
      }
      const headers = safeHeaders(request.headers);
      const body = jsonBody(request.body);
      const target = await resolvePublicHttpsTarget(request.url, adapters.lookup);
      const timeoutMs = boundedTimeout(deadlineAt, request.timeoutMs ?? MAX_REQUEST_TIMEOUT_MS, now);
      const outgoingHeaders = { ...headers, host: target.url.host, accept: headers.accept ?? 'application/json' };
      if (body !== undefined) {
        outgoingHeaders['content-type'] = headers['content-type'] ?? 'application/json';
        outgoingHeaders['content-length'] = String(body.byteLength);
      }
      return await new Promise((resolve, reject) => {
        const options = { protocol: 'https:', hostname: target.address, family: target.family, port: 443,
          path: `${target.url.pathname}${target.url.search}`, method: request.method, headers: outgoingHeaders,
          rejectUnauthorized: true, checkServerIdentity, ca: rootCertificates, signal: AbortSignal.timeout(timeoutMs) };
        if (target.servername !== undefined) options.servername = target.servername;
        const outgoing = requestAdapter(options, (response) => {
          if (response.statusCode >= 300 && response.statusCode < 400) {
            response.resume(); reject(new EvidenceError('redirect_not_allowed')); return;
          }
          if (Object.keys(response.headers ?? {}).some((name) => /authorization|set-cookie|token|secret|api-key/i.test(name))) {
            response.resume(); reject(new EvidenceError('redaction')); return;
          }
          let bytes = '';
          response.once('error', reject);
          response.setEncoding('utf8'); response.on('data', (chunk) => {
            bytes += chunk;
            if (Buffer.byteLength(bytes) > MAX_RESPONSE_BYTES) response.destroy(new EvidenceError('response_output_limit'));
          });
          response.on('end', async () => {
            try {
              const parsed = bytes ? JSON.parse(bytes) : null;
              assertPublicResponseSafe(parsed);
              resolve(Object.freeze({ statusCode: response.statusCode ?? 0, body: parsed, observedAt: now() }));
            } catch (error) { reject(error); }
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
