import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { deploymentReceiptHref, logEmptyState, shouldRefreshDeployment } from '../apps/dashboard/lib/operations-ux.ts';

function streamHref(browser) {
  const source = readFileSync(new URL('../apps/dashboard/components/operation-submit.tsx', import.meta.url), 'utf8');
  const declaration = source.slice(source.indexOf('export function sameOriginStreamHref'), source.indexOf('export function OperationSubmit'));
  const compiled = ts.transpileModule(declaration.replace('export function', 'function'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return vm.runInNewContext(`${compiled}; sameOriginStreamHref`, { URL, ...(browser ? { window: { location: { origin: 'https://console.example' } } } : {}) });
}

test('Given a deployment stream path, server and first browser render resolve the same href', () => {
  const path = '/api/control/deployments/new/stream';
  assert.equal(streamHref(false)(path), path);
  assert.equal(streamHref(true)(path), path);
});

test('Given an unsafe stream href, neither external nor browser-normalized host escapes are accepted', () => {
  for (const href of ['//outside.example/x', '/\\outside.example/x', '/foo/..//outside.example/x', 'https://outside.example/x', 'javascript:alert(1)']) {
    assert.equal(streamHref(true)(href), null);
  }
});

test('Given an old deployment or service return path, receipt points to the returned deployment in the same project', () => {
  for (const suffix of ['/deployments/old?view=overview', '?view=services', '/resources/db/console?view=connection']) {
    assert.equal(deploymentReceiptHref(`/org/team/projects/project-two${suffix}`, 'new/id'), '/org/team/projects/project-two/deployments/new%2Fid?view=overview');
  }
  for (const path of ['https://outside.example/org/team/projects/p', '//outside.example/org/team/projects/p', '/org/team/projects/..', '/org/team/projects/%2e%2e', '/account']) {
    assert.equal(deploymentReceiptHref(path, 'new'), null);
  }
});

test('Given stored logs and zero matches, empty state distinguishes filtering from no output', () => {
  assert.equal(logEmptyState(3, 0), 'filtered');
  assert.equal(logEmptyState(0, 0), 'empty');
  assert.equal(logEmptyState(3, 2), null);
});

test('Given a pending deployment, automatic refresh stops at its bound and terminal states', () => {
  assert.equal(shouldRefreshDeployment('BUILDING', 11), true);
  assert.equal(shouldRefreshDeployment('IMAGE_READY', 1), true);
  assert.equal(shouldRefreshDeployment('BUILDING', 12), false);
  for (const status of ['READY', 'FAILED', 'CANCELLED', 'unknown']) assert.equal(shouldRefreshDeployment(status, 0), false);
});
