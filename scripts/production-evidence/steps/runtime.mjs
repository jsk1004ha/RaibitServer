import { X509Certificate } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseStepRequest, parseStepResult } from '../lib/step-contract.mjs';
import { assertJournalAuthority } from '../lib/journal-authority.mjs';
import { digest } from '../lib/operator-inputs.mjs';
import { runFixedStepMain } from '../run-component.mjs';
import { isSafeHealthPath } from '../../../packages/core/src/deployment-health.ts';

const STEP = 'runtime';
const IDS = ['rollout', 'https', 'functional_write_read', 'trusted_proxy'];
const rows = (failed, unavailable = false) => IDS.map((id, index) => ({ id, status: failed === null || index < IDS.indexOf(failed) ? 'PASS' : id === failed ? (unavailable ? 'NOT_RUN' : 'FAIL') : 'NOT_RUN' }));
function parseJson(text) { try { return JSON.parse(text); } catch (error) { if (error instanceof SyntaxError) return null; throw error; } }
async function command(context, file, args, timeoutMs) { try { return await context.executeFile(file, args, { timeoutMs }); } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { exitCode: 127, stdout: '', stderr: '' }; throw error; } }
async function control(context, request) { try { return await context.controlPlaneJson(request); } catch (error) { if (error instanceof Error) return { statusCode: 0, body: null }; throw error; } }
async function publicHttp(context, request) { try { return await context.requestJson(request); } catch (error) { if (error instanceof Error) return { statusCode: 0, body: null }; throw error; } }
function httpsUrl(value) { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url : null; } catch (error) { if (error instanceof TypeError) return null; throw error; } }
function exactSan(output, host) {
  const pem = output.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
  if (!pem) return output.split(/\r?\n/).includes(`subjectAltName=DNS:${host}`);
  try { return (new X509Certificate(pem).subjectAltName ?? '').split(', ').includes(`DNS:${host}`); } catch (error) { if (error instanceof Error) return false; throw error; }
}
function one(entries, role, bindingId) { const found = entries.filter((entry) => entry.role === role && entry.bindingId === bindingId); return found.length === 1 ? found[0].payload : null; }

export async function execute(input, context) {
  const request = parseStepRequest(input, STEP);
  let authority = null; let project = null; let service = null; let revision = null; let boundDeployment = null;
  try { authority = assertJournalAuthority(context.journalAuthority); const snapshot = await authority.bindingSnapshot(); if (snapshot.runIdentitySha256 !== digest(request.identity)) throw new Error('foreign journal'); const entries = await authority.loadBindings(); if (snapshot.entryCount !== entries.length || snapshot.entriesSha256 !== digest(entries)) throw new Error('journal snapshot mismatch'); project = one(entries, 'project', 'primary'); service = one(entries, 'service', 'primary'); revision = one(entries, 'revision', 'candidate'); boundDeployment = one(entries, 'deployment', 'candidate'); } catch { authority = null; project = null; service = null; revision = null; boundDeployment = null; }
  let failed = null; let reason = null; let unavailable = false; let generation = null; let workloadUid = null; let publicUrl = null; let observedDigest = null;
  let namespace = null; let deploymentName = null; let functionalObservation = null;
  const credentials = ['runtime', 'database'].every((role) => request.secretRefs.some((reference) => reference.role === role));
  if (!credentials) { failed = 'rollout'; reason = 'missing_credentials'; unavailable = true; }
  else if (typeof context.controlPlaneJson !== 'function') { failed = 'rollout'; reason = 'authenticated_control_plane_unavailable'; unavailable = true; }
  else if (!authority || !project || !service || !revision || !boundDeployment) { failed = 'rollout'; reason = 'binding_journal_unavailable'; unavailable = true; }
  else if (boundDeployment.serviceId !== service.serviceId) { failed = 'rollout'; reason = 'invalid_runtime_state'; }
  else {
    const observed = await control(context, { method: 'GET', path: `/api/deployments/${encodeURIComponent(boundDeployment.deploymentId)}`, timeoutMs: 30_000 });
    const deployment = observed.statusCode === 200 ? observed.body : null;
    observedDigest = deployment?.imageDigest ?? null;
    publicUrl = deployment?.publicUrl ?? deployment?.url ?? deployment?.previewUrl ?? null; namespace = deployment?.namespace ?? null; deploymentName = deployment?.deploymentName ?? null;
    const endpoint = httpsUrl(publicUrl);
    if (deployment?.id !== boundDeployment.deploymentId || deployment?.projectId !== project.projectId || deployment?.serviceId !== service.serviceId || deployment?.status !== 'READY' || endpoint === null || !/^sha256:[0-9a-f]{64}$/.test(observedDigest ?? '') || deployment?.commitSha !== revision.tenantCommitSha || typeof namespace !== 'string' || typeof deploymentName !== 'string') { failed = 'rollout'; reason = 'deployment_ready_not_observed'; }
    let kube = null;
    if (failed === null) {
      const rollout = await command(context, 'kubectl', ['--context', request.selectors.RAIBITSERVER_RELEASE_KUBE_CONTEXT, '-n', namespace, 'rollout', 'status', `deployment/${deploymentName}`, '--timeout=10m'], 10 * 60_000);
      if (rollout.exitCode === 127) { failed = 'rollout'; reason = 'missing_tool'; unavailable = true; }
      else if (rollout.exitCode !== 0) { failed = 'rollout'; reason = 'rollout_failed'; }
      else {
        const fetched = await command(context, 'kubectl', ['--context', request.selectors.RAIBITSERVER_RELEASE_KUBE_CONTEXT, '-n', namespace, 'get', 'deployment', deploymentName, '-o', 'json'], 30_000);
        kube = fetched.exitCode === 0 ? parseJson(fetched.stdout) : null;
        if (fetched.exitCode === 127) { failed = 'rollout'; reason = 'missing_tool'; unavailable = true; }
        else {
          generation = kube?.status?.observedGeneration ?? null; workloadUid = kube?.metadata?.uid ?? null;
          const replicas = kube?.spec?.replicas; const images = kube?.spec?.template?.spec?.containers?.map(({ image }) => image) ?? [];
          const labels = { ...kube?.metadata?.labels, ...kube?.spec?.template?.metadata?.labels };
          if (fetched.exitCode !== 0 || !kube || kube.metadata?.generation !== generation || kube.status?.readyReplicas !== replicas || kube.status?.updatedReplicas !== replicas
            || labels['raibitserver.io/deployment-id'] !== boundDeployment.deploymentId || labels['raibitserver.io/project-id'] !== project.projectId
            || labels['raibitserver.io/service-id'] !== service.serviceId || !images.some((image) => image.endsWith(`@${observedDigest}`))) { failed = 'rollout'; reason = 'rollout_not_ready'; }
        }
      }
    }
    if (failed === null) {
      const endpoint = httpsUrl(publicUrl), snapshot = deployment.desiredSpecSnapshot;
      const healthPaths = [snapshot?.livenessPath ?? snapshot?.healthCheckPath, snapshot?.publicHealthPath ?? snapshot?.readinessPath ?? snapshot?.healthCheckPath];
      const tls = await command(context, 'openssl', ['s_client', '-connect', `${endpoint.hostname}:${endpoint.port || '443'}`, '-servername', endpoint.hostname, '-verify_hostname', endpoint.hostname, '-verify_return_error', '-showcerts'], 3 * 60_000);
      if (tls.exitCode === 127) { failed = 'https'; reason = 'missing_tool'; unavailable = true; }
      else if (tls.exitCode !== 0 || !exactSan(tls.stdout, endpoint.hostname)) { failed = 'https'; reason = 'tls_san_mismatch'; }
      else if (!healthPaths.every(isSafeHealthPath)) { failed = 'https'; reason = 'fixture_health_contract_unavailable'; unavailable = true; }
      else { for (const pathname of new Set(healthPaths)) { const health = await publicHttp(context, { method: 'GET', url: new URL(pathname, endpoint).href, timeoutMs: 30_000 }); if (health.statusCode !== 200) { failed = 'https'; reason = 'https_health_failed'; break; } } }
      if (failed === null) {
        const nonce = digest({ runId: request.identity.runId, deploymentId: boundDeployment.deploymentId, purpose: 'runtime' });
        const functional = await publicHttp(context, { method: 'POST', url: new URL('/_evidence/db', endpoint).href, body: { runId: request.identity.runId, deploymentId: boundDeployment.deploymentId, nonce }, timeoutMs: 30_000 });
        if ([404, 405].includes(functional.statusCode)) { failed = 'functional_write_read'; reason = 'fixture_functional_contract_unavailable'; unavailable = true; }
        else if (functional.statusCode !== 200 || functional.body?.nonce !== nonce || functional.body?.readBack !== nonce) { failed = 'functional_write_read'; reason = 'nonce_round_trip_failed'; }
        else {
          functionalObservation = { correlationId: nonce, nonce: functional.body.nonce, readBack: functional.body.readBack };
          failed = 'trusted_proxy'; reason = 'trusted_proxy_observation_unavailable'; unavailable = true;
        }
      }
    }
  }
  const status = failed === null ? 'PASS' : unavailable ? 'NOT_RUN' : 'FAIL';
  const artifact = await context.writeArtifact('lifecycle', 'runtime-observation.json', { schema: 'raibitserver.runtime-observation/v1', identity: request.identity, deploymentId: boundDeployment?.deploymentId ?? null, namespace, deploymentName, functionalObservation, workloadUid, generation, publicUrl, observedDigest, status, observedAt: context.now() });
  return parseStepResult({ status, reason, assertions: rows(failed, unavailable).map((row) => ({ ...row, artifactPaths: [artifact.path] })), artifacts: [artifact], cleanupInventory: [] }, STEP, request);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runFixedStepMain(STEP, process.argv.slice(2)).then(({ exitCode }) => { process.exitCode = exitCode; });
