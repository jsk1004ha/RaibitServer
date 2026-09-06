import { execFile } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import { readFile, lstat, realpath } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';
import { promisify } from 'node:util';
import { APPROVED_INPUT_SHA256, digest, EvidenceError } from './operator-inputs.mjs';
import { inspectSecretReference } from './orchestrator-io.mjs';

const execute = promisify(execFile);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DNS = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const HEX32 = /^[a-f0-9]{32}$/;
const SHA = /^[a-f0-9]{64}$/;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function normalize(value) { return typeof value === 'string' ? value.trim().toLowerCase().replace(/\.$/, '') : ''; }
function guard(hostname, fixtureZone, baseDomain) {
  const host = normalize(hostname), zone = normalize(fixtureZone), base = normalize(baseDomain);
  if (![host, zone, base].every((value) => DNS.test(value)) || host === zone || !host.endsWith(`.${zone}`)
    || zone === base || base.endsWith(`.${zone}`)) throw new EvidenceError('fixture_zone_escape');
  return host;
}
function httpsUrl(value) {
  try { const parsed = new URL(value); return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash; }
  catch { return false; }
}

export function parseDomainEvidenceInputs(value, baseDomain) {
  const keys = ['schema', 'approvedInputSha256', 'provider', 'fixtureZone', 'zoneId', 'expectedClusterIssuer', 'hostname',
    'projectId', 'serviceId', 'deploymentId', 'generatedFallbackUrl', 'expectedResponseMarkerSha256', 'tokenSecretRef'];
  if (!exactKeys(value, keys) || value.schema !== 'raibitserver.production-domain-inputs/v1'
    || value.approvedInputSha256 !== APPROVED_INPUT_SHA256 || value.provider !== 'cloudflare' || !HEX32.test(value.zoneId ?? '')
    || !ID.test(value.expectedClusterIssuer ?? '') || ![value.projectId, value.serviceId, value.deploymentId].every((item) => ID.test(item ?? ''))
    || !SHA.test(value.expectedResponseMarkerSha256 ?? '') || !httpsUrl(value.generatedFallbackUrl)
    || !exactKeys(value.tokenSecretRef, ['namespace', 'name', 'key'])
    || ![value.tokenSecretRef.namespace, value.tokenSecretRef.name].every((item) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(item ?? ''))
    || !/^[A-Za-z0-9_.-]+$/.test(value.tokenSecretRef.key ?? '')) throw new EvidenceError('invalid_domain_inputs');
  const hostname = guard(value.hostname, value.fixtureZone, baseDomain);
  const fallback = new URL(value.generatedFallbackUrl);
  const fallbackHost = normalize(fallback.hostname), base = normalize(baseDomain);
  if ((fallbackHost !== base && !fallbackHost.endsWith(`.${base}`)) || fallbackHost === hostname
    || fallbackHost.endsWith(`.${normalize(value.fixtureZone)}`)) throw new EvidenceError('invalid_domain_inputs');
  return Object.freeze({ ...value, fixtureZone: normalize(value.fixtureZone), hostname });
}

export async function loadDomainEvidenceInputs(file, baseDomain) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new EvidenceError('domain_provider_contract_unavailable');
  let resolved;
  try { resolved = await realpath(file); }
  catch { throw new EvidenceError('domain_provider_contract_unavailable'); }
  if (resolved !== path.resolve(file) || !(await lstat(resolved)).isFile()) throw new EvidenceError('domain_provider_contract_unavailable');
  let value;
  try { value = JSON.parse(await readFile(resolved, 'utf8')); }
  catch { throw new EvidenceError('invalid_domain_inputs'); }
  return parseDomainEvidenceInputs(value, baseDomain);
}

async function cloudflareRequest(request, apiToken) {
  const target = new URL(request.url);
  if (target.origin !== 'https://api.cloudflare.com' || target.username || target.password) throw new EvidenceError('cloudflare_request_forbidden');
  const body = request.body === undefined ? undefined : Buffer.from(JSON.stringify(request.body));
  return new Promise((resolve, reject) => {
    const outgoing = https.request({ protocol: 'https:', hostname: 'api.cloudflare.com', port: 443,
      path: `${target.pathname}${target.search}`, method: request.method, headers: { authorization: `Bearer ${apiToken}`,
        accept: 'application/json', ...(body ? { 'content-type': 'application/json', 'content-length': String(body.length) } : {}) },
      rejectUnauthorized: true, servername: 'api.cloudflare.com', signal: AbortSignal.timeout(30_000) }, (response) => {
      let text = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { text += chunk; if (text.length > 1024 * 1024) response.destroy(); });
      response.on('end', () => { try { resolve(JSON.parse(text)); } catch { reject(new EvidenceError('cloudflare_response_invalid')); } });
    });
    outgoing.once('error', () => reject(new EvidenceError('cloudflare_request_failed')));
    if (body) outgoing.write(body); outgoing.end();
  });
}

export function createCloudflareFixtureDnsAdapter({ extension, apiToken, request = cloudflareRequest }) {
  if (!extension || extension.provider !== 'cloudflare' || typeof apiToken !== 'string' || apiToken.length < 8 || typeof request !== 'function') throw new EvidenceError('missing_credentials');
  const owned = new Map(), root = `https://api.cloudflare.com/client/v4/zones/${extension.zoneId}/dns_records`;
  return Object.freeze({
    async createTxt({ hostname, content, runId }) {
      const host = guard(hostname, extension.fixtureZone, new URL(extension.generatedFallbackUrl).hostname);
      if (typeof runId !== 'string' || !runId || typeof content !== 'string' || !content.startsWith('raibit-verification=') || content.length > 512) throw new EvidenceError('invalid_dns_record');
      const name = `_raibit-challenge.${host}`;
      const response = await request({ method: 'POST', url: root, body: { type: 'TXT', name, content, ttl: 60, comment: `raibit-evidence:${runId}` } }, apiToken);
      const result = response?.result;
      if (response?.success !== true || !HEX32.test(result?.id ?? '') || normalize(result?.name) !== name || result?.type !== 'TXT' || result?.content !== content) throw new EvidenceError('cloudflare_create_failed');
      owned.set(result.id, host);
      return Object.freeze({ recordId: result.id, hostname: host });
    },
    async readTxt({ hostname, recordId }) {
      const host = guard(hostname, extension.fixtureZone, new URL(extension.generatedFallbackUrl).hostname);
      if (!HEX32.test(recordId ?? '') || owned.get(recordId) !== host) throw new EvidenceError('dns_record_not_owned');
      const response = await request({ method: 'GET', url: `${root}/${recordId}` }, apiToken);
      const result = response?.result;
      if (response?.success !== true || result?.id !== recordId || normalize(result?.name) !== `_raibit-challenge.${host}` || result?.type !== 'TXT'
        || typeof result?.content !== 'string' || !result.content.startsWith('raibit-verification=')) throw new EvidenceError('cloudflare_read_failed');
      return Object.freeze({ recordId, hostname: host, contentSha256: digest(result.content) });
    },
    async deleteTxt({ hostname, recordId }) {
      const host = guard(hostname, extension.fixtureZone, new URL(extension.generatedFallbackUrl).hostname);
      if (!HEX32.test(recordId ?? '') || owned.get(recordId) !== host) throw new EvidenceError('dns_record_not_owned');
      const response = await request({ method: 'DELETE', url: `${root}/${recordId}` }, apiToken);
      if (response?.success !== true || response?.result?.id !== recordId) throw new EvidenceError('cloudflare_delete_failed');
      owned.delete(recordId);
    },
  });
}

async function readSecretValue(inputs, ref) {
  const context = inputs.selectors.RAIBITSERVER_RELEASE_KUBE_CONTEXT;
  let stdout;
  try { ({ stdout } = await execute('kubectl', ['--context', context, '--namespace', ref.namespace, 'get', 'secret', ref.name, '-o', 'json'], { encoding: 'utf8', timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 })); }
  catch { throw new EvidenceError('missing_credentials'); }
  let value;
  try { value = JSON.parse(stdout); } catch { throw new EvidenceError('missing_credentials'); }
  const encoded = value?.data?.[ref.key];
  if (typeof encoded !== 'string') throw new EvidenceError('missing_credentials');
  const token = Buffer.from(encoded, 'base64').toString('utf8');
  if (token.length < 8 || /[\r\n]/.test(token)) throw new EvidenceError('missing_credentials');
  return token;
}

async function apiRequest(baseDomain, method, route, body, sessionToken = null) {
  const target = new URL(`https://api.${baseDomain}${route}`), bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = https.request({ hostname: target.hostname, port: 443, path: target.pathname, method, servername: target.hostname,
      rejectUnauthorized: true, signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json', ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
        ...(bytes ? { 'content-type': 'application/json', 'content-length': String(bytes.length) } : {}) } }, (response) => {
      let text = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { text += chunk; if (text.length > 1024 * 1024) response.destroy(); });
      response.on('end', () => { try { resolve({ statusCode: response.statusCode ?? 0, body: text ? JSON.parse(text) : null }); } catch { reject(new EvidenceError('control_plane_response_invalid')); } });
    }); request.once('error', () => reject(new EvidenceError('control_plane_request_failed'))); if (bytes) request.write(bytes); request.end();
  });
}

async function waitForDomain(baseDomain, domainId, sessionToken, predicate) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const response = await apiRequest(baseDomain, 'GET', `/api/domains/${domainId}`, undefined, sessionToken);
    if (response.statusCode === 200 && predicate(response.body)) return response.body;
    if (response.statusCode === 404) throw new EvidenceError('domain_not_found');
    if (response.statusCode !== 200) throw new EvidenceError('domain_state_unavailable');
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new EvidenceError('domain_state_timeout');
}

async function domainObjects(inputs, domainId) {
  const context = inputs.selectors.RAIBITSERVER_RELEASE_KUBE_CONTEXT;
  let stdout;
  try { ({ stdout } = await execute('kubectl', ['--context', context, 'get', 'certificate,ingress', '--all-namespaces',
    '--selector', `raibitserver.io/domain-id=${domainId}`, '--output=json'], { encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })); }
  catch { throw new EvidenceError('domain_objects_unavailable'); }
  try { return JSON.parse(stdout).items ?? []; } catch { throw new EvidenceError('domain_objects_unavailable'); }
}

async function externalOwnership(hostname, fixtureZone, challenge) {
  const resolver = new Resolver(); resolver.setServers(['1.1.1.1', '8.8.8.8']);
  const name = `_raibit-challenge.${hostname}`, expected = `raibit-verification=${challenge}`;
  const recursive = (await resolver.resolveTxt(name)).map((parts) => parts.join('')).includes(expected);
  const nameservers = await resolver.resolveNs(fixtureZone), addresses = await resolver.resolve4(nameservers[0]);
  const authoritative = new Resolver(); authoritative.setServers([addresses[0]]);
  const direct = (await authoritative.resolveTxt(name)).map((parts) => parts.join('')).includes(expected);
  return { recursive, authoritative: direct };
}

async function waitOwnershipAbsent(hostname, fixtureZone, challenge) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const ownership = await externalOwnership(hostname, fixtureZone, challenge);
      if (!ownership.recursive && !ownership.authoritative) return;
    } catch (error) {
      if (error?.code === 'ENODATA' || error?.code === 'ENOTFOUND') return;
      if (attempt === 59) throw new EvidenceError('cleanup_failed');
    }
    if (attempt === 59) throw new EvidenceError('cleanup_failed');
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

async function credentialedLifecycle({ inputs, extension, dns, observeReady }) {
  const runtime = inputs.secretRefs.find(({ role }) => role === 'runtime');
  if (!runtime || runtime.kind !== 'helm-existingSecret') throw new EvidenceError('missing_credentials');
  const emailKey = runtime.keys.includes('RAIBITSERVER_EVIDENCE_OPERATOR_EMAIL') ? 'RAIBITSERVER_EVIDENCE_OPERATOR_EMAIL' : null;
  const passwordKey = runtime.keys.includes('RAIBITSERVER_EVIDENCE_OPERATOR_PASSWORD') ? 'RAIBITSERVER_EVIDENCE_OPERATOR_PASSWORD' : null;
  if (!emailKey || !passwordKey) throw new EvidenceError('missing_credentials');
  const [email, password] = await Promise.all([readSecretValue(inputs, { namespace: runtime.namespace, name: runtime.existingSecret, key: emailKey }),
    readSecretValue(inputs, { namespace: runtime.namespace, name: runtime.existingSecret, key: passwordKey })]);
  const base = inputs.selectors.RAIBITSERVER_RELEASE_BASE_DOMAIN;
  const login = await apiRequest(base, 'POST', '/api/auth/login', { email, password });
  const session = login.body?.token;
  if (login.statusCode !== 200 || typeof session !== 'string') throw new EvidenceError('authentication_failed');
  let domain = null, record = null, challenge = null;
  try {
    const created = await apiRequest(base, 'POST', `/api/projects/${extension.projectId}/domains`, { serviceId: extension.serviceId, hostname: extension.hostname }, session);
    domain = created.body?.domain; challenge = created.body?.challengeToken;
    if (created.statusCode !== 201 || !ID.test(domain?.id ?? '') || typeof challenge !== 'string') throw new EvidenceError('domain_create_failed');
    record = await dns.createTxt({ hostname: extension.hostname, content: `raibit-verification=${challenge}`, runId: domain.id });
    await dns.readTxt({ hostname: extension.hostname, recordId: record.recordId });
    const ownership = await externalOwnership(extension.hostname, extension.fixtureZone, challenge);
    if (!ownership.recursive || !ownership.authoritative) throw new EvidenceError('external_dns_unavailable');
    const requestCheck = () => apiRequest(base, 'POST', `/api/domains/${domain.id}/verify`, { expectedVersion: domain.verificationVersion }, session);
    await requestCheck(); domain = await waitForDomain(base, domain.id, session, (value) => value.status === 'READY');
    const deployment = await apiRequest(base, 'GET', `/api/deployments/${extension.deploymentId}`, undefined, session);
    if (deployment.statusCode !== 200 || deployment.body?.serviceId !== extension.serviceId || deployment.body?.status !== 'READY') throw new EvidenceError('wrong_backend_blocked');
    const objects = await domainObjects(inputs, domain.id);
    const certificate = objects.find(({ kind }) => kind === 'Certificate'), ingress = objects.find(({ kind }) => kind === 'Ingress');
    if (!certificate || !ingress || certificate.spec?.issuerRef?.name !== extension.expectedClusterIssuer
      || JSON.stringify(certificate.spec?.dnsNames) !== JSON.stringify([extension.hostname])
      || ingress.spec?.rules?.[0]?.host !== extension.hostname
      || ingress.metadata?.labels?.['raibitserver.io/service-id'] !== extension.serviceId) throw new EvidenceError('domain_objects_mismatch');
    const readyObservation = await observeReady();
    await dns.deleteTxt({ hostname: extension.hostname, recordId: record.recordId }); record = null;
    await waitOwnershipAbsent(extension.hostname, extension.fixtureZone, challenge);
    for (let failure = 1; failure <= 3; failure++) {
      await requestCheck(); domain = await waitForDomain(base, domain.id, session, (value) => value.consecutiveFailures >= failure);
    }
    if (domain.status !== 'FAILED') throw new EvidenceError('revalidation_disable_failed');
    record = await dns.createTxt({ hostname: extension.hostname, content: `raibit-verification=${challenge}`, runId: domain.id });
    await requestCheck(); domain = await waitForDomain(base, domain.id, session, (value) => value.status === 'READY' && value.consecutiveFailures === 0);
    const deleted = await apiRequest(base, 'DELETE', `/api/domains/${domain.id}`, { expectedVersion: domain.verificationVersion }, session);
    if (![200, 202].includes(deleted.statusCode)) throw new EvidenceError('domain_delete_failed');
    await dns.deleteTxt({ hostname: extension.hostname, recordId: record.recordId }); record = null;
    await waitOwnershipAbsent(extension.hostname, extension.fixtureZone, challenge);
    await waitForDomain(base, domain.id, session, () => false).catch((error) => { if (error.reason !== 'domain_not_found') throw error; });
    if ((await domainObjects(inputs, domain.id)).length !== 0) throw new EvidenceError('cleanup_failed');
    return { domainId: domain.id, organizationId: domain.organizationId, projectId: extension.projectId, serviceId: extension.serviceId,
      deploymentId: extension.deploymentId, verificationVersion: domain.verificationVersion, desiredGeneration: domain.desiredGeneration,
      controllerLeaseGeneration: domain.controllerLeaseGeneration, ownership: { externalRecursive: true, authoritative: true, version: domain.verificationVersion },
      revalidation: { dailySimulationObserved: true, failuresObserved: 3, disabledAfterFailures: true, ownershipRecovered: true },
      certificateIssuer: extension.expectedClusterIssuer, cleanup: { txtAbsent: true, dnsAbsent: true, certificateAbsent: true, routeAbsent: true },
      readyObservation };
  } finally {
    let cleanupFailed = false;
    if (record) {
      try { await dns.deleteTxt({ hostname: extension.hostname, recordId: record.recordId }); if (challenge) await waitOwnershipAbsent(extension.hostname, extension.fixtureZone, challenge); }
      catch { cleanupFailed = true; }
    }
    if (domain?.id) {
      try {
        if (domain.status !== 'DELETING') await apiRequest(base, 'DELETE', `/api/domains/${domain.id}`, { expectedVersion: domain.verificationVersion }, session);
        await waitForDomain(base, domain.id, session, () => false).catch((error) => { if (error.reason !== 'domain_not_found') throw error; });
        if ((await domainObjects(inputs, domain.id)).length !== 0) cleanupFailed = true;
      } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) throw new EvidenceError('cleanup_failed');
  }
}

async function publicDns(hostname) {
  const resolver = new Resolver(); resolver.setServers(['1.1.1.1', '8.8.8.8']);
  const lookup = async () => [...new Set((await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]))
    .flatMap((item) => item.status === 'fulfilled' ? item.value : []))].sort();
  const addresses = await lookup(), reboundAddresses = await lookup();
  if (!addresses.length) throw new EvidenceError('external_dns_unavailable');
  return { addresses, reboundAddresses, stable: JSON.stringify(addresses) === JSON.stringify(reboundAddresses) };
}

async function tlsObservation(hostname) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: hostname, port: 443, servername: hostname, rejectUnauthorized: true, timeout: 20_000 }, () => {
      const certificate = socket.getPeerCertificate(); socket.end();
      resolve({ chainVerified: socket.authorized, dnsNames: String(certificate.subjectaltname ?? '').split(/,\s*/).map((name) => name.replace(/^DNS:/, '')) });
    });
    socket.once('timeout', () => socket.destroy(new EvidenceError('tls_probe_failed'))); socket.once('error', () => reject(new EvidenceError('tls_probe_failed')));
  });
}

async function httpsBody(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url); const request = https.get({ hostname: target.hostname, port: 443, path: `${target.pathname}${target.search}`,
      headers: { host: target.hostname }, servername: target.hostname, rejectUnauthorized: true, signal: AbortSignal.timeout(20_000) }, (response) => {
      let body = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { body += chunk; if (body.length > 1024 * 1024) response.destroy(); });
      response.on('end', () => resolve({ statusCode: response.statusCode ?? 0, body }));
    }); request.once('error', () => reject(new EvidenceError('https_probe_failed')));
  });
}

export async function executeCredentialedDomainProbes({ inputs, extension, lifecycle }) {
  lifecycle ??= ({ dns, observeReady }) => credentialedLifecycle({ inputs, extension, dns, observeReady });
  if (typeof lifecycle !== 'function') throw new EvidenceError('domain_lifecycle_adapter_unavailable');
  const providerRef = { kind: 'worker-secretKeyRef', role: 'dns-provider', binding: 'domain-evidence',
    namespace: extension.tokenSecretRef.namespace,
    secretKeyRef: { name: extension.tokenSecretRef.name, key: extension.tokenSecretRef.key, optional: false } };
  let metadata;
  try { metadata = await inspectSecretReference(providerRef, inputs, process.cwd()); }
  catch { throw new EvidenceError('missing_credentials'); }
  if (!metadata.available || !metadata.keysPresent) throw new EvidenceError('missing_credentials');
  const token = await readSecretValue(inputs, extension.tokenSecretRef);
  const dns = createCloudflareFixtureDnsAdapter({ extension, apiToken: token });
  const observeReady = async () => {
    const resolution = await publicDns(extension.hostname), certificate = await tlsObservation(extension.hostname);
    const route = await httpsBody(`https://${extension.hostname}/`);
    if (digest(route.body) !== extension.expectedResponseMarkerSha256) throw new EvidenceError('wrong_backend_blocked');
    return { resolution, certificate, route };
  };
  const observed = await lifecycle({ dns, extension, observeReady });
  const fallback = await httpsBody(extension.generatedFallbackUrl), ready = observed.readyObservation;
  if (!ready || digest(fallback.body) !== extension.expectedResponseMarkerSha256) throw new EvidenceError('wrong_backend_blocked');
  const { readyObservation: _readyObservation, ...lifecycleProof } = observed;
  return { ...lifecycleProof, resolution: ready.resolution,
    certificate: { ...ready.certificate, configuredIssuer: extension.expectedClusterIssuer, issuer: observed.certificateIssuer },
    https: { host: extension.hostname, servername: extension.hostname, statusCode: ready.route.statusCode, responseMarkerSha256: digest(ready.route.body), serviceId: extension.serviceId, deploymentId: extension.deploymentId },
    cleanup: { ...observed.cleanup, generatedFallbackStatusCode: fallback.statusCode, generatedFallbackMarkerSha256: digest(fallback.body) } };
}
