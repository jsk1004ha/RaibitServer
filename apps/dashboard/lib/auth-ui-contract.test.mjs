import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const loginPagePath = new URL('../app/login/page.tsx', import.meta.url);
const authSpecPath = new URL('../tests/e2e/specs/auth-flows.spec.ts', import.meta.url);
const fixturePath = new URL('../tests/e2e/fixture/control-plane.mjs', import.meta.url);
const fixtureRedactionPath = new URL('../tests/e2e/fixture/redact.mjs', import.meta.url);

async function source() {
  return readFile(loginPagePath, 'utf8');
}

async function authSpec() {
  return readFile(authSpecPath, 'utf8');
}

async function fixture() {
  return readFile(fixturePath, 'utf8');
}

async function fixtureRedaction() {
  return readFile(fixtureRedactionPath, 'utf8');
}

test('auth UI keeps server-rendered native form contracts for every activity', async () => {
  const page = await source();

  for (const action of ['/auth/login', '/auth/signup', '/auth/email/verify', '/auth/email/resend']) {
    assert.ok(page.includes(`apiAction('${action}')`), `${action} action missing`);
  }
  assert.match(page, /name="_returnTo" type="hidden" value=\{next\}/);
  assert.match(page, /name="_returnTo" type="hidden" value="\/login\?mode=verify"/);
  assert.match(page, /name="clubMemberClaim" required type="radio" value="1"/);
  assert.match(page, /name="clubMemberClaim" required type="radio" value="0"/);
  assert.match(page, /name="password" type="password" autoComplete="new-password" minLength=\{8\} required/);
  assert.match(page, /name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\[0-9\]\{6\}" maxLength=\{6\} required/);
  assert.doesNotMatch(page, /name="organizationSlug"/);
  assert.doesNotMatch(page, /useState|onChange=/);
});

test('auth UI uses URL mode navigation and associates messages with the focused activity', async () => {
  const page = await source();

  assert.match(page, /<nav aria-label="인증 메뉴"/);
  assert.equal([...page.matchAll(/<h1\b/g)].length, 1);
  assert.match(page, /href=\{authHref\(item, next, email\)\}/);
  assert.match(page, /id="auth-message"/);
  assert.match(page, /aria-describedby=\{messageId\}/);
  assert.match(page, /function isAuthMode\(value: string\): value is AuthMode/);
  assert.match(page, /function errorMessage\(code: string\)/);
  assert.match(page, /border-destructive\/40 bg-destructive\/10 text-foreground/);
  assert.match(page, /role="status" variant="notice"/);
  assert.doesNotMatch(page, /이미 가입된 이메일입니다/);
});

test('auth E2E locks keyboard submission and the verification mutation observation', async () => {
  const spec = await authSpec();

  assert.equal([...spec.matchAll(/getByLabel\('비밀번호'\)\.press\('Enter'\)/g)].length, 2, 'login and signup submit from native password inputs');
  assert.match(spec, /getByLabel\('6자리 인증 코드'\)\.press\('Enter'\)/);
  assert.match(spec, /search\)\.toBe\('\?mode=verify&email=signup%40fixture\.test&notice=saved'\)/);
  assert.match(spec, /expectRoute\(page, '\/console', \{ notice: 'saved' \}\)/);
  assert.match(spec, /path: '\/api\/auth\/email\/verify'/);
  assert.match(spec, /body: \{ email: 'verify@fixture\.test', code: '\[MASKED\]' \}/);
  assert.match(spec, /not\.toContain\('123456'\)/);
  assert.match(spec, /test\('resend executes independently after keyboard submission and records its FormData'/);
  assert.match(spec, /installSession\(page\.context\(\), 'fixture-user-populated'\)/);
  assert.match(spec, /path: '\/api\/auth\/email\/resend'/);
  assert.match(spec, /'invalid_or_expired_email_verification_code'/);
  assert.match(spec, /'session_expired'/);
  assert.match(spec, /'account_not_approved'/);
});

test('auth fixture ledger keeps non-secret form values while masking credentials', async () => {
  const [source, redaction] = await Promise.all([fixture(), fixtureRedaction()]);

  assert.match(source, /import \{ redactFixtureRequestBody \} from '\.\/redact\.mjs';/);
  assert.match(source, /body: redactFixtureRequestBody\(body, url\.pathname\)/);
  assert.match(redaction, /const OTP_PATHS = new Set\(\['\/api\/auth\/email\/verify'\]\);/);
  assert.match(redaction, /key === 'code' && OTP_PATHS\.has\(pathname\)/);
  assert.match(redaction, /SENSITIVE_KEY\.test\(key\) \|\| \(key === 'code' && OTP_PATHS\.has\(pathname\)\) \? '\[MASKED\]' : redactFixtureRequestBody\(entry, pathname\)/);
});
