import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function read(relativePath) {
  return fs.readFile(new URL(relativePath, root), 'utf8');
}

test('Given the public apex When it renders Then it stays server neutral and safely lists five published sites', async () => {
  const source = await read('app/page.tsx');

  assert.match(source, /loadPublicSites\(5\)/);
  assert.doesNotMatch(source, /loadConsoleContext|loadSession|cookies\(/);
  assert.match(source, /<main id="main-content"/);
  assert.equal(source.match(/<h1/g)?.length, 1);
  assert.match(source, /target="_blank"[\s\S]{0,80}rel="noreferrer"/);
  assert.match(source, /sites\.length/);
  assert.match(source, /운영 사이트 준비 중/);
});

test('Given every public route When its source is inspected Then shared chrome and one semantic h1 are present', async () => {
  const sources = await Promise.all([
    read('app/page.tsx'),
    read('app/status/page.tsx'),
    read('app/support/page.tsx'),
    read('app/privacy/page.tsx'),
    read('app/contributors/page.tsx'),
  ]);

  for (const source of sources) {
    assert.match(source, /<PublicHeader/);
    assert.match(source, /<PublicFooter/);
    assert.match(source, /<main id="main-content"/);
    assert.equal(source.match(/<h1/g)?.length, 1);
    assert.doesNotMatch(source, /landing-nav|support-card|contributor-card|privacy-section/);
  }
});

test('Given status polling When refresh succeeds or fails Then no-store validation and stale accessible feedback remain', async () => {
  const source = await read('components/system-status-panel.tsx');

  assert.match(source, /cache:\s*["']no-store["']/);
  assert.match(source, /visibilitychange/);
  assert.match(source, /aria-busy=\{refreshing\}/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /setStale\(true\)/);
  assert.match(source, /isSystemStatusSnapshot\(payload\)/);
  assert.match(source, /snapshot\.deployment\.commitUrl/);
  assert.doesNotMatch(source, /as Partial|as Error/);
});

test('Given the deterministic browser fixture When public states run Then every allowlisted state is selected and reset', async () => {
  const source = await read('tests/e2e/specs/public-surfaces.spec.ts');

  assert.match(source, /\["populated", "empty", "partial", "long"\] as const/);
  assert.match(source, /\/__fixture\/state/);
  assert.match(source, /\/__fixture\/reset/);
  assert.match(source, /for \(const state of publicStates\)/);
  assert.match(source, /for \(const viewport of viewports\)/);
});

test('Given shared public navigation When links render Then compact labels keep 44px targets and visible focus', async () => {
  const [header, privacy] = await Promise.all([
    read('components/public-header.tsx'),
    read('app/privacy/page.tsx'),
  ]);

  assert.match(header, /min-h-11 min-w-11 items-center justify-center/);
  assert.match(privacy, /inline-flex min-h-11 items-center/);
  assert.match(privacy, /text-primary-foreground/);
  assert.match(privacy, /focus-visible:ring-3 focus-visible:ring-primary-foreground\/50/);
  assert.match(privacy, /href="https:\/\/www\.privacy\.go\.kr"/);
});

test('Given legal and contributor surfaces When rendered Then required Korean copy and external-link safety remain', async () => {
  const [privacy, support, contributors, footer] = await Promise.all([
    read('app/privacy/page.tsx'),
    read('app/support/page.tsx'),
    read('app/contributors/page.tsx'),
    read('components/public-footer.tsx'),
  ]);

  for (const marker of ['개인정보의 처리 목적', '처리하는 개인정보 항목', '정보주체의 권리와 행사 방법', 'raibitserver_session']) {
    assert.match(privacy, new RegExp(marker));
  }
  assert.match(support, /mailto:/);
  assert.match(support, /GitHub Issues/);
  assert.match(support, /target="_blank"[\s\S]{0,80}rel="noreferrer"/);
  for (const marker of ['2309', '김준서', '2414', '엄지오', 'teacher', '최희진']) assert.match(contributors, new RegExp(marker));
  for (const marker of ['/support', '/status', '/contributors', '/privacy', 'github\.com']) assert.match(footer, new RegExp(marker));
  assert.match(privacy, /table-fixed/);
  assert.doesNotMatch(privacy, /overflow-x-auto|min-w-\[42rem\]|text-primary-foreground\//);
  assert.equal(footer.match(/min-w-11/g)?.length, 5);
});
