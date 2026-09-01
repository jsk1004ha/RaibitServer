import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const component = (name) => readFile(new URL(`../components/${name}`, import.meta.url), 'utf8');

test('authenticated console shell remains server-first and preserves tenant-safe navigation', async () => {
  // Given: the authenticated shell and its two client-only interaction leaves.
  const [shell, search, mobile] = await Promise.all([
    component('console-ui.tsx'),
    component('console-search.tsx'),
    component('console-mobile-nav.tsx'),
  ]);

  // When: the source boundary is inspected as Next.js will compile it.
  const clientLeaves = [search, mobile];

  // Then: authentication and route identity stay on the server while only the leaves hydrate.
  assert.doesNotMatch(shell, /['"]use client['"]/);
  assert.match(shell, /getJson\('\/auth\/me'/);
  assert.match(shell, /redirect\('\/login\?error=session_expired'\)/);
  assert.match(shell, /String\(user\?\.role \|\| subject\?\.userRole \|\| ''\)\.toUpperCase\(\) === 'ADMIN'/);
  assert.match(shell, /requested: orgRouteValue/);
  assert.match(shell, /memberships: me\.body\?\.memberships/);
  assert.match(shell, /<Suspense fallback=\{null\}><FlashBanner \/><\/Suspense>/);
  assert.match(shell, /method="post" action=\{apiAction\('\/auth\/logout'\)\}/);
  assert.match(shell, /name="_returnTo" value="\/login"/);
  for (const leaf of clientLeaves) assert.match(leaf, /^['"]use client['"]/);
});

test('console interaction leaves compose the Base UI command and mobile sheet primitives', async () => {
  // Given: the command search and mobile navigation source.
  const [search, mobile] = await Promise.all([
    component('console-search.tsx'),
    component('console-mobile-nav.tsx'),
  ]);

  // When: their keyboard and overlay composition is inspected.
  const combined = `${search}\n${mobile}`;

  // Then: Command owns list navigation and Sheet owns focus, Escape, restore, and scroll locking.
  for (const marker of ['CommandDialog', 'CommandInput', 'CommandList', 'CommandGroup', 'CommandItem', 'CommandEmpty']) {
    assert.match(search, new RegExp(marker));
  }
  for (const marker of ['Sheet', 'SheetTrigger', 'SheetContent', 'SheetTitle', 'SheetDescription', 'SheetClose']) {
    assert.match(mobile, new RegExp(marker));
  }
  assert.match(search, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(search, /event\.key === '\/'/);
  assert.match(search, /input, textarea, select, \[contenteditable="true"\]/);
  assert.match(search, /if \(compact\) return/);
  assert.match(search, /returnFocusRef\.current\?\.focus\(\)/);
  assert.match(combined, /onOpenChange/);
  assert.doesNotMatch(combined, /command-palette-backdrop|window\.addEventListener\('keydown'.*Escape/s);
});

test('console shell has a single bounded main scroll owner across the 768px breakpoint', async () => {
  // Given: the server shell and mobile navigation layouts.
  const [shell, mobile] = await Promise.all([
    component('console-ui.tsx'),
    component('console-mobile-nav.tsx'),
  ]);

  // When: responsive utility contracts are inspected.
  const combined = `${shell}\n${mobile}`;

  // Then: the viewport is bounded, desktop starts at md, and only main owns page scrolling.
  assert.match(shell, /h-dvh/);
  assert.match(shell, /overflow-hidden/);
  assert.match(shell, /min-h-0[^"\n]*overflow-y-auto/);
  assert.match(shell, /hidden[^"\n]*md:flex/);
  assert.match(shell, /<div className="hidden min-w-0 lg:block">\s*<p[^>]+>\{eyebrow\}<\/p>\s*<p[^>]+>\{projectValue\}<\/p>\s*<\/div>/);
  assert.match(mobile, /md:hidden/);
  assert.doesNotMatch(combined, /h-screen|overflow-x-auto/);
});

test('shared load errors use a valid atomic alert without changing sanitized issue copy', async () => {
  const shell = await component('console-ui.tsx');

  assert.match(shell, /<div className="load-error-summary" role="alert" aria-live="polite" aria-atomic="true">/);
  assert.doesNotMatch(shell, /<aside[^>]*role="alert"/);
  assert.match(shell, /일부 정보를 불러오지 못했습니다\./);
  assert.match(shell, /<ul className="text-foreground">\{issues\.map/);
  assert.match(shell, /<span>\{issue\.label\}<\/span>: \{issue\.message\}/);
  assert.match(shell, /<p className="text-foreground">잠시 후 다시 시도해 주세요\.<\/p>/);
  assert.doesNotMatch(shell, /<p className="muted">잠시 후 다시 시도해 주세요\.<\/p>/);
});
