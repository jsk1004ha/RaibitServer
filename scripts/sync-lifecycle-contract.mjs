import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The root fixture remains authoritative for TypeScript and Go. Package-local
// mirrors let Docker and browser consumers run without the repository fixtures.
export async function syncLifecycleContract(root, write = false) {
  const canonical = await readFile(path.join(root, 'test-fixtures/contracts/lifecycle-v1.json'));
  for (const relative of ['packages/core/src/lifecycle-v1.json', 'packages/schemas/src/lifecycle-v1.json']) {
    const target = path.join(root, relative);
    if (write) await writeFile(target, canonical);
    const actual = await readFile(target);
    if (!actual.equals(canonical)) throw new Error(`Lifecycle contract drift: ${relative}; run node scripts/sync-lifecycle-contract.mjs --write`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some(argument => argument !== '--write')) throw new Error('Usage: node scripts/sync-lifecycle-contract.mjs [--write]');
  await syncLifecycleContract(fileURLToPath(new URL('../', import.meta.url)), process.argv.includes('--write'));
  console.log('lifecycle-package-mirrors=PASS');
}
