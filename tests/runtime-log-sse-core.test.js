import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  decodeServiceLogResumeToken,
  encodeServiceLogResumeToken,
  startBoundedSseStream,
} from '../packages/core/src/sse.ts';

test('Given accepted and rejected SSE writes, When cursors advance, Then only accepted payloads become resume IDs', async () => {
  const req = new EventEmitter();
  const res = new ThrowingResponse(3);
  startBoundedSseStream({
    req,
    res,
    event: 'service.logs.snapshot',
    preprojected: true,
    initialPayload: { logs: [], logCursor: 'cursor-a', stream: { retryMs: 10, heartbeatMs: 100, maxLifetimeMs: 100, slowClientTimeoutMs: 20 } },
    eventId: (payload) => String(payload.logCursor),
    load: async () => ({ logs: [{ id: 'log-b' }], logCursor: 'cursor-b' }),
  });
  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.match(res.chunks.join(''), /id: cursor-a/);
  assert.doesNotMatch(res.chunks.join(''), /id: cursor-b/);
});

test('Given a buffered SSE write, When drain resumes polling, Then the accepted cursor prevents duplicate reloads', async () => {
  const req = new EventEmitter();
  const res = new BackpressureResponse();
  const loadedCursors = [];
  startBoundedSseStream({
    req,
    res,
    event: 'service.logs.snapshot',
    preprojected: true,
    initialPayload: { logs: [], logCursor: 'cursor-a', stream: { retryMs: 10, heartbeatMs: 100, maxLifetimeMs: 200, slowClientTimeoutMs: 100 } },
    eventId: (payload) => String(payload.logCursor),
    load: async (cursors) => {
      loadedCursors.push(cursors.logCursor);
      return loadedCursors.length === 1
        ? { logs: [{ id: 'log-b' }], logCursor: 'cursor-b' }
        : { logs: [], logCursor: cursors.logCursor };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  res.emit('drain');
  await new Promise((resolve) => setTimeout(resolve, 25));
  req.emit('close');

  assert.deepEqual(loadedCursors.slice(0, 2), ['cursor-a', 'cursor-b']);
  assert.equal((res.chunks.join('').match(/log-b/g) || []).length, 1);
});

test('Given a deployment stream, When emitted, Then its legacy timestamp-sequence ID remains compatible', () => {
  const req = new EventEmitter();
  const res = new ThrowingResponse(Number.POSITIVE_INFINITY);
  startBoundedSseStream({
    req,
    res,
    event: 'deployment.snapshot',
    initialPayload: { deployment: { id: 'dep-1' }, logs: [], events: [], stream: { retryMs: 100, heartbeatMs: 100, maxLifetimeMs: 30, slowClientTimeoutMs: 20 } },
    load: async () => ({ logs: [], events: [] }),
  });
  assert.match(res.chunks.join(''), /id: \d+-1/);
  req.emit('close');
});

test('Given authorization is revoked during polling, When loading fails, Then the stream emits an error and closes', async () => {
  const res = new ThrowingResponse(Number.POSITIVE_INFINITY);
  startBoundedSseStream({
    req: new EventEmitter(),
    res,
    event: 'service.logs.snapshot',
    preprojected: true,
    initialPayload: { logs: [], logCursor: 'cursor-a', stream: { retryMs: 10, heartbeatMs: 100, maxLifetimeMs: 200, slowClientTimeoutMs: 20 } },
    eventId: (payload) => String(payload.logCursor),
    terminalError: (error) => error instanceof AuthorizationRevoked,
    load: async () => { throw new AuthorizationRevoked(); },
  });
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.match(res.chunks.join(''), /event: stream\.error/);
  assert.equal(res.writableEnded, true);
});

test('service resume tokens are versioned, opaque, and scope-bound', () => {
  const token = encodeServiceLogResumeToken(
    { projectId: 'project-1', serviceId: 'service-1' },
    { serviceCursor: 'service-version', logCursor: Buffer.from(JSON.stringify({ v: 1, at: '2026-09-04T00:00:00.000Z', id: 'log-1' })).toString('base64url') },
  );
  const decoded = decodeServiceLogResumeToken(token, { projectId: 'project-1', serviceId: 'service-1' });
  assert.equal(decoded.serviceCursor, 'service-version');
  assert.equal(decoded.logCursor?.id, 'log-1');
  assert.throws(() => decodeServiceLogResumeToken(token, { projectId: 'project-1', serviceId: 'service-2' }), /resume token/i);
});

class ThrowingResponse extends EventEmitter {
  constructor(throwAt) {
    super();
    this.throwAt = throwAt;
    this.chunks = [];
    this.headersSent = false;
    this.writableEnded = false;
    this.destroyed = false;
  }

  status() { return this; }
  setHeader() {}
  flushHeaders() {}
  write(chunk) {
    if (this.chunks.length + 1 === this.throwAt) throw new Error('socket closed');
    this.chunks.push(String(chunk));
    return true;
  }
  end() { this.writableEnded = true; }
}

class BackpressureResponse extends ThrowingResponse {
  write(chunk) {
    this.chunks.push(String(chunk));
    return this.chunks.length !== 3;
  }
}

class AuthorizationRevoked extends Error {}
