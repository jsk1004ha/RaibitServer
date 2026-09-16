import { spawn } from 'node:child_process';
import { sign, verify } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { EvidenceIdentitySchema, OperatorInputValuesSchema, Sha256Schema } from '../../../packages/schemas/src/production-evidence.ts';
import { canonical, digest, EvidenceError, loadOperatorContract, parseOperatorInputs } from './operator-inputs.mjs';
import { receiptAuthoritySealContext } from './receipt-authority.mjs';
import { assertJournalAuthority } from './journal-authority.mjs';
import { assertFresh, verifyManifest } from './manifest.mjs';
import { checkRun, verifyRunReceipts } from './run.mjs';
import { verifyResourceLifecycle } from './resource-lifecycle.mjs';
import { snapshotJournalData } from './journal-data-snapshot.mjs';
import { durableBytes, durableJson, inventoryDurableRun, readDurableEvidence, SEAL_FILE } from './durable-evidence-files.mjs';

const SIGNING_KEY = '/var/run/secrets/raibitserver/signing/cosign.key';
const TRUST_ROOT = '/var/run/secrets/raibitserver/verification/cosign.pub';
const proofs = new WeakSet();
const fail = (reason) => { throw new EvidenceError(reason); };
const executionShape = z.record(z.string(), z.union([z.string(), z.number()])).nullable();
const StatementSchema = z.strictObject({ schema: z.literal('raibitserver.durable-evidence-statement/v1'),
  identity: EvidenceIdentitySchema, executionContext: executionShape, operatorInputs: OperatorInputValuesSchema,
  profile: z.enum(['train-a', 'final']), fixture: z.boolean(), observedAt: z.string().datetime(),
  manifestSha256: Sha256Schema, committedReceiptsSha256: Sha256Schema, receiptJournalSha256: Sha256Schema, bindingJournalSha256: Sha256Schema, cleanupJournalSha256: Sha256Schema,
  files: z.array(z.strictObject({ path: z.string().regex(/^[a-z0-9][a-z0-9_./-]*$/).refine(value => !value.split('/').includes('..')),
    sha256: Sha256Schema, bytes: z.number().int().positive().max(4 * 1024 * 1024) })).min(1).max(4096),
});
const SealSchema = z.strictObject({ schema: z.literal('raibitserver.durable-evidence-seal/v1'),
  statement: StatementSchema, signature: z.string().min(1).max(32768).regex(/^[A-Za-z0-9+/]+={0,2}$/) });
const message = statement => Buffer.from(`${JSON.stringify(canonical(statement))}\n`);

async function ciContext(expected) {
  try {
    const ci = await import('./ci-invocation.mjs');
    return expected === undefined ? ci.readCiExecutionContext() : ci.parseCiExecutionContext(expected);
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    if (error instanceof Error) fail('ci_authority_unavailable');
    throw error;
  }
}

async function mounted(file) {
  try {
    const resolved = await realpath(file), root = path.dirname(file), relative = path.relative(root, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !(await lstat(resolved)).isFile()) fail('signing_authority_unavailable');
  } catch (error) { if (error instanceof Error) fail('signing_authority_unavailable'); throw error; }
}

async function cosign(statement, signature) {
  const signing = signature === undefined;
  await mounted(TRUST_ROOT);
  if (signing) { await mounted(SIGNING_KEY); if (typeof process.env.COSIGN_PASSWORD !== 'string') fail('signing_authority_unavailable'); }
  const inherited = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME'];
  const environment = Object.fromEntries(inherited.filter(name => typeof process.env[name] === 'string').map(name => [name, process.env[name]]));
  if (signing) environment.COSIGN_PASSWORD = process.env.COSIGN_PASSWORD;
  const args = signing ? ['sign-blob', '--key', SIGNING_KEY, '--tlog-upload=false', '--yes', '--timeout', '30s', '-']
    : ['verify-blob', '--key', TRUST_ROOT, '--signature', signature, '--offline', '--insecure-ignore-tlog=true', '--timeout', '30s', '-'];
  const child = spawn('cosign', args, { shell: false, windowsHide: true, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', size = 0, exceeded = false, expired = false;
  const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 30_000);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { size += Buffer.byteLength(chunk); if (size > 32768) { exceeded = true; child.kill('SIGKILL'); } else stdout += chunk; });
  child.stderr.on('data', chunk => { size += chunk.length; if (size > 32768) { exceeded = true; child.kill('SIGKILL'); } });
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', () => reject(new EvidenceError('signing_authority_unavailable')));
      child.once('close', code => resolve(code));
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') { child.kill('SIGKILL'); reject(new EvidenceError('durable_signature_failed')); } });
      child.stdin.end(message(statement));
    });
    if (code !== 0 || expired || exceeded) fail('durable_signature_failed');
    if (signing && !/^[A-Za-z0-9+/]+={0,2}$/.test(stdout.trim())) fail('durable_signature_failed');
    return stdout.trim();
  } finally { clearTimeout(timer); delete environment.COSIGN_PASSWORD; }
}

export function assertDurableReceiptProof(proof, manifest) {
  if (!proof || !proofs.has(proof) || proof.fixture || proof.manifestDigest !== digest(manifest)
    || digest(proof.identity) !== digest(manifest.identity)) fail('invalid_durable_receipt_proof');
  return proof;
}

async function validatePhysical(root, statement, now) {
  const inputs = parseOperatorInputs(statement.operatorInputs, await loadOperatorContract());
  if (digest(inputs) !== statement.identity.operatorInputFingerprint) fail('operator_input_fingerprint_mismatch');
  const physical = await readDurableEvidence(root, { fixture: statement.fixture, operatorInputs: inputs });
  if (digest(physical.manifest.identity) !== digest(statement.identity) || physical.manifest.profile !== statement.profile) fail('identity_mismatch');
  if (physical.manifest.status !== 'PASS' || physical.manifest.cleanup.status !== 'PASS') fail('cleanup_failed');
  for (const field of ['committedReceiptsSha256', 'receiptJournalSha256', 'bindingJournalSha256', 'cleanupJournalSha256']) if (physical[field] !== statement[field]) fail('durable_digest_mismatch');
  if (digest(physical.files) !== digest(statement.files) || physical.files.find(file => file.path === 'manifest.json')?.sha256 !== statement.manifestSha256) fail('durable_digest_mismatch');
  assertFresh(physical.manifest.startedAt, physical.manifest.observedAt, now);
  if (statement.observedAt !== physical.manifest.observedAt) fail('stale_state');
  await checkRun(root, physical.manifest, now);
  await verifyRunReceipts(root, physical.manifest, now);
  await verifyResourceLifecycle(root, physical.manifest);
  return physical;
}

async function seal(options, fixture) {
  const allowed = fixture ? ['receiptAuthority', 'journalAuthority', 'privateKey', 'publicKey', 'now'] : ['receiptAuthority', 'journalAuthority'];
  if (!options || Object.keys(options).some(key => !allowed.includes(key))) fail('invalid_arguments');
  const context = await receiptAuthoritySealContext(options.receiptAuthority);
  if (context.fixture !== fixture || context.journalAuthority !== assertJournalAuthority(options.journalAuthority)) fail('fixture_not_release_evidence');
  const target = path.join(context.runDirectory, SEAL_FILE);
  try { await lstat(target); fail('reused_durable_seal'); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  const now = fixture ? options.now : Date.now(), executionContext = fixture ? null : await ciContext();
  if (!fixture && executionContext.sourceCommitSha !== context.identity.sourceCommitSha) fail('ci_identity_mismatch');
  const physical = await readDurableEvidence(context.runDirectory, { fixture, operatorInputs: context.fullOperatorInput });
  if (['committedReceiptsSha256', 'bindingJournalSha256', 'cleanupJournalSha256'].some(field => physical[field] !== context[field])) fail('receipt_authority_mutated');
  const statement = StatementSchema.parse({ schema: 'raibitserver.durable-evidence-statement/v1', identity: context.identity,
    executionContext, operatorInputs: context.fullOperatorInput, profile: physical.manifest.profile, fixture, observedAt: physical.manifest.observedAt,
    manifestSha256: physical.files.find(file => file.path === 'manifest.json')?.sha256,
    committedReceiptsSha256: context.committedReceiptsSha256, receiptJournalSha256: physical.receiptJournalSha256, bindingJournalSha256: physical.bindingJournalSha256,
    cleanupJournalSha256: physical.cleanupJournalSha256, files: physical.files });
  await validatePhysical(context.runDirectory, statement, now);
  if (!fixture) {
    const result = verifyManifest(physical.manifest, { now, receiptAuthority: options.receiptAuthority, journalAuthority: options.journalAuthority,
      verifiedBindingJournal: await options.journalAuthority.verifyBindingJournal() });
    if (!result.valid || !result.releaseEligible) fail(result.reason);
  }
  const signature = fixture ? sign('sha256', message(statement), options.privateKey).toString('base64') : await cosign(statement);
  if (fixture) { if (!verify('sha256', message(statement), options.publicKey, Buffer.from(signature, 'base64'))) fail('durable_signature_failed'); }
  else await cosign(statement, signature);
  if (digest((await inventoryDurableRun(context.runDirectory, fixture)).files) !== digest(statement.files)) fail('durable_digest_mismatch');
  return context.writer.writeJson(SEAL_FILE, { schema: 'raibitserver.durable-evidence-seal/v1', statement, signature });
}

async function verifyFile(file, options, fixture) {
  const allowed = ['expectedIdentity', 'expectedCi', 'now', ...(fixture ? ['publicKey'] : [])];
  if (!options || Object.keys(options).some(key => !allowed.includes(key))) fail('invalid_arguments');
  const expectedIdentity = EvidenceIdentitySchema.safeParse(options.expectedIdentity);
  if (!expectedIdentity.success) fail('durable_expectation_unavailable');
  const root = path.dirname(path.resolve(file));
  if (path.basename(file) !== 'manifest.json') fail('invalid_arguments');
  const parsed = SealSchema.safeParse(durableJson(await durableBytes(path.join(root, SEAL_FILE), fixture)));
  if (!parsed.success) fail('invalid_durable_seal');
  const { statement, signature } = parsed.data, now = options.now ?? Date.now();
  if (statement.fixture !== fixture) fail('fixture_not_release_evidence');
  if (digest(statement.identity) !== digest(expectedIdentity.data)) fail('identity_mismatch');
  if (fixture) { if (!verify('sha256', message(statement), options.publicKey, Buffer.from(signature, 'base64'))) fail('durable_signature_failed'); }
  else {
    await cosign(statement, signature);
    const authenticatedCi = await ciContext(statement.executionContext);
    if (authenticatedCi.sourceCommitSha !== statement.identity.sourceCommitSha
      || (options.expectedCi !== undefined && digest(await ciContext(options.expectedCi)) !== digest(authenticatedCi))) fail('ci_identity_mismatch');
  }
  const physical = await validatePhysical(root, statement, now);
  if (fixture) return Object.freeze({ valid: true, releaseEligible: false, reason: 'fixture_not_release_evidence', manifestDigest: digest(physical.manifest) });
  const proof = snapshotJournalData({ schema: 'raibitserver.verified-durable-evidence/v1', fixture: false, identity: statement.identity,
    executionContext: statement.executionContext, manifestDigest: digest(physical.manifest), verifiedBindingJournal: physical.verifiedBindingJournal });
  proofs.add(proof);
  const result = verifyManifest(physical.manifest, { now, durableReceiptProof: proof });
  if (!result.valid || !result.releaseEligible) { proofs.delete(proof); fail(result.reason); }
  if (digest((await inventoryDurableRun(root, false)).files) !== digest(statement.files)) { proofs.delete(proof); fail('durable_digest_mismatch'); }
  return Object.freeze({ ...result, durableReceiptProof: proof });
}

export const sealProductionEvidence = options => seal(options, false);
export const verifyDurableEvidenceFile = (file, options) => verifyFile(file, options, false);
export const sealFixtureEvidenceUnsafe = options => seal(options, true);
export const verifyDurableEvidenceFixtureUnsafe = (file, options) => verifyFile(file, options, true);
