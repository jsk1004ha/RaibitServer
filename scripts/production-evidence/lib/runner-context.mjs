import { spawn } from 'node:child_process';
import https from 'node:https';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertRedacted, digest, EvidenceError } from './operator-inputs.mjs';

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

export function createRunnerContext(runDirectory, deadlineAt, clock = { now: () => new Date() }) {
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
      if (!request || Object.keys(request).some((key) => !allowedKeys.includes(key))
        || !['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method)) throw new EvidenceError('invalid_request');
      let url;
      try { url = new URL(request.url); }
      catch (error) { if (error instanceof TypeError) throw new EvidenceError('invalid_request'); throw error; }
      if (url.protocol !== 'https:' || url.username || url.password) throw new EvidenceError('invalid_request');
      if (request.headers && Object.keys(request.headers).some((name) => /authorization|cookie|token|secret|api-key/i.test(name))) throw new EvidenceError('redaction');
      if (request.headers) assertRedacted(request.headers);
      const body = request.body === undefined ? undefined : Buffer.from(JSON.stringify(request.body));
      if (body) assertRedacted(body.toString('utf8'));
      const timeoutMs = boundedTimeout(deadlineAt, request.timeoutMs, now);
      return await new Promise((resolve, reject) => {
        const outgoing = https.request(url, { method: request.method, headers: request.headers, signal: AbortSignal.timeout(timeoutMs) }, (response) => {
          let bytes = '';
          response.once('error', reject);
          response.setEncoding('utf8'); response.on('data', (chunk) => {
            bytes += chunk;
            if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) response.destroy(new EvidenceError('response_output_limit'));
          });
          response.on('end', async () => {
            try {
              const parsed = bytes ? JSON.parse(bytes) : null;
              assertRedacted(parsed);
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
