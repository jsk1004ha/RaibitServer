import { isSecretKey } from './secrets.ts';
import { validateServiceSecurity } from './security.ts';

type AnyRecord = Record<string, any>;
type ThreatSeverity = 'critical' | 'high' | 'medium' | 'low';

export type DeploymentThreatFinding = {
  severity: ThreatSeverity;
  code: string;
  message: string;
  field?: string;
};

export type DeploymentServiceAssessment = {
  serviceId: string;
  name: string;
  type: string;
  eligible: boolean;
  findings: DeploymentThreatFinding[];
};

export type DeploymentAgentPlan = {
  version: 'v1';
  projectId: string;
  generatedBy: 'deterministic' | 'external-ai';
  summary: string;
  blocked: boolean;
  canApply: boolean;
  deploymentOrder: string[];
  services: DeploymentServiceAssessment[];
  security: {
    highestSeverity: ThreatSeverity | 'none';
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
};

const SEVERITY_ORDER: Record<ThreatSeverity, number> = { critical: 4, high: 3, medium: 2, low: 1 };
const DANGEROUS_COMMANDS = [
  { pattern: /(?:curl|wget)\b[^|;&]*(?:\||;)\s*(?:ba)?sh\b/i, code: 'REMOTE_SCRIPT_EXECUTION', severity: 'critical' as const },
  { pattern: /\brm\s+-[^\s]*r[^\s]*f\s+(?:\/|~|\$HOME)\b/i, code: 'DESTRUCTIVE_COMMAND', severity: 'critical' as const },
  { pattern: /\b(?:sudo|su)\b/i, code: 'PRIVILEGE_COMMAND', severity: 'high' as const },
  { pattern: /\bchmod\s+(?:-R\s+)?777\b/i, code: 'WORLD_WRITABLE_COMMAND', severity: 'high' as const },
  { pattern: /\b(?:nc|ncat|netcat)\b.*(?:-e|--exec)\b/i, code: 'REVERSE_SHELL_COMMAND', severity: 'critical' as const },
];

export function assessDeploymentService(serviceInput: AnyRecord = {}): DeploymentServiceAssessment {
  const service = mergedService(serviceInput);
  const serviceId = String(serviceInput.id || service.id || '');
  const findings: DeploymentThreatFinding[] = [];
  const workloadSecurity = validateServiceSecurity(service);

  for (const finding of workloadSecurity.findings) {
    findings.push({
      severity: finding.level === 'block' ? 'critical' : 'medium',
      code: String(finding.code),
      message: String(finding.message),
      field: 'securityContext',
    });
  }

  const image = String(service.imageUrl || service.image || '').trim();
  if (image && !/@sha256:[a-f0-9]{64}$/i.test(image)) {
    findings.push({
      severity: 'high',
      code: /(?:^|:)latest$/i.test(image) ? 'MUTABLE_IMAGE_TAG' : 'UNPINNED_IMAGE',
      message: 'Container images must be pinned to an immutable sha256 digest.',
      field: 'image',
    });
  }

  const repoUrl = String(service.repoUrl || service.repositoryUrl || '').trim();
  if (repoUrl && unsafeRepositoryProtocol(repoUrl)) {
    findings.push({
      severity: 'high',
      code: 'UNSAFE_REPOSITORY_PROTOCOL',
      message: 'Repository URLs must use HTTPS without embedded credentials.',
      field: 'repoUrl',
    });
  }

  for (const field of ['installCommand', 'buildCommand', 'startCommand', 'command']) {
    const command = commandText(service[field]);
    if (!command) continue;
    for (const rule of DANGEROUS_COMMANDS) {
      if (!rule.pattern.test(command)) continue;
      findings.push({
        severity: rule.severity,
        code: rule.code,
        message: `Potentially dangerous ${field} is not allowed for agent-managed deployment.`,
        field,
      });
    }
  }

  for (const [key, value] of environmentEntries(service)) {
    if (!isSecretKey(key) || !isPlaintextEnvironmentValue(value)) continue;
    findings.push({
      severity: 'critical',
      code: 'PLAINTEXT_SECRET_ENV',
      message: `Secret-looking environment key ${key} must use a secret reference.`,
      field: `environment.${key}`,
    });
  }

  const deduplicated = deduplicateFindings(findings).sort(compareFindings);
  return {
    serviceId,
    name: String(service.name || serviceInput.name || serviceId),
    type: String(service.type || service.runtimeType || 'service'),
    eligible: !deduplicated.some((finding) => finding.severity === 'critical' || finding.severity === 'high'),
    findings: deduplicated,
  };
}

export async function createDeploymentAgentPlan(
  overview: AnyRecord,
  options: { env?: AnyRecord; fetch?: typeof globalThis.fetch; timeoutMs?: number; serviceIds?: string[] } = {},
): Promise<DeploymentAgentPlan> {
  const requestedIds = Array.isArray(options.serviceIds) && options.serviceIds.length
    ? new Set(options.serviceIds.map(String))
    : null;
  const services = (Array.isArray(overview?.services) ? overview.services : [])
    .filter((service: AnyRecord) => !requestedIds || requestedIds.has(String(service.id)))
    .map(assessDeploymentService)
    .sort((left: DeploymentServiceAssessment, right: DeploymentServiceAssessment) => left.serviceId.localeCompare(right.serviceId));
  const security = securitySummary(services);
  const blocked = security.critical > 0 || security.high > 0;
  const safeIds = services.filter((service) => service.eligible).map((service) => service.serviceId);
  const base: DeploymentAgentPlan = {
    version: 'v1',
    projectId: String(overview?.project?.id || overview?.projectId || ''),
    generatedBy: 'deterministic',
    summary: blocked
      ? 'Deployment is blocked until all critical and high security findings are resolved.'
      : safeIds.length ? `${safeIds.length} service(s) are ready for deployment.` : 'No deployable services were found.',
    blocked,
    canApply: !blocked && safeIds.length > 0,
    deploymentOrder: blocked ? [] : safeIds,
    services,
    security,
  };

  if (blocked || !safeIds.length) return base;
  const recommendation = await requestExternalRecommendation(overview, base, options);
  if (!recommendation) return base;
  return {
    ...base,
    generatedBy: 'external-ai',
    summary: recommendation.summary || base.summary,
    deploymentOrder: recommendation.serviceIds,
    canApply: recommendation.serviceIds.length > 0,
  };
}

async function requestExternalRecommendation(
  overview: AnyRecord,
  plan: DeploymentAgentPlan,
  options: { env?: AnyRecord; fetch?: typeof globalThis.fetch; timeoutMs?: number },
) {
  const env = options.env || process.env;
  const url = String(env.RAIBITSERVER_AI_AGENT_URL || '').trim();
  const token = String(env.RAIBITSERVER_AI_AGENT_TOKEN || '').trim();
  const model = String(env.RAIBITSERVER_AI_AGENT_MODEL || '').trim();
  const fetchImpl = options.fetch || globalThis.fetch;
  if (!url || !token || !model || typeof fetchImpl !== 'function') return null;
  if (!/^https:\/\//i.test(url) && !isLoopbackUrl(url)) return null;

  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || 3_000, 100), 5_000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const allowedIds = new Set(plan.services.filter((service) => service.eligible).map((service) => service.serviceId));
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        version: 'v1',
        model,
        project: {
          id: plan.projectId,
          name: boundedText(overview?.project?.name, 120),
        },
        services: plan.services.map((service) => ({
          id: service.serviceId,
          name: boundedText(service.name, 120),
          type: boundedText(service.type, 40),
          eligible: service.eligible,
          findingCodes: service.findings.map((finding) => finding.code),
        })),
        requestedOutput: ['serviceIds', 'ordering', 'summary'],
      }),
    });
    if (!response.ok) return null;
    const text = await readBoundedResponse(response, 32_768);
    if (text === null) return null;
    const body = JSON.parse(text);
    const candidates = Array.isArray(body?.ordering) ? body.ordering : body?.serviceIds;
    if (!Array.isArray(candidates)) return null;
    const serviceIds = [...new Set(candidates.map(String))].filter((id) => allowedIds.has(id));
    return { serviceIds, summary: boundedText(body?.summary, 500) };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedResponse(response: Response, maximumBytes: number) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) return null;
  const reader = response.body?.getReader?.();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(combined);
}

function mergedService(service: AnyRecord) {
  const desired = service.desiredState || service.desiredSpec;
  return desired && typeof desired === 'object' && !Array.isArray(desired) ? { ...service, ...desired } : service;
}

function unsafeRepositoryProtocol(repoUrl: string) {
  if (/^[\w.-]+\/[\w.-]+(?:\.git)?$/i.test(repoUrl)) return false;
  if (!/^https:\/\//i.test(repoUrl)) return true;
  try {
    const parsed = new URL(repoUrl);
    return Boolean(parsed.username || parsed.password);
  } catch {
    return true;
  }
}

function commandText(value: any) {
  return Array.isArray(value) ? value.map(String).join(' ') : typeof value === 'string' ? value : '';
}

function environmentEntries(service: AnyRecord): Array<[string, any]> {
  const environment = service.environment || service.env || {};
  if (Array.isArray(environment)) {
    return environment.map((entry) => {
      const [key, ...rest] = String(entry).split('=');
      return [key, rest.length ? rest.join('=') : undefined];
    });
  }
  return environment && typeof environment === 'object' ? Object.entries(environment) : [];
}

function isPlaintextEnvironmentValue(value: any) {
  if (value === undefined || value === null || value === '') return false;
  if (typeof value === 'object') return !isStructuredSecretReference(value);
  const normalized = String(value).trim();
  return !/^\$\{[A-Z0-9_]+\}$/i.test(normalized)
    && !/^<restricted>$/i.test(normalized)
    && !/^(?:secret|k8s|external-secret):(?:(?:\/\/)?[^\s]+)$/i.test(normalized);
}

function isStructuredSecretReference(value: any) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const reference = value.valueFrom?.secretKeyRef || value.secretKeyRef;
  return Boolean(reference
    && typeof reference === 'object'
    && typeof reference.name === 'string'
    && reference.name.trim()
    && typeof reference.key === 'string'
    && reference.key.trim());
}

function deduplicateFindings(findings: DeploymentThreatFinding[]) {
  return [...new Map(findings.map((finding) => [`${finding.code}:${finding.field || ''}`, finding])).values()];
}

function compareFindings(left: DeploymentThreatFinding, right: DeploymentThreatFinding) {
  return SEVERITY_ORDER[right.severity] - SEVERITY_ORDER[left.severity]
    || left.code.localeCompare(right.code)
    || String(left.field || '').localeCompare(String(right.field || ''));
}

function securitySummary(services: DeploymentServiceAssessment[]) {
  const summary = { highestSeverity: 'none' as ThreatSeverity | 'none', critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of services.flatMap((service) => service.findings)) summary[finding.severity] += 1;
  summary.highestSeverity = (['critical', 'high', 'medium', 'low'] as ThreatSeverity[]).find((severity) => summary[severity] > 0) || 'none';
  return summary;
}

function boundedText(value: any, maximum: number) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maximum);
}

function isLoopbackUrl(url: string) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}
