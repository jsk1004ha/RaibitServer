import { pathToFileURL } from 'node:url';
import { PreviewWebhookSchema } from '../../../packages/schemas/src/preview.ts';
import { EvidenceBindingSchema } from '../../../packages/schemas/src/production-evidence.ts';
import { assertJournalAuthority } from '../lib/journal-authority.mjs';
import { deriveRunResourceName } from '../lib/cleanup-intent-journal.mjs';
import { digest } from '../lib/operator-inputs.mjs';
import { parseStepRequest, parseStepResult } from '../lib/step-contract.mjs';
import { runFixedStepMain } from '../run-component.mjs';

const STEP = 'preview';
const one = (entries, role, bindingId) => entries.filter(entry => entry.role === role && entry.bindingId === bindingId).length === 1 ? entries.find(entry => entry.role === role && entry.bindingId === bindingId) : null;
const ref = entry => ({ role: entry.role, bindingId: entry.bindingId, entrySha256: entry.entrySha256 });
async function control(context, request) { try { return await context.controlPlaneJson(request); } catch (error) { if (error instanceof Error) return { statusCode: 0, body: null }; throw error; } }
async function command(context, args) { try { return await context.executeFile('kubectl', args, { timeoutMs: 30_000 }); } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { exitCode: 127, stdout: '' }; throw error; } }
async function wait(context, request, attempt) {
  const delay = Math.min(30_000, 1_000 * (2 ** attempt), Date.parse(request.deadlineAt) - Date.parse(context.now()));
  if (delay <= 0) return false;
  await (typeof context.wait === 'function' ? context.wait(delay) : new Promise(resolve => setTimeout(resolve, delay)));
  return true;
}
async function poll(context, request, deploymentId) {
  for (let attempt = 0; Date.parse(context.now()) < Date.parse(request.deadlineAt); attempt += 1) {
    const remaining = Date.parse(request.deadlineAt) - Date.parse(context.now()); if (remaining <= 0) return null;
    const response = await control(context, { method: 'GET', path: `/api/deployments/${encodeURIComponent(deploymentId)}`, timeoutMs: Math.min(30_000, remaining) });
    if (response.statusCode !== 200 || ['CLEANED_UP', 'FAILED'].includes(response.body?.status)) return response.statusCode === 200 ? response.body : null;
    if (!await wait(context, request, attempt)) return null;
  }
  return null;
}
async function discover(context, request, scope) {
  for (let attempt = 0; Date.parse(context.now()) < Date.parse(request.deadlineAt); attempt += 1) {
    if (Date.parse(context.now()) >= Date.parse(request.deadlineAt)) return null;
    const listed = await control(context, { method: 'GET', path: `/api/projects/${encodeURIComponent(scope.projectId)}/services/${encodeURIComponent(scope.serviceId)}/deployments?limit=100`, timeoutMs: 30_000 });
    if (listed.statusCode !== 200 || !Array.isArray(listed.body?.deployments) || listed.body.nextCursor) return null;
    const matches = [];
    for (const candidate of listed.body.deployments.filter(item => item.projectId === scope.projectId && item.serviceId === scope.serviceId && item.deploymentType === 'preview' && item.triggerType === 'github_pull_request' && !['CLEANED_UP', 'CANCELLED'].includes(item.status))) {
      const events = await control(context, { method: 'GET', path: `/api/deployments/${encodeURIComponent(candidate.id)}/events?limit=100`, timeoutMs: 30_000 });
      if (events.statusCode !== 200 || !Array.isArray(events.body?.events) || events.body.nextCursor) continue;
      for (const row of events.body.events) {
        const { source, webhookEventId, lineageId, ...payload } = row.metadata ?? {};
        const parsed = PreviewWebhookSchema.safeParse(payload);
        if (row.type !== 'preview.workload.queued' || row.deploymentId !== candidate.id || typeof row.id !== 'string' || source !== 'github-webhook' || !parsed.success) continue;
        const event = parsed.data;
        const binding = EvidenceBindingSchema.safeParse({ kind: 'github-webhook-event', webhookEventId, provider: 'github', eventType: 'pull_request', deliveryId: event.deliveryId, handled: true, event });
        if (!binding.success || event.action === 'closed' || event.installationId !== scope.repository.installationId || event.repositoryId !== scope.repository.repositoryId
          || event.repository !== scope.repository.repository || event.baseRef !== scope.repository.branch || event.headSha !== candidate.commitSha || event.headRef !== candidate.branch
          || event.pullRequestNumber !== candidate.pullRequestNumber || lineageId !== candidate.previewLineageId || typeof lineageId !== 'string') continue;
        matches.push({ candidate, row, event, binding: binding.data, lineageId, webhookEventId });
      }
    }
    if (matches.length > 1) return { ambiguous: true };
    if (matches.length === 1 && matches[0].candidate.status === 'READY') return matches[0];
    if (matches.length === 1 && ['FAILED', 'BUILD_FAILED'].includes(matches[0].candidate.status)) return matches[0];
    if (!await wait(context, request, attempt)) return null;
  }
  return null;
}

export async function execute(input, context) {
  const request = parseStepRequest(input, STEP);
  let authority = null; let entries = [];
  try {
    authority = assertJournalAuthority(context.journalAuthority); const snapshot = await authority.bindingSnapshot(); entries = await authority.loadBindings();
    if (snapshot.runIdentitySha256 !== digest(request.identity) || snapshot.entryCount !== entries.length || snapshot.entriesSha256 !== digest(entries)) throw new Error('journal snapshot mismatch');
  } catch { authority = null; entries = []; }
  const membershipEntry = one(entries, 'identity', 'membership'), repositoryEntry = one(entries, 'source', 'repository'), projectEntry = one(entries, 'project', 'primary'), serviceEntry = one(entries, 'service', 'primary');
  const membership = membershipEntry?.payload, repository = repositoryEntry?.payload, project = projectEntry?.payload, service = serviceEntry?.payload;
  let status = 'PASS', reason = null, deploymentId = null, remainingObjects = null, observedStatus = null, lineageId = null, pullRequestNumber = null, namespace = null, webhookEventId = null, event = null, observationId = null;
  const credentials = ['github', 'runtime'].every(role => request.secretRefs.some(reference => reference.role === role));
  if (!credentials) { status = 'NOT_RUN'; reason = 'missing_credentials'; }
  else if (typeof context.controlPlaneJson !== 'function') { status = 'NOT_RUN'; reason = 'authenticated_control_plane_unavailable'; }
  else if (!authority || !membership || !repository || !project || !service || service.projectId !== project.projectId || project.organizationId !== membership.organizationId
    || repository.repository !== request.selectors.RAIBITSERVER_RELEASE_FIXTURE_REPOSITORY || repository.installationId !== request.selectors.RAIBITSERVER_RELEASE_GITHUB_INSTALLATION_ID) { status = 'NOT_RUN'; reason = 'binding_journal_unavailable'; }
  else {
    const found = await discover(context, request, { projectId: project.projectId, serviceId: service.serviceId, repository });
    if (!found) { status = 'NOT_RUN'; reason = 'preview_webhook_observation_unavailable'; }
    else if (found.ambiguous) { status = 'NOT_RUN'; reason = 'preview_webhook_observation_ambiguous'; }
    else {
      deploymentId = found.candidate.id; lineageId = found.lineageId; webhookEventId = found.webhookEventId; event = found.event; observationId = found.row.id;
      pullRequestNumber = event.pullRequestNumber; observedStatus = found.candidate.status; namespace = found.candidate.namespace ?? found.candidate.previewRuntime?.namespace;
      let timestamp = Math.max(Date.parse(context.now()), ...entries.map(entry => Date.parse(entry.createdAt))) + 1;
      for (const [role, bindingId, payload] of [
        ['webhook', 'preview', found.binding],
        ['revision', 'preview', { kind: 'tenant-revision', tenantRevisionId: deploymentId, purpose: 'preview', observationId, repositoryId: repository.repositoryId, repository: repository.repository, branch: event.headRef, tenantCommitSha: event.headSha, pullRequestNumber }],
        ['deployment', 'preview', { kind: 'deployment', role: 'preview', deploymentId, serviceId: service.serviceId, tenantRevisionId: deploymentId, tenantCommitSha: event.headSha, repositoryId: repository.repositoryId, repository: repository.repository, branch: event.headRef }],
      ]) {
        try { const existing = one(entries, role, bindingId); if (existing) { if (digest(existing.payload) !== digest(payload)) throw new Error('preview binding changed'); } else await authority.appendBinding({ role, bindingId, payload, createdAt: new Date(timestamp++).toISOString() }); }
        catch { status = 'FAIL'; reason = 'preview_binding_persistence_failed'; break; }
      }
      if (status === 'PASS' && (observedStatus !== 'READY' || typeof namespace !== 'string')) { status = 'FAIL'; reason = 'preview_lineage_not_observed'; }
    }
    let intent = null;
    if (status === 'PASS') {
      const bound = await authority.loadBindings(), intentId = 'preview-cleanup', resourceName = deriveRunResourceName(request.identity, intentId);
      const createdAt = new Date(Math.max(Date.parse(context.now()), ...bound.map(entry => Date.parse(entry.createdAt))) + 1).toISOString();
      try { intent = await authority.appendCleanupIntent({ intentId, mutationKind: 'control-plane-preview-cleanup', bindingRefs: [membershipEntry, repositoryEntry, projectEntry, serviceEntry, one(bound, 'revision', 'preview'), one(bound, 'deployment', 'preview')].map(ref), resourceName, method: 'POST', routeTemplate: '/api/deployments/:deploymentId/preview-cleanup', relativeRoute: `/api/deployments/${deploymentId}/preview-cleanup`, recoverySelector: { kind: 'Deployment', projectId: project.projectId, serviceId: service.serviceId, deploymentId, name: resourceName, runIdentitySha256: digest(request.identity) }, approvedRuntimeSelector: null, createdAt, deadlineAt: request.deadlineAt }); }
      catch (error) { status = 'NOT_RUN'; reason = error instanceof Error && 'reason' in error ? error.reason : 'cleanup_intent_unavailable'; }
    }
    if (status === 'PASS') {
      const closed = await control(context, { method: 'POST', path: `/api/deployments/${encodeURIComponent(deploymentId)}/preview-cleanup`, body: { confirmed: true }, timeoutMs: 30_000 });
      if (closed.statusCode !== 202 || closed.body?.lineageId !== lineageId) { status = 'FAIL'; reason = 'preview_cleanup_failed'; }
      else { try { await authority.appendOutcome({ intentId: intent.intentId, actualId: deploymentId, actualUid: null, responseSha256: digest(closed.body), resolvedAt: new Date(Math.max(Date.parse(context.now()), Date.parse(intent.createdAt) + 1)).toISOString(), approvedRuntimeSelector: null }); } catch { status = 'FAIL'; reason = 'cleanup_outcome_unavailable'; } }
      if (status === 'PASS') { const cleaned = await poll(context, request, deploymentId); observedStatus = cleaned?.status ?? null; if (observedStatus !== 'CLEANED_UP') { status = 'FAIL'; reason = 'preview_cleanup_not_observed'; } }
    }
    if (status === 'PASS') {
      const inventories = []; for (const selector of [`raibitserver.io/run-id=${request.identity.runId}`, `raibitserver.io/preview-lineage-id=${lineageId}`]) inventories.push(await command(context, ['--context', request.selectors.RAIBITSERVER_RELEASE_KUBE_CONTEXT, '-n', namespace, 'get', 'all,ingress,secret,configmap,networkpolicy', '-l', selector, '-o', 'json']));
      const counts = inventories.map(result => { try { const items = JSON.parse(result.stdout)?.items; return Array.isArray(items) ? items.length : null; } catch (error) { if (error instanceof SyntaxError) return null; throw error; } }); remainingObjects = counts.every(Number.isSafeInteger) ? counts.reduce((sum, count) => sum + count, 0) : null;
      if (inventories.some(({ exitCode }) => exitCode === 127)) { status = 'NOT_RUN'; reason = 'missing_tool'; } else if (inventories.some(({ exitCode }) => exitCode !== 0) || remainingObjects !== 0) { status = 'FAIL'; reason = inventories.every(({ exitCode }) => exitCode === 0) ? 'preview_cleanup_leak' : 'preview_cleanup_observation_failed'; }
    }
  }
  const artifact = await context.writeArtifact('lifecycle', 'preview-observation.json', { schema: 'raibitserver.preview-observation/v1', identity: request.identity, observationId, webhookEventId, event, deliveryId: event?.deliveryId ?? null, deploymentId, lineageId, pullRequestNumber, observedStatus, remainingObjects, status, observedAt: context.now() });
  const cleanupInventory = deploymentId !== null && status !== 'PASS' ? [{ type: 'control-plane', resourceType: 'preview', id: deploymentId, organizationId: membership.organizationId, projectId: project.projectId }] : [];
  return parseStepResult({ status, reason, assertions: [{ id: 'preview_cleanup', status, artifactPaths: [artifact.path] }], artifacts: [artifact], cleanupInventory }, STEP, request, authority ? await authority.verifiedBindingSnapshot() : undefined);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runFixedStepMain(STEP, process.argv.slice(2)).then(({ exitCode }) => { process.exitCode = exitCode; });
