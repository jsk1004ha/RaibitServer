import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as preview from '../packages/core/src/preview-contract.ts';
import * as schemas from '../packages/schemas/src/preview.ts';

const identity = JSON.parse(readFileSync(new URL('./fixtures/preview-identity.json', import.meta.url), 'utf8'));
const deliveryId = 'c60b7c80-1cd0-4d7c-a65a-aa642dc1992b';
const secret = 'local-preview-contract-fixture';
const payload = () => ({ action: 'opened', number: 42, installation: { id: 900 }, repository: { id: 101, full_name: 'club/demo' }, pull_request: { number: 42, state: 'open', head: { sha: 'a'.repeat(40), ref: 'feature/example' }, base: { ref: 'main' }, updated_at: '2026-09-03T01:02:03Z' } });
function signed(value = payload()) {
  const body = JSON.stringify(value);
  return { body, signature: `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`, secret, deliveryId };
}
const runtime = () => ({ version: 1, lineageId: identity.lineageId, deploymentId: identity.deploymentId, generation: 1, lineageVersion: 1, stableHost: identity.stableHost, probeHost: identity.probeHost, namespace: 'org-1--demo', workloadName: 'pr-42-web-6d187e3ec9dc', serviceName: 'pr-42-web-6d187e3ec9dc', probeIngressName: 'pr-42-web-6d187e3ec9dc', routeName: 'preview-route-1' });
const observation = () => ({ version: 1, lineageId: identity.lineageId, lineageVersion: 1, installationId: '900', repositoryId: '101', pullRequestNumber: 42, state: 'open', headSha: 'a'.repeat(40), headRef: 'feature/example', baseRef: 'main', updatedAt: '2026-09-03T01:02:03Z', observedAt: '2026-09-03T01:02:04.123Z' });
const owned = () => ({ group: 'apps', version: 'v1', kind: 'Deployment', namespace: 'org-1--demo', name: 'pr-42-web-6d187e3ec9dc', uid: 'c60b7c80-1cd0-4d7c-a65a-aa642dc1992b' });
const typedFailure = (error) => error instanceof preview.PreviewError && error.statusCode === 400 && error.code === 'preview_invalid_input';

test('uses signed raw bytes as sole authority when an unrelated parsed payload disagrees', () => {
  // Given
  const input = { ...signed(), payload: { installation: { id: 666 } } };
  // When
  const actual = preview.parsePreviewWebhook(input);
  // Then
  assert.deepEqual(actual, { deliveryId, installationId: '900', repositoryId: '101', repository: 'club/demo', pullRequestNumber: 42, action: 'opened', headSha: 'a'.repeat(40), headRef: 'feature/example', baseRef: 'main', beforeSha: null, updatedAt: '2026-09-03T01:02:03Z' });
  assert.deepEqual(schemas.PreviewWebhookSchema.parse(actual), actual);
});

for (const action of ['opened', 'synchronize', 'reopened', 'closed']) {
  test(`parses signed buffer when action is ${action}`, () => {
    // Given
    const value = payload();
    value.action = action;
    value.pull_request.state = action === 'closed' ? 'closed' : 'open';
    if (action === 'synchronize') value.before = 'b'.repeat(40);
    const input = signed(value);
    // When
    const actual = preview.parsePreviewWebhook({ ...input, body: Buffer.from(input.body) });
    // Then
    assert.equal(actual.action, action);
  });
}

const invalidPayloads = {
  'numeric string installation': (p) => { p.installation.id = '900'; },
  'unsafe repository id': (p) => { p.repository.id = Number.MAX_SAFE_INTEGER + 1; },
  'nonpositive PR': (p) => { p.number = p.pull_request.number = 0; },
  'mismatched PR': (p) => { p.number = 41; },
  'unsupported action': (p) => { p.action = 'edited'; },
  'closed action with open state': (p) => { p.action = 'closed'; },
  'open action with closed state': (p) => { p.pull_request.state = 'closed'; },
  'synchronize without before': (p) => { p.action = 'synchronize'; },
  'invalid before SHA': (p) => { p.before = 'bad'; },
  'invalid head SHA': (p) => { p.pull_request.head.sha = 'bad'; },
  'normalized invalid calendar day': (p) => { p.pull_request.updated_at = '2026-02-30T01:02:03Z'; },
  'non-UTC timestamp': (p) => { p.pull_request.updated_at = '2026-09-03T01:02:03+00:00'; },
  'ref traversal': (p) => { p.pull_request.head.ref = '../main'; },
  'missing repository binding': (p) => { delete p.repository.id; },
};
for (const [name, mutate] of Object.entries(invalidPayloads)) {
  test(`rejects admission when ${name}`, () => {
    // Given
    const value = payload(); mutate(value);
    // When / Then
    assert.throws(() => preview.parsePreviewWebhook(signed(value)), typedFailure);
  });
}
for (const [name, change, code] of [
  ['modified bytes', (input) => ({ ...input, body: `${input.body} ` }), 'preview_invalid_signature'],
  ['invalid signature hex', (input) => ({ ...input, signature: 'sha256=00' }), 'preview_invalid_signature'],
  ['empty secret', (input) => ({ ...input, secret: '' }), 'preview_invalid_signature'],
  ['invalid UUID', (input) => ({ ...input, deliveryId: 'delivery-1' }), 'preview_invalid_input'],
]) {
  test(`rejects envelope when ${name}`, () => {
    // Given
    const input = change(signed());
    // When / Then
    assert.throws(() => preview.parsePreviewWebhook(input), (error) => error instanceof preview.PreviewError && error.code === code);
  });
}

test('matches frozen cross-language hash when delimiters are actual NUL bytes', () => {
  // Given
  const bytes = Buffer.from(identity.hashInputUtf8Hex, 'hex');
  // When
  const actual = preview.previewProbeHost(identity.lineageId, identity.deploymentId, identity.baseDomain);
  // Then
  assert.equal(createHash('sha256').update(bytes).digest('hex'), identity.sha256);
  assert.equal(actual, identity.probeHost);
  assert.notEqual(preview.previewProbeHost(identity.lineageId, 'deployment-2', identity.baseDomain), actual);
});

test('accepts SHA256 Git object identity when head has 64 hexadecimal digits', () => {
  // Given
  const value = payload(); value.pull_request.head.sha = 'a'.repeat(64);
  // When
  const actual = preview.parsePreviewWebhook(signed(value));
  // Then
  assert.equal(actual.headSha, 'a'.repeat(64));
  assert.deepEqual(schemas.PreviewWebhookSchema.parse(actual), actual);
});

for (const [name, fixture, parse, schema] of [
  ['runtime', runtime, preview.parsePreviewRuntime, schemas.PreviewRuntimeSchema],
  ['observation', observation, preview.parsePreviewObservation, schemas.PreviewObservationSchema],
]) {
  test(`parses ${name} when identity is complete`, () => {
    // Given
    const value = fixture();
    // When
    const actual = parse(value);
    // Then
    assert.deepEqual(actual, value);
    assert.deepEqual(schema.parse(value), value);
  });
  for (const [field, replacement] of [['version', 2], ['lineageVersion', '1'], ['lineageId', 'bad\0id'], ['extra', true]]) {
    test(`rejects ${name} when ${field} violates the exact contract`, () => {
      // Given
      const value = { ...fixture(), [field]: replacement };
      // When / Then
      assert.throws(() => parse(value), typedFailure);
      assert.equal(schema.safeParse(value).success, false);
    });
  }
  for (const field of Object.keys(fixture())) {
    test(`rejects ${name} when required ${field} is missing`, () => {
      // Given
      const value = fixture(); delete value[field];
      // When / Then
      assert.throws(() => parse(value), typedFailure);
      assert.equal(schema.safeParse(value).success, false);
    });
  }
}

for (const [name, body] of [['invalid JSON', '{'], ['invalid UTF8', Buffer.from([0xff])]]) {
  test(`rejects signed bytes when ${name}`, () => {
    // Given
    const input = { body, signature: `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`, secret, deliveryId };
    // When / Then
    assert.throws(() => preview.parsePreviewWebhook(input), typedFailure);
  });
}

test('accepts inventory when exactly 32 unique owned objects are supplied', () => {
  // Given
  const value = Array.from({ length: 32 }, (_, index) => ({ ...owned(), name: `object-${index}` }));
  // When
  const actual = preview.parsePreviewInventory(value);
  // Then
  assert.deepEqual(actual, value);
  assert.deepEqual(schemas.PreviewInventorySchema.parse(value), value);
});

for (const [kind, group] of [['Deployment', 'apps'], ['Service', ''], ['Ingress', 'networking.k8s.io']]) {
  test(`parses owned inventory when kind is ${kind}`, () => {
    // Given
    const value = [{ ...owned(), kind, group, resourceVersion: '123' }];
    // When
    const actual = preview.parsePreviewInventory(value);
    // Then
    assert.deepEqual(actual, value);
    assert.deepEqual(schemas.PreviewInventorySchema.parse(value), value);
  });
}
for (const [name, value] of [
  ...['Namespace', 'Secret', 'Certificate'].map((kind) => [kind, [{ ...owned(), kind }]]),
  ['missing UID', [{ ...owned(), uid: '' }]], ['wrong API group', [{ ...owned(), group: '' }]],
  ['unknown property', [{ ...owned(), selector: 'tenant=true' }]], ['duplicate identity', [owned(), owned()]],
  ['over 32 objects', Array.from({ length: 33 }, (_, index) => ({ ...owned(), name: `object-${index}` }))],
]) {
  test(`rejects inventory when ${name}`, () => {
    // Given: invalid inventory above; When / Then
    assert.throws(() => preview.parsePreviewInventory(value), typedFailure);
    assert.equal(schemas.PreviewInventorySchema.safeParse(value).success, false);
  });
}
