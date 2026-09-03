import crypto from 'node:crypto';
import { isSecretKey, maskSecretValue } from './secrets.ts';
import { can } from './rbac.ts';
import { canonicalizeProviderDesiredSpec, sanitizeResourceValue } from './resource-sanitizer.ts';
import { INTERNAL_SERVICE_MUTATION, parseResourceMutation, parseServiceMutation } from './desired-state-mutations.ts';
import { requireResourceCapability } from './resource-capabilities.ts';

type AnyRecord = Record<string, any>;

const SAFE_SERVICE_KEYS = new Set([
  'projectId',
  'name',
  'slug',
  'type',
  'runtimeType',
  'sourceType',
  'buildMode',
  'repoUrl',
  'repositoryUrl',
  'githubRepositoryId',
  'githubRepository',
  'githubIntegrationId',
  'githubInstallationId',
  'githubRepositoryVisibility',
  'sourceAccess',
  'branch',
  'rootDirectory',
  'buildContext',
  'localPath',
  'dockerfilePath',
  'installCommand',
  'buildCommand',
  'startCommand',
  'command',
  'args',
  'outputDirectory',
  'image',
  'imageUrl',
  'port',
  'resources',
  'scaling',
  'healthCheck',
  'schedule',
  'concurrencyPolicy',
  'backoffLimit',
  'availability',
  'sleepPolicy',
  'environment',
  'env',
  'attachedResources',
  'desiredSpec',
]);

const SAFE_RESOURCE_API_KEYS = new Set([
  'projectId',
  'name',
  'slug',
  'type',
  'engine',
  'provider',
  'plan',
  'region',
  'version',
  'storageMb',
  'storageGb',
  'databaseName',
  'database',
  'username',
  'bucket',
  'collection',
  'topic',
  'backup',
  'desiredSpec',
]);

const RESOURCE_TYPES = new Set(['database', 'cache', 'storage', 'vector', 'queue']);
const RESOURCE_PLANS = new Set(['shared-small', 'dedicated-local']);

const SAFE_DEPLOYMENT_CREATE_KEYS = new Set([
  'serviceId',
  'projectId',
  'commitHash',
  'commitSha',
  'imageUrl',
  'image',
  'imageDigest',
  'deploymentType',
  'type',
  'branch',
  'previewUrl',
  'triggerType',
  'pullRequestNumber',
]);

const SAFE_DEPLOYMENT_STATUS_KEYS = new Set([
  'status',
  'imageUrl',
  'image',
  'imageDigest',
  'buildStartedAt',
  'buildFinishedAt',
  'deployedAt',
  'finishedAt',
  'errorCode',
  'errorMessage',
  'previewUrl',
  'eventType',
  'message',
  'metadata',
]);

const DEFAULT_ALLOWED_GIT_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org'];
const GITHUB_BINDING_KEYS = new Set([
  'githubIntegrationId',
  'githubInstallationId',
  'githubRepositoryId',
  'githubRepository',
  'githubRepositoryPrivate',
  'githubRepositoryVisibility',
]);

export const DEFAULT_CONTAINER_SECURITY_CONTEXT = Object.freeze({
  runAsNonRoot: true,
  runAsUser: 10001,
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ['ALL'] },
  seccompProfile: { type: 'RuntimeDefault' },
});

export const DEFAULT_POD_SECURITY_CONTEXT = Object.freeze({
  fsGroup: 10001,
  seccompProfile: { type: 'RuntimeDefault' },
});

export function validateServiceSecurity(service: AnyRecord = {}) {
  const findings = [];
  const context = service.securityContext || {};
  if (service.privileged === true || service.securityContext?.privileged === true) {
    findings.push({ level: 'block', code: 'NO_PRIVILEGED', message: 'privileged containers are not allowed' });
  }
  if (service.hostNetwork === true) {
    findings.push({ level: 'block', code: 'NO_HOST_NETWORK', message: 'hostNetwork is not allowed for tenant workloads' });
  }
  if (service.hostPID === true) {
    findings.push({ level: 'block', code: 'NO_HOST_PID', message: 'hostPID is not allowed for tenant workloads' });
  }
  if (service.hostIPC === true) {
    findings.push({ level: 'block', code: 'NO_HOST_IPC', message: 'hostIPC is not allowed for tenant workloads' });
  }
  if (service.automountServiceAccountToken === true) {
    findings.push({ level: 'block', code: 'NO_SERVICE_ACCOUNT_TOKEN', message: 'tenant workloads cannot automount Kubernetes service account tokens' });
  }
  for (const volume of service.volumes || []) {
    if (volume.hostPath) {
      findings.push({ level: 'block', code: 'NO_HOST_PATH', message: `hostPath mount is not allowed: ${volume.name || volume.hostPath}` });
    }
  }
  for (const mount of service.volumeMounts || []) {
    if (mount.readOnly !== true && mount.mountPath !== '/tmp') {
      findings.push({ level: 'block', code: 'WRITABLE_PATH_NOT_ALLOWED', message: `writable mount path is not allowed: ${mount.mountPath || mount.name}` });
    }
  }
  const limits = service.resources?.limits;
  if (!limits?.cpu || !limits?.memory) {
    findings.push({ level: 'warn', code: 'RESOURCE_LIMITS_REQUIRED', message: 'CPU and memory limits should be configured' });
  }
  if (service.runAsRoot === true || context.runAsUser === 0 || context.runAsNonRoot === false) {
    findings.push({ level: 'block', code: 'NO_ROOT', message: 'runtime containers must not run as root' });
  }
  if (context.allowPrivilegeEscalation === true) {
    findings.push({ level: 'block', code: 'NO_PRIVILEGE_ESCALATION', message: 'allowPrivilegeEscalation must be false' });
  }
  if (context.readOnlyRootFilesystem === false) {
    findings.push({ level: 'block', code: 'READ_ONLY_ROOT_REQUIRED', message: 'readOnlyRootFilesystem must remain true' });
  }
  if (Array.isArray(context.capabilities?.add) && context.capabilities.add.length > 0) {
    findings.push({ level: 'block', code: 'NO_CAPABILITY_ADD', message: 'Linux capabilities.add is not allowed' });
  }
  if (context.seccompProfile && context.seccompProfile.type !== 'RuntimeDefault') {
    findings.push({ level: 'block', code: 'RUNTIME_DEFAULT_SECCOMP_REQUIRED', message: 'seccompProfile.type must be RuntimeDefault' });
  }
  return {
    ok: !findings.some((finding) => finding.level === 'block'),
    findings,
  };
}

export function secureContainerDefaults(service: AnyRecord = {}) {
  const requestedRunAsUser = Number(service.runAsUser ?? service.securityContext?.runAsUser);
  const runAsUser = Number.isInteger(requestedRunAsUser) && requestedRunAsUser > 0
    ? requestedRunAsUser
    : DEFAULT_CONTAINER_SECURITY_CONTEXT.runAsUser;
  return {
    runAsNonRoot: true,
    runAsUser,
    privileged: false,
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ['ALL'] },
    seccompProfile: { type: 'RuntimeDefault' },
  };
}

export function unsafeDisabledAuthAllowed(env: AnyRecord = process.env) {
  if (env.RAIBITSERVER_AUTH_DISABLED !== '1') return false;
  if (env.NODE_ENV === 'production') return false;
  return env.RAIBITSERVER_AUTH_DISABLED_CONFIRM === 'I_UNDERSTAND_THIS_GRANTS_GLOBAL_OWNER';
}

export function safeAuthModeFromEnv(env: AnyRecord = process.env) {
  return unsafeDisabledAuthAllowed(env) ? 'disabled' : 'jwt';
}

export function securityHeaders() {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'cache-control': 'no-store',
  };
}

export function createFixedWindowRateLimiter({ limit = 10, windowMs = 60_000 } = {}) {
  const entries = new Map<string, { count: number; resetAt: number }>();
  return {
    check(key: string) {
      const now = Date.now();
      const normalized = String(key || 'global');
      const current = entries.get(normalized);
      if (!current || current.resetAt <= now) {
        const row = { count: 1, resetAt: now + windowMs };
        entries.set(normalized, row);
        return { allowed: true, remaining: Math.max(0, limit - 1), resetAt: row.resetAt };
      }
      current.count += 1;
      return { allowed: current.count <= limit, remaining: Math.max(0, limit - current.count), resetAt: current.resetAt };
    },
    reset(key: string) {
      entries.delete(String(key || 'global'));
    },
  };
}

export function assertRateLimit(limiter: ReturnType<typeof createFixedWindowRateLimiter>, key: string) {
  const result = limiter.check(key);
  if (!result.allowed) {
    const error = new Error('rate_limit_exceeded');
    (error as any).statusCode = 429;
    (error as any).retryAfterSeconds = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
    throw error;
  }
  return result;
}

export async function enforceAuthAbuseLimits(repository: AnyRecord, input: AnyRecord & { readonly phase?: 'all' | 'request' | 'email' } = {}) {
  if (!repository || typeof repository.consumeAuthRateLimit !== 'function') {
    const error = new Error('durable_auth_rate_limiter_not_configured');
    (error as any).statusCode = 500;
    throw error;
  }
  const env = input.env || process.env;
  const action = String(input.action || 'auth').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'auth';
  const email = String(input.email || '').trim().toLowerCase();
  const source = String(input.source || 'unknown').trim().toLowerCase() || 'unknown';
  const now = Number(input.now === undefined ? Date.now() : input.now);
  const windowMs = boundedPositiveInteger(env.RAIBITSERVER_AUTH_RATE_WINDOW_MS, 60_000, 1_000, 60 * 60_000);
  const globalDimension = {
    key: authRateLimitKey('global', 'all', env),
    limit: boundedPositiveInteger(env.RAIBITSERVER_AUTH_GLOBAL_RATE_LIMIT, 5_000, 1, 50_000),
    windowMs,
  };
  if (input.phase !== 'email' && typeof repository.peekAuthRateLimit === 'function') {
    const globalState = await repository.peekAuthRateLimit({ ...globalDimension, now });
    if (!globalState.allowed) throwAuthRateLimitExceeded(globalState, now);
  }
  const dimensions = input.phase === 'email' ? [] : [
    { key: authRateLimitKey(`source:${action}`, source, env), limit: boundedPositiveInteger(env.RAIBITSERVER_AUTH_SOURCE_RATE_LIMIT, 30, 1, 100_000), windowMs },
    { key: authRateLimitKey('flow-source', source, env), limit: boundedPositiveInteger(env.RAIBITSERVER_AUTH_FLOW_SOURCE_RATE_LIMIT, 60, 1, 100_000), windowMs },
    globalDimension,
  ];
  if (input.phase !== 'request' && action === 'email-resend' && email) {
    dimensions.push({
      key: authRateLimitKey('resend-cooldown', email, env),
      limit: 1,
      windowMs: boundedPositiveInteger(env.RAIBITSERVER_EMAIL_RESEND_COOLDOWN_MS, 60_000, 1_000, 24 * 60 * 60_000),
    });
  }
  if (input.phase !== 'request' && email) dimensions.push({ key: authRateLimitKey(`email:${action}`, email, env), limit: boundedPositiveInteger(env.RAIBITSERVER_AUTH_EMAIL_RATE_LIMIT, 10, 1, 10_000), windowMs });
  const results = [];
  for (const dimension of dimensions) {
    const result = await repository.consumeAuthRateLimit({ ...dimension, now });
    results.push(result);
    if (!result.allowed) throwAuthRateLimitExceeded(result, now);
  }
  return results;
}

function throwAuthRateLimitExceeded(result: AnyRecord, now: number): never {
  const error = new Error('rate_limit_exceeded');
  (error as any).statusCode = 429;
  (error as any).retryAfterSeconds = Math.max(1, Math.ceil((Number(result.resetAt || now) - now) / 1_000));
  throw error;
}

function authRateLimitKey(dimension: string, value: string, env: AnyRecord) {
  const material = `${dimension}\u0000${value}`;
  const secret = String(env.RAIBITSERVER_AUTH_RATE_LIMIT_KEY_SECRET || env.RAIBITSERVER_AUTH_JWT_SECRET || '');
  const digest = secret
    ? crypto.createHmac('sha256', secret).update(material).digest('base64url')
    : crypto.createHash('sha256').update(material).digest('base64url');
  return `auth:${dimension.split(':')[0]}:${digest}`;
}

function boundedPositiveInteger(value: any, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

export function sanitizeTenantServiceInput(input: AnyRecord = {}, options: AnyRecord = {}) {
  if (options.allowGitHubBinding !== true) assertNoTenantGitHubBinding(input);
  const output = pickKnown(input, SAFE_SERVICE_KEYS);

  sanitizeRuntimeCommandFields(output);
  if (output.name !== undefined) output.name = String(output.name || '').trim();
  if (output.sourceType !== undefined) output.sourceType = String(output.sourceType || 'github').toLowerCase();
  if (output.port !== undefined && output.port !== null && output.port !== '') output.port = Number(output.port);
  if (output.repoUrl || output.repositoryUrl) output.repoUrl = normalizeTenantGitUrl(output.repoUrl || output.repositoryUrl, options);
  if (output.repositoryUrl) delete output.repositoryUrl;
  const sourceType = String(output.sourceType || 'github').toLowerCase();
  if (sourceType === 'local' || output.localPath || isLocalOrFileSource(output.repoUrl || output.buildContext || '')) {
    if (!tenantLocalSourceAllowed(options.env || process.env)) {
      const error = new Error('local service sources are disabled for tenant API requests');
      (error as any).statusCode = 400;
      throw error;
    }
  }
  if (output.desiredSpec && typeof output.desiredSpec === 'object') {
    output.desiredSpec = pickKnown(output.desiredSpec, SAFE_SERVICE_KEYS);
    sanitizeRuntimeCommandFields(output.desiredSpec);
    delete output.desiredSpec.status;
    delete output.desiredSpec.desiredState;
  }
  delete output.status;
  delete output.desiredState;
  delete output.id;
  return output;
}

export function assertNoTenantGitHubBinding(input: AnyRecord) {
  const candidates = [input, input?.desiredSpec].filter((value) => value && typeof value === 'object' && !Array.isArray(value));
  if (candidates.some((candidate) => [...GITHUB_BINDING_KEYS].some((key) => Object.prototype.hasOwnProperty.call(candidate, key)))) {
    badRequest('GitHub repository bindings must be created through the verified attach or import flow');
  }
}

function sanitizeRuntimeCommandFields(output: AnyRecord) {
  for (const key of ['command', 'args']) {
    if (!Object.prototype.hasOwnProperty.call(output, key)) continue;
    const value = output[key];
    if (!Array.isArray(value) || value.length === 0 || value.length > 64 || value.some((entry) => typeof entry !== 'string' || !entry.trim() || entry.length > 4096 || /[\u0000-\u001f\u007f]/.test(entry))) {
      delete output[key];
      continue;
    }
    output[key] = [...value];
  }
}

export function sanitizeTenantServiceUpdate(input: AnyRecord = {}, options: AnyRecord = {}) {
  const output = sanitizeTenantServiceInput(options.mutation === INTERNAL_SERVICE_MUTATION || options.allowGitHubBinding === true ? input : parseServiceMutation(input), options);
  delete output.projectId;
  return output;
}

export function sanitizeTenantResourceApiInput(input: AnyRecord = {}) {
  const output = pickKnown(input, SAFE_RESOURCE_API_KEYS);
  validateManagedResourceRouteFields(output);
  if (output.desiredSpec && typeof output.desiredSpec === 'object' && !Array.isArray(output.desiredSpec)) {
    output.desiredSpec = sanitizeResourceValue(output.desiredSpec);
  }
  if (['sqlite', 'sqlite3'].includes(String(output.engine || '').toLowerCase()) && output.desiredSpec && typeof output.desiredSpec === 'object' && !Array.isArray(output.desiredSpec)) {
    output.desiredSpec = { ...output.desiredSpec };
    delete output.desiredSpec.sqlitePath;
  }
  output.desiredSpec = canonicalizeProviderDesiredSpec(output, { rejectUnknown: true });
  for (const key of ['storageMb', 'storageGb', 'databaseName', 'database', 'username', 'bucket', 'collection', 'topic', 'backup']) delete output[key];
  delete output.status;
  delete output.desiredState;
  delete output.connectionSecretName;
  return output;
}

function validateManagedResourceRouteFields(input: AnyRecord) {
  if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 128)) badRequest('resource name must be a non-empty string of at most 128 characters');
  if (input.type !== undefined && !RESOURCE_TYPES.has(String(input.type).toLowerCase())) badRequest(`unsupported managed resource type: ${input.type}`);
  if (input.engine !== undefined) requireResourceCapability(String(input.engine), 'provision');
  if (input.plan !== undefined && !RESOURCE_PLANS.has(String(input.plan).toLowerCase())) badRequest(`unsupported managed resource plan: ${input.plan}`);
  if (input.region !== undefined && String(input.region).trim().toLowerCase() !== 'local') badRequest(`unsupported managed resource region: ${input.region}`);
  if (input.version !== undefined && String(input.version).trim() !== '') badRequest('managed resource version selection is not implemented');
  if (input.provider !== undefined) {
    const provider = String(input.provider).trim().toLowerCase();
    const localSqlite = provider === 'local-pvc' && ['sqlite', 'sqlite3'].includes(String(input.engine || '').trim().toLowerCase());
    if (!localSqlite && !['local', 'raibitserver', 'managed-catalog', 'shared-provider', 'dedicated-local'].includes(provider) && !/^raibitserver-local-[a-z0-9-]+$/.test(provider)) {
      badRequest(`unsupported managed resource provider: ${input.provider}`);
    }
  }
}

export function sanitizeTenantResourceApiUpdate(input: AnyRecord = {}, currentEngine?: unknown) {
  const mutation = parseResourceMutation(input);
  const output = sanitizeTenantResourceApiInput(currentEngine !== undefined && !Object.hasOwn(mutation, 'engine') ? { ...mutation, engine: currentEngine } : mutation);
  delete output.projectId;
  return output;
}

export function sanitizeTenantDeploymentCreate(input: AnyRecord = {}) {
  const output = pickKnown(input, SAFE_DEPLOYMENT_CREATE_KEYS);
  if (output.deploymentType === undefined && output.type !== undefined) output.deploymentType = output.type;
  delete output.type;
  delete output.id;
  delete output.status;
  delete output.workflowJob;
  return output;
}

export function sanitizeDeploymentStatusInput(input: AnyRecord = {}) {
  const output = pickKnown(input, SAFE_DEPLOYMENT_STATUS_KEYS);
  delete output.workflowJob;
  return output;
}

export function assertSystemDeploymentActor(subject: AnyRecord = {}) {
  if (subject.authMode === 'disabled' || subject.claims?.system === true || subject.role === 'system') return true;
  const error = new Error('deployment status updates require a builder/system actor');
  (error as any).statusCode = 403;
  throw error;
}

export function redactDbConsoleStatement(statement: any) {
  const withoutLiteralValues = String(statement || '')
    .replace(/'([^']|'')*'/g, "'?'")
    .replace(/"([^"]|"")*"/g, '"?"');
  const text = sanitizeLogString(withoutLiteralValues.replace(/\s+/g, ' ').trim()).slice(0, 160);
  return text ? `${text}${String(statement || '').length > 160 ? '…' : ''}` : '';
}

export function tenantLocalSourceAllowed(env: AnyRecord = process.env) {
  return env.RAIBITSERVER_ALLOW_LOCAL_SOURCE === '1' || env.NODE_ENV !== 'production';
}

export function normalizeTenantGitUrl(repoUrl: any, options: AnyRecord = {}) {
  const value = String(repoUrl || '').trim();
  if (!value) return value;
  if (hasGitUrlCredentials(value)) {
    badRequest('credentialed git URLs are not allowed; pass tokens through integration secrets');
  }
  if (isLocalOrFileSource(value)) {
    if (tenantLocalSourceAllowed(options.env || process.env)) return value;
    badRequest('local/file git URLs are not allowed for tenant API requests');
  }
  const allowedHosts = new Set([
    ...DEFAULT_ALLOWED_GIT_HOSTS,
    ...String((options.env || process.env).RAIBITSERVER_ALLOWED_GIT_HOSTS || '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean),
  ]);
  const ssh = value.match(/^git@([^:]+):[^/\s]+\/[^/\s]+(?:\.git)?$/i);
  if (ssh) {
    const host = ssh[1].toLowerCase();
    if (!allowedHosts.has(host)) badRequest(`git host is not allowed: ${host}`);
    return value;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    badRequest('unsupported git URL');
  }
  if (parsed.protocol !== 'https:') badRequest('git URLs must use https');
  const host = parsed.hostname.toLowerCase();
  if (!allowedHosts.has(host)) badRequest(`git host is not allowed: ${host}`);
  if (!/\/[^/]+\/[^/]+/.test(parsed.pathname)) badRequest('unsupported git URL');
  return value;
}

export function guardDatabaseQuery(query: any, { confirmed = false, role = 'developer' }: AnyRecord = {}) {
  const text = String(query || '').trim();
  const readOnly = isReadOnlyDatabaseQuery(text);
  const destructive = !readOnly;
  if (!text) {
    return { allowed: false, reason: 'query is required', destructive: false, readOnly: false };
  }
  if (readOnly && !can(role, 'db:data:read')) {
    return { allowed: false, reason: `role ${role} requires db:data:read permission for read-only queries`, destructive, readOnly };
  }
  if (destructive && !canMutateDatabase(role)) {
    return { allowed: false, reason: `role ${role} requires db:query:write permission for destructive queries`, destructive, readOnly };
  }
  if (destructive && !confirmed) {
    return { allowed: false, reason: 'destructive query requires explicit confirmation', destructive };
  }
  return { allowed: true, reason: 'query accepted', destructive, readOnly };
}

function pickKnown(input: AnyRecord = {}, allowed: Set<string>) {
  const output: AnyRecord = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (!allowed.has(key)) continue;
    output[key] = sanitizeLogRecord(value);
  }
  return output;
}

function isLocalOrFileSource(value: any) {
  const text = String(value || '').trim();
  return text.startsWith('/') || text.startsWith('./') || text.startsWith('../') || /^[a-z]:[\\/]/i.test(text) || /^\\\\/.test(text) || /^file:\/\//i.test(text);
}

function hasGitUrlCredentials(value: string) {
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]*@/i.test(value)) return true;
  try {
    const parsed = new URL(value);
    return Boolean(parsed.username || parsed.password || [...parsed.searchParams.keys()].some(isGitCredentialQueryKey));
  } catch {
    const query = value.split('#', 1)[0].split('?', 2)[1];
    return Boolean(query && [...new URLSearchParams(query).keys()].some(isGitCredentialQueryKey));
  }
}

function isGitCredentialQueryKey(key: string) {
  return /(?:secret|password|passwd|token|private.?key|credential|database.?url|api.?key|access.?key|auth)/i.test(key);
}

function badRequest(message: string): never {
  const error = new Error(message);
  (error as any).statusCode = 400;
  throw error;
}

function canMutateDatabase(role: string) {
  return can(role, 'db:query:write');
}

export function isReadOnlyDatabaseQuery(query: any) {
  const text = stripLeadingSqlComments(String(query || '').trim()).replace(/;+\s*$/, '').trim();
  if (!text || text.includes(';')) return false;
  const normalized = text.replace(/\s+/g, ' ').toUpperCase();
  if (/^SELECT\b/.test(normalized)) {
    return !/\b(FOR\s+UPDATE|INTO\s+(?:OUTFILE|DUMPFILE)?|COPY|DO)\b/.test(normalized);
  }
  if (/^SHOW\b/.test(normalized) || /^DESCRIBE\b/.test(normalized)) return true;
  if (/^EXPLAIN\s+SELECT\b/.test(normalized)) return true;
  if (/^PRAGMA\b/.test(normalized)) return !/[=;]/.test(normalized);
  return false;
}

function stripLeadingSqlComments(value: string) {
  let text = value;
  let changed = true;
  while (changed) {
    changed = false;
    const next = text.replace(/^\s*--[^\n]*(?:\n|$)/, '').replace(/^\s*\/\*[\s\S]*?\*\//, '');
    if (next !== text) {
      text = next.trimStart();
      changed = true;
    }
  }
  return text;
}

export function sanitizeLogRecord(record: any): any {
  if (typeof record === 'string') return sanitizeLogString(record);
  if (Array.isArray(record)) return record.map((item) => sanitizeLogRecord(item));
  if (!record || typeof record !== 'object') return record;
  const output: AnyRecord = {};
  for (const [key, value] of Object.entries(record)) {
    output[key] = isSecretKey(key) && value !== null && value !== undefined && typeof value !== 'object'
      ? maskSecretValue(value)
      : sanitizeLogRecord(value);
  }
  return output;
}

function sanitizeLogString(value: string) {
  return value
    .replace(/([A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|KEY|DATABASE_URL|MONGODB_URI|REDIS_URL)[A-Z0-9_]*=)([^\s]+)/gi, '$1****')
    .replace(/(["']?[A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|KEY|DATABASE_URL|MONGODB_URI|REDIS_URL)[A-Z0-9_]*["']?\s*[:=]\s*["'])([^"'\s,}]+)/gi, '$1****')
    .replace(/\b(Bearer|Token)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 ****')
    .replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)([^@\s]+)(@)/gi, '$1****$3')
    .replace(/(mysql:\/\/[^:\s/@]+:)([^@\s]+)(@)/gi, '$1****$3')
    .replace(/(redis:\/\/:[^@\s]+@)/gi, 'redis://:****@');
}

export function splitEnvForSecret(environment: AnyRecord = {}) {
  const plain: AnyRecord = {};
  const secret: AnyRecord = {};
  for (const [key, value] of Object.entries(environment)) {
    if (isSecretKey(key)) secret[key] = String(value);
    else plain[key] = String(value);
  }
  return { plain, secret };
}
