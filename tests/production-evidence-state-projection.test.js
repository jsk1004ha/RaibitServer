import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveProductionEvidenceStepState as derive } from '../scripts/production-evidence/lib/state-projection.mjs';
import { createJournalAuthorityFixtureUnsafe } from '../scripts/production-evidence/lib/journal-authority.mjs';
import { digest } from '../scripts/production-evidence/lib/operator-inputs.mjs';
import { STEP_NAMES } from '../scripts/production-evidence/lib/step-contract.mjs';
import { INPUTS, sandbox } from './fixtures/receipt-authority-fixture.mjs';

test('Given physical run bindings, When pure state is projected, Then only fixed same-run source state is copied', async (t) => {
  const fixture = await sandbox(t);
  const authority = await createJournalAuthorityFixtureUnsafe({ runDirectory: fixture.runDirectory, identity: fixture.runIdentity, genuineSafeWriter: fixture.writer });
  const payloads = [
    { role: 'identity', bindingId: 'membership', payload: { kind: 'organization-membership', membershipId: 'member', organizationId: 'organization', userId: 'user', role: 'owner' } },
    { role: 'source', bindingId: 'repository', payload: { kind: 'github-repository', repositoryId: 'repository', repository: INPUTS.selectors.RAIBITSERVER_RELEASE_FIXTURE_REPOSITORY,
      installationId: INPUTS.selectors.RAIBITSERVER_RELEASE_GITHUB_INSTALLATION_ID, branch: 'main' } },
  ];
  for (const [index, entry] of payloads.entries()) await authority.appendBinding({ ...entry, createdAt: new Date(Date.parse(fixture.startedAt) + index).toISOString() });
  const input = { step: 'auth-source', identity: fixture.runIdentity, fullOperatorInput: INPUTS, bootstrap: null,
    bindingSnapshot: await authority.bindingSnapshot(), bindingEntries: await authority.loadBindings(), committedSteps: [] };
  const state = derive(input);
  assert.equal(state.organizationId, 'organization');
  assert.equal(Object.hasOwn(state, 'candidateCommitSha'), false);
  assert.equal(Object.isFrozen(state), true);
  assert.throws(() => derive({ ...input, observations: [] }), { reason: 'invalid_arguments' });
  assert.throws(() => derive({ ...input, bindingSnapshot: { ...input.bindingSnapshot, runIdentitySha256: 'f'.repeat(64) } }), { reason: 'invalid_journal' });
});

test('Given a prior failed committed step, When subsequent state and cleanup project, Then cleanup inventory remains available without new source state', () => {
  const runIdentity = { runId: '123e4567-e89b-42d3-a456-426614174000' };
  const inventory = { type: 'control-plane', resourceType: 'project', id: 'project', organizationId: 'organization', projectId: 'project' };
  const committed = STEP_NAMES.slice(0, -1).map((step, index) => ({ step, sequence: index + 1, requestSha256: 'a'.repeat(64), observations: [],
    receipt: { step, identity: runIdentity, requestSha256: 'a'.repeat(64), status: index === 0 ? 'FAIL' : 'NOT_RUN', cleanupInventory: index === 0 ? [inventory] : [] } }));
  const common = { identity: runIdentity, fullOperatorInput: INPUTS, bootstrap: null, bindingEntries: [],
    bindingSnapshot: { runIdentitySha256: digest(runIdentity), entryCount: 0, entriesSha256: digest([]) } };
  const later = derive({ ...common, step: 'supply-chain', committedSteps: committed.slice(0, 1) });
  const cleanup = derive({ ...common, step: 'cleanup', committedSteps: committed });
  assert.equal(Object.hasOwn(later, 'serviceId'), false);
  assert.deepEqual(cleanup.cleanupInventory, [inventory]);
  assert.equal(Object.isFrozen(cleanup.cleanupInventory[0]), true);
});
