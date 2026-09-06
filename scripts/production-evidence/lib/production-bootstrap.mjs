import { createRunnerContext } from './runner-context.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createAuthenticatedEvidenceClient, cleanupAuthenticatedEvidenceClient, executeAuthenticatedEvidenceRequest } from './authenticated-client.mjs';
import { digest, EvidenceError } from './operator-inputs.mjs';

const fail = (reason) => { throw new EvidenceError(reason); };
const DNS = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export async function createProductionBootstrap({ runDirectory, identity, fullOperatorInput, writer, journalAuthority }) {
  const startedAt = Date.now();
  const deadlineAt = new Date(startedAt + 4 * 60 * 60_000).toISOString();
  const selectors = fullOperatorInput.selectors;
  const runtimeSecret = fullOperatorInput.secretRefs.find(({ role }) => role === 'runtime');
  const approvedRuntimeSelector = { context: selectors.RAIBITSERVER_RELEASE_KUBE_CONTEXT, namespace: runtimeSecret?.namespace };
  let client = null, reason = null, lastAt = startedAt;
  const nextAt = () => new Date(lastAt = Math.max(Date.now(), lastAt + 1)).toISOString();
  const base = createRunnerContext(runDirectory, deadlineAt);
  const executeFile = async (file, args, options = {}) => {
    const scopedArgs = file === 'kubectl' && !args.includes('--context') ? ['--context', approvedRuntimeSelector.context, ...args] : args;
    let intent = null;
    if (file === 'kubectl' && args[0] === 'create' && args[1] === '-f' && args[2] === '-') {
      const manifest = JSON.parse(Buffer.isBuffer(options.stdin) ? options.stdin.toString('utf8') : options.stdin);
      const pod = manifest.kind === 'Pod';
      const name = `evidence-client-${identity.runId}${pod ? '' : '-egress'}`;
      if (!['Pod', 'NetworkPolicy'].includes(manifest.kind) || manifest.metadata?.name !== name
        || manifest.metadata?.namespace !== approvedRuntimeSelector.namespace || manifest.metadata?.labels?.['raibitserver.io/run-id'] !== identity.runId) fail('invalid_recovery_selector');
      const mutationKind = pod ? 'kubernetes-apply-pod' : 'kubernetes-apply-network-policy';
      const routeTemplate = pod ? '/api/v1/namespaces/:namespace/pods' : '/apis/networking.k8s.io/v1/namespaces/:namespace/networkpolicies';
      intent = await journalAuthority.appendCleanupIntent({ intentId: pod ? 'bootstrap-client-pod' : 'bootstrap-client-policy',
        mutationKind, bindingRefs: [], resourceName: name, method: 'APPLY', routeTemplate,
        relativeRoute: routeTemplate.replace(':namespace', approvedRuntimeSelector.namespace), approvedRuntimeSelector,
        recoverySelector: { kind: manifest.kind, namespace: approvedRuntimeSelector.namespace, name, runLabel: identity.runId,
          runIdentitySha256: digest(identity), runtimeSelectorSha256: digest(approvedRuntimeSelector) },
        createdAt: nextAt(), deadlineAt });
    }
    const result = await base.executeFile(file, scopedArgs, options);
    if (intent && result.exitCode === 0) {
      const [namespace, name, uid, resourceVersion, runId] = result.stdout.trim().split('\t');
      if (namespace !== approvedRuntimeSelector.namespace || name !== intent.resourceName || runId !== identity.runId || !uid || !resourceVersion) fail('authenticated_client_identity_mismatch');
      await journalAuthority.appendOutcome({ intentId: intent.intentId, actualId: name, actualUid: uid,
        responseSha256: digest(result.stdout), resolvedAt: nextAt(), approvedRuntimeSelector });
    }
    return result;
  };
  const controlPlaneJson = async ({ method, path, body, timeoutMs, client: ignoredClient }) => {
    void timeoutMs; void ignoredClient;
    if (!client) fail('authenticated_control_plane_unavailable');
    return executeAuthenticatedEvidenceRequest({ descriptor: client.descriptor, runId: identity.runId, runDirectory,
      method, path, ...(body === undefined ? {} : { body }), executeFile });
  };
  try {
    for (const [component, name] of [['local', 'baseline'], ['cluster', 'live-helm']]) {
      let foundation;
      try { foundation = JSON.parse(await readFile(path.join(runDirectory, 'artifacts', component, `${name}.json`), 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        foundation = JSON.parse(await readFile(path.join(runDirectory, 'artifacts', component, `${component}-unavailable.json`), 'utf8'));
      }
      if (foundation.status !== 'PASS') fail(foundation.reason ?? 'dependency_failed');
    }
    if (!runtimeSecret || !DNS.test(runtimeSecret.namespace)) fail('missing_evidence_operator_credentials');
    const releases = await executeFile('kubectl', ['get', 'deployments', '-n', runtimeSecret.namespace,
      '-l', 'app.kubernetes.io/name=raibitserver-api', '-o',
      'go-template={{range .items}}{{index .metadata.labels "app.kubernetes.io/instance"}}{{"\\n"}}{{end}}'], { timeoutMs: 10_000 });
    const names = [...new Set(releases.stdout.trim().split(/\r?\n/).filter(Boolean))];
    if (releases.exitCode !== 0 || names.length !== 1 || !DNS.test(names[0])) fail('ambiguous_api_target');
    client = await createAuthenticatedEvidenceClient({ runtimeRef: { namespace: runtimeSecret.namespace, releaseName: names[0] },
      secretRefs: fullOperatorInput.secretRefs.filter(({ role }) => role === 'runtime'), runId: identity.runId, runDirectory, executeFile });
    const me = await controlPlaneJson({ method: 'GET', path: '/api/auth/me' });
    const memberships = me.body?.memberships;
    const membership = Array.isArray(memberships) && memberships.length === 1 ? memberships[0] : null;
    if (me.statusCode !== 200 || !membership?.id || membership.userId !== client.auth.userId
      || membership.organizationId !== client.auth.organizationId) fail('invalid_evidence_operator_membership');
    await journalAuthority.appendBinding({ role: 'identity', bindingId: 'membership', createdAt: nextAt(),
      payload: { kind: 'organization-membership', membershipId: membership.id, organizationId: membership.organizationId, userId: membership.userId, role: membership.role } });
    const installationId = selectors.RAIBITSERVER_RELEASE_GITHUB_INSTALLATION_ID;
    const response = await controlPlaneJson({ method: 'GET', path: `/api/github/installations/${installationId}/repositories` });
    const repositories = response.body?.repositories?.filter((item) => item.fullName === selectors.RAIBITSERVER_RELEASE_FIXTURE_REPOSITORY && item.private === true) ?? [];
    if (response.statusCode !== 200 || repositories.length !== 1) fail('private_repository_access_unverified');
    const source = repositories[0];
    await journalAuthority.appendBinding({ role: 'source', bindingId: 'repository', createdAt: nextAt(),
      payload: { kind: 'github-repository', repositoryId: source.githubRepoId ?? source.id, repository: source.fullName,
        installationId, branch: source.defaultBranch } });
  } catch (error) { reason = error instanceof Error && typeof error.reason === 'string' ? error.reason : 'authentication_bootstrap_failed'; }
  return Object.freeze({
    reason,
    state: Object.freeze({ authenticatedClient: client?.descriptor ?? null, cleanupInventory: client?.cleanupInventory ?? [] }),
    contextFor(request) {
      const context = createRunnerContext(runDirectory, request.deadlineAt);
      return Object.freeze({ ...context, journalAuthority, controlPlaneJson,
        executeFile: (file, args, options) => {
          const scoped = file === 'kubectl' && !args.includes('--context') ? ['--context', approvedRuntimeSelector.context, ...args] : args;
          return context.executeFile(file, scoped, options);
        },
        waitForCleanup: async ({ delayMs, deadlineAt: cleanupDeadline }) => {
          if (!Number.isFinite(delayMs) || delayMs < 0 || Date.now() + delayMs > Date.parse(cleanupDeadline)) return false;
          await new Promise((resolve) => setTimeout(resolve, delayMs)); return true;
        },
        writeArtifact: (component, name, value) => writer.writeJson(component === 'cleanup' ? `cleanup/${name}` : `artifacts/${component}/${name}`, value),
      });
    },
    async dispose() {
      if (client) await cleanupAuthenticatedEvidenceClient({ descriptor: client.descriptor, runId: identity.runId, runDirectory, executeFile });
    },
  });
}
