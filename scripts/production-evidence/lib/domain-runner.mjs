#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DomainEvidenceProofSchema } from '../../../packages/schemas/src/production-evidence.ts';
import { verifyManifest } from './manifest.mjs';
import { buildIdentity, immutableJson } from './orchestrator-io.mjs';
import { digest, EvidenceError, loadOperatorContract, loadProductionInputs, parseOperatorInputs, readJson } from './operator-inputs.mjs';
import { createRun, writeFragment } from './run.mjs';
import { executeCredentialedDomainProbes, loadDomainEvidenceInputs } from './cloudflare-domain-evidence.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ASSERTIONS = Object.freeze(['ownership', 'tls_exact_san', 'route', 'revalidation', 'domain_delete']);
const FAULTS = Object.freeze({
  'duplicate-hostname-race': 'duplicate_hostname_race_blocked',
  'cross-tenant-claim': 'cross_tenant_claim_blocked',
  'token-theft-replay': 'token_replay_blocked',
  'dns-rebinding': 'dns_rebinding_blocked',
  'stale-controller': 'stale_controller_blocked',
  'wrong-backend': 'wrong_backend_blocked',
  'cleanup-failure': 'cleanup_failed',
});

function normalizedHostname(value) {
  if (typeof value !== 'string') throw new EvidenceError('invalid_fixture_zone');
  const normalized = value.trim().toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)) throw new EvidenceError('invalid_fixture_zone');
  return normalized;
}

export function assertDedicatedFixtureHostname(hostname, fixtureZone, baseDomain) {
  const host = normalizedHostname(hostname), zone = normalizedHostname(fixtureZone), base = normalizedHostname(baseDomain);
  if (host === zone || !host.endsWith(`.${zone}`) || zone === base || base.endsWith(`.${zone}`)) throw new EvidenceError('fixture_zone_escape');
  return host;
}

function publicAddress(value) {
  if (/^(?:127\.|10\.|0\.|169\.254\.|192\.168\.|::1$|::$|fe80:|fc|fd)/i.test(value)) return false;
  const match = /^(172)\.(\d+)\./.exec(value);
  return !match || Number(match[2]) < 16 || Number(match[2]) > 31;
}

export function validateDomainProof(value, { baseDomain }) {
  const parsed = DomainEvidenceProofSchema.safeParse(value);
  if (!parsed.success) throw new EvidenceError('invalid_domain_proof');
  assertDedicatedFixtureHostname(parsed.data.hostname, parsed.data.fixtureZone, baseDomain);
  const addresses = [...parsed.data.resolution.addresses, ...parsed.data.resolution.reboundAddresses];
  if (!addresses.every((address) => isIP(address) !== 0 && publicAddress(address))) throw new EvidenceError('dns_rebinding_blocked');
  return parsed.data;
}

export function parseDomainArguments(args) {
  const accepted = new Set(['--profile', '--scenario', '--fault-matrix', '--attempt-dir']);
  const values = new Map();
  if (args.length % 2 !== 0) throw new EvidenceError('invalid_arguments');
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!accepted.has(flag) || values.has(flag) || typeof value !== 'string' || !value || value.startsWith('--')) throw new EvidenceError('invalid_arguments');
    values.set(flag, value);
  }
  const profile = values.get('--profile'), attemptDir = values.get('--attempt-dir');
  const scenario = values.get('--scenario'), faultPath = values.get('--fault-matrix');
  if (!['component', 'final'].includes(profile) || typeof attemptDir !== 'string' || !path.isAbsolute(attemptDir)
    || (scenario === 'happy') === (typeof faultPath === 'string') || (scenario !== undefined && scenario !== 'happy')
    || (faultPath !== undefined && !path.isAbsolute(faultPath))) throw new EvidenceError('invalid_arguments');
  return { profile, attemptDir, scenario, faultPath };
}

export function parseDomainFaultMatrix(value) {
  if (!value || Object.keys(value).length !== 2 || value.schema !== 'raibitserver.production-domain-fault-matrix/v1'
    || !Array.isArray(value.cases) || value.cases.length !== Object.keys(FAULTS).length
    || new Set(value.cases.map(({ id }) => id)).size !== value.cases.length) throw new EvidenceError('invalid_fault_matrix');
  for (const item of value.cases) {
    if (!item || Object.keys(item).length !== 2 || FAULTS[item.id] !== item.expectedReason) throw new EvidenceError('invalid_fault_matrix');
  }
  if (Object.keys(FAULTS).some((id) => !value.cases.some((item) => item.id === id))) throw new EvidenceError('invalid_fault_matrix');
  return Object.freeze(value);
}

function validateOptions(options) {
  const keys = ['profile', 'scenario', 'faultCase', 'attemptDir', 'inputs', 'fixture', 'clock', 'uuid', 'execute', ...(Object.hasOwn(options, 'extension') ? ['extension'] : [])];
  if (!options || Object.keys(options).length !== keys.length || keys.some((key) => !Object.hasOwn(options, key))
    || !['component', 'final'].includes(options.profile) || !path.isAbsolute(options.attemptDir)
    || !((options.scenario === 'happy' && options.faultCase === null) || (options.scenario === null && options.faultCase !== null))
    || typeof options.fixture !== 'boolean' || typeof options.clock?.now !== 'function' || typeof options.uuid !== 'function'
    || !(options.execute === null || typeof options.execute === 'function')) throw new EvidenceError('invalid_arguments');
  if (options.faultCase && FAULTS[options.faultCase.id] !== options.faultCase.expectedReason) throw new EvidenceError('invalid_fault_matrix');
}

export async function runDomainEvidence(options) {
  validateOptions(options);
  const contract = await loadOperatorContract();
  const inputs = parseOperatorInputs(options.inputs, contract);
  const configured = options.extension ?? null;
  const runnable = options.fixture || configured !== null;
  await mkdir(options.attemptDir, { recursive: true, mode: 0o700 });
  const startedAt = new Date(options.clock.now()).toISOString(), runId = options.uuid();
  const baseIdentity = await buildIdentity({ inputs, runId, root: ROOT, fixture: !runnable || options.fixture });
  const domainInputDigest = configured ? digest(configured) : undefined;
  const identity = Object.freeze({ ...baseIdentity,
    environmentFingerprint: domainInputDigest ? digest({ environmentFingerprint: baseIdentity.environmentFingerprint, domainInputDigest }) : baseIdentity.environmentFingerprint,
    ...(domainInputDigest ? { domainInputDigest } : {}) });
  const runDirectory = await createRun(options.attemptDir, identity, startedAt);
  const baseDomain = inputs.selectors.RAIBITSERVER_RELEASE_BASE_DOMAIN;
  let status = 'NOT_RUN', reason = configured === null && !options.fixture ? 'domain_provider_contract_unavailable' : 'domain_provider_adapter_unavailable';
  let proof = null;
  if (runnable) {
    let result;
    try {
      result = options.execute
        ? await options.execute({ identity, baseDomain, config: configured, faultCase: options.faultCase })
        : { status: 'PASS', reason: null, proof: await executeCredentialedDomainProbes({ inputs, extension: configured }) };
    } catch (error) {
      const failure = error instanceof EvidenceError ? error.reason : 'domain_evidence_failed';
      result = { status: ['missing_credentials', 'domain_provider_contract_unavailable'].includes(failure) ? 'NOT_RUN' : 'FAIL', reason: failure, proof: null };
    }
    if (!result || !['PASS', 'FAIL', 'NOT_RUN'].includes(result.status) || !(result.reason === null || typeof result.reason === 'string')) throw new EvidenceError('invalid_domain_result');
    status = result.status; reason = result.reason; proof = result.proof;
    if (options.faultCase && (status === 'PASS' || reason !== options.faultCase.expectedReason)) {
      status = 'FAIL'; reason = 'fault_expectation_mismatch'; proof = null;
    }
    if (status === 'PASS') proof = validateDomainProof({ ...proof, ...(domainInputDigest ? { domainInputDigest } : {}) }, { baseDomain });
    else if (proof !== null) throw new EvidenceError('invalid_domain_result');
  }
  const observedAt = new Date(options.clock.now()).toISOString();
  const cleanupStatus = reason === 'cleanup_failed' && !options.fixture ? 'FAIL' : 'PASS';
  const observation = await immutableJson(runDirectory, 'artifacts/domains/domain-observation.json', {
    schema: 'raibitserver.production-domain-observation/v1', status, reason, ...(proof ? { proof } : {}), redacted: true, fixture: options.fixture,
  });
  const cleanupArtifact = await immutableJson(runDirectory, 'cleanup/domains.json', {
    schema: 'raibitserver.production-domain-runner-cleanup/v1', status: cleanupStatus,
    reason: cleanupStatus === 'PASS' ? null : 'cleanup_failed', resourcesRemaining: cleanupStatus === 'PASS' ? 0 : null, redacted: true, fixture: options.fixture,
  });
  const runCleanup = await immutableJson(runDirectory, 'cleanup/run.json', {
    schema: 'raibitserver.production-domain-run-cleanup/v1', status: cleanupStatus,
    reason: cleanupStatus === 'PASS' ? null : 'cleanup_failed', resourcesRemaining: cleanupStatus === 'PASS' ? 0 : null, redacted: true, fixture: options.fixture,
  });
  const assertions = ASSERTIONS.map((id) => ({ id, status, artifactPaths: [observation.path] }));
  const fragment = { component: 'domains', level: 'L3', provenance: options.fixture ? 'fixture' : 'credentialed', identity,
    startedAt, observedAt, status, assertions, artifacts: [observation, cleanupArtifact, runCleanup],
    cleanup: { status: cleanupStatus, assertions: [{ id: 'component_cleanup', status: cleanupStatus, artifactPaths: [cleanupArtifact.path] }] },
    ...(proof ? { domainProof: proof } : {}) };
  await writeFragment(runDirectory, fragment);
  const manifest = { schema: 'raibitserver.production-evidence/v1', profile: options.profile, identity, startedAt, observedAt, status,
    preflight: { status: runnable ? 'PASS' : 'NOT_RUN', approvedInputSha256: identity.approvedInputSha256,
      operatorContractDigest: identity.operatorContractDigest, operatorInputFingerprint: identity.operatorInputFingerprint },
    fragments: [fragment], cleanup: { status: cleanupStatus, assertions: [{ id: 'run_cleanup', status: cleanupStatus, artifactPaths: [runCleanup.path] }] }, fixture: options.fixture };
  await writeFile(path.join(runDirectory, 'manifest.json'), `${JSON.stringify(manifest)}\n`, { flag: 'wx', mode: 0o600 });
  const verification = verifyManifest(manifest, { fragment: 'domains', profile: options.profile, now: Date.parse(observedAt) });
  return Object.freeze({ status, reason, releaseEligible: verification.releaseEligible, runId, runDirectory, manifestPath: path.join(runDirectory, 'manifest.json') });
}

export async function main(args, environment = process.env) {
  if (environment.RAIBITSERVER_PRODUCTION_EVIDENCE !== '1') throw new EvidenceError('production_evidence_not_enabled');
  const parsed = parseDomainArguments(args), inputs = await loadProductionInputs(parsed.attemptDir, environment);
  let extension = null;
  if (typeof environment.RAIBITSERVER_PRODUCTION_DOMAIN_INPUTS_FILE === 'string') {
    extension = await loadDomainEvidenceInputs(environment.RAIBITSERVER_PRODUCTION_DOMAIN_INPUTS_FILE, inputs.selectors.RAIBITSERVER_RELEASE_BASE_DOMAIN);
  }
  const common = { profile: parsed.profile, attemptDir: parsed.attemptDir, inputs, fixture: false,
    clock: { now: () => new Date() }, uuid: randomUUID, execute: null, extension };
  if (parsed.scenario === 'happy') return runDomainEvidence({ ...common, scenario: 'happy', faultCase: null });
  const matrix = parseDomainFaultMatrix(await readJson(parsed.faultPath, 'invalid_fault_matrix'));
  const runs = [];
  for (const faultCase of matrix.cases) runs.push(await runDomainEvidence({ ...common, scenario: null, faultCase }));
  return { status: 'NOT_RUN', reason: runs.every(({ reason }, index) => reason === matrix.cases[index].expectedReason)
    ? 'fault_matrix_observed' : runs[0]?.reason ?? 'domain_provider_contract_unavailable', releaseEligible: false, runs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) try {
  const result = await main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'PASS' ? 0 : 1;
} catch (error) {
  const reason = error instanceof EvidenceError ? error.reason : 'evidence_io_failed';
  process.stdout.write(`${JSON.stringify({ status: 'NOT_RUN', releaseEligible: false, reason })}\n`);
  process.exitCode = ['invalid_arguments', 'invalid_fault_matrix'].includes(reason) ? 2 : 1;
}
