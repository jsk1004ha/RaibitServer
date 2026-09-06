import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
export const capabilitySource = new URL('test-fixtures/contracts/resource-capabilities-v1.json', root);
export const capabilityCopies = {
  TypeScript: new URL('packages/core/src/resource-capabilities-v1.json', root),
  CLI: new URL('apps/cli/src/resource-capabilities-v1.json', root),
  Schemas: new URL('packages/schemas/src/resource-capabilities-v1.json', root),
  Go: new URL('services/provisioner/internal/provider/resource-capabilities-v1.json', root),
  Helm: new URL('infra/helm/raibitserver/files/resource-capabilities-v1.json', root),
};

export function assertCapabilityParity(expected, actual, consumer) {
  assert.deepEqual(actual, expected, `${consumer}: resource capability drift`);
}

async function generate() {
  const source = await readFile(capabilitySource);
  const check = process.argv.includes('--check');
  for (const [consumer, destination] of Object.entries(capabilityCopies)) {
    if (check) assertCapabilityParity(source, await readFile(destination), consumer);
    else await writeFile(destination, source);
  }
  console.log(`RESOURCE_CAPABILITY_SHA256=${createHash('sha256').update(source).digest('hex')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await generate();
