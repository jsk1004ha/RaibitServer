import { parseStepRequest, parseStepResult } from '../lib/step-contract.mjs';
import { pathToFileURL } from 'node:url';
import { runFixedStepMain } from '../run-component.mjs';
import { assertJournalAuthority } from '../lib/journal-authority.mjs';
import { digest } from '../lib/operator-inputs.mjs';
import { deriveRunResourceName } from '../lib/cleanup-intent-journal.mjs';

const STEP = 'supply-chain';
const IDS = ['image_digest', 'scan_policy', 'signature'];
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const rows = (failed, unavailable = false) => IDS.map((id, index) => ({ id, status: failed === null || index < IDS.indexOf(failed) ? 'PASS' : id === failed ? (unavailable ? 'NOT_RUN' : 'FAIL') : 'NOT_RUN' }));
function parseJson(text) { try { return JSON.parse(text); } catch (error) { if (error instanceof SyntaxError) return null; throw error; } }
function one(entries, role, bindingId) { const found = entries.filter((entry) => entry.role === role && entry.bindingId === bindingId); return found.length === 1 ? found[0].payload : null; }
async function command(context, file, args, timeoutMs) { try { return await context.executeFile(file, args, { timeoutMs }); } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { exitCode: 127, stdout: '', stderr: '' }; throw error; } }
async function control(context, request) { try { return await context.controlPlaneJson(request); } catch (error) { if (error instanceof Error) return { statusCode: 0, body: null }; throw error; } }
async function pollDeployment(context, request, deploymentId) {
  for (let attempt = 0; Date.parse(context.now()) < Date.parse(request.deadlineAt); attempt += 1) {
    const intervalMs = Math.min(30_000, 1_000 * (2 ** attempt));
    const remaining = Date.parse(request.deadlineAt) - Date.parse(context.now()); if (remaining <= 0) return null;
    const response = await control(context, { method: 'GET', path: `/api/deployments/${encodeURIComponent(deploymentId)}`, timeoutMs: Math.min(intervalMs, remaining) });
    if (response.statusCode !== 200) return null;
    if (['IMAGE_READY', 'READY', 'FAILED', 'BUILD_FAILED', 'CANCELLED'].includes(response.body?.status)) return response.body;
    const afterRequest = Date.parse(request.deadlineAt) - Date.parse(context.now()); if (afterRequest <= 0) return null;
    await (typeof context.wait === 'function' ? context.wait(Math.min(intervalMs, afterRequest)) : new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, afterRequest))));
  }
  return null;
}

export async function execute(input, context) {
  const request = parseStepRequest(input, STEP);
  let authority = null; let repository = null; let project = null; let service = null; let entries = [];
  try { authority = assertJournalAuthority(context.journalAuthority); const snapshot = await authority.bindingSnapshot(); if (snapshot.runIdentitySha256 !== digest(request.identity)) throw new Error('foreign journal'); entries = await authority.loadBindings(); if (snapshot.entryCount !== entries.length || snapshot.entriesSha256 !== digest(entries)) throw new Error('journal snapshot mismatch'); repository = one(entries, 'source', 'repository'); project = one(entries, 'project', 'primary'); service = one(entries, 'service', 'primary'); } catch { authority = null; repository = null; project = null; service = null; }
  let failed = null; let reason = null; let unavailable = false;
  let deploymentId = null; let tenantCommitSha = null; let observedDigest = null; let imageReference = null; let unfixedHighCritical = null; let sourceBranch = null; let observationId = null;
  const credentials = ['registry', 'scanner', 'signing', 'trust-root'].every((role) => request.secretRefs.some((reference) => reference.role === role));
  const repositoryName = repository?.repository ?? null;
  const valid = repositoryName === request.selectors.RAIBITSERVER_RELEASE_FIXTURE_REPOSITORY && service?.projectId === project?.projectId;
  if (!credentials) { failed = 'image_digest'; reason = 'missing_credentials'; unavailable = true; }
  else if (typeof context.controlPlaneJson !== 'function') { failed = 'image_digest'; reason = 'authenticated_control_plane_unavailable'; unavailable = true; }
  else if (!authority) { failed = 'image_digest'; reason = 'binding_journal_unavailable'; unavailable = true; }
  else if (!valid) { failed = 'image_digest'; reason = 'invalid_supply_chain_state'; }
  else {
    const catalog = await control(context, { method: 'GET', path: `/api/github/installations/${encodeURIComponent(repository.installationId)}/repositories`, timeoutMs: 5_000 });
    const source = catalog.body?.repositories?.find((item) => (item.githubRepoId ?? item.id) === repository.repositoryId && item.fullName === repositoryName && item.private === true) ?? null;
    sourceBranch = source?.defaultBranch ?? null;
    if (catalog.statusCode !== 200 || typeof sourceBranch !== 'string' || sourceBranch !== repository.branch) { failed = 'image_digest'; reason = 'private_repository_access_unverified'; }
    let intent = null;
    if (failed === null) {
      const intentId = 'candidate-deployment', resourceName = deriveRunResourceName(request.identity, intentId), createdAt = new Date(Math.max(Date.parse(context.now()), ...entries.map(entry => Date.parse(entry.createdAt))) + 1).toISOString();
      const bindingRefs = entries.filter(entry => ['identity', 'source', 'project', 'service'].includes(entry.role)).map(entry => ({ role: entry.role, bindingId: entry.bindingId, entrySha256: entry.entrySha256 }));
      try { intent = await authority.appendCleanupIntent({ intentId, mutationKind: 'control-plane-create-deployment', bindingRefs, resourceName, method: 'POST', routeTemplate: '/api/projects/:projectId/services/:serviceId/deployments', relativeRoute: `/api/projects/${project.projectId}/services/${service.serviceId}/deployments`, recoverySelector: { kind: 'Deployment', projectId: project.projectId, serviceId: service.serviceId, name: resourceName, runIdentitySha256: digest(request.identity) }, approvedRuntimeSelector: null, createdAt, deadlineAt: request.deadlineAt }); }
      catch { failed = 'image_digest'; reason = 'deployment_intent_unavailable'; unavailable = true; }
    }
    const created = failed === null ? await control(context, { method: 'POST', path: `/api/projects/${encodeURIComponent(project.projectId)}/services/${encodeURIComponent(service.serviceId)}/deployments`, body: { deploymentType: 'production', branch: sourceBranch }, timeoutMs: 30_000 }) : null;
    deploymentId = created?.body?.id ?? null;
    if (failed === null && (created.statusCode !== 202 || typeof deploymentId !== 'string')) { failed = 'image_digest'; reason = 'deployment_creation_failed'; }
    if (failed === null) { try { await authority.appendOutcome({ intentId: intent.intentId, actualId: deploymentId, actualUid: null, responseSha256: digest(created.body), resolvedAt: new Date(Math.max(Date.parse(context.now()), Date.parse(intent.createdAt) + 1)).toISOString(), approvedRuntimeSelector: null }); } catch { failed = 'image_digest'; reason = 'deployment_outcome_unavailable'; } }
    let deployment = null;
    if (failed === null) {
      deployment = await pollDeployment(context, request, deploymentId);
      tenantCommitSha = deployment?.commitSha ?? null;
      observedDigest = deployment?.imageDigest ?? null;
      imageReference = typeof deployment?.imageUrl === 'string' ? deployment.imageUrl.replace(/@sha256:[0-9a-f]{64}$/, '') : null;
      const events = await control(context, { method: 'GET', path: `/api/deployments/${encodeURIComponent(deploymentId)}/events?limit=100`, timeoutMs: 30_000 });
      const publications = Array.isArray(events.body?.events) ? events.body.events.filter(event => event.deploymentId === deploymentId && event.type === 'build.image_ready' && event.metadata?.dryRun === false && event.metadata?.imageDigest === observedDigest && event.metadata?.image === deployment?.imageUrl && typeof event.id === 'string') : [];
      observationId = events.statusCode === 200 && !events.body?.nextCursor && publications.length === 1 ? publications[0].id : null;
      if (!['IMAGE_READY', 'READY'].includes(deployment?.status) || deployment.id !== deploymentId || deployment.projectId !== project.projectId || deployment.serviceId !== service.serviceId || deployment.branch !== sourceBranch || observationId === null || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tenantCommitSha ?? '') || !DIGEST.test(observedDigest ?? '') || typeof deployment?.imageUrl !== 'string' || !deployment.imageUrl.endsWith(`@${observedDigest}`)) { failed = 'image_digest'; reason = 'image_ready_not_observed'; }
      else {
        const revisionId = deploymentId;
        const revisionAt = new Date(Math.max(Date.parse(context.now()), ...entries.map(entry => Date.parse(entry.createdAt))) + 1).toISOString();
        try {
          await authority.appendBinding({ role: 'revision', bindingId: 'candidate', payload: { kind: 'tenant-revision', tenantRevisionId: revisionId, purpose: 'candidate', observationId, repositoryId: repository.repositoryId, repository: repositoryName, branch: sourceBranch, tenantCommitSha }, createdAt: revisionAt });
          await authority.appendBinding({ role: 'deployment', bindingId: 'candidate', payload: { kind: 'deployment', role: 'candidate', deploymentId, serviceId: service.serviceId, tenantRevisionId: revisionId, tenantCommitSha, repositoryId: repository.repositoryId, repository: repositoryName, branch: sourceBranch }, createdAt: new Date(Date.parse(revisionAt) + 1).toISOString() });
        } catch { failed = 'image_digest'; reason = 'tenant_revision_binding_failed'; }
      }
    }
    if (failed === null) {
      const digestResult = await command(context, 'crane', ['digest', imageReference], 10 * 60_000);
      if (digestResult.exitCode === 127) { failed = 'image_digest'; reason = 'missing_tool'; unavailable = true; }
      else if (digestResult.exitCode !== 0 || digestResult.stdout.trim() !== observedDigest) { failed = 'image_digest'; reason = 'image_digest_mismatch'; }
    }
    if (failed === null) {
      const target = `${imageReference}@${observedDigest}`;
      const scan = await command(context, 'trivy', ['image', '--format', 'json', '--severity', 'HIGH,CRITICAL', target], 10 * 60_000);
      if (scan.exitCode === 127) { failed = 'scan_policy'; reason = 'missing_tool'; unavailable = true; }
      else if (scan.exitCode !== 0) { failed = 'scan_policy'; reason = 'scan_failed'; }
      else {
        const report = parseJson(scan.stdout);
        const vulnerabilities = Array.isArray(report?.Results) ? report.Results.flatMap((item) => Array.isArray(item.Vulnerabilities) ? item.Vulnerabilities : []) : null;
        if (vulnerabilities === null) { failed = 'scan_policy'; reason = 'invalid_scan_report'; }
        else { unfixedHighCritical = vulnerabilities.filter((item) => ['HIGH', 'CRITICAL'].includes(item.Severity) && !item.FixedVersion).length; if (unfixedHighCritical > 0) { failed = 'scan_policy'; reason = 'unfixed_high_critical'; } }
      }
    }
    if (failed === null) {
      const signature = await command(context, 'cosign', ['verify', '--key', '/run/secrets/trust-root/value', `${imageReference}@${observedDigest}`, '--output', 'json'], 10 * 60_000);
      const signatures = signature.exitCode === 0 ? parseJson(signature.stdout) : null;
      if (signature.exitCode === 127) { failed = 'signature'; reason = 'missing_tool'; unavailable = true; }
      else if (!Array.isArray(signatures) || signatures.length === 0) { failed = 'signature'; reason = 'signature_verification_failed'; }
    }
  }
  const status = failed === null ? 'PASS' : unavailable ? 'NOT_RUN' : 'FAIL';
  const tenantRevision = tenantCommitSha && observedDigest && observationId ? { schema: 'raibitserver.production-evidence-tenant-revision/v1', projectId: project?.projectId ?? null, serviceId: service?.serviceId ?? null, repository: repositoryName, repositoryId: repository?.repositoryId ?? null, branch: sourceBranch, commitSha: tenantCommitSha, deploymentId, observationId, imageDigest: observedDigest } : null;
  const artifact = await context.writeArtifact('lifecycle', 'supply-chain-observation.json', { schema: 'raibitserver.supply-chain-observation/v1', identity: request.identity, tenantRevision, imageReference, imageReady: failed === null, unfixedHighCritical, signatureVerified: failed === null, status, observedAt: context.now() });
  return parseStepResult({ status, reason, assertions: rows(failed, unavailable).map((row) => ({ ...row, artifactPaths: [artifact.path] })), artifacts: [artifact], cleanupInventory: [] }, STEP, request);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runFixedStepMain(STEP, process.argv.slice(2)).then(({ exitCode }) => { process.exitCode = exitCode; });
