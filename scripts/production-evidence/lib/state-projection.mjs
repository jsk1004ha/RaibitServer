import { digest, EvidenceError } from './operator-inputs.mjs';
import { parseEvidenceBindingEntry } from './binding-journal.mjs';
import { STEP_NAMES } from './step-contract.mjs';

export const PRODUCTION_EVIDENCE_STEP_ORDER = STEP_NAMES;
export class StateProjectionError extends EvidenceError {
  constructor(reason, status = 'FAIL') { super(reason); this.status = status; }
}
const fail = (reason, status) => { throw new StateProjectionError(reason, status); };
const freeze = (value) => {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freeze(item)])));
  return value;
};
const ENGINES = ['postgresql', 'mysql', 'mariadb', 'mongodb', 'redis', 'valkey'];
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

export function deriveProductionEvidenceStepState(input) {
  if (!exact(input, ['step', 'identity', 'fullOperatorInput', 'bootstrap', 'bindingSnapshot', 'bindingEntries', 'committedSteps'])) fail('invalid_arguments');
  const { step, identity, fullOperatorInput, bootstrap, bindingSnapshot, bindingEntries, committedSteps } = input;
  const index = STEP_NAMES.indexOf(step);
  if (index < 0 || !Array.isArray(bindingEntries) || !Array.isArray(committedSteps)) fail('invalid_arguments');
  if (bindingSnapshot.runIdentitySha256 !== digest(identity) || bindingSnapshot.entryCount !== bindingEntries.length
    || bindingSnapshot.entriesSha256 !== digest(bindingEntries)) fail('invalid_journal');
  if (committedSteps.length !== index) fail('invalid_receipt_order');
  const graph = new Map();
  for (const [offset, raw] of bindingEntries.entries()) {
    const entry = parseEvidenceBindingEntry(raw, digest(identity));
    if (entry.sequence !== offset + 1) fail('invalid_journal');
    const key = `${entry.role}:${entry.bindingId}`;
    if (graph.has(key)) fail('binding_conflict');
    graph.set(key, entry.payload);
  }
  for (const [offset, committed] of committedSteps.entries()) {
    if (committed.step !== STEP_NAMES[offset] || committed.sequence !== offset + 1
      || committed.receipt.step !== committed.step || digest(committed.receipt.identity) !== digest(identity)
      || committed.requestSha256 !== committed.receipt.requestSha256 || !Array.isArray(committed.observations)) fail('invalid_receipt_progression');
  }
  const selectors = fullOperatorInput.selectors;
  const common = {
    cleanupNamespace: `${selectors.RAIBITSERVER_RELEASE_NAMESPACE_PREFIX}-${identity.runId.replaceAll('-', '').slice(0, 8)}`,
    cleanupInventory: [...new Map([...(bootstrap?.cleanupInventory ?? []), ...committedSteps.flatMap(({ receipt }) => receipt.cleanupInventory)]
      .map((item) => [digest(item), item])).values()],
    ...(bootstrap?.authenticatedClient ? { authenticatedClient: bootstrap.authenticatedClient } : {}),
  };
  if (step !== 'cleanup' && committedSteps.some(({ receipt }) => receipt.status !== 'PASS')) return freeze(common);
  const one = (key) => { const value = graph.get(key); if (!value) fail('missing_binding', 'NOT_RUN'); return value; };
  const observation = (name, schema) => {
    const record = committedSteps.find(({ step }) => step === name);
    const values = record?.observations.filter(({ value }) => value.schema === schema).map(({ value }) => value) ?? [];
    if (!values.length) fail('missing_receipt', 'NOT_RUN');
    if (values.some((value) => digest(value) !== digest(values[0]))) fail('receipt_conflict');
    return values[0];
  };
  const bindings = bindingEntries.map(({ payload }) => payload);
  const suffix = identity.runId.replaceAll('-', '').slice(0, 12);
  let state;
  switch (step) {
    case 'auth-source': {
      const membership = one('identity:membership'), repository = one('source:repository');
      if (repository.repository !== selectors.RAIBITSERVER_RELEASE_FIXTURE_REPOSITORY
        || repository.installationId !== selectors.RAIBITSERVER_RELEASE_GITHUB_INSTALLATION_ID) fail('binding_graph_mismatch');
      state = { organizationId: membership.organizationId, repository: repository.repository, installationId: repository.installationId,
        projectName: `evidence-${suffix}`, serviceName: `web-${suffix}`, idempotencyKey: `evidence-auth-${suffix}` }; break;
    }
    case 'supply-chain': state = { projectId: one('project:primary').projectId, serviceId: one('service:primary').serviceId,
      defaultBranch: one('source:repository').branch, idempotencyKey: `evidence-build-${suffix}` }; break;
    case 'runtime': {
      const deploymentId = one('deployment:candidate').deploymentId;
      state = { deploymentId, nonce: digest({ runId: identity.runId, deploymentId, purpose: 'runtime' }) }; break;
    }
    case 'observability': {
      const runtime = observation('runtime', 'raibitserver.runtime-observation/v1');
      state = { deploymentId: one('deployment:candidate').deploymentId, namespace: runtime.namespace,
        deploymentName: runtime.deploymentName, ...runtime.operation }; break;
    }
    case 'resources': state = { projectId: one('project:primary').projectId, serviceId: one('service:primary').serviceId,
      deploymentId: one('deployment:candidate').deploymentId, engines: ENGINES }; break;
    case 'backup-sql': case 'backup-nosql': {
      const engines = step === 'backup-sql' ? ENGINES.slice(0, 3) : ENGINES.slice(3);
      state = { bindings, bindingsDigest: digest(bindings), bindingJournalSnapshot: bindingSnapshot,
        resources: Object.fromEntries(engines.map((engine) => [engine, one(`resource:source-${engine}`).resourceId])), engines }; break;
    }
    case 'preview': state = { projectId: one('project:primary').projectId, serviceId: one('service:primary').serviceId,
      repository: one('source:repository').repository }; break;
    case 'rollback': {
      const runtime = observation('runtime', 'raibitserver.runtime-observation/v1');
      state = { readyDeploymentId: one('deployment:candidate').deploymentId, previousReadyDigest: runtime.observedDigest,
        namespace: runtime.namespace, deploymentName: runtime.deploymentName }; break;
    }
    case 'cleanup': state = {}; break;
    default: fail('unknown_step');
  }
  return freeze({ ...common, ...state });
}
