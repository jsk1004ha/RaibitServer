import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { checkServerIdentity, rootCertificates } from 'node:tls';
import path from 'node:path';
import { resolvePublicHttpsTarget } from '../scripts/production-evidence/lib/public-endpoint.mjs';
import { createRunnerContext } from '../scripts/production-evidence/lib/runner-context.mjs';

const deadline = () => new Date(Date.now() + 60_000).toISOString();

function responseAdapter(statusCode, payload, capture) {
  return (options, callback) => {
    capture.options = options;
    const outgoing = new EventEmitter();
    outgoing.write = () => undefined;
    outgoing.end = () => {
      const response = Readable.from([payload]);
      response.statusCode = statusCode;
      response.headers = statusCode >= 300 && statusCode < 400 ? { location: 'https://redirect.example/' } : {};
      callback(response);
    };
    return outgoing;
  };
}

test('Given representative non-public literal addresses, When the endpoint is resolved, Then each listed address is rejected before I/O', async () => {
  const forbidden = [
    '127.0.0.1', '10.1.2.3', '100.64.0.1', '169.254.1.1', '172.16.0.1', '192.168.1.1',
    '0.0.0.0', '192.0.2.1', '192.88.99.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '[::]', '[::1]', '[fc00::1]', '[fe80::1]', '[ff02::1]', '[2001:db8::1]',
    '[::ffff:192.168.1.1]', '[::ffff:c0a8:101]',
    '[64:ff9b::a00:1]', '[64:ff9b:1::a00:1]', '[100:0:0:1::1]', '[2001::1]', '[2001:2::1]',
    '[2001:10::1]', '[2002::1]', '[3fff::1]', '[5f00::1]',
  ];
  const lookup = async () => { throw new Error('literal addresses must not use DNS'); };

  for (const address of forbidden) {
    await assert.rejects(resolvePublicHttpsTarget(`https://${address}/`, lookup), { reason: 'invalid_request' });
  }
});

test('Given alternate IPv4 URL spellings, When the URL is canonicalized, Then loopback and private destinations remain rejected', async () => {
  const lookup = async () => { throw new Error('numeric addresses must not use DNS'); };

  for (const url of ['https://0x7f000001/', 'https://0177.0.0.1/', 'https://2130706433/', 'https://127.1/', 'https://0x0a000001/']) {
    await assert.rejects(resolvePublicHttpsTarget(url, lookup), { reason: 'invalid_request' });
  }
});

test('Given internal hostnames, When the endpoint is resolved, Then DNS is never consulted', async () => {
  let lookups = 0;
  const lookup = async () => { lookups += 1; return [{ address: '93.184.216.34', family: 4 }]; };

  for (const hostname of ['localhost', 'api', 'service.local', 'service.internal', 'example.com.']) {
    await assert.rejects(resolvePublicHttpsTarget(`https://${hostname}/`, lookup), { reason: 'invalid_request' });
  }
  assert.equal(lookups, 0);
});

test('Given DNS with any private answer, When a public name is resolved, Then the entire answer set is rejected', async () => {
  const lookup = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '10.0.0.8', family: 4 },
  ];

  await assert.rejects(resolvePublicHttpsTarget('https://api.example.com/data', lookup), { reason: 'invalid_request' });
});

test('Given DNS answers from special-purpose IPv6 ranges, When a public name is resolved, Then each answer is rejected', async () => {
  const special = ['64:ff9b:1::a00:1', '5f00::1', '2001::1', '2001:2::1', '2002::1', '3fff::1'];

  for (const address of special) {
    const lookup = async () => [{ address, family: 6 }];
    await assert.rejects(resolvePublicHttpsTarget('https://api.example.com/data', lookup), { reason: 'invalid_request' });
  }
});

test('Given IANA-allocated global IPv6 answers, When the endpoint is resolved, Then normal RIR space remains usable', async () => {
  const addresses = ['2606:4700:4700::1111', '2a00:1450:4001:800::200e'];

  for (const address of addresses) {
    const resolved = await resolvePublicHttpsTarget('https://api.example.com/data', async () => [{ address, family: 6 }]);
    assert.equal(resolved.address, address);
  }
});

test('Given globally reachable special IPv6 destinations, When resolved directly or through DNS, Then the precise exceptions remain usable', async () => {
  const direct = await resolvePublicHttpsTarget('https://[2001:3::1]/', async () => { throw new Error('literal must not use DNS'); });
  const dnsResolved = await resolvePublicHttpsTarget('https://api.example.com/data', async () => [{ address: '2001:20::1', family: 6 }]);
  const mapped = await resolvePublicHttpsTarget('https://[::ffff:8.8.8.8]/', async () => { throw new Error('literal must not use DNS'); });
  const translated = await resolvePublicHttpsTarget('https://[64:ff9b::808:808]/', async () => { throw new Error('literal must not use DNS'); });

  assert.equal(direct.address, '2001:3::1');
  assert.equal(dnsResolved.address, '2001:20::1');
  assert.equal(mapped.address, '::ffff:808:808');
  assert.equal(translated.address, '64:ff9b::808:808');
});

test('Given hostile ambient TLS settings, When requestJson connects, Then it pins the address and explicit built-in trust policy', async (t) => {
  const previousRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  const previousExtraCa = process.env.NODE_EXTRA_CA_CERTS;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  process.env.NODE_EXTRA_CA_CERTS = path.resolve('hostile-ca.pem');
  t.after(() => {
    if (previousRejectUnauthorized === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousRejectUnauthorized;
    if (previousExtraCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = previousExtraCa;
  });
  const capture = {};
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const context = createRunnerContext(path.resolve('run'), deadline(), { now: () => new Date() }, {
    lookup,
    request: responseAdapter(200, '{"status":"READY"}', capture),
  });

  const response = await context.requestJson({ method: 'GET', url: 'https://api.example.com/v1/status?view=summary', timeoutMs: 5_000 });

  assert.deepEqual(response.body, { status: 'READY' });
  assert.equal(capture.options.hostname, '93.184.216.34');
  assert.equal(capture.options.servername, 'api.example.com');
  assert.equal(capture.options.headers.host, 'api.example.com');
  assert.equal(capture.options.path, '/v1/status?view=summary');
  assert.equal(capture.options.rejectUnauthorized, true);
  assert.equal(capture.options.checkServerIdentity, checkServerIdentity);
  assert.equal(capture.options.ca, rootCertificates);
});

test('Given a redirect or token-shaped output, When requestJson receives it, Then it fails closed', async () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const redirected = createRunnerContext(path.resolve('run'), deadline(), { now: () => new Date() }, {
    lookup,
    request: responseAdapter(302, '', {}),
  });
  const tokenResponse = createRunnerContext(path.resolve('run'), deadline(), { now: () => new Date() }, {
    lookup,
    request: responseAdapter(200, '{"value":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature123456"}', {}),
  });

  await assert.rejects(redirected.requestJson({ method: 'GET', url: 'https://api.example.com/' }), { reason: 'redirect_not_allowed' });
  await assert.rejects(tokenResponse.requestJson({ method: 'GET', url: 'https://api.example.com/' }), { reason: 'redaction' });
});

test('Given unsafe request metadata, When requestJson validates the boundary, Then it rejects it before DNS', async () => {
  let lookups = 0;
  const lookup = async () => { lookups += 1; return [{ address: '93.184.216.34', family: 4 }]; };
  const context = createRunnerContext(path.resolve('run'), deadline(), { now: () => new Date() }, { lookup });

  const requests = [
    { method: 'GET', url: 'https://api.example.com/?access_token=secret' },
    { method: 'GET', url: 'https://api.example.com/', headers: { Cookie: 'session=value' } },
    { method: 'GET', url: 'https://api.example.com/', headers: { Host: 'attacker.example' } },
    { method: 'GET', url: 'https://api.example.com:8443/' },
    { method: 'GET', url: 'https://api.example.com/', body: { value: true } },
    { method: 'POST', url: 'https://api.example.com/', timeoutMs: 0 },
  ];
  for (const request of requests) await assert.rejects(context.requestJson(request), { reason: /invalid_request|redaction/ });
  assert.equal(lookups, 0);
});
