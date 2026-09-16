import { parseStepRequest, parseStepResult } from '../lib/step-contract.mjs';
import { pathToFileURL } from 'node:url';
import { runFixedStepMain } from '../run-component.mjs';
import { assertJournalAuthority } from '../lib/journal-authority.mjs';
import { digest } from '../lib/operator-inputs.mjs';

const STEP = 'observability';
const IDS = ['runtime_logs', 'usage_quota_audit', 'metrics'];
const rows = (failed, unavailable = false) => IDS.map((id, index) => ({ id, status: failed === null || index < IDS.indexOf(failed) ? 'PASS' : id === failed ? (unavailable ? 'NOT_RUN' : 'FAIL') : 'NOT_RUN' }));
function parseJson(text) { try { return JSON.parse(text); } catch (error) { if (error instanceof SyntaxError) return null; throw error; } }
function records(body, key) { return Array.isArray(body?.[key]) ? body[key] : []; }
function payload(record) { if (record && typeof record === 'object' && !Array.isArray(record)) { if (typeof record.line === 'string') { const parsed = parseJson(record.line); if (parsed) return { ...record, ...parsed }; } return { ...record, ...(record.metadata && typeof record.metadata === 'object' ? record.metadata : {}) }; } return {}; }
function matches(record, correlationId) { return payload(record).correlationId === correlationId; }
function one(entries, role, bindingId) { const found = entries.filter((entry) => entry.role === role && entry.bindingId === bindingId); return found.length === 1 ? found[0].payload : null; }
async function command(context, args) { try { return await context.executeFile('kubectl', args, { timeoutMs: 3 * 60_000 }); } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { exitCode: 127, stdout: '', stderr: '' }; throw error; } }
async function control(context, request) { try { return await context.controlPlaneJson(request); } catch (error) { if (error instanceof Error) return { statusCode: 0, body: null }; throw error; } }

export async function execute(input, context) {
  const request = parseStepRequest(input, STEP);
  let authority = null; let operation = null; try { authority = assertJournalAuthority(context.journalAuthority); const snapshot = await authority.bindingSnapshot(); if (snapshot.runIdentitySha256 !== digest(request.identity)) throw new Error('foreign journal'); const entries = await authority.loadBindings(); if (snapshot.entryCount !== entries.length || snapshot.entriesSha256 !== digest(entries)) throw new Error('journal snapshot mismatch'); operation = one(entries, 'deployment', 'candidate'); } catch { authority = null; operation = null; }
  let failed = null; let reason = null; let unavailable = false; let observedLogCount = 0; let observedMetricCount = 0;
  let namespace = null; let serviceName = null; let correlationId = null; let auditBinding = null;
  if (!request.secretRefs.some(({ role }) => role === 'runtime')) { failed = 'runtime_logs'; reason = 'missing_credentials'; unavailable = true; }
  else if (typeof context.controlPlaneJson !== 'function') { failed = 'runtime_logs'; reason = 'authenticated_control_plane_unavailable'; unavailable = true; }
  else if (!authority || !operation) { failed = 'runtime_logs'; reason = 'binding_journal_unavailable'; unavailable = true; }
  else {
    const deployment = await control(context, { method: 'GET', path: `/api/deployments/${encodeURIComponent(operation.deploymentId)}`, timeoutMs: 30_000 });
    namespace = deployment.body?.namespace ?? null; serviceName = deployment.body?.deploymentName ?? null;
    if (deployment.statusCode !== 200 || typeof namespace !== 'string' || typeof serviceName !== 'string') { failed = 'runtime_logs'; reason = 'deployment_observation_unavailable'; unavailable = true; }
    const paths = [
      `/api/deployments/${encodeURIComponent(operation.deploymentId)}/logs`,
      `/api/deployments/${encodeURIComponent(operation.deploymentId)}/events`,
      `/api/services/${encodeURIComponent(operation.serviceId)}/logs`,
    ];
    const responses = [];
    if (failed === null) for (const path of paths) responses.push(await control(context, { method: 'GET', path, timeoutMs: 3 * 60_000 }));
    const clusterLogs = failed === null ? await command(context, ['--context', request.selectors.RAIBITSERVER_RELEASE_KUBE_CONTEXT, '-n', namespace, 'logs', '-l', `raibitserver.io/service=${serviceName}`, '--since=3m', '--tail=500']) : { exitCode: 1, stdout: '' };
    const apiGroups = [records(responses[0]?.body, 'logs'), records(responses[1]?.body, 'events'), records(responses[2]?.body, 'logs')];
    const clusterRecords = clusterLogs.stdout.split(/\r?\n/).filter(Boolean).map(parseJson).filter(Boolean);
    const candidates = new Set(apiGroups.flat().map(payload).filter((item) => item.runId === request.identity.runId && typeof item.correlationId === 'string').map((item) => item.correlationId));
    correlationId = [...candidates].find((candidate) => apiGroups.every((group) => group.some((record) => matches(record, candidate))) && clusterRecords.some((record) => matches(record, candidate))) ?? null;
    observedLogCount = correlationId ? apiGroups.flat().filter((record) => matches(record, correlationId)).length + clusterRecords.filter((record) => matches(record, correlationId)).length : 0;
    if (failed === null && responses.some(({ statusCode }) => [404, 501].includes(statusCode))) { failed = 'runtime_logs'; reason = 'log_observation_unavailable'; unavailable = true; }
    else if (failed === null && (responses.some(({ statusCode }) => statusCode !== 200) || clusterLogs.exitCode !== 0 || correlationId === null)) {
      failed = 'runtime_logs'; reason = clusterLogs.exitCode === 127 ? 'missing_tool' : 'correlated_log_missing'; unavailable = clusterLogs.exitCode === 127;
    }
    if (failed === null) {
      const usage = await control(context, { method: 'GET', path: '/api/usage/me', timeoutMs: 3 * 60_000 });
      const auditRecords = records(usage.body, 'usage').map(payload);
      const exposesAuditIds = auditRecords.some((entry) => ['reservationId', 'releaseId', 'auditId'].some((key) => typeof entry[key] === 'string'));
      const matched = auditRecords.find((entry) => entry.runId === request.identity.runId && entry.correlationId === correlationId && ['reservationId', 'releaseId', 'auditId'].every((key) => typeof entry[key] === 'string')) ?? null; auditBinding = matched;
      if ([404, 501].includes(usage.statusCode) || (usage.statusCode === 200 && !exposesAuditIds)) { failed = 'usage_quota_audit'; reason = 'quota_audit_observation_unavailable'; unavailable = true; }
      else if (usage.statusCode !== 200 || !matched) { failed = 'usage_quota_audit'; reason = 'usage_quota_audit_missing'; }
    }
    if (failed === null) {
      const metrics = await command(context, ['--context', request.selectors.RAIBITSERVER_RELEASE_KUBE_CONTEXT, '-n', namespace, 'logs', '-l', 'raibitserver.io/component=metrics-ingester', '--since=3m', '--tail=500']);
      const metricRecords = metrics.stdout.split(/\r?\n/).filter(Boolean).map(parseJson).filter(Boolean);
      const samples = metricRecords.filter((entry) => matches(entry, correlationId) && Number(payload(entry).value) > 0);
      observedMetricCount = samples.length;
      if (metrics.exitCode === 127 || (metrics.exitCode === 0 && metricRecords.length === 0)) { failed = 'metrics'; reason = 'metrics_observation_unavailable'; unavailable = true; }
      else if (metrics.exitCode !== 0 || observedMetricCount === 0) { failed = 'metrics'; reason = 'correlated_metric_missing'; }
    }
  }
  const status = failed === null ? 'PASS' : unavailable ? 'NOT_RUN' : 'FAIL';
  const artifact = await context.writeArtifact('operations', 'observability-observation.json', { schema: 'raibitserver.observability-observation/v1', identity: request.identity, deploymentId: operation?.deploymentId ?? null, correlationId, auditBinding, observedLogCount, observedMetricCount, status, observedAt: context.now() });
  return parseStepResult({ status, reason, assertions: rows(failed, unavailable).map((row) => ({ ...row, artifactPaths: [artifact.path] })), artifacts: [artifact], cleanupInventory: [] }, STEP, request);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runFixedStepMain(STEP, process.argv.slice(2)).then(({ exitCode }) => { process.exitCode = exitCode; });
