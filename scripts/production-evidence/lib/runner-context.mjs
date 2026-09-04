import { spawn } from 'node:child_process';
import https from 'node:https';
import { checkServerIdentity, rootCertificates } from 'node:tls';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertRedacted, digest, EvidenceError } from './operator-inputs.mjs';
import { resolvePublicHttpsTarget } from './public-endpoint.mjs';

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_TIMEOUT_MS = 30_000;

function boundedTimeout(deadlineAt, requested, now) {
  const remaining = Date.parse(deadlineAt) - Date.parse(now());
  if (!Number.isFinite(remaining) || remaining <= 0) throw new EvidenceError('step_deadline_exceeded');
  return Math.min(remaining, requested ?? remaining);
}

function safeRelativeArtifact(component, name) {
  if (!['local', 'cluster', 'lifecycle', 'resources', 'operations', 'cleanup'].includes(component)
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
    || (adapters.request !== undefined && typeof adapters.request !== 'function')) throw new EvidenceError('invalid_request');
  const requestAdapter = adapters.request ?? https.request;
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
      assertRedacted(args);
      if (options.env !== undefined) {
        if (Object.keys(options.env).some((name) => /password|token|secret|credential|authorization|api[_-]?key|private[_-]?key/i.test(name))) throw new EvidenceError('redaction');
        assertRedacted(options.env);
      }
      const timeoutMs = boundedTimeout(deadlineAt, options.timeoutMs, now);
      const startedAt = now();
      const child = spawn(file, args, { cwd: options.cwd, env: { ...inherited, ...(options.env ?? {}) }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      const exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => resolve(code ?? 1));
      }).finally(() => clearTimeout(timer));
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
