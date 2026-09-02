#!/usr/bin/env node
import path from 'node:path';
import { verifyManifest } from './production-evidence/lib/manifest.mjs';
import { EvidenceError, loadOperatorContract, readJson } from './production-evidence/lib/operator-inputs.mjs';
import { checkRun, verifyArtifacts } from './production-evidence/lib/run.mjs';

try {
  const args = process.argv.slice(2);
  const options = {};
  for (const flag of ['--fragment', '--profile']) {
    const index = args.indexOf(flag);
    if (index >= 0) { options[flag.slice(2)] = args[index + 1]; args.splice(index, 2); }
  }
  if (args.length !== 1 || !args[0] || args[0].startsWith('--')) throw new EvidenceError('invalid_arguments');
  await loadOperatorContract();
  const file = path.resolve(args[0]);
  const manifest = await readJson(file);
  const result = verifyManifest(manifest, options);
  if (!result.valid) throw new EvidenceError(result.reason);
  // A committed component sample has no run receipt and never authorizes release.
  if (!manifest.fixture) await checkRun(path.dirname(file), manifest);
  await verifyArtifacts(path.dirname(file), manifest);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof EvidenceError ? error.reason : 'evidence_io_failed'}\n`);
  process.exitCode = 1;
}
