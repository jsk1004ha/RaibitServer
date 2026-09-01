import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  THEME_COOKIE_MAX_AGE,
  nextThemePreference,
  normalizeThemePreference,
  serializeThemeCookie,
  themePreferenceFromCookieHeader,
} from './theme.js';

const dashboardRoot = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, dashboardRoot), 'utf8');

test('theme preferences normalize and cycle deterministically', () => {
  assert.equal(normalizeThemePreference('system'), 'system');
  assert.equal(normalizeThemePreference('light'), 'light');
  assert.equal(normalizeThemePreference('dark'), 'dark');
  assert.equal(normalizeThemePreference('unexpected'), 'system');
  assert.equal(normalizeThemePreference(null), 'system');
  assert.equal(nextThemePreference('system'), 'light');
  assert.equal(nextThemePreference('light'), 'dark');
  assert.equal(nextThemePreference('dark'), 'system');
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

test('root documents and CSS expose the three-state theme without inline boot scripts', async () => {
  const [layout, globalError, toggle, css] = await Promise.all([
    read('app/layout.tsx'),
    read('app/global-error.tsx'),
    read('components/theme-toggle.tsx'),
    read('app/globals.css'),
  ]);

  assert.match(layout, /requestCookies\.get\(THEME_COOKIE_NAME\)/);
  assert.match(layout, /data-theme=\{theme\}/);
  assert.match(layout, /<ThemeToggle initialTheme=\{theme\}/);
  assert.doesNotMatch(layout, /dangerouslySetInnerHTML|<script/);
  assert.match(globalError, /data-theme="system"/);
  assert.match(globalError, /<ThemeToggle initialTheme="system"/);
  assert.match(toggle, /document\.documentElement\.dataset\.theme/);
  assert.match(toggle, /serializeThemeCookie/);
  assert.match(css, /\[data-theme="dark"\]/);
  assert.match(css, /prefers-color-scheme:\s*dark/);
  assert.match(css, /\[data-theme="system"\]/);
});
