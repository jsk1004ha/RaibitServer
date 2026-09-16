import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import {
  RAIBITSERVERClient,
  createRuntimeLogStreamRequest,
  runtimeLogStreamPath,
  runtimeLogStreamUrl,
} from '../src/index.ts';

const snapshot = {
  service: null,
  logs: [],
  serviceCursor: 'service-cursor-1',
  logCursor: null,
  stream: { retryMs: 1_000, heartbeatMs: 15_000, maxLifetimeMs: 900_000, slowClientTimeoutMs: 5_000 },
};

test('Given one service stream request, when it is built, then the opaque cursor stays a header and the service path is isolated', () => {
  const first = createRuntimeLogStreamRequest(
    { baseUrl: 'https://api.example.test/', token: 'session-token' },
    { serviceId: 'service/alpha', lastEventId: 'opaque:v1/42' },
  );
  const second = runtimeLogStreamUrl('https://api.example.test', { serviceId: 'service/beta' });

  assert.equal(first.url, 'https://api.example.test/services/service%2Falpha/logs/stream');
  assert.equal(first.headers.accept, 'text/event-stream');
  assert.equal(first.headers.authorization, 'Bearer session-token');
  assert.equal(first.headers['last-event-id'], 'opaque:v1/42');
  assert.equal(new URL(first.url).search, '');
  assert.equal(second, 'https://api.example.test/services/service%2Fbeta/logs/stream');
  assert.equal(runtimeLogStreamPath({ serviceId: 'service/beta' }), '/services/service%2Fbeta/logs/stream');
});

test('Given a valid service SSE response, when the typed operation resumes it, then it sends Last-Event-ID and returns the parsed snapshot', async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, lastEventId: request.headers['last-event-id'], accept: request.headers.accept });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`id: opaque:v1/43\r\nevent: service.logs.snapshot\r\ndata: ${JSON.stringify(snapshot)}\r\n\r\n`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const client = new RAIBITSERVERClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: 'session-token' });

  try {
    const result = await client.operations['services-logs-stream'](
      { path: { serviceId: 'service/alpha' }, query: {}, body: {} },
      { lastEventId: 'opaque:v1/42' },
    );
    assert.deepEqual(result, snapshot);
  } finally {
    server.close();
    await once(server, 'close');
  }

  assert.deepEqual(requests, [{
    url: '/services/service%2Falpha/logs/stream',
    lastEventId: 'opaque:v1/42',
    accept: 'text/event-stream',
  }]);
});

test('Given a hostile cursor, when a stream request is built, then it is rejected before any HTTP request', () => {
  assert.throws(
    () => createRuntimeLogStreamRequest({ baseUrl: 'https://api.example.test' }, { serviceId: 'service-a', lastEventId: 'cursor\nforged' }),
    /lastEventId/,
  );
});
