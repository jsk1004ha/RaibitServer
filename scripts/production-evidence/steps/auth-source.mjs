import { pathToFileURL } from 'node:url';
import { assertJournalAuthority } from '../lib/journal-authority.mjs';
import { deriveRunResourceName } from '../lib/cleanup-intent-journal.mjs';
import { digest } from '../lib/operator-inputs.mjs';
import { parseStepRequest, parseStepResult } from '../lib/step-contract.mjs';
import { runFixedStepMain } from '../run-component.mjs';

const STEP = 'auth-source';
async function control(context, request) { try { return await context.controlPlaneJson(request); } catch { return { statusCode: 0, body: null }; } }
function one(entries, role, bindingId) { const found = entries.filter((entry) => entry.role === role && entry.bindingId === bindingId); return found.length === 1 ? found[0] : null; }
const ref = (entry) => ({ role: entry.role, bindingId: entry.bindingId, entrySha256: entry.entrySha256 });
function after(context, previous) { return new Date(Math.max(Date.parse(context.now()), Date.parse(previous) + 1)).toISOString(); }

export async function execute(input, context) {
  const request = parseStepRequest(input, STEP);
  let authority = null; let membershipEntry = null; let repositoryEntry = null;
  try {
    authority = assertJournalAuthority(context.journalAuthority);
    const snapshot = await authority.bindingSnapshot();
    if (snapshot.runIdentitySha256 !== digest(request.identity)) throw new Error('foreign journal');
    const entries = await authority.loadBindings(); if (snapshot.entryCount !== entries.length || snapshot.entriesSha256 !== digest(entries)) throw new Error('journal snapshot mismatch'); membershipEntry = one(entries, 'identity', 'membership'); repositoryEntry = one(entries, 'source', 'repository');
  } catch { authority = null; membershipEntry = null; repositoryEntry = null; }
  const membership = membershipEntry?.payload ?? null; const repositoryBinding = repositoryEntry?.payload ?? null;
  const repository = repositoryBinding?.repository ?? null;
  const installationId = repositoryBinding?.installationId ?? null;
  let status = 'PASS'; let reason = null; let projectId = null; let serviceId = null; let repositoryId = null; let integrationId = null; let defaultBranch = null;
  if (!request.secretRefs.some(({ role }) => role === 'github')) { status = 'NOT_RUN'; reason = 'missing_credentials'; }
  else if (typeof context.controlPlaneJson !== 'function') { status = 'NOT_RUN'; reason = 'authenticated_control_plane_unavailable'; }
  else if (!authority || !membership || !repositoryBinding || repository !== request.selectors.RAIBITSERVER_RELEASE_FIXTURE_REPOSITORY
    || installationId !== request.selectors.RAIBITSERVER_RELEASE_GITHUB_INSTALLATION_ID) { status = 'NOT_RUN'; reason = 'binding_journal_unavailable'; }
  else {
    const me = await control(context, { method: 'GET', path: '/api/auth/me', timeoutMs: 5_000 });
    const memberships = Array.isArray(me.body?.memberships) ? me.body.memberships : [];
    if (me.statusCode !== 200 || !memberships.some((item) => item.organizationId === membership.organizationId)) { status = 'FAIL'; reason = 'organization_membership_unverified'; }
    if (status === 'PASS') {
      const response = await control(context, { method: 'GET', path: `/api/github/installations?organizationId=${encodeURIComponent(membership.organizationId)}`, timeoutMs: 5_000 });
      const installation = response.body?.installations?.find((item) => String(item.installationId) === installationId && item.organizationId === membership.organizationId) ?? null;
      integrationId = installation?.integrationId ?? null;
      if (response.statusCode !== 200 || typeof integrationId !== 'string') { status = 'FAIL'; reason = 'verified_github_installation_unavailable'; }
    }
    if (status === 'PASS') {
      const response = await control(context, { method: 'GET', path: `/api/github/installations/${encodeURIComponent(installationId)}/repositories`, timeoutMs: 5_000 });
      const source = response.body?.repositories?.find((item) => item.fullName === repository) ?? null;
      repositoryId = source?.githubRepoId ?? source?.id ?? null; defaultBranch = source?.defaultBranch ?? null;
      if (response.statusCode !== 200 || source?.private !== true || repositoryId !== repositoryBinding.repositoryId || defaultBranch !== repositoryBinding.branch) { status = 'FAIL'; reason = 'private_repository_access_unverified'; }
    }
    let projectIntent = null;
    if (status === 'PASS') {
      const intentId = 'auth-project'; const resourceName = deriveRunResourceName(request.identity, intentId); const createdAt = context.now();
      try { projectIntent = await authority.appendCleanupIntent({ intentId, mutationKind: 'control-plane-create-project', bindingRefs: [ref(membershipEntry)], resourceName, method: 'POST', routeTemplate: '/api/projects', relativeRoute: '/api/projects', recoverySelector: { kind: 'Project', organizationId: membership.organizationId, slug: resourceName, runIdentitySha256: digest(request.identity) }, approvedRuntimeSelector: null, createdAt, deadlineAt: request.deadlineAt }); }
      catch { status = 'NOT_RUN'; reason = 'binding_journal_unavailable'; }
      const created = status === 'PASS' ? await control(context, { method: 'POST', path: '/api/projects', body: { organizationId: membership.organizationId, project: { name: resourceName, slug: resourceName, description: 'Production evidence run' }, services: [], resources: [] }, timeoutMs: 30_000 }) : null;
      projectId = created?.body?.id ?? null;
      if (status === 'PASS' && (created.statusCode < 200 || created.statusCode >= 300 || typeof projectId !== 'string' || projectId.length === 0)) { status = 'FAIL'; reason = 'run_project_creation_failed'; }
      if (status === 'PASS') {
        const resolvedAt = after(context, projectIntent.createdAt);
        try { await authority.appendOutcome({ intentId, actualId: projectId, actualUid: null, responseSha256: digest(created.body), resolvedAt, approvedRuntimeSelector: null }); await authority.appendBinding({ role: 'project', bindingId: 'primary', payload: { kind: 'project', projectId, organizationId: membership.organizationId }, createdAt: resolvedAt }); }
        catch { status = 'FAIL'; reason = 'project_binding_persistence_failed'; }
      }
    }
    if (status === 'PASS') {
      const entries = await authority.loadBindings(); const projectEntry = one(entries, 'project', 'primary'); const intentId = 'auth-import'; const resourceName = deriveRunResourceName(request.identity, intentId); const createdAt = after(context, projectEntry.createdAt);
      let importIntent = null;
      try { importIntent = await authority.appendCleanupIntent({ intentId, mutationKind: 'control-plane-import-repository', bindingRefs: [ref(membershipEntry), ref(repositoryEntry), ref(projectEntry)], resourceName, method: 'POST', routeTemplate: '/api/github/repositories/import', relativeRoute: '/api/github/repositories/import', recoverySelector: { kind: 'RepositoryImport', projectId, repositoryId, name: resourceName, runIdentitySha256: digest(request.identity) }, approvedRuntimeSelector: null, createdAt, deadlineAt: request.deadlineAt }); }
      catch { status = 'FAIL'; reason = 'repository_import_intent_failed'; }
      const imported = status === 'PASS' ? await control(context, { method: 'POST', path: '/api/github/repositories/import', body: { projectId, integrationId, repositoryId, branch: defaultBranch }, timeoutMs: 30_000 }) : null;
      serviceId = imported?.body?.service?.id ?? null; const service = imported?.body?.service;
      if (status === 'PASS' && (imported.statusCode < 200 || imported.statusCode >= 300 || typeof serviceId !== 'string' || serviceId.length === 0 || service?.githubRepository !== repository || service?.githubRepositoryVisibility !== 'private' || service?.sourceAccess !== 'github-app-private')) { status = 'FAIL'; reason = 'private_repository_import_unverified'; }
      if (status === 'PASS') {
        const resolvedAt = after(context, importIntent.createdAt);
        try { await authority.appendOutcome({ intentId, actualId: serviceId, actualUid: null, responseSha256: digest(imported.body), resolvedAt, approvedRuntimeSelector: null }); await authority.appendBinding({ role: 'service', bindingId: 'primary', payload: { kind: 'service', serviceId, projectId }, createdAt: resolvedAt }); }
        catch { status = 'FAIL'; reason = 'service_binding_persistence_failed'; }
      }
    }
  }
  const sourceBinding = status === 'PASS' ? { schema: 'raibitserver.production-evidence-source-binding/v1', projectId, serviceId, repository, repositoryId, integrationId, installationId, defaultBranch, visibility: 'private', sourceAccess: 'github-app-private' } : null;
  const artifact = await context.writeArtifact('lifecycle', 'auth-source-observation.json', { schema: 'raibitserver.github-source-observation/v1', identity: request.identity, sourceBinding, status, observedAt: context.now() });
  const cleanupInventory = projectId !== null ? [{ type: 'control-plane', resourceType: 'project', id: projectId, organizationId: membership.organizationId, projectId }] : [];
  return parseStepResult({ status, reason, assertions: [{ id: 'github_source', status, artifactPaths: [artifact.path] }], artifacts: [artifact], cleanupInventory }, STEP, request, authority ? await authority.verifiedBindingSnapshot() : undefined);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runFixedStepMain(STEP, process.argv.slice(2)).then(({ exitCode }) => { process.exitCode = exitCode; });
