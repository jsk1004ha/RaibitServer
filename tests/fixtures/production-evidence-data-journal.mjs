import { createUnsafeFixtureArtifactWriter } from '../../scripts/production-evidence/lib/safe-artifact-writer.mjs';
import { createJournalAuthorityFixtureUnsafe } from '../../scripts/production-evidence/lib/journal-authority.mjs';
import { digest } from '../../scripts/production-evidence/lib/operator-inputs.mjs';

export async function createDataJournalFixture(request, testContext, engineList, { tamperedJournal = false } = {}) {
  let corruptMutation = false;
  const writer = await createUnsafeFixtureArtifactWriter({ runDirectory: request.runDirectory,
    allowedPaths: (relative) => /^(?:bindings|cleanup-intents)\/[a-z0-9.-]+$/.test(relative),
    testHooks: { write: async (handle, bytes) => {
      const value = JSON.parse(bytes.toString('utf8'));
      await handle.writeFile(corruptMutation && value.entryType === 'intent' ? Buffer.from(`${JSON.stringify({ ...value, relativeRoute: '/api/foreign' })}\n`) : bytes);
    } } });
  testContext.after(() => writer.close());
  const authority = await createJournalAuthorityFixtureUnsafe({ runDirectory: request.runDirectory, identity: request.identity, genuineSafeWriter: writer });
  const values = [{ kind: 'organization-membership', organizationId: 'org-a', membershipId: 'member-a', userId: 'user-a', role: 'OWNER' },
    { kind: 'github-repository', installationId: 'install-a', repositoryId: 'repo-a', repository: 'org/repo', branch: 'main' },
    { kind: 'tenant-revision', tenantRevisionId: 'revision-a', purpose: 'candidate', observationId: 'observation-a', repositoryId: 'repo-a', repository: 'org/repo', branch: 'main', tenantCommitSha: 'a'.repeat(40) },
    { kind: 'project', projectId: 'project-a', organizationId: 'org-a' }, { kind: 'service', serviceId: 'service-a', projectId: 'project-a' },
    { kind: 'deployment', role: 'candidate', deploymentId: 'deployment-a', serviceId: 'service-a', tenantRevisionId: 'revision-a', tenantCommitSha: 'a'.repeat(40), repositoryId: 'repo-a', repository: 'org/repo', branch: 'main' },
    ...engineList.map((engine) => ({ kind: 'resource', role: 'source', engine, resourceId: 'source', projectId: 'project-a' }))];
  for (const [index, payload] of values.entries()) await authority.appendBinding({ role: payload.kind, bindingId: `${payload.kind}-${index}`, payload,
    createdAt: new Date(Date.parse('2026-09-04T00:00:00.000Z') + index * 1000).toISOString() });
  const state = { bindings: values, bindingsDigest: digest(values), bindingJournalSnapshot: await authority.bindingSnapshot() };
  corruptMutation = tamperedJournal;
  return { state, authority };
}
