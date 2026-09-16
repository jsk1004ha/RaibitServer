import { pathToFileURL } from 'node:url';
import { assertJournalAuthority } from '../lib/journal-authority.mjs';
import { deriveRunResourceName } from '../lib/cleanup-intent-journal.mjs';
import { digest } from '../lib/operator-inputs.mjs';
import { parseStepRequest, parseStepResult } from '../lib/step-contract.mjs';
import { runFixedStepMain } from '../run-component.mjs';
import { isSafeHealthPath } from '../../../packages/core/src/deployment-health.ts';

const STEP = 'rollback';
const one = (entries, role, bindingId) => entries.filter(entry => entry.role === role && entry.bindingId === bindingId).length === 1 ? entries.find(entry => entry.role === role && entry.bindingId === bindingId) : null;
const ref = entry => ({ role: entry.role, bindingId: entry.bindingId, entrySha256: entry.entrySha256 });
async function control(context, request) { try { return await context.controlPlaneJson(request); } catch (error) { if (error instanceof Error) return { statusCode: 0, body: null }; throw error; } }
async function publicHttp(context, request) { try { return await context.requestJson(request); } catch (error) { if (error instanceof Error) return { statusCode: 0, body: null }; throw error; } }
async function command(context, args) { try { return await context.executeFile('kubectl', args, { timeoutMs: 30_000 }); } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { exitCode: 127, stdout: '' }; throw error; } }
function endpoint(deployment) { try { const url = new URL(deployment?.publicUrl ?? deployment?.url); return url.protocol === 'https:' && !url.username && !url.password ? url : null; } catch (error) { if (error instanceof TypeError) return null; throw error; } }
async function poll(context, request, deploymentId, terminals) {
  for (let attempt = 0; Date.parse(context.now()) < Date.parse(request.deadlineAt); attempt += 1) {
    const remaining = Date.parse(request.deadlineAt) - Date.parse(context.now()); if (remaining <= 0) return null;
    const response = await control(context, { method: 'GET', path: `/api/deployments/${encodeURIComponent(deploymentId)}`, timeoutMs: Math.min(30_000, remaining) });
    if (response.statusCode !== 200 || terminals.includes(response.body?.status)) return response.statusCode === 200 ? response.body : null;
    const delay = Math.min(30_000, 1_000 * (2 ** attempt), Date.parse(request.deadlineAt) - Date.parse(context.now())); if (delay <= 0) return null;
    await (typeof context.wait === 'function' ? context.wait(delay) : new Promise(resolve => setTimeout(resolve, delay)));
  }
  return null;
}

export async function execute(input, context) {
  const request = parseStepRequest(input, STEP);
  let authority = null, entries = [], cleanupEntries = [];
  try {
    authority = assertJournalAuthority(context.journalAuthority); const snapshot = await authority.bindingSnapshot(); entries = await authority.loadBindings();
    if (snapshot.runIdentitySha256 !== digest(request.identity) || snapshot.entryCount !== entries.length || snapshot.entriesSha256 !== digest(entries)) throw new Error('journal snapshot mismatch');
    cleanupEntries = (await authority.loadCleanup({ approvedRuntimeSelector: null })).entries;
  } catch { authority = null; entries = []; }
  const membershipEntry = one(entries, 'identity', 'membership'), repositoryEntry = one(entries, 'source', 'repository'), projectEntry = one(entries, 'project', 'primary'), serviceEntry = one(entries, 'service', 'primary'), readyRevisionEntry = one(entries, 'revision', 'candidate'), readyDeploymentEntry = one(entries, 'deployment', 'candidate');
  const membership = membershipEntry?.payload, repository = repositoryEntry?.payload, project = projectEntry?.payload, service = serviceEntry?.payload, ready = readyRevisionEntry?.payload, readyDeployment = readyDeploymentEntry?.payload;
  let status = 'PASS', reason = null, badDeploymentId = null, rollbackDeploymentId = null, servedDigest = null, badRolloutObserved = false, previousDigest = null, failureRevision = null, controlledFault = null;
  let timestamp = Math.max(Date.parse(context.now()), ...entries.map(entry => Date.parse(entry.createdAt)), ...cleanupEntries.map(entry => Date.parse(entry.createdAt ?? entry.resolvedAt)));
  const at = () => { timestamp = Math.max(timestamp + 1, Date.parse(context.now())); return new Date(timestamp).toISOString(); };
  if (!request.secretRefs.some(role => role.role === 'runtime')) { status = 'NOT_RUN'; reason = 'missing_credentials'; }
  else if (typeof context.controlPlaneJson !== 'function') { status = 'NOT_RUN'; reason = 'authenticated_control_plane_unavailable'; }
  else if (!authority || !membership || !repository || !project || !service || !ready || !readyDeployment
    || project.organizationId !== membership.organizationId || service.projectId !== project.projectId || readyDeployment.serviceId !== service.serviceId
    || repository.repository !== request.selectors.RAIBITSERVER_RELEASE_FIXTURE_REPOSITORY || repository.installationId !== request.selectors.RAIBITSERVER_RELEASE_GITHUB_INSTALLATION_ID
    || ready.repositoryId !== repository.repositoryId || ready.repository !== repository.repository || ready.branch !== repository.branch) { status = 'NOT_RUN'; reason = 'binding_journal_unavailable'; }
  else {
    const refs = [membershipEntry, repositoryEntry, projectEntry, serviceEntry, readyRevisionEntry, readyDeploymentEntry].map(ref);
    const previous = await control(context, { method: 'GET', path: `/api/deployments/${encodeURIComponent(readyDeployment.deploymentId)}`, timeoutMs: 30_000 });
    const currentService = await control(context, { method: 'GET', path: `/api/services/${encodeURIComponent(service.serviceId)}`, timeoutMs: 30_000 });
    previousDigest = previous.body?.imageDigest ?? null;
    const baseUrl = endpoint(previous.body), originalReadinessPath = currentService.body?.readinessPath ?? null;
    const healthConfig = currentService.body, healthPaths = [healthConfig?.livenessPath ?? healthConfig?.healthCheckPath, healthConfig?.publicHealthPath ?? healthConfig?.readinessPath ?? healthConfig?.healthCheckPath];
    const failingPath = `/__raibit_rollout_failure_${request.identity.runId}`;
    let probeStatusCode = null, healthAttempted = false;
    async function changeHealth(intentId, nextPath, previousPath) {
      const resourceName = deriveRunResourceName(request.identity, intentId);
      const intent = await authority.appendCleanupIntent({ intentId, mutationKind: 'control-plane-update-service-health', bindingRefs: [membershipEntry, projectEntry, serviceEntry].map(ref), resourceName, method: 'PATCH', routeTemplate: '/api/services/:serviceId', relativeRoute: `/api/services/${service.serviceId}`, recoverySelector: { kind: 'ServiceHealth', projectId: project.projectId, serviceId: service.serviceId, name: resourceName, runIdentitySha256: digest(request.identity), readinessPathSha256: digest(nextPath), previousReadinessPathSha256: digest(previousPath) }, approvedRuntimeSelector: null, createdAt: at(), deadlineAt: request.deadlineAt });
      if (intentId === 'rollback-health-fault') healthAttempted = true;
      const changed = await control(context, { method: 'PATCH', path: `/api/services/${encodeURIComponent(service.serviceId)}`, body: { readinessPath: nextPath }, timeoutMs: 30_000 });
      if (changed.statusCode !== 200 || changed.body?.id !== service.serviceId || changed.body?.projectId !== project.projectId || changed.body?.readinessPath !== nextPath) throw new Error('service health update failed');
      await authority.appendOutcome({ intentId: intent.intentId, actualId: service.serviceId, actualUid: null, responseSha256: digest(changed.body), resolvedAt: at(), approvedRuntimeSelector: null });
    }
    if (previous.statusCode !== 200 || previous.body?.id !== readyDeployment.deploymentId || previous.body?.serviceId !== service.serviceId || previous.body?.projectId !== project.projectId
      || previous.body?.status !== 'READY' || previous.body?.commitSha !== ready.tenantCommitSha || !/^sha256:[0-9a-f]{64}$/.test(previousDigest ?? '') || baseUrl === null) { status = 'FAIL'; reason = 'previous_ready_deployment_unavailable'; }
    else if (currentService.statusCode !== 200 || currentService.body?.id !== service.serviceId || currentService.body?.projectId !== project.projectId
      || !(originalReadinessPath === null || typeof originalReadinessPath === 'string')) { status = 'FAIL'; reason = 'service_health_configuration_unavailable'; }
    else if (!healthPaths.every(isSafeHealthPath)) { status = 'NOT_RUN'; reason = 'fixture_health_contract_unavailable'; }
    if (status === 'PASS') for (const pathname of new Set(healthPaths)) { const health = await publicHttp(context, { method: 'GET', url: new URL(pathname, baseUrl).href, timeoutMs: 30_000 }); if (health.statusCode !== 200) { status = 'FAIL'; reason = 'previous_ready_health_unavailable'; break; } }
    if (status === 'PASS') {
      const probe = await publicHttp(context, { method: 'GET', url: new URL(failingPath, baseUrl).href, timeoutMs: 30_000 }); probeStatusCode = probe.statusCode;
      if (probeStatusCode !== 404) { status = 'NOT_RUN'; reason = 'controlled_fault_path_unavailable'; }
    }
    if (status === 'PASS') {
      try {
        await changeHealth('rollback-health-fault', failingPath, originalReadinessPath);
        const intentId = 'rollback-failed-deployment', resourceName = deriveRunResourceName(request.identity, intentId);
        const intent = await authority.appendCleanupIntent({ intentId, mutationKind: 'control-plane-create-deployment', bindingRefs: refs, resourceName, method: 'POST', routeTemplate: '/api/projects/:projectId/services/:serviceId/deployments', relativeRoute: `/api/projects/${project.projectId}/services/${service.serviceId}/deployments`, recoverySelector: { kind: 'Deployment', projectId: project.projectId, serviceId: service.serviceId, name: resourceName, runIdentitySha256: digest(request.identity) }, approvedRuntimeSelector: null, createdAt: at(), deadlineAt: request.deadlineAt });
        const created = await control(context, { method: 'POST', path: `/api/projects/${encodeURIComponent(project.projectId)}/services/${encodeURIComponent(service.serviceId)}/deployments`, body: { deploymentType: 'production', commitSha: ready.tenantCommitSha, branch: ready.branch }, timeoutMs: 30_000 });
        badDeploymentId = created.body?.id ?? null;
        if (created.statusCode !== 202 || typeof badDeploymentId !== 'string' || badDeploymentId === readyDeployment.deploymentId) throw new Error('bad rollout not started');
        await authority.appendOutcome({ intentId: intent.intentId, actualId: badDeploymentId, actualUid: null, responseSha256: digest(created.body), resolvedAt: at(), approvedRuntimeSelector: null });
        const failed = await poll(context, request, badDeploymentId, ['FAILED', 'BUILD_FAILED', 'CANCELLED', 'READY']);
        const events = await control(context, { method: 'GET', path: `/api/deployments/${encodeURIComponent(badDeploymentId)}/events?limit=100`, timeoutMs: 30_000 });
        const failures = Array.isArray(events.body?.events) ? events.body.events.filter(event => event.deploymentId === badDeploymentId && event.type === 'rollout.failed' && event.metadata?.errorSpec?.code === 'ROLLOUT_FAILED' && typeof event.id === 'string') : [];
        const snapshot = failed?.desiredSpecSnapshot;
        badRolloutObserved = failed?.id === badDeploymentId && failed?.projectId === project.projectId && failed?.serviceId === service.serviceId && failed?.status === 'FAILED'
          && failed?.errorCode === 'ROLLOUT_FAILED' && failed?.commitSha === ready.tenantCommitSha && failed?.branch === ready.branch && failed?.snapshotVersion === 1
          && snapshot?.readinessPath === failingPath && snapshot?.githubRepositoryId === repository.repositoryId && snapshot?.githubRepository === repository.repository
          && events.statusCode === 200 && !events.body?.nextCursor && failures.length === 1;
        if (!badRolloutObserved) { status = 'FAIL'; reason = 'controlled_bad_rollout_not_observed'; }
        else {
          const observationId = failures[0].id;
          failureRevision = { projectId: project.projectId, serviceId: service.serviceId, repositoryId: repository.repositoryId, repository: repository.repository, branch: failed.branch, commitSha: failed.commitSha, deploymentId: failed.id, observationId };
          controlledFault = { kind: 'readiness-path', originalReadinessPath, failingPath, probeStatusCode, snapshotVersion: failed.snapshotVersion, deploymentReadinessPath: snapshot.readinessPath, failedStatus: failed.status, errorCode: failed.errorCode, rolloutEventId: observationId, restoredReadinessPath: null };
          await authority.appendBinding({ role: 'revision', bindingId: 'failure', payload: { kind: 'tenant-revision', tenantRevisionId: failed.id, purpose: 'failure', observationId, repositoryId: repository.repositoryId, repository: repository.repository, branch: failed.branch, tenantCommitSha: failed.commitSha }, createdAt: at() });
          await authority.appendBinding({ role: 'deployment', bindingId: 'failed', payload: { kind: 'deployment', role: 'failed', deploymentId: failed.id, serviceId: service.serviceId, tenantRevisionId: failed.id, tenantCommitSha: failed.commitSha, repositoryId: repository.repositoryId, repository: repository.repository, branch: failed.branch }, createdAt: at() });
        }
      } catch (error) { status = 'FAIL'; reason = error instanceof Error && 'reason' in error ? error.reason : 'controlled_rollout_failed'; }
      finally {
        if (healthAttempted) {
          try { await changeHealth('rollback-health-restore', originalReadinessPath, failingPath); if (controlledFault) controlledFault.restoredReadinessPath = originalReadinessPath; }
          catch { status = 'FAIL'; reason = 'service_health_restoration_failed'; }
        }
      }
    }
    if (status === 'PASS' && badRolloutObserved) {
      const bound = await authority.loadBindings(), intentId = 'rollback', resourceName = deriveRunResourceName(request.identity, intentId);
      try {
        const intent = await authority.appendCleanupIntent({ intentId, mutationKind: 'control-plane-rollback', bindingRefs: [membershipEntry, repositoryEntry, projectEntry, serviceEntry, one(bound, 'revision', 'failure'), one(bound, 'deployment', 'failed')].map(ref), resourceName, method: 'POST', routeTemplate: '/api/deployments/:deploymentId/rollback', relativeRoute: `/api/deployments/${badDeploymentId}/rollback`, recoverySelector: { kind: 'Deployment', projectId: project.projectId, serviceId: service.serviceId, deploymentId: badDeploymentId, name: resourceName, runIdentitySha256: digest(request.identity) }, approvedRuntimeSelector: null, createdAt: at(), deadlineAt: request.deadlineAt });
        const started = await control(context, { method: 'POST', path: `/api/deployments/${encodeURIComponent(badDeploymentId)}/rollback`, body: { confirmed: true, previousDeploymentId: readyDeployment.deploymentId }, timeoutMs: 30_000 }); rollbackDeploymentId = started.body?.deployment?.id ?? null;
        if (started.statusCode !== 202 || typeof rollbackDeploymentId !== 'string' || [badDeploymentId, readyDeployment.deploymentId].includes(rollbackDeploymentId)) throw new Error('rollback not started');
        await authority.appendOutcome({ intentId: intent.intentId, actualId: rollbackDeploymentId, actualUid: null, responseSha256: digest(started.body), resolvedAt: at(), approvedRuntimeSelector: null });
        const restored = await poll(context, request, rollbackDeploymentId, ['READY', 'FAILED', 'BUILD_FAILED']), healthUrl = endpoint(restored);
        if (restored?.id !== rollbackDeploymentId || restored?.serviceId !== service.serviceId || restored?.projectId !== project.projectId || restored?.status !== 'READY' || restored?.commitSha !== ready.tenantCommitSha || restored?.imageDigest !== previousDigest || healthUrl === null || typeof restored.namespace !== 'string' || typeof restored.deploymentName !== 'string') { status = 'FAIL'; reason = 'rollback_ready_not_observed'; }
        else {
          const rollout = await command(context, ['--context', request.selectors.RAIBITSERVER_RELEASE_KUBE_CONTEXT, '-n', restored.namespace, 'rollout', 'status', `deployment/${restored.deploymentName}`, '--timeout=30s']);
          const fetched = rollout.exitCode === 0 ? await command(context, ['--context', request.selectors.RAIBITSERVER_RELEASE_KUBE_CONTEXT, '-n', restored.namespace, 'get', 'deployment', restored.deploymentName, '-o', 'json']) : null;
          let kube = null; try { kube = fetched?.exitCode === 0 ? JSON.parse(fetched.stdout) : null; } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
          const labels = { ...kube?.metadata?.labels, ...kube?.spec?.template?.metadata?.labels }, images = kube?.spec?.template?.spec?.containers?.map(container => container.image) ?? [];
          if (!kube || labels['raibitserver.io/deployment-id'] !== rollbackDeploymentId || labels['raibitserver.io/service-id'] !== service.serviceId || labels['raibitserver.io/project-id'] !== project.projectId
            || kube.metadata?.generation !== kube.status?.observedGeneration || kube.spec?.replicas !== kube.status?.readyReplicas || !images.some(image => image.endsWith(`@${previousDigest}`))) { status = 'FAIL'; reason = 'rollback_digest_mismatch'; }
          else {
            servedDigest = previousDigest;
            for (const pathname of new Set(healthPaths)) { const health = await publicHttp(context, { method: 'GET', url: new URL(pathname, healthUrl).href, timeoutMs: 30_000 }); if (health.statusCode !== 200) { status = 'FAIL'; reason = 'rollback_health_failed'; break; } }
            if (status === 'PASS') await authority.appendBinding({ role: 'deployment', bindingId: 'rollback', payload: { kind: 'deployment', role: 'rollback', deploymentId: rollbackDeploymentId, serviceId: service.serviceId, tenantRevisionId: ready.tenantRevisionId, tenantCommitSha: ready.tenantCommitSha, repositoryId: repository.repositoryId, repository: repository.repository, branch: ready.branch }, createdAt: at() });
          }
        }
      } catch (error) { status = 'FAIL'; reason = error instanceof Error && 'reason' in error ? error.reason : 'rollback_failed'; }
    }
  }
  const artifact = await context.writeArtifact('operations', 'rollback-observation.json', { schema: 'raibitserver.rollback-observation/v1', identity: request.identity, readyDeploymentId: readyDeployment?.deploymentId ?? null, controlledBadObservationId: failureRevision?.observationId ?? null, failureRevision, controlledFault, badDeploymentId, rollbackDeploymentId, servedDigest, badRolloutObserved, status, observedAt: context.now() });
  return parseStepResult({ status, reason, assertions: [{ id: 'rollback', status, artifactPaths: [artifact.path] }], artifacts: [artifact], cleanupInventory: [] }, STEP, request);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runFixedStepMain(STEP, process.argv.slice(2)).then(({ exitCode }) => { process.exitCode = exitCode; });
