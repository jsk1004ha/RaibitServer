import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { ApiPermissionError, ApiRetryableError, ApiTerminalError, createOperationsClient } from '../src/operations.ts';

test('Given operation failures, When the typed client receives them, Then retryable, terminal, and permission variants remain distinct', async () => {
  const responses = {
    permission: [403, { statusCode: 403, message: 'Forbidden' }],
    retryable: [503, { statusCode: 503, message: 'temporarily unavailable', code: 'TEMPORARY', retryable: true, terminal: false, permission: false }],
    terminal: [409, { statusCode: 409, message: 'STALE_SNAPSHOT', code: 'STALE_SNAPSHOT', retryable: false, terminal: true, permission: false }],
  };
  const server = http.createServer((request, response) => {
    const kind = request.url.split('/')[1];
    const [status, body] = responses[kind];
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  server.listen(0);
  await once(server, 'listening');

  try {
    const port = server.address().port;
    for (const [kind, ErrorType] of [['permission', ApiPermissionError], ['retryable', ApiRetryableError], ['terminal', ApiTerminalError]]) {
      const client = createOperationsClient({ baseUrl: `http://127.0.0.1:${port}/${kind}` });
      await assert.rejects(client.health({ path: {}, query: {}, body: {} }), (error) => {
        assert.equal(error instanceof ErrorType, true);
        assert.equal(error.permission, kind === 'permission');
        assert.equal(error.retryable, kind === 'retryable');
        assert.equal(error.terminal, kind !== 'retryable');
        assert.equal('operationId' in error.body, false);
        return true;
      });
    }
  } finally {
    server.close();
    await once(server, 'close');
  }
});
