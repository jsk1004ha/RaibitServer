import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sanitizeObservationLine, OBSERVABILITY_LINE_BYTES } from '../packages/core/src/observability-redaction.ts';
import { createObservationProjectionContinuation, projectObservationPayload, observationLogSource } from '../packages/core/src/observability-projection.ts';

const corpus = JSON.parse(readFileSync(new URL('./fixtures/observability-redaction-v1.json', import.meta.url)));
const canary = 'AuditSyntheticValue_97531';
for (const stream of corpus.streams) {
  test('shared stream contract: ' + stream.name, () => {
    // Given independently split source records and only serialized parser state.
    let state = { v: 1, pem: false };
    for (const record of stream.records) {
      // When each record resumes, then the shared output and finite state agree.
      const result = sanitizeObservationLine(record.input, JSON.parse(JSON.stringify(state)));
      assert.equal(result.line, record.expected);
      assert.equal(result.state.pem, record.pemAfter);
      assert.equal(result.state.quote, record.quoteAfter);
      state = result.state;
    }
  });
}
for (const item of corpus.cases) {
  test('shared redaction contract: ' + item.name, () => {
    // Given a synthetic source, when sanitized, then preserve the shared masked output.
    assert.equal(sanitizeObservationLine(item.input).line, item.expected);
  });
}

for (const quote of ['"', "'", '\\"', "\\'"]) {
  test('restores quoted-secret continuation from JSON state: ' + JSON.stringify(quote), () => {
    // Given a secret split into source records and process-restored state.
    const first = sanitizeObservationLine('POSTGRES_PASSWORD=' + quote + 'begin');
    // When resumed twice, then no secret bytes survive and ordinary suffixes remain.
    const middle = sanitizeObservationLine(canary, JSON.parse(JSON.stringify(first.state)));
    const last = sanitizeObservationLine('end' + quote + ' ready=true', JSON.parse(JSON.stringify(middle.state)));
    assert.equal(first.state.quote, quote);
    assert.equal(middle.line, '****');
    assert.equal(last.line, '****' + quote + ' ready=true');
    assert.equal(last.state.quote, undefined);
    assert.equal(JSON.stringify(middle.state).includes(canary), false);
  });
}

const source = { serviceId: 'service-1', deploymentId: 'deploy-1', podUid: 'pod-1', containerName: 'app', timestamp: '2026-09-13T00:00:00.000Z' };
test('keeps quoted state across projection pages without mixing sources', () => {
  // Given a retained continuation with an open secret in one immutable source.
  const continuation = createObservationProjectionContinuation();
  projectObservationPayload({ logs: [{ ...source, id: '1', line: 'DATABASE_PASSWORD_1="begin' }] }, { continuation });
  // When another page arrives, then only that source continuation is masked.
  const result = projectObservationPayload({ logs: [
    { ...source, id: '2', line: canary },
    { ...source, podUid: 'pod-2', id: '3', line: 'healthy' },
    { ...source, id: '4', line: 'end" ready=true' },
  ] }, { continuation });
  assert.deepEqual(result.logs.map(row => row.line), ['****', 'healthy', '****" ready=true']);
});

test('reconstructs quoted state from complete page context', () => {
  // Given a fresh request whose context contains the opening source record.
  const contexts = [{ source: observationLogSource(source), complete: true, rows: [{ line: 'POSTGRES_PASSWORD="begin' }] }];
  // When the page starts in the secret, then its first row is masked.
  const result = projectObservationPayload({ logs: [{ ...source, id: '2', line: canary }] }, { logContexts: contexts });
  assert.equal(result.logs[0].line, '****');
});

for (const options of [
  { unknownLogState: true },
  { logContexts: [{ source: observationLogSource(source), complete: false, rows: [] }] },
]) {
  test('fails closed when page context is missing: ' + Object.keys(options)[0], () => {
    // Given an unknown boundary inside a quoted value, including a decoy PEM end marker.
    const input = '-----END PRIVATE KEY----- ' + canary + '" ready=true';
    // When projected, then an unrelated marker cannot establish a safe boundary.
    const result = projectObservationPayload({ logs: [{ ...source, id: '2', line: input }] }, options);
    assert.equal(result.logs[0].line, '****');
  });
}

test('fails closed for discarded quote state at the bounded line edge', () => {
  // Given the opening quote lies in the discarded part of a long source row.
  const first = sanitizeObservationLine('x'.repeat(OBSERVABILITY_LINE_BYTES + 1) + ' PASSWORD="begin');
  // When the next record arrives, then unknown tail state cannot leak its contents.
  const next = sanitizeObservationLine(canary, first.state);
  assert.equal(next.line, '****');
});
