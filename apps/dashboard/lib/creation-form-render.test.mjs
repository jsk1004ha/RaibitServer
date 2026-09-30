import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

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

test('given a new project, rendering offers native submit without forced steps', async () => {
  // Given a workspace and a native form action.
  const { ProjectCreateWizard } = await import('../components/project-create-wizard.tsx');
  // When the creation form renders.
  const html = renderToStaticMarkup(createElement(ProjectCreateWizard, { action: '/api/proxy/projects', orgSlug: 'team' }));
  // Then submission is available immediately and optional settings do not require step navigation.
  assert.match(html, /<button[^>]*type="submit"/);
  assert.doesNotMatch(html, /data-step=|name="organizationId"|id="project-organization"/);
  assert.match(html, /<details/);
});

for (const imageField of ['image', 'imageUrl']) {
  for (const initialSource of ['github', 'image']) {
    test(`given ${initialSource}, rendering ${imageField} enables only matching source inputs`, async () => {
      // Given either creation endpoint's native image field contract.
      const { CreationSourceFields } = await import('../components/creation-source-fields.tsx');
      // When the selected source renders.
      const html = renderToStaticMarkup(createElement(CreationSourceFields, { imageField, initialSource }));
      // Then irrelevant fields cannot validate or enter native FormData.
      const fieldsets = [...html.matchAll(/<fieldset([^>]*)>([\s\S]*?)<\/fieldset>/g)];
      const enabled = fieldsets.filter(([, attributes]) => !attributes.includes('disabled')).map(([, , content]) => content).join('');
      const disabled = fieldsets.filter(([, attributes]) => attributes.includes('disabled'));
      assert.equal(disabled.length, 1);
      assert.match(disabled[0][1], /hidden/);
      const names = [...enabled.matchAll(/name="([^"]+)"/g)].map(([, name]) => name);
      assert.deepEqual(names, initialSource === 'github' ? ['repoUrl', 'branch', 'dockerfilePath', 'buildContext'] : [imageField]);
      const required = [...enabled.matchAll(/<input[^>]*required=""[^>]*>/g)];
      assert.equal(required.length, 1);
      assert.match(required[0][0], new RegExp(`name="${initialSource === 'github' ? 'repoUrl' : imageField}"`));
      assert.doesNotMatch(html, /<option[^>]*value="local"|type="file"/);
    });
  }
}
