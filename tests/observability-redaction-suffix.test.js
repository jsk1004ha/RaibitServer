import test from 'node:test';
import assert from 'node:assert/strict';
import { OBSERVABILITY_LINE_BYTES, sanitizeObservationLine } from '../packages/core/src/observability-redaction.ts';
import { sanitizeLogRecord } from '../packages/core/src/security.ts';
import { projectObservationPayload } from '../packages/core/src/observability-projection.ts';

const canary = 'RaibitAuditCanary_12345';
const cases = [
  ['bare named suffix', `POSTGRES_PASSWORD_PRIMARY=${canary} ready=true`, 'POSTGRES_PASSWORD_PRIMARY=**** ready=true'],
  ['bare numeric suffix', `DATABASE_PASSWORD_1=${canary}`, 'DATABASE_PASSWORD_1=****'],
  ['double-quoted assignment', `POSTGRES_PASSWORD_PRIMARY="${canary} with spaces" ready=true`, 'POSTGRES_PASSWORD_PRIMARY="****" ready=true'],
  ['single-quoted assignment', `DATABASE_PASSWORD_1='${canary} with spaces' ready=true`, "DATABASE_PASSWORD_1='****' ready=true"],
  ['serialized JSON', JSON.stringify({ POSTGRES_PASSWORD_PRIMARY: canary, ok: true }), '{"POSTGRES_PASSWORD_PRIMARY":"****","ok":true}'],
  ['numeric suffix JSON', JSON.stringify({ DATABASE_PASSWORD_1: canary, ok: true }), '{"DATABASE_PASSWORD_1":"****","ok":true}'],
  ['nested serialized JSON', JSON.stringify({ message: JSON.stringify({ POSTGRES_PASSWORD_PRIMARY: canary, ok: true }) }), JSON.stringify({ message: '{"POSTGRES_PASSWORD_PRIMARY":"****","ok":true}' })],
  ['escaped quote in JSON value', JSON.stringify({ DATABASE_PASSWORD_1: `prefix"${canary}`, ok: true }), '{"DATABASE_PASSWORD_1":"****","ok":true}'],
  ['truncated quoted value', `{"POSTGRES_PASSWORD_PRIMARY":"${canary}`, '{"POSTGRES_PASSWORD_PRIMARY":"****"'],
  ['mixed-case hyphen suffix', `Service-Api-Key-Backup=${canary}`, 'Service-Api-Key-Backup=****'],
  ['token suffix', `ACCESS_TOKEN_2=${canary}`, 'ACCESS_TOKEN_2=****'],
  ['secret suffix', `CLIENT_SECRET_BACKUP=${canary}`, 'CLIENT_SECRET_BACKUP=****'],
  ['credential suffix', `APP_CREDENTIAL_SECONDARY=${canary}`, 'APP_CREDENTIAL_SECONDARY=****'],
  ['query suffixes and neighbors', `https://example.test/?page=2&POSTGRES_PASSWORD_PRIMARY=${canary}&DATABASE_PASSWORD_1=${canary}&sort=asc#details`, 'https://example.test/?page=2&POSTGRES_PASSWORD_PRIMARY=****&DATABASE_PASSWORD_1=****&sort=asc#details'],
  ['query suffix before fragment', `https://example.test/?access_token_backup=${canary}#details`, 'https://example.test/?access_token_backup=****'],
  ['empty query suffix', 'https://example.test/?api_key_2=&page=2', 'https://example.test/?api_key_2=****&page=2'],
];

for (const [name, input, expected] of cases) {
  test(`masks suffix-bearing secrets in ${name}`, () => {
    // Given a synthetic credential in a log line, when it crosses the shared sanitizer.
    const result = sanitizeObservationLine(input);
    // Then mask the entire value and preserve surrounding text without echoing it on failure.
    assert.equal(result.line.includes(canary), false, 'synthetic secret must not survive');
    assert.equal(result.line === expected, true, 'masked value and surrounding text must match');
    assert.deepEqual(result.state, { v: 1, pem: false, ...(name === 'truncated quoted value' ? { quote: '"' } : {}) });
  });
}

test('preserves benign text and non-secret assignments', () => {
  // Given ordinary prose, variable names, and query parameters.
  const inputs = [
    'POSTGRES_PASSWORD_PRIMARY rotated successfully; DATABASE_PASSWORD_1 is configured',
    'DATABASE_HOST_PRIMARY=db.internal PORT_1=5432 KEY_VERSION=2 keyboard=us monkey=banana',
    'https://example.test/?page=2&key_version=3&monkey=banana#details',
  ];
  // When sanitizing normal output, then preserve it exactly.
  assert.deepEqual(inputs.map(input => sanitizeObservationLine(input).line), inputs);
});

test('continues masking unsuffixed assignments', () => {
  // Given the neighboring pre-existing secret-name behavior.
  const input = `POSTGRES_PASSWORD=${canary} KEY=${canary} https://example.test/?token=${canary}#details`;
  // When sanitized, then preserve the existing masks, including consuming a trailing fragment.
  const result = sanitizeObservationLine(input);
  assert.equal(result.line === 'POSTGRES_PASSWORD=**** KEY=**** https://example.test/?token=****', true);
});

test('masks complete URL credentials before assignment redaction consumes the authority', () => {
  // Given a valid URI whose password contains an assignment-shaped substring.
  const input = 'postgres://user:URI_PASSWORD_PREFIX-token=P1_INDEPENDENT_CANARY_7f21@host.test/db';
  // When sanitized, then preserve the baseline URL shape while masking the complete userinfo.
  const result = sanitizeObservationLine(input);
  assert.equal(result.line === 'postgres://****:****@host.test/db', true, 'complete URI credential output must match');
});

test('masks a quoted secret crossing the bounded input edge', () => {
  // Given malformed quoted input whose secret starts immediately before the visible byte edge.
  const input = `${'x'.repeat(OBSERVABILITY_LINE_BYTES - 30)} PASSWORD_PRIMARY="${canary.repeat(4)}`;
  // When sanitizing the oversized line, then no boundary fragment leaks and truncation is explicit.
  const result = sanitizeObservationLine(input);
  assert.equal(result.line.includes(canary), false, 'boundary secret must not survive');
  assert.equal(result.line.endsWith(' [truncated]'), true);
  assert.equal(Buffer.byteLength(result.line) <= OBSERVABILITY_LINE_BYTES, true);
});

test('masks URL credentials whose authority terminator is beyond the bounded edge', () => {
  // Given valid credentials whose at-sign is beyond the retained prefix.
  const input = `postgres://user:${canary.repeat(1000)}@host.test/db`;
  // When bounded before expensive output processing, then the retained credential prefix is masked.
  const result = sanitizeObservationLine(input);
  assert.equal(result.line.includes(canary), false, 'truncated URL credentials must not survive');
  assert.equal(result.line.endsWith(' [truncated]'), true);
});

test('masks a JWT whose first delimiter is beyond the bounded edge', () => {
  // Given a valid JWT with a first component larger than the retained prefix.
  const input = `eyJ${canary}${'A'.repeat(OBSERVABILITY_LINE_BYTES)}.payload.signature`;
  // When bounded before expensive output processing, then the retained JWT prefix is masked.
  const result = sanitizeObservationLine(input);
  assert.equal(result.line.includes(canary), false, 'truncated JWT prefix must not survive');
  assert.equal(result.line.endsWith(' [truncated]'), true);
});

test('derives PEM continuation state from markers beyond the bounded output prefix', () => {
  // Given a PEM begin marker beyond the portion retained for output.
  const first = `${'x'.repeat(OBSERVABILITY_LINE_BYTES + 1)}-----BEGIN RSA PRIVATE KEY-----`;
  // When sanitizing that line and its continuation, then state follows the complete source line.
  const started = sanitizeObservationLine(first);
  const ended = sanitizeObservationLine(`${canary}\n-----END RSA PRIVATE KEY-----`, started.state);
  assert.deepEqual(started.state, { v: 1, pem: true, uncertain: true });
  assert.equal(ended.line.includes(canary), false, 'continued PEM content must not survive');
  assert.deepEqual(ended.state, started.state, 'discarded non-PEM tail cannot establish a known boundary');
});

test('continues masking suffixed object fields through sanitizeLogRecord', () => {
  // Given structured fields that already redact correctly.
  const input = { POSTGRES_PASSWORD_PRIMARY: canary, nested: { DATABASE_PASSWORD_1: canary }, ok: true };
  // When crossing the public log-record boundary, then mask only the secret fields.
  const result = sanitizeLogRecord(input);
  assert.equal(JSON.stringify(result) === '{"POSTGRES_PASSWORD_PRIMARY":"****","nested":{"DATABASE_PASSWORD_1":"****"},"ok":true}', true);
});

test('masks suffixed assignments inside record strings through sanitizeLogRecord', () => {
  // Given strings embedded in a structured log record.
  const input = { line: `POSTGRES_PASSWORD_PRIMARY=${canary}`, metadata: [JSON.stringify({ DATABASE_PASSWORD_1: canary, ok: true })] };
  // When crossing the public log-record boundary, then sanitize nested strings too.
  const result = sanitizeLogRecord(input);
  assert.equal(JSON.stringify(result).includes(canary), false, 'record strings must not leak');
  assert.deepEqual(result, { line: 'POSTGRES_PASSWORD_PRIMARY=****', metadata: ['{"DATABASE_PASSWORD_1":"****","ok":true}'] });
});

test('masks suffix-bearing legacy log lines and serialized event metadata in projection', () => {
  // Given complete runtime identity so projection actually sanitizes each line.
  const source = { serviceId: 'service-1', deploymentId: 'deployment-1', podUid: 'pod-1', containerName: 'app', timestamp: '2026-09-12T00:00:00.000Z' };
  const payload = {
    logs: cases.map(([name, line], index) => ({ ...source, podUid: `pod-${index}`, id: `log-${index}`, name, line })),
    events: [{ id: 'event-1', timestamp: source.timestamp, metadata: JSON.stringify({ DATABASE_PASSWORD_1: canary, ok: true }) }],
  };
  // When producing the public payload, then retain useful rows and mask all source secrets.
  const result = projectObservationPayload(payload);
  assert.equal(JSON.stringify(result).includes(canary), false, 'projected payload must not leak');
  assert.deepEqual(result.logs.map(row => row.line), cases.map(([, , expected]) => expected));
  assert.equal(result.events[0].metadata, '{"DATABASE_PASSWORD_1":"****","ok":true}');
});
