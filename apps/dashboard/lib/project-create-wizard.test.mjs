import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('project wizard blocks native submit until the resource step', async () => {
  const source = await readFile(new URL('../components/project-create-wizard.tsx', import.meta.url), 'utf8');
  assert.match(source, /onSubmit=\{guardSubmit\}/);
  assert.match(source, /if \(step === steps\.length - 1\) return;\s*event\.preventDefault\(\);\s*moveNext\(\);/);
  assert.match(source, /data-step="resources" hidden=\{step !== 3\}/);
});
