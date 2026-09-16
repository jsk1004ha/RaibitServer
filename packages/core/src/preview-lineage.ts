import crypto from 'node:crypto';
import { identityDnsLabel } from './domain-router.ts';
import { previewProbeHost, type PreviewObservation, type PreviewRuntime, type PreviewWebhook } from './preview-contract.ts';
import { previewRuntimePlan } from './preview-deployments.ts';

export const PREVIEW_RESOLVER_JOB = 'github.preview-resolve';
export const PREVIEW_APPLY_JOB = 'github.preview-apply';
export const RESERVED_PREVIEW_JOBS = new Set([PREVIEW_RESOLVER_JOB, PREVIEW_APPLY_JOB]);

export type PreviewLineageRecord = Readonly<{
  id: string; organizationId: string; projectId: string; serviceId: string; integrationId: string;
  installationId: string; repositoryId: string; repository: string; pullRequestNumber: number;
  stableHost: string; namespace: string; routeName: string; state: 'OPEN' | 'CLOSED' | 'AMBIGUOUS';
  version: number; generation: number; eventUpdatedAt: string; eventAction: string; headSha: string;
  headRef: string; baseRef: string; beforeSha: string | null; candidateDeploymentId: string | null;
  candidateGeneration: number | null; currentDeploymentId: string | null; currentGeneration: number | null;
}>;
export type PreviewIdentity = Readonly<{ organizationId: string; projectId: string; serviceId: string; integrationId: string; baseDomain?: string }>;
export type PreviewTransition = Readonly<{ decision: 'stale' | 'duplicate' | 'ambiguous' | 'open' | 'close'; lineage: PreviewLineageRecord; enqueueResolver: boolean }>;

export class PreviewLifecycleError extends Error {
  readonly name = 'PreviewLifecycleError';
  readonly statusCode = 409;
  readonly code: 'PREVIEW_BINDING_INVALID' | 'PREVIEW_CLOSED' | 'PREVIEW_AMBIGUOUS' | 'PREVIEW_STALE' | 'PREVIEW_FOREIGN' | 'PREVIEW_LEGACY';
  constructor(code: PreviewLifecycleError['code']) { super(code); this.code = code; }
}

function semanticKey(event: PreviewWebhook): string {
  return [event.action, event.headSha, event.beforeSha ?? '', event.headRef, event.baseRef].join('\0');
}

export function transitionPreviewLineage(current: PreviewLineageRecord | null, event: PreviewWebhook, identity: PreviewIdentity, id: string): PreviewTransition {
  const eventTime = Date.parse(event.updatedAt);
  if (current && eventTime < Date.parse(current.eventUpdatedAt)) return { decision: 'stale', lineage: current, enqueueResolver: false };
  if (current && eventTime === Date.parse(current.eventUpdatedAt)) {
    const previous = [current.eventAction, current.headSha, current.beforeSha ?? '', current.headRef, current.baseRef].join('\0');
    if (previous === semanticKey(event)) return { decision: 'duplicate', lineage: current, enqueueResolver: false };
    if (current.state === 'AMBIGUOUS') return { decision: 'duplicate', lineage: current, enqueueResolver: false };
    return { decision: 'ambiguous', enqueueResolver: true, lineage: { ...current, state: 'AMBIGUOUS', version: current.version + 1, candidateDeploymentId: null, candidateGeneration: null } };
  }
  const plan = previewRuntimePlan({ service: { id: identity.serviceId }, project: { id: identity.projectId, organizationId: identity.organizationId }, organization: { id: identity.organizationId }, pullRequestNumber: event.pullRequestNumber, baseDomain: identity.baseDomain });
  const nextVersion = (current?.version ?? 0) + 1;
  const nextGeneration = event.action === 'closed' ? current?.generation ?? 0 : (current?.generation ?? 0) + 1;
  const base: PreviewLineageRecord = {
    id, organizationId: identity.organizationId, projectId: identity.projectId, serviceId: identity.serviceId, integrationId: identity.integrationId,
    installationId: event.installationId, repositoryId: event.repositoryId, repository: event.repository,
    pullRequestNumber: event.pullRequestNumber, stableHost: current?.stableHost ?? plan.host, namespace: current?.namespace ?? plan.kubernetes.namespace,
    routeName: current?.routeName ?? identityDnsLabel('preview-route', id), state: event.action === 'closed' ? 'CLOSED' : 'OPEN',
    version: nextVersion, generation: nextGeneration, eventUpdatedAt: event.updatedAt, eventAction: event.action,
    headSha: event.headSha, headRef: event.headRef, baseRef: event.baseRef, beforeSha: event.beforeSha,
    candidateDeploymentId: null, candidateGeneration: null,
    currentDeploymentId: event.action === 'closed' ? null : current?.currentDeploymentId ?? null,
    currentGeneration: event.action === 'closed' ? null : current?.currentGeneration ?? null,
  };
  return { decision: event.action === 'closed' ? 'close' : 'open', lineage: base, enqueueResolver: false };
}

export function applyPreviewObservation(current: PreviewLineageRecord, observation: PreviewObservation): PreviewTransition {
  if (observation.lineageId !== current.id || observation.lineageVersion !== current.version || observation.installationId !== current.installationId || observation.repositoryId !== current.repositoryId || observation.pullRequestNumber !== current.pullRequestNumber) throw new PreviewLifecycleError('PREVIEW_FOREIGN');
  if (Date.parse(observation.updatedAt) < Date.parse(current.eventUpdatedAt)) return { decision: 'stale', lineage: current, enqueueResolver: false };
  const closes = observation.state === 'closed';
  return { decision: closes ? 'close' : 'open', enqueueResolver: false, lineage: { ...current,
    state: closes ? 'CLOSED' : 'OPEN', version: current.version + 1, generation: closes ? current.generation : current.generation + 1,
    eventUpdatedAt: observation.updatedAt, eventAction: 'resolved', headSha: observation.headSha, headRef: observation.headRef, baseRef: observation.baseRef, beforeSha: current.headSha,
    candidateDeploymentId: null, candidateGeneration: null, currentDeploymentId: closes ? null : current.currentDeploymentId, currentGeneration: closes ? null : current.currentGeneration } };
}

export function createPreviewRuntime(lineage: PreviewLineageRecord, deploymentId: string, baseDomain?: string): PreviewRuntime {
  const plan = previewRuntimePlan({ service: { id: lineage.serviceId }, project: { id: lineage.projectId, organizationId: lineage.organizationId }, organization: { id: lineage.organizationId }, pullRequestNumber: lineage.pullRequestNumber, deploymentId, baseDomain });
  return { version: 1, lineageId: lineage.id, deploymentId, generation: lineage.generation, lineageVersion: lineage.version,
    stableHost: lineage.stableHost, probeHost: previewProbeHost(lineage.id, deploymentId, baseDomain ?? lineage.stableHost.split('.').slice(1).join('.')),
    namespace: lineage.namespace, workloadName: plan.kubernetes.workloadName, serviceName: plan.kubernetes.serviceName,
    probeIngressName: plan.kubernetes.ingressName, routeName: lineage.routeName };
}

export function assertPreviewRetry(lineage: PreviewLineageRecord | null, source: Readonly<Record<string, unknown>>): PreviewLineageRecord {
  if (!lineage || !source.previewLineageId || !source.previewRuntime) throw new PreviewLifecycleError('PREVIEW_LEGACY');
  if (source.previewLineageId !== lineage.id || source.serviceId !== lineage.serviceId || source.projectId !== lineage.projectId) throw new PreviewLifecycleError('PREVIEW_FOREIGN');
  if (lineage.state === 'CLOSED') throw new PreviewLifecycleError('PREVIEW_CLOSED');
  if (lineage.state === 'AMBIGUOUS') throw new PreviewLifecycleError('PREVIEW_AMBIGUOUS');
  if (source.commitSha !== lineage.headSha) throw new PreviewLifecycleError('PREVIEW_STALE');
  return lineage;
}

export function resolverPayload(lineage: PreviewLineageRecord) { return { version: 1, lineageId: lineage.id, lineageVersion: lineage.version }; }
export function resolverJobId(lineage: PreviewLineageRecord) { return `preview-resolve:${lineage.id}:${lineage.version}`; }
export function applyJobId(observation: PreviewObservation) { return `preview-apply:${observation.lineageId}:${observation.lineageVersion}`; }
export function previewCloseIntent(lineage: PreviewLineageRecord) { return { version: 1, lineageVersion: lineage.version, operation: 'clear', deploymentId: null, generation: null, token: crypto.randomUUID(), namespace: lineage.namespace, name: lineage.routeName, uid: null, resourceVersion: null }; }
