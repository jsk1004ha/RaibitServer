import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export class PreviewError extends Error {
  readonly name = 'PreviewError';
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, statusCode = 400) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type PreviewAction = 'opened' | 'synchronize' | 'reopened' | 'closed';
export type PreviewWebhookInput = Readonly<{ body: string | Buffer; signature: string; secret: string; deliveryId: string }>;
export type PreviewWebhook = Readonly<{
  deliveryId: string; installationId: string; repositoryId: string; repository: string;
  pullRequestNumber: number; action: PreviewAction; headSha: string; headRef: string;
  baseRef: string; beforeSha: string | null; updatedAt: string;
}>;
export type PreviewRuntime = Readonly<{
  version: 1; lineageId: string; deploymentId: string; generation: number; lineageVersion: number;
  stableHost: string; probeHost: string; namespace: string; workloadName: string;
  serviceName: string; probeIngressName: string; routeName: string;
}>;
export type PreviewObservation = Readonly<{
  version: 1; lineageId: string; lineageVersion: number; installationId: string; repositoryId: string;
  pullRequestNumber: number; state: 'open' | 'closed'; headSha: string; headRef: string;
  baseRef: string; updatedAt: string; observedAt: string;
}>;
export type PreviewOwnedObject = Readonly<{
  group: string; version: 'v1'; kind: 'Deployment' | 'Service' | 'Ingress'; namespace: string;
  name: string; uid: string; resourceVersion?: string;
}>;

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const dnsLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const shaPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const runtimeKeys = ['version', 'lineageId', 'deploymentId', 'generation', 'lineageVersion', 'stableHost', 'probeHost', 'namespace', 'workloadName', 'serviceName', 'probeIngressName', 'routeName'] as const;
const observationKeys = ['version', 'lineageId', 'lineageVersion', 'installationId', 'repositoryId', 'pullRequestNumber', 'state', 'headSha', 'headRef', 'baseRef', 'updatedAt', 'observedAt'] as const;

function invalid(): never { throw new PreviewError('preview_invalid_input'); }
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid();
  return Object.fromEntries(Object.entries(value));
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const parsed = object(value);
  if (Object.keys(parsed).some((key) => !keys.includes(key))) return invalid();
  return parsed;
}
function text(value: unknown, pattern: RegExp, limit = 128): string {
  if (typeof value !== 'string' || value.length > limit || !pattern.test(value)) return invalid();
  return value;
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return invalid();
  return value;
}
function numericId(value: unknown): string {
  const parsed = text(value, /^[1-9][0-9]{0,15}$/);
  positive(Number(parsed));
  return parsed;
}
function timestamp(value: unknown): string {
  const parsed = text(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/, 24);
  const millis = Date.parse(parsed);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== (parsed.length === 20 ? parsed.replace('Z', '.000Z') : parsed)) return invalid();
  return parsed;
}
function ref(value: unknown): string {
  const parsed = text(value, /^[^\s\x00-\x1f\x7f~^:?*\[\\]+$/, 255);
  if (parsed === '@' || parsed.includes('..') || parsed.includes('@{') || parsed.endsWith('.') || parsed.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))) return invalid();
  return parsed;
}
function host(value: unknown): string {
  const parsed = text(value, /^[a-z0-9.-]+$/, 253);
  if (!parsed.includes('.') || parsed.split('.').some((part) => !dnsLabelPattern.test(part))) return invalid();
  return parsed;
}

export function parsePreviewWebhook(input: PreviewWebhookInput): PreviewWebhook {
  if ((typeof input.body !== 'string' && !Buffer.isBuffer(input.body)) || typeof input.secret !== 'string' || !input.secret) throw new PreviewError('preview_invalid_signature', 401);
  if (Buffer.byteLength(input.body) > 1_048_576) throw new PreviewError('preview_payload_too_large', 413);
  if (typeof input.signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(input.signature)) throw new PreviewError('preview_invalid_signature', 401);
  const expected = createHmac('sha256', input.secret).update(input.body).digest();
  if (!timingSafeEqual(expected, Buffer.from(input.signature.slice(7), 'hex'))) throw new PreviewError('preview_invalid_signature', 401);
  const deliveryId = text(input.deliveryId, uuidPattern).toLowerCase();
  let decoded: unknown;
  try { decoded = JSON.parse(typeof input.body === 'string' ? input.body : new TextDecoder('utf-8', { fatal: true }).decode(input.body)); }
  catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) return invalid();
    throw error;
  }
  const payload = object(decoded);
  const pr = object(payload.pull_request);
  const head = object(pr.head);
  const base = object(pr.base);
  const repository = object(payload.repository);
  const action = payload.action;
  if (action !== 'opened' && action !== 'synchronize' && action !== 'reopened' && action !== 'closed') return invalid();
  if (pr.state !== (action === 'closed' ? 'closed' : 'open')) return invalid();
  const pullRequestNumber = positive(pr.number);
  if (positive(payload.number) !== pullRequestNumber) return invalid();
  const beforeSha = payload.before === undefined || payload.before === null ? null : text(payload.before, shaPattern);
  if (action === 'synchronize' && beforeSha === null) return invalid();
  return {
    deliveryId, installationId: String(positive(object(payload.installation).id)), repositoryId: String(positive(repository.id)),
    repository: text(repository.full_name, /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/, 140),
    pullRequestNumber, action, headSha: text(head.sha, shaPattern), headRef: ref(head.ref), baseRef: ref(base.ref),
    beforeSha, updatedAt: timestamp(pr.updated_at),
  };
}

export function previewProbeHost(lineageId: string, deploymentId: string, baseDomain: string): string {
  const digest = createHash('sha256').update(`raibitserver.preview-probe/v1\0${text(lineageId, idPattern)}\0${text(deploymentId, idPattern)}`).digest('hex').slice(0, 32);
  return host(`preview--probe-${digest}.${host(baseDomain)}`);
}

export function parsePreviewRuntime(input: unknown): PreviewRuntime {
  const value = exact(input, runtimeKeys);
  if (value.version !== 1) return invalid();
  return {
    version: 1, lineageId: text(value.lineageId, idPattern), deploymentId: text(value.deploymentId, idPattern),
    generation: positive(value.generation), lineageVersion: positive(value.lineageVersion),
    stableHost: host(value.stableHost), probeHost: host(value.probeHost), namespace: text(value.namespace, dnsLabelPattern, 63),
    workloadName: text(value.workloadName, dnsLabelPattern, 63), serviceName: text(value.serviceName, dnsLabelPattern, 63),
    probeIngressName: text(value.probeIngressName, dnsLabelPattern, 63), routeName: text(value.routeName, dnsLabelPattern, 63),
  };
}

export function parsePreviewObservation(input: unknown): PreviewObservation {
  const value = exact(input, observationKeys);
  if (value.version !== 1 || (value.state !== 'open' && value.state !== 'closed')) return invalid();
  return {
    version: 1, lineageId: text(value.lineageId, idPattern), lineageVersion: positive(value.lineageVersion),
    installationId: numericId(value.installationId), repositoryId: numericId(value.repositoryId),
    pullRequestNumber: positive(value.pullRequestNumber), state: value.state, headSha: text(value.headSha, shaPattern),
    headRef: ref(value.headRef), baseRef: ref(value.baseRef), updatedAt: timestamp(value.updatedAt), observedAt: timestamp(value.observedAt),
  };
}

export function parsePreviewInventory(input: unknown): readonly PreviewOwnedObject[] {
  if (!Array.isArray(input) || input.length > 32) return invalid();
  const identities = new Set<string>();
  return input.map((entry: unknown): PreviewOwnedObject => {
    const value = exact(entry, ['group', 'version', 'kind', 'namespace', 'name', 'uid', 'resourceVersion']);
    const kind = value.kind;
    if (kind !== 'Deployment' && kind !== 'Service' && kind !== 'Ingress') return invalid();
    const group = { Deployment: 'apps', Service: '', Ingress: 'networking.k8s.io' }[kind];
    if (value.group !== group || value.version !== 'v1') return invalid();
    const result: PreviewOwnedObject = {
      group, version: 'v1' as const, kind, namespace: text(value.namespace, dnsLabelPattern, 63),
      name: text(value.name, dnsLabelPattern, 63), uid: text(value.uid, idPattern),
      ...(value.resourceVersion === undefined ? {} : { resourceVersion: text(value.resourceVersion, /^[1-9][0-9]*$/, 128) }),
    };
    const identity = `${group}/${kind}/${result.namespace}/${result.name}`;
    if (identities.has(identity)) return invalid();
    identities.add(identity);
    return result;
  });
}
