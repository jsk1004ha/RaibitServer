import { digest, EvidenceError } from './operator-inputs.mjs';

const fail = () => { throw new EvidenceError('binding_provenance_mismatch'); };
const SOURCE_STEPS = Object.freeze({ candidate: 'supply-chain', preview: 'preview', failure: 'rollback' });

export function verifyReceiptProvenance(progression, journal) {
  for (const observation of journal.observations) {
    const committed = progression.receipts.find(({ descriptor }) => descriptor.path === observation.receiptPath);
    const materialized = progression.observations.find(({ descriptor }) => descriptor.path === observation.artifactPath);
    if (!committed || !materialized || committed.descriptor.sha256 !== observation.receiptSha256
      || materialized.descriptor.sha256 !== observation.artifactSha256 || observation.identityDigest !== digest(committed.receipt.identity)
      || !committed.receipt.artifacts.some(({ path, sha256 }) => path === observation.artifactPath && sha256 === observation.artifactSha256)) fail();
    const value = materialized.value;
    switch (observation.kind) {
      case 'builder-deployment-observation':
        if (value.tenantRevision?.observationId !== observation.observationId
          || value.tenantRevision?.commitSha !== observation.tenantCommitSha
          || value.tenantRevision?.repositoryId !== observation.repositoryId) fail();
        break;
      case 'github-pull-request-observation':
        if (value.webhookEventId !== observation.webhookEventId || digest(value.event) !== digest(observation.event)
          || value.deploymentId !== observation.deploymentId || value.lineageId !== observation.lineageId) fail();
        break;
      case 'controlled-fixture-observation':
        if (value.failureRevision?.observationId !== observation.observationId
          || value.failureRevision?.deploymentId !== observation.deploymentId
          || value.failureRevision?.commitSha !== observation.tenantCommitSha || digest(value.controlledFault) !== digest(observation.controlledFault)) fail();
        break;
      default: fail();
    }
  }
}

export async function appendReceiptProvenance({ committed, journalAuthority, observations }) {
  const purpose = Object.keys(SOURCE_STEPS).find((purpose) => SOURCE_STEPS[purpose] === committed.step);
  if (!purpose || committed.receipt.status !== 'PASS') return;
  const entries = await journalAuthority.loadBindings();
  const revisions = entries.filter(({ payload }) => payload.kind === 'tenant-revision' && payload.purpose === purpose);
  if (revisions.length !== 1) fail();
  const revision = revisions[0].payload;
  const schemas = { candidate: 'raibitserver.supply-chain-observation/v1', preview: 'raibitserver.preview-observation/v1', failure: 'raibitserver.rollback-observation/v1' };
  const materialized = observations.find(({ value }) => value.schema === schemas[purpose]);
  if (!materialized) fail();
  const value = materialized.value;
  const base = { observationId: revision.observationId, identityDigest: digest(committed.receipt.identity),
    receiptPath: committed.descriptor.path, receiptSha256: committed.descriptor.sha256,
    artifactPath: materialized.descriptor.path, artifactSha256: materialized.descriptor.sha256,
    repositoryId: revision.repositoryId, repository: revision.repository, branch: revision.branch, tenantCommitSha: revision.tenantCommitSha };
  let payload;
  switch (purpose) {
    case 'candidate': payload = { ...base, kind: 'builder-deployment-observation' }; break;
    case 'preview': payload = { ...base, kind: 'github-pull-request-observation', webhookEventId: value.webhookEventId,
      deploymentId: value.deploymentId, lineageId: value.lineageId, event: value.event }; break;
    case 'failure': payload = { ...base, kind: 'controlled-fixture-observation', deploymentId: value.failureRevision?.deploymentId,
      controlledFault: value.controlledFault }; break;
    default: fail();
  }
  verifyReceiptProvenance({ receipts: [committed], observations }, { observations: [payload] });
  const createdAt = new Date(Math.max(Date.now(), Date.parse(entries.at(-1)?.createdAt ?? committed.receipt.observedAt) + 1)).toISOString();
  await journalAuthority.appendBinding({ role: 'observation', bindingId: purpose, payload, createdAt });
}
