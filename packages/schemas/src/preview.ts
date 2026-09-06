import { z } from 'zod';

const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const numericId = z.string().regex(/^[1-9][0-9]{0,15}$/).refine((value) => Number.isSafeInteger(Number(value)));
const sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
const dnsLabel = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const host = z.string().max(253).regex(/^[a-z0-9.-]+$/).refine((value) => value.includes('.') && value.split('.').every((label) => dnsLabel.safeParse(label).success));
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/).refine((value) => {
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === (value.length === 20 ? value.replace('Z', '.000Z') : value);
});
const ref = z.string().min(1).max(255).regex(/^[^\s\x00-\x1f\x7f~^:?*\[\\]+$/).refine((value) => value !== '@' && !value.includes('..') && !value.includes('@{') && !value.endsWith('.') && value.split('/').every((part) => !!part && !part.startsWith('.') && !part.endsWith('.lock')));

export const PreviewWebhookSchema = z.strictObject({
  deliveryId: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i).transform((value) => value.toLowerCase()),
  installationId: numericId, repositoryId: numericId,
  repository: z.string().max(140).regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/),
  pullRequestNumber: positive, action: z.enum(['opened', 'synchronize', 'reopened', 'closed']),
  headSha: sha, headRef: ref, baseRef: ref, beforeSha: sha.nullable(), updatedAt: timestamp,
}).refine((value) => value.action !== 'synchronize' || value.beforeSha !== null);

export const PreviewRuntimeSchema = z.strictObject({
  version: z.literal(1), lineageId: identity, deploymentId: identity, generation: positive,
  lineageVersion: positive, stableHost: host, probeHost: host, namespace: dnsLabel,
  workloadName: dnsLabel, serviceName: dnsLabel, probeIngressName: dnsLabel, routeName: dnsLabel,
});
export const PreviewObservationSchema = z.strictObject({
  version: z.literal(1), lineageId: identity, lineageVersion: positive, installationId: numericId,
  repositoryId: numericId, pullRequestNumber: positive, state: z.enum(['open', 'closed']),
  headSha: sha, headRef: ref, baseRef: ref, updatedAt: timestamp, observedAt: timestamp,
});
export const PreviewOwnedObjectSchema = z.strictObject({
  group: z.string(), version: z.literal('v1'), kind: z.enum(['Deployment', 'Service', 'Ingress']),
  namespace: dnsLabel, name: dnsLabel, uid: identity, resourceVersion: z.string().max(128).regex(/^[1-9][0-9]*$/).optional(),
}).refine((value) => value.group === { Deployment: 'apps', Service: '', Ingress: 'networking.k8s.io' }[value.kind]);
export const PreviewInventorySchema = z.array(PreviewOwnedObjectSchema).max(32).refine((values) => new Set(values.map((value) => `${value.group}/${value.kind}/${value.namespace}/${value.name}`)).size === values.length);
