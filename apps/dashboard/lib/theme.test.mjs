import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  THEME_COOKIE_MAX_AGE,
  normalizeThemePreference,
  serializeThemeCookie,
  themePreferenceFromCookieHeader,
} from './theme.js';

const dashboardRoot = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, dashboardRoot), 'utf8');

test('theme preferences allow direct selection and normalize invalid values to system', () => {
  assert.equal(normalizeThemePreference('system'), 'system');
  assert.equal(normalizeThemePreference('light'), 'light');
  assert.equal(normalizeThemePreference('dark'), 'dark');
  assert.equal(normalizeThemePreference('unexpected'), 'system');
  assert.equal(normalizeThemePreference(null), 'system');
});

test('theme cookies are scoped, durable, and reject invalid values', () => {
  assert.equal(themePreferenceFromCookieHeader('session=abc; raibit-theme=dark; other=1'), 'dark');
  assert.equal(themePreferenceFromCookieHeader('raibit-theme=unexpected'), null);
  assert.equal(themePreferenceFromCookieHeader('session=abc'), null);

  const cookie = serializeThemeCookie('light', { secure: true });
  assert.match(cookie, /^raibit-theme=light; Path=\//);
  assert.match(cookie, new RegExp(`Max-Age=${THEME_COOKIE_MAX_AGE}`));
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /; Secure$/);
});

test('the synchronized theme menu uses direct radio selection without a cycle fallback', async () => {
  const [menu, fixture, css] = await Promise.all([
    read('components/theme-menu.tsx'),
    read('app/primitives-fixture/page.tsx'),
    read('app/globals.css'),
  ]);

  assert.match(menu, /^['"]use client['"]/);
  assert.match(menu, /DropdownMenuRadioGroup/);
  assert.match(menu, /DropdownMenuRadioItem/);
  assert.match(menu, /closeOnClick/);
  assert.match(menu, /테마 설정: 현재/);
  assert.match(menu, /document\.documentElement\.dataset\.theme/);
  assert.match(menu, /document\.cookie\s*=\s*serializeThemeCookie/);
  assert.match(menu, /window\.localStorage\.setItem/);
  assert.match(menu, /raibit-theme-change/);
  assert.doesNotMatch(menu, /nextThemePreference|data-theme-toggle/);
  assert.doesNotMatch(await read('lib/theme.js'), /nextThemePreference/);
  assert.ok(menu.indexOf('document.documentElement.dataset.theme') < menu.indexOf('document.cookie = serializeThemeCookie'));
  assert.ok(menu.indexOf('document.cookie = serializeThemeCookie') < menu.indexOf('window.localStorage.setItem'));
  assert.ok(menu.indexOf('window.localStorage.setItem') < menu.indexOf('window.dispatchEvent'));
  assert.match(menu, /window\.removeEventListener\('storage', handleStorage\)/);
  assert.match(menu, /window\.removeEventListener\(THEME_CHANGE_EVENT, handleThemeChange\)/);
  assert.equal((fixture.match(/<ThemeMenu/g) ?? []).length, 2);
  assert.match(css, /\[data-theme="dark"\]/);
  assert.match(css, /prefers-color-scheme:\s*dark/);
  assert.match(css, /\[data-theme="system"\]/);
});
