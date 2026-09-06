#!/usr/bin/env node
import fs from 'node:fs/promises';
// Generated package-local snapshot keeps emitted CLI help independent of source paths.
import resourceCapabilities from './resource-capabilities-v1.json' with { type: 'json' };
import { ApiOperationError, RAIBITSERVERClient } from '@raibitserver/api-client';

const apiUrl = process.env.RAIBITSERVER_API_URL || 'http://localhost:3000/api';
const token = process.env.RAIBITSERVER_TOKEN;
const client = new RAIBITSERVERClient({ baseUrl: apiUrl, token });

async function main(argv: string[]) {
  const [domain, action, ...args] = argv;
  if (!domain || ['help', '--help', '-h'].includes(domain)) {
    console.log(`Resource capabilities (local only; release evidence not recorded):\n${resourceCapabilities.engines.map((entry) => `  ${entry.engine}: ${entry.reasonKo}`).join('\n')}\nManaged backup/restore commands use the configured API; accepted requests do not prove runtime readiness.`);
    return help();
  }
  if (domain === 'login') return print(await client.login({ email: value(args, '--email') || args[0], password: value(args, '--password') || args[1] }));
  if (domain === 'whoami') return print(await client.me());
  if (domain === 'projects' && action === 'list') return print(await client.listProjects(value(args, '--organization-id')));
  if (domain === 'projects' && action === 'create') return print(await client.createProject({ name: value(args, '--name') || args[0], slug: value(args, '--slug') }, value(args, '--organization-id')));
  if (domain === 'services' && action === 'create') return print(await client.createService(required(args, '--project-id'), { name: value(args, '--name') || args[0], type: value(args, '--type') || 'web', sourceType: value(args, '--source-type') || 'image', image: value(args, '--image'), repoUrl: value(args, '--repo-url'), port: numberValue(args, '--port') } as any));
  if (domain === 'deploy' && action === 'retry') {
    const scope = deploymentScope(args);
    return output(scoped(await client.retryDeployment(scope.deploymentId, operationInput(args)), scope), args);
  }
  if (domain === 'services' && action === 'redeploy') {
    const scope = serviceScope(args);
    return output(scoped(await client.redeployService(scope.serviceId, operationInput(args)), scope), args);
  }
  if (domain === 'deployments' && (action === 'logs' || action === 'events')) {
    const scope = deploymentScope(args);
    if (args.includes('--follow')) {
      return follow(args, 4_096, (options) => client.deploymentActivityStream(scope.deploymentId, {
        ...options,
        onStreamEvent: (snapshot, eventId) => {
          scoped(snapshot, scope);
          output(action === 'logs' ? { logs: snapshot.logs, nextCursor: eventId } : { events: snapshot.events, nextCursor: eventId }, args, true);
        },
      }));
    }
    const page = pageOptions(args);
    return output(action === 'logs' ? await client.listDeploymentLogs(scope.deploymentId, page) : await client.listDeploymentEvents(scope.deploymentId, page), args);
  }
  if (domain === 'services' && action === 'logs') {
    const scope = serviceScope(args);
    if (args.includes('--follow')) {
      return follow(args, 2_048, (options) => client.serviceLogStream(scope.serviceId, {
        ...options,
        onStreamEvent: (snapshot, eventId) => {
          scoped(snapshot, scope);
          output({ logs: snapshot.logs, nextCursor: eventId }, args, true);
        },
      }));
    }
    return output(await client.listRuntimeLogs(scope.serviceId, pageOptions(args)), args);
  }
  if (domain === 'deploy') {
    const deployment = { branch: value(args, '--branch') || 'main', commitSha: value(args, '--commit'), deploymentType: value(args, '--type') || 'manual' } as any;
    const projectId = value(args, '--project-id');
    const serviceId = required(args, '--service-id');
    return print(projectId ? await client.createDeployment(projectId, serviceId, deployment) : await client.createDeployment(serviceId, deployment));
  }
  if (domain === 'deployments' && action === 'logs') return print(await client.listDeploymentLogs(required(args, '--deployment-id')));
  if (domain === 'resources' && action === 'create') return print(await client.createResource(required(args, '--project-id'), { name: value(args, '--name') || args[0], type: value(args, '--type') || 'database', engine: value(args, '--engine') || 'postgresql', plan: value(args, '--plan') || 'shared-small' } as any));
  if (domain === 'resources' && action === 'attach') {
    const scope = resourceScope(args);
    const serviceId = required(args, '--service-id');
    const envPrefix = value(args, '--env-prefix');
    return output(scoped(await client.attachResource(scope.resourceId, { serviceId, ...(envPrefix ? { envPrefix } : {}) }), { ...scope, serviceId }), args);
  }
  if (domain === 'resources' && action === 'backup') {
    const [backupAction, ...backupArgs] = args;
    const scope = resourceScope(backupArgs);
    if (backupAction === 'create') return output(scoped(await client.createBackup(scope.resourceId, { requestIdempotencyKey: idempotencyKey(backupArgs), formatVersion: 1 }), scope), backupArgs);
    if (backupAction === 'list') return output(scoped(await client.listBackups(scope.resourceId, pageOptions(backupArgs)), scope), backupArgs);
    if (backupAction === 'delete') {
      if (!backupArgs.includes('--confirm')) throw new UsageError('--confirm is required');
      const expected = { ...scope, backupId: required(backupArgs, '--backup-id') };
      return output(scoped(await client.deleteBackup(expected.backupId, { confirmed: true }), expected), backupArgs);
    }
    throw new UsageError('resources backup requires create, list, or delete');
  }
  if (domain === 'resources' && action === 'restore') {
    const [restoreAction, ...restoreArgs] = args;
    const scope = resourceScope(restoreArgs);
    const backupId = required(restoreArgs, '--backup-id');
    const expected = { ...scope, backupId };
    if (restoreAction === 'create') return output(scoped(await client.createRestore(backupId, { requestIdempotencyKey: idempotencyKey(restoreArgs), formatVersion: 1, name: restoreName(restoreArgs) }), expected), restoreArgs);
    if (restoreAction === 'get') return output(scoped(await client.getRestore(required(restoreArgs, '--restore-id')), expected), restoreArgs);
    throw new UsageError('resources restore requires create or get');
  }
  if (domain === 'resources' && action === 'provision') {
    const intent = required(args, '--intent');
    if (intent !== 'preview-plan' && intent !== 'live-provision') throw new Error('--intent must be preview-plan or live-provision');
    return print(await client.provisionResource(required(args, '--resource-id'), { intent }));
  }
  if (domain === 'db' && action === 'query') return print(await client.queryResource(required(args, '--resource-id'), { query: await queryText(args), confirmed: args.includes('--confirm') }));
  if (domain === 'usage') return print(await client.usageMe());
  if (domain === 'admin' && action === 'approve') return print(await raw(`/admin/users/${encodeURIComponent(required(args, '--user-id') || args[0])}/approve`, 'POST', { accountType: value(args, '--account-type') || 'NON_CLUB' }));
  if (domain === 'admin' && action === 'quota') return print(await raw(`/admin/users/${encodeURIComponent(required(args, '--user-id'))}/quota`, 'PATCH', Object.fromEntries(pairArgs(args))));
  throw new UsageError(`unknown command: ${[domain, action].filter(Boolean).join(' ')}`);
}

class UsageError extends Error { readonly name = 'UsageError'; }
class ScopeError extends Error { readonly name = 'ScopeError'; }

type TenantScope = { readonly organizationId: string; readonly projectId: string };
type ServiceScope = TenantScope & { readonly serviceId: string };
type DeploymentScope = ServiceScope & { readonly deploymentId: string };
type ResourceScope = TenantScope & { readonly resourceId: string };
type ExpectedScope = TenantScope & { readonly serviceId?: string; readonly resourceId?: string; readonly backupId?: string };
type StreamOptions = { readonly lastEventId?: string; readonly signal: AbortSignal };

function tenantScope(args: string[]): TenantScope {
  return { organizationId: required(args, '--organization-id'), projectId: required(args, '--project-id') };
}

function serviceScope(args: string[]): ServiceScope {
  return { ...tenantScope(args), serviceId: required(args, '--service-id') };
}

function deploymentScope(args: string[]): DeploymentScope {
  return { ...serviceScope(args), deploymentId: required(args, '--deployment-id') };
}

function resourceScope(args: string[]): ResourceScope {
  return { ...tenantScope(args), resourceId: required(args, '--resource-id') };
}

function operationInput(args: string[]) {
  return { requestIdempotencyKey: idempotencyKey(args), snapshotVersion: positiveInteger(args, '--snapshot-version', 1) };
}

function idempotencyKey(args: string[]) {
  const key = required(args, '--idempotency-key');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new UsageError('--idempotency-key is invalid');
  return key;
}

function pageOptions(args: string[]) {
  const cursor = value(args, '--cursor');
  if (cursor && cursor.length > 1024) throw new UsageError('--cursor is invalid');
  const limit = optionalPositiveInteger(args, '--limit');
  return { ...(cursor ? { cursor } : {}), ...(limit ? { limit } : {}) };
}

function restoreName(args: string[]) {
  const name = required(args, '--name');
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(name)) throw new UsageError('--name is invalid');
  return name;
}

async function follow(args: string[], maxCursorLength: number, open: (options: StreamOptions) => Promise<unknown>) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  try {
    const cursor = value(args, '--cursor');
    if (cursor && (cursor.length > maxCursorLength || /[\u0000-\u001f\u007f]/.test(cursor))) throw new UsageError('--cursor is invalid');
    await open({ ...(cursor ? { lastEventId: cursor } : {}), signal: controller.signal });
  } catch (error) {
    if (!(controller.signal.aborted && error instanceof DOMException && error.name === 'AbortError')) throw error;
  } finally {
    process.off('SIGINT', stop);
  }
}

function scoped<T>(result: T, expected: ExpectedScope): T {
  const nested = isRecord(result) ? Object.values(result).filter(Array.isArray).flat().filter(isRecord) : [];
  const candidates = [result, isRecord(result) ? result.deployment : undefined, ...nested].filter(isRecord);
  for (const candidate of candidates) {
    assertField(candidate, 'organizationId', expected.organizationId);
    assertField(candidate, 'projectId', expected.projectId);
    if (expected.serviceId) assertField(candidate, 'serviceId', expected.serviceId);
    if (expected.resourceId) {
      assertField(candidate, 'resourceId', expected.resourceId);
      assertField(candidate, 'sourceResourceId', expected.resourceId);
    }
    if (expected.backupId) assertField(candidate, 'backupId', expected.backupId);
  }
  return result;
}

function assertField(record: Record<string, unknown>, key: string, expected: string) {
  const actual = record[key];
  if (actual !== undefined && actual !== expected) throw new ScopeError('response scope mismatch');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function output(value: unknown, args: string[], streaming = false) {
  const safe = sanitize(value);
  if (args.includes('--json')) return process.stdout.write(`${JSON.stringify(safe, null, streaming ? 0 : 2)}\n`);
  const rows = Array.isArray(safe) ? safe : isRecord(safe) ? Object.values(safe).find(Array.isArray) ?? [safe] : [{ value: safe }];
  const records = rows.filter(isRecord);
  if (records.length === 0) return process.stdout.write('(empty)\n');
  const columns = [...new Set(records.flatMap((record) => Object.keys(record)))].sort();
  process.stdout.write(`${columns.join('\t')}\n${records.map((record) => columns.map((column) => display(record[column])).join('\t')).join('\n')}\n`);
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => !/(?:password|secret|credential|artifactkey|connection(?:url|string)|authorization|accessToken|refreshToken)/i.test(key)).map(([key, item]) => [key, sanitize(item)]));
  if (typeof value === 'string') return value.replace(/([a-z][a-z0-9+.-]*:\/\/[^:/\s]+:)[^@\s]+@/gi, '$1****@').replace(/(artifactKey|password|secret|credential|token)\s*[=:]\s*[^\s,;]+/gi, '$1=****');
  return value;
}

function display(value: unknown) {
  return typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ') : JSON.stringify(value);
}

function optionalPositiveInteger(args: string[], flag: string) {
  const raw = value(args, flag);
  return raw === undefined ? undefined : parsePositiveInteger(raw, flag);
}

function positiveInteger(args: string[], flag: string, fallback: number) {
  const raw = value(args, flag);
  return raw === undefined ? fallback : parsePositiveInteger(raw, flag);
}

function parsePositiveInteger(raw: string, flag: string) {
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new UsageError(`${flag} must be a positive integer`);
  return parsed;
}

async function raw(path: string, method = 'GET', body?: unknown) {
  const headers: Record<string, string> = body ? { 'content-type': 'application/json' } : {};
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${apiUrl.replace(/\/$/, '')}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(parsed.error || text || `HTTP ${response.status}`);
  return parsed;
}

function value(args: string[], flag: string) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; }
function required(args: string[], flag: string) { const v = value(args, flag); if (!v) throw new UsageError(`${flag} is required`); return v; }
function numberValue(args: string[], flag: string) { const v = value(args, flag); return v ? Number(v) : undefined; }
async function queryText(args: string[]) { const file = value(args, '--file'); if (file) return fs.readFile(file, 'utf8'); return value(args, '--query') || args.filter((arg) => !arg.startsWith('--')).slice(1).join(' '); }
function* pairArgs(args: string[]) { for (let i = 0; i < args.length; i += 1) if (args[i].startsWith('--') && args[i] !== '--user-id') yield [args[i].slice(2), coerce(args[i + 1])]; }
function coerce(v: string) { return /^\d+$/.test(String(v)) ? Number(v) : v; }
function print(v: unknown) { process.stdout.write(`${JSON.stringify(v, null, 2)}\n`); }
function help() { console.log(`RAIBITSERVER CLI\n  raibitserver login --email EMAIL --password PASS\n  raibitserver whoami\n  raibitserver projects list|create\n  raibitserver services create --project-id ID --name web --source-type image --image IMAGE@sha256:DIGEST\n  raibitserver deploy --project-id ID --service-id ID\n  raibitserver deploy retry --organization-id ID --project-id ID --service-id ID --deployment-id ID --idempotency-key KEY\n  raibitserver services redeploy --organization-id ID --project-id ID --service-id ID --idempotency-key KEY\n  raibitserver deployments logs|events --organization-id ID --project-id ID --service-id ID --deployment-id ID [--follow] [--cursor CURSOR]\n  raibitserver services logs --organization-id ID --project-id ID --service-id ID [--follow] [--cursor CURSOR]\n  raibitserver resources attach --organization-id ID --project-id ID --resource-id ID --service-id ID\n  raibitserver resources backup create|list|delete --organization-id ID --project-id ID --resource-id ID\n  raibitserver resources restore create|get --organization-id ID --project-id ID --resource-id ID --backup-id ID\n  raibitserver resources create --project-id ID --engine postgresql\n  raibitserver resources provision --resource-id ID --intent preview-plan|live-provision\n  raibitserver db query --resource-id ID --query "SELECT 1"\n  raibitserver usage\n  raibitserver admin approve --user-id ID --account-type NON_CLUB|CLUB_MEMBER\n  raibitserver admin quota --user-id ID --maxProjects 3\n\nLifecycle output defaults to a human table; add --json for stable JSON. Exit codes: 0 success, 1 failure, 2 usage, 3 auth/permission, 4 conflict, 5 unavailable/NOT_RUN.`); }

main(process.argv.slice(2)).catch((error: unknown) => { // no-excuse-ok: catch
  const exitCode = error instanceof UsageError || (error instanceof ApiOperationError && [400, 422].includes(error.status)) ? 2
    : error instanceof ScopeError || (error instanceof ApiOperationError && error.permission) ? 3
      : error instanceof ApiOperationError && error.status === 409 ? 4
        : error instanceof ApiOperationError && ([408, 429, 502, 503, 504].includes(error.status) || ('code' in error.body && ['NOT_RUN', 'UNAVAILABLE'].includes(error.body.code ?? ''))) ? 5 : 1;
  const code = error instanceof ApiOperationError && 'code' in error.body ? error.body.code : error instanceof UsageError ? error.message : 'request_failed';
  process.stderr.write(`${JSON.stringify({ error: sanitize(code), exitCode })}\n`);
  process.exitCode = exitCode;
});
