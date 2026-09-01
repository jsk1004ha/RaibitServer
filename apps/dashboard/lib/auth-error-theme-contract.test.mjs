import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const dashboardDirectory = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, dashboardDirectory), 'utf8');

test('auth theme surface preserves native submissions while separating the brand field from interactive primary', async () => {
  const login = await read('app/login/page.tsx');

  for (const action of ['/auth/login', '/auth/signup', '/auth/email/verify', '/auth/email/resend']) {
    assert.match(login, new RegExp(`apiAction\\('${action.replaceAll('/', '\\/')}\\'\\)`));
  }
  for (const name of ['_returnTo', 'email', 'password', 'name', 'studentId', 'clubMemberClaim', 'code']) {
    assert.match(login, new RegExp(`name="${name}"`));
  }
  assert.match(login, /function authHref\(/);
  assert.match(login, /function errorMessage\(/);
  assert.match(login, /function noticeMessage\(/);
  assert.match(login, /import \{ ThemeMenu \} from '..\/..\/components\/theme-menu';/);
  assert.match(login, /data-slot="theme-utility"[\s\S]*<ThemeMenu \/>/);
  assert.match(login, /bg-brand-surface[\s\S]*text-brand-surface-foreground/);
  assert.doesNotMatch(login, /hidden min-h-dvh[^\n]*bg-primary/);
  assert.match(login, /text-balance break-keep \[overflow-wrap:anywhere\]/);
});

test('React error surfaces own one normal-flow theme utility while global error keeps system SSR and recovery safety', async () => {
  const [screen, globalError, routeError, notFound] = await Promise.all([
    read('components/error-screen.tsx'),
    read('app/global-error.tsx'),
    read('app/error.tsx'),
    read('app/not-found.tsx'),
  ]);

  assert.match(screen, /import \{ ThemeMenu \} from '.\/theme-menu';/);
  assert.equal((screen.match(/<ThemeMenu/g) ?? []).length, 1);
  assert.match(screen, /data-slot="theme-utility"[\s\S]*<ThemeMenu \/>/);
  assert.match(screen, /<h1 id="error-screen-title" className="break-keep \[overflow-wrap:anywhere\]">/);
  assert.match(screen, /text-body-lg text-muted-foreground break-keep \[overflow-wrap:anywhere\]/);
  assert.match(globalError, /data-theme="system"/);
  assert.match(globalError, /import '\.\/globals\.css';/);
  assert.match(globalError, /normalizePublicIdentifier\(error\.digest\)/);
  assert.match(globalError, /onClick=\{reset\}/);
  assert.match(globalError, /href="\/support"/);
  assert.doesNotMatch(globalError, /ThemeMenu|ThemeToggle|cookies\(|document\.cookie|localStorage|<script/);
  for (const source of [routeError, notFound]) assert.match(source, /<ErrorScreen/);
});

test('hosted errors remain a standalone light-only HTML boundary', async () => {
  const model = await read('lib/error-page-model.ts');

  assert.match(model, /data-theme="light"/);
  assert.match(model, /color-scheme:light/);
  assert.doesNotMatch(model, /ThemeMenu|theme-toggle|<script/);
});
