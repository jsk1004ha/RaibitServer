import assert from 'node:assert/strict';

export const response = (statusCode, body) => ({ statusCode, body, observedAt: '2026-09-04T00:00:01.000Z' });
export const ok = (stdout) => ({ exitCode: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '', startedAt: '2026-09-04T00:00:00.000Z', observedAt: '2026-09-04T00:00:01.000Z' });

export function createLifecycleTransport({ control = [], publicHttp = [], files = [], calls = [] } = {}) {
  const protectedRequests = [...control], publicRequests = [...publicHttp], commands = [...files];
  const next = (queue, request, fallback) => { const item = queue.shift(); return typeof item === 'function' ? item(request) : item ?? fallback; };
  const bounded = (request) => assert.ok(Number.isInteger(request.timeoutMs) && request.timeoutMs > 0 && request.timeoutMs <= 30_000, 'HTTP timeout must fit the real RunnerContext contract');
  return {
    calls,
    controlPlaneJson: async (request) => { bounded(request); calls.push({ kind: 'control', request }); return next(protectedRequests, request, response(404, {})); },
    requestJson: async (request) => { bounded(request); calls.push({ kind: 'public', request }); return next(publicRequests, request, response(500, {})); },
    executeFile: async (file, args, options) => { calls.push({ kind: 'file', file, args, options }); return next(commands, { file, args, options }, ok('')); },
  };
}
