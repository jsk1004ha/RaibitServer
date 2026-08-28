import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./error-page-model.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  CLIENT_ERROR_STATUS_CODES,
  ERROR_STATUS_CODES,
  SERVER_ERROR_STATUS_CODES,
  errorPageModel,
  errorStatusCode,
  normalizePublicIdentifier,
  normalizePublicPath,
  renderHostedErrorHtml,
} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('every supported HTTP error has a Korean public model', () => {
  assert.deepEqual(CLIENT_ERROR_STATUS_CODES, [
    400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413,
    414, 415, 416, 417, 421, 422, 423, 424, 425, 426, 428, 429, 431, 451,
  ]);
  assert.deepEqual(SERVER_ERROR_STATUS_CODES, [500, 501, 502, 503, 504, 505, 506, 507, 508, 511]);
  assert.equal(ERROR_STATUS_CODES.length, 38);
  for (const code of ERROR_STATUS_CODES) {
    const model = errorPageModel(code);
    assert.equal(model.code, code);
    assert.match(model.title, /[가-힣]/);
    assert.match(model.description, /[가-힣]/);
  }
  assert.equal(errorStatusCode('502'), 502);
  assert.equal(errorStatusCode('422'), 422);
  assert.equal(errorStatusCode('507'), 507);
  assert.equal(errorStatusCode('418'), 404);
  assert.equal(errorStatusCode('509'), 404);
  assert.equal(errorStatusCode('510'), 404);
  assert.equal(errorStatusCode('503ignore-this'), 404);
});

test('public request metadata drops queries, secrets, controls and unsafe identifiers', () => {
  assert.equal(normalizePublicPath('/private/path?token=secret#fragment'), '/private/path');
  assert.equal(normalizePublicPath('https://tenant.example/private/path?token=secret'), '/private/path');
  assert.equal(normalizePublicPath('//attacker.example/path'), null);
  assert.equal(normalizePublicPath('/safe\\redirect'), null);
  assert.equal(normalizePublicIdentifier('digest_123.ABC'), 'digest_123.ABC');
  assert.equal(normalizePublicIdentifier('<script>secret</script>'), null);
});

test('hosted error HTML is standalone, no-JS and never reflects query secrets or markup', () => {
  const html = renderHostedErrorHtml(503, {
    path: '/deploy?<script>alert(1)</script>&token=secret',
    identifier: 'bad<script>',
  });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<html lang="ko"/);
  assert.match(html, /class="signal-wrap"/);
  assert.match(html, /class="copy"/);
  assert.match(html, /서비스를 잠시 사용할 수 없습니다/);
  assert.match(html, /<code>\/deploy<\/code>/);
  assert.match(html, /href="\/deploy"/);
  assert.match(html, />다시 시도하기<\/a>/);
  assert.match(html, /<link rel="icon" href="data:,">/);
  assert.doesNotMatch(html, /width:min\(680px|border-radius:18px|box-shadow/);
  assert.doesNotMatch(html, /<script|token=secret|bad&lt;script&gt;/);
});
