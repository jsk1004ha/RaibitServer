#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APPROVED_INPUT_SHA256, OPERATOR_CONTRACT_DIGEST, EvidenceError, digest, readJson } from './lib/operator-inputs.mjs';
import { REQUIRED_ASSERTIONS } from './lib/manifest.mjs';
import { createRun, writeFragment } from './lib/run.mjs';
import { preflight } from './preflight.mjs';

export function componentSample(component, now = new Date().toISOString()) {
  if (!['resources', 'domains'].includes(component)) throw new EvidenceError('invalid_component');
  const identity = { runId: randomUUID(), environmentFingerprint: digest('synthetic-environment'), sourceCommitSha: '0'.repeat(40), migrationDigest: digest('synthetic-migration'), approvedInputSha256: APPROVED_INPUT_SHA256, operatorContractDigest: OPERATOR_CONTRACT_DIGEST, operatorInputFingerprint: digest('synthetic-input'), organizationId: 'fixture-org', projectId: 'fixture-project', serviceId: 'fixture-service', deploymentId: 'fixture-deployment', resourceId: 'fixture-resource' };
  const artifact = `${JSON.stringify({ fixture: true, component, observedAt: now, assertions: REQUIRED_ASSERTIONS[component], cleanup: 'PASS' })}\n`;
  const assertion = (id) => ({ id, status: 'PASS', artifactPaths: ['assertions.json'] });
  const fragment = { component, level: 'L3', provenance: 'fixture', identity, startedAt: now, observedAt: now, status: 'PASS', assertions: REQUIRED_ASSERTIONS[component].map(assertion), artifacts: [{ path: 'assertions.json', sha256: digest(artifact), redacted: true }], cleanup: { status: 'PASS', assertions: [assertion('component_cleanup')] } };
  const manifest = { schema: 'raibitserver.production-evidence/v1', profile: 'component', identity, startedAt: now, observedAt: now, status: 'PASS', preflight: { status: 'NOT_RUN', approvedInputSha256: APPROVED_INPUT_SHA256, operatorContractDigest: OPERATOR_CONTRACT_DIGEST, operatorInputFingerprint: identity.operatorInputFingerprint }, fragments: [fragment], cleanup: { status: 'PASS', assertions: [assertion('run_cleanup')] }, fixture: true };
  return { manifest, artifact };
}

export async function runComponent(request) {
  const { parent, identity, component, inputs } = request;
  if (!['resources', 'domains'].includes(component)) throw new EvidenceError('invalid_component');
  const startedAt = new Date().toISOString();
  const directory = await createRun(parent, identity, startedAt);
  const result = await preflight(inputs);
  const observedAt = new Date().toISOString();
  const reason = result.status === 'PASS' ? 'runner_not_implemented' : result.reason;
  const artifact = `${JSON.stringify({ status: 'NOT_RUN', reason, cleanup: 'PASS', externalOperations: 0 })}\n`;
  await writeFile(path.join(directory, 'assertions.json'), artifact, { flag: 'wx', mode: 0o600 });
  const assertion = (id, status) => ({ id, status, artifactPaths: ['assertions.json'] });
  const fragment = { component, level: 'L3', provenance: 'credentialed', identity, startedAt, observedAt, status: 'NOT_RUN', assertions: REQUIRED_ASSERTIONS[component].map((id) => assertion(id, 'NOT_RUN')), artifacts: [{ path: 'assertions.json', sha256: digest(artifact), redacted: true }], cleanup: { status: 'PASS', assertions: [assertion('component_cleanup', 'PASS')] } };
  await writeFragment(directory, fragment);
  return { status: 'NOT_RUN', reason, releaseEligible: false, runId: identity.runId };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--sample' && args.length === 3) {
      const sample = componentSample(args[1]);
      const directory = await createRun(args[2], sample.manifest.identity, sample.manifest.startedAt);
      await writeFile(path.join(directory, 'assertions.json'), sample.artifact, { flag: 'wx', mode: 0o600 });
      await writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(sample.manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      process.stdout.write(`${JSON.stringify({ manifestPath: path.join(directory, 'manifest.json'), releaseEligible: false, fixture: true })}\n`);
    } else {
      if (args.length !== 1) throw new EvidenceError('invalid_arguments');
      const result = await runComponent(await readJson(args[0], 'missing_approved_input'));
      process.stderr.write(`${result.reason}\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof EvidenceError ? error.reason : 'evidence_io_failed'}\n`);
    process.exitCode = 1;
  }
}
