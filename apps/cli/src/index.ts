#!/usr/bin/env node
import fs from 'node:fs/promises';
// Generated package-local snapshot keeps emitted CLI help independent of source paths.
import resourceCapabilities from './resource-capabilities-v1.json' with { type: 'json' };
import { RAIBITSERVERClient } from '@raibitserver/api-client';

const apiUrl = process.env.RAIBITSERVER_API_URL || 'http://localhost:3000/api';
const token = process.env.RAIBITSERVER_TOKEN;
const client = new RAIBITSERVERClient({ baseUrl: apiUrl, token });

async function main(argv: string[]) {
  const [domain, action, ...args] = argv;
  if (!domain || ['help', '--help', '-h'].includes(domain)) {
    console.log(`Resource capabilities (local only; release evidence not recorded):\n${resourceCapabilities.engines.map((entry) => `  ${entry.engine}: ${entry.reasonKo}`).join('\n')}\nManaged backup/restore: unavailable; command plans only.`);
    return help();
  }
  if (domain === 'login') return print(await client.login({ email: value(args, '--email') || args[0], password: value(args, '--password') || args[1] }));
  if (domain === 'whoami') return print(await client.me());
  if (domain === 'projects' && action === 'list') return print(await client.listProjects(value(args, '--organization-id')));
  if (domain === 'projects' && action === 'create') return print(await client.createProject({ name: value(args, '--name') || args[0], slug: value(args, '--slug') }, value(args, '--organization-id')));
  if (domain === 'services' && action === 'create') return print(await client.createService(required(args, '--project-id'), { name: value(args, '--name') || args[0], type: value(args, '--type') || 'web', sourceType: value(args, '--source-type') || 'image', image: value(args, '--image'), repoUrl: value(args, '--repo-url'), port: numberValue(args, '--port') } as any));
  if (domain === 'deploy') {
    const deployment = { branch: value(args, '--branch') || 'main', commitSha: value(args, '--commit'), deploymentType: value(args, '--type') || 'manual' } as any;
    const projectId = value(args, '--project-id');
    const serviceId = required(args, '--service-id');
    return print(projectId ? await client.createDeployment(projectId, serviceId, deployment) : await client.createDeployment(serviceId, deployment));
  }
  if (domain === 'deployments' && action === 'logs') return print(await client.listDeploymentLogs(required(args, '--deployment-id')));
  if (domain === 'resources' && action === 'create') return print(await client.createResource(required(args, '--project-id'), { name: value(args, '--name') || args[0], type: value(args, '--type') || 'database', engine: value(args, '--engine') || 'postgresql', plan: value(args, '--plan') || 'shared-small' } as any));
  if (domain === 'resources' && action === 'attach') return print({ error: 'Use API POST /resources/:resourceId/attach; CLI attach is reserved for provider-backed mode.' });
  if (domain === 'db' && action === 'query') return print(await client.queryResource(required(args, '--resource-id'), { query: await queryText(args), confirmed: args.includes('--confirm') }));
  if (domain === 'usage') return print(await client.usageMe());
  if (domain === 'admin' && action === 'approve') return print(await raw(`/admin/users/${encodeURIComponent(required(args, '--user-id') || args[0])}/approve`, 'POST', { accountType: value(args, '--account-type') || 'NON_CLUB' }));
  if (domain === 'admin' && action === 'quota') return print(await raw(`/admin/users/${encodeURIComponent(required(args, '--user-id'))}/quota`, 'PATCH', Object.fromEntries(pairArgs(args))));
  throw new Error(`unknown command: ${[domain, action].filter(Boolean).join(' ')}`);
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
function required(args: string[], flag: string) { const v = value(args, flag); if (!v) throw new Error(`${flag} is required`); return v; }
function numberValue(args: string[], flag: string) { const v = value(args, flag); return v ? Number(v) : undefined; }
async function queryText(args: string[]) { const file = value(args, '--file'); if (file) return fs.readFile(file, 'utf8'); return value(args, '--query') || args.filter((arg) => !arg.startsWith('--')).slice(1).join(' '); }
function* pairArgs(args: string[]) { for (let i = 0; i < args.length; i += 1) if (args[i].startsWith('--') && args[i] !== '--user-id') yield [args[i].slice(2), coerce(args[i + 1])]; }
function coerce(v: string) { return /^\d+$/.test(String(v)) ? Number(v) : v; }
function print(v: unknown) { process.stdout.write(`${JSON.stringify(v, null, 2)}\n`); }
function help() { console.log(`RAIBITSERVER CLI\n  raibitserver login --email EMAIL --password PASS\n  raibitserver whoami\n  raibitserver projects list|create\n  raibitserver services create --project-id ID --name web --source-type image --image IMAGE@sha256:DIGEST\n  raibitserver deploy --project-id ID --service-id ID\n  raibitserver deployments logs --deployment-id ID\n  raibitserver resources create --project-id ID --engine postgresql\n  raibitserver db query --resource-id ID --query "SELECT 1"\n  raibitserver usage\n  raibitserver admin approve --user-id ID --account-type NON_CLUB|CLUB_MEMBER\n  raibitserver admin quota --user-id ID --maxProjects 3`); }

main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exit(1); });
