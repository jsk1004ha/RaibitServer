import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { projectCreatePayloadFromForm } from './request-security.js';

const root = new URL('../', import.meta.url);
registerHooks({
  resolve(specifier, context, next) {
    const base = specifier.startsWith('@/') ? new URL(specifier.slice(2), root) : specifier.startsWith('.') && context.parentURL?.startsWith(root.href) ? new URL(specifier, context.parentURL) : null;
    if (base) for (const extension of ['', '.tsx', '.ts']) {
      const candidate = new URL(base.href + extension);
      if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
    }
    if (specifier === 'next/link') return next('next/link.js', context);
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(root.href) && /\.tsx?$/.test(url)) return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText,
    };
    return next(url, context);
  },
});

const { ProjectCreateWizard } = await import('../components/project-create-wizard.tsx');
const render = () => renderToStaticMarkup(createElement(ProjectCreateWizard, { action: '/api/control/projects', orgSlug: 'team' }));

function enabledControls(html) {
  const enabled = html.replace(/<fieldset\b[^>]*disabled=""[^>]*>[\s\S]*?<\/fieldset>/g, '');
  const inputs = [...enabled.matchAll(/<input\b([^>]*)>/g)].map(([, attributes]) => [
    /\bname="([^"]+)"/.exec(attributes)?.[1],
    /\bvalue="([^"]*)"/.exec(attributes)?.[1] ?? '',
  ]);
  const selects = [...enabled.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)].map(([, attributes, options]) => {
    const selected = [...options.matchAll(/<option\b([^>]*)>/g)].find(([, attrs]) => attrs.includes('selected=""'));
    return [/\bname="([^"]+)"/.exec(attributes)?.[1], /\bvalue="([^"]*)"/.exec(selected?.[1] ?? '')?.[1] ?? ''];
  });
  return Object.fromEntries([...inputs, ...selects].filter(([name]) => name));
}

test('given a fresh project form, rendering enables native submission and optional settings', () => {
  // Given the initial creation form; when it renders.
  const html = render();
  // Then the primary form posts immediately without gated steps.
  assert.match(html, /<form\b[^>]*action="\/api\/control\/projects"[^>]*method="post"/);
  const submit = [...html.matchAll(/<button\b[^>]*type="submit"[^>]*>/g)];
  assert.equal(submit.length, 1);
  assert.doesNotMatch(submit[0][0], /\sdisabled(?:=|\s|>)/);
  assert.doesNotMatch(html, /data-step=|data-wizard-next/);
  assert.ok([...html.matchAll(/<details>/g)].length >= 3);
});

test('given default repository creation, rendered controls preserve the native payload contract', () => {
  // Given rendered successful controls with optional sections closed.
  const fields = enabledControls(render());
  // When user-provided primary values pass through the real form adapter.
  const payload = projectCreatePayloadFromForm({ ...fields, name: 'Club Website', repoUrl: 'https://github.com/club/site' });
  // Then defaults, return route, and tenant isolation survive the simplified UI.
  assert.equal(fields._returnTo, '/org/team/projects');
  assert.deepEqual(Object.keys(fields).sort(), ['_returnTo', 'name', 'slug', 'sourceType', 'repoUrl', 'branch', 'serviceName', 'type', 'dockerfilePath', 'buildContext', 'database', 'cache'].sort());
  assert.deepEqual(payload, {
    name: 'Club Website',
    services: [{ name: 'web', type: 'web', sourceType: 'github', buildMode: 'auto', repoUrl: 'https://github.com/club/site', branch: 'main', buildContext: '.', attachedResources: [] }],
    resources: [],
  });
});

test('given initial creation, rendered primary inputs keep required validation', () => {
  // Given the initial form; when its inputs render.
  const inputs = [...render().matchAll(/<input\b[^>]*>/g)].map(([tag]) => tag);
  // Then name, selected repository, and default service name require values.
  const required = inputs.filter((tag) => tag.includes('required=""')).map((tag) => /\bname="([^"]+)"/.exec(tag)?.[1]);
  assert.deepEqual(required.sort(), ['name', 'repoUrl', 'serviceName'].sort());
  const slug = inputs.find((tag) => tag.includes('name="slug"'));
  assert.ok(slug);
  assert.doesNotMatch(slug, /required/);
  assert.match(slug, /pattern="\[a-z0-9\]\+\(-\[a-z0-9\]\+\)\*"/);
  assert.match(slug, /maxLength="63"/i);
});

test('given selected image and optional resources, the adapter preserves source and attachments', () => {
  // Given the native image-mode fields plus customized optional settings.
  const fields = { name: 'Club API', slug: 'club-api', sourceType: 'image', image: 'registry.example.test/club/api:1', serviceName: 'api', type: 'private', database: 'postgresql', cache: 'redis' };
  // When the existing adapter creates desired state.
  const payload = projectCreatePayloadFromForm(fields);
  // Then the prebuilt image and optional resources are preserved.
  assert.deepEqual(payload, {
    name: 'Club API', slug: 'club-api',
    services: [{ name: 'api', type: 'private', sourceType: 'image', buildMode: 'prebuilt-image', image: 'registry.example.test/club/api:1', attachedResources: ['postgresql', 'redis'] }],
    resources: [{ name: 'postgresql', type: 'database', engine: 'postgresql' }, { name: 'redis', type: 'cache', engine: 'redis' }],
  });
});

test('given a missing project name, the form adapter rejects creation', () => {
  // Given an empty required name; when the form crosses the server boundary.
  // Then it cannot produce project desired state.
  assert.throws(() => projectCreatePayloadFromForm({ name: '', sourceType: 'github' }), /invalid_form_body/);
});
