import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const dashboardTsconfigUrl = new URL('../apps/dashboard/tsconfig.json', import.meta.url);

test('dashboard tsconfig exposes Node and React ambient types to editors', async () => {
  const config = JSON.parse(await fs.readFile(dashboardTsconfigUrl, 'utf8'));
  const compilerOptions = config.compilerOptions || {};
  const types = compilerOptions.types || [];
  const typeRoots = compilerOptions.typeRoots || [];

  for (const typeName of ['node', 'react', 'react-dom']) {
    assert.ok(types.includes(typeName), `dashboard tsconfig must include ${typeName} ambient types`);
  }

  for (const typeRoot of ['./node_modules/@types', '../../node_modules/@types']) {
    assert.ok(typeRoots.includes(typeRoot), `dashboard tsconfig must search ${typeRoot}`);
  }
});
