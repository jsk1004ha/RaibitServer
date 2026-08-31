import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  isFinalProjectWizardStep,
  nextProjectWizardStep,
  projectWizardSteps,
} from '../components/project-create-wizard-state.ts';

const wizardUrl = new URL('../components/project-create-wizard.tsx', import.meta.url);

test('project wizard reaches resources before native submit is enabled', () => {
  const visited = ['project'];

  while (!isFinalProjectWizardStep(visited.at(-1))) {
    visited.push(nextProjectWizardStep(visited.at(-1)));
  }

  assert.deepEqual(projectWizardSteps.map(({ id }) => id), ['project', 'source', 'service', 'resources']);
  assert.deepEqual(visited, ['project', 'source', 'service', 'resources']);
  assert.equal(nextProjectWizardStep('service'), 'resources');
  assert.equal(isFinalProjectWizardStep('service'), false);
  assert.equal(isFinalProjectWizardStep('resources'), true);
});

test('project wizard guards Enter and exposes submit only for resources', async () => {
  const source = await readFile(wizardUrl, 'utf8');

  assert.match(source, /<form ref=\{formRef\} method="post" action=\{action\} onSubmit=\{guardSubmit\}/);
  assert.match(source, /function guardSubmit\([\s\S]*if \(finalStep\) return;\s*event\.preventDefault\(\);\s*moveNext\(\);\s*\}/);
  assert.match(source, /if \(stepId === 'service'\) \{ setStepId\('resources'\); return; \}/);
  assert.match(source, /!finalStep \? <button type="button"[\s\S]*data-wizard-next>[\s\S]*: <button type="submit"[\s\S]*data-wizard-submit>/);
  assert.doesNotMatch(source, /requestSubmit|\.submit\(/);
});

test('project wizard native FormData contract has exactly thirteen tuples and no tenant id', async () => {
  const source = await readFile(wizardUrl, 'utf8');
  const fieldNames = [...source.matchAll(/<(?:input|Input|Select)\b[^>]*\bname="([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(fieldNames, [
    '_returnTo', 'name', 'slug', 'sourceType', 'repoUrl', 'branch', 'serviceName',
    'type', 'image', 'dockerfilePath', 'buildContext', 'database', 'cache',
  ]);
  assert.equal(fieldNames.length, 13);
  assert.equal(fieldNames.includes('organizationId'), false);
  assert.match(source, /name="_returnTo" value=\{`\/org\/\$\{orgSlug\}\/projects`\}/);
  assert.match(source, /id="project-organization" value=\{orgSlug\} readOnly/);
});
