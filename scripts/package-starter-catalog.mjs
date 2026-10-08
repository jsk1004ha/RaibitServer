#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
export {
  buildStarterArtifacts,
  canonicalSourceBundle,
  expandStarter,
  parseStarterBundle,
  readStarterArtifacts,
  StarterCatalogError,
  verifyStarterArtifacts,
  writeStarterArtifacts,
} from './starter-catalog-lib.mjs';
import { verifyStarterArtifacts, writeStarterArtifacts } from './starter-catalog-lib.mjs';

async function main() {
  const mode = process.argv[2] ?? '--generate';
  if (mode === '--check') {
    const catalog = await verifyStarterArtifacts();
    process.stdout.write(`${catalog.catalogDigest} ${catalog.bundleDigest}\n`);
    return;
  }
  if (mode === '--generate') {
    const catalog = await writeStarterArtifacts();
    process.stdout.write(`${catalog.catalogDigest} ${catalog.bundleDigest}\n`);
    return;
  }
  throw new Error('usage: package-starter-catalog.mjs [--generate|--check]');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
