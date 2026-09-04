import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertRedacted, EvidenceError } from './operator-inputs.mjs';
import { discoverApiTarget, EvidenceClientError, inspectMetadata, readPod, readPolicy, readService } from './authenticated-client-kubernetes.mjs';

export { EvidenceClientError } from './authenticated-client-kubernetes.mjs';

const EMAIL_KEY = 'RAIBITSERVER_EVIDENCE_OPERATOR_EMAIL';
const PASSWORD_KEY = 'RAIBITSERVER_EVIDENCE_OPERATOR_PASSWORD';
const RUN_LABEL = 'raibitserver.io/run-id';
const API_LABELS = Object.freeze({ name: 'raibitserver-api', component: 'api' });
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const KUBE_LABEL_VALUE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?)?$/;
const SAFE_ID = '[A-Za-z0-9][A-Za-z0-9_-]{0,127}';
const ROUTES = Object.freeze([
  ['GET', /^\/api\/projects(?:\?.*)?$/], ['POST', /^\/api\/projects$/],
  ['GET', new RegExp(`^/api/projects/${SAFE_ID}(?:\\?.*)?$`)], ['PATCH', new RegExp(`^/api/projects/${SAFE_ID}$`)], ['DELETE', new RegExp(`^/api/projects/${SAFE_ID}$`)],
  ['GET', new RegExp(`^/api/projects/${SAFE_ID}/services(?:\\?.*)?$`)], ['POST', new RegExp(`^/api/projects/${SAFE_ID}/services$`)],
  ['GET', new RegExp(`^/api/services/${SAFE_ID}(?:\\?.*)?$`)], ['PATCH', new RegExp(`^/api/services/${SAFE_ID}$`)], ['DELETE', new RegExp(`^/api/services/${SAFE_ID}$`)],
  ['GET', new RegExp(`^/api/(?:projects/${SAFE_ID}/services/${SAFE_ID}|services/${SAFE_ID})/deployments(?:\\?.*)?$`)],
  ['POST', new RegExp(`^/api/(?:projects/${SAFE_ID}/services/${SAFE_ID}|services/${SAFE_ID})/deployments$`)],
  ['GET', new RegExp(`^/api/deployments/${SAFE_ID}(?:\\?.*)?$`)],
  ['POST', new RegExp(`^/api/deployments/${SAFE_ID}/(?:retry|rollback|preview-cleanup|cancel)$`)],
  ['GET', new RegExp(`^/api/deployments/${SAFE_ID}/(?:logs|events)(?:\\?.*)?$`)],
  ['GET', new RegExp(`^/api/services/${SAFE_ID}/logs(?:\\?.*)?$`)],
  ['GET', new RegExp(`^/api/projects/${SAFE_ID}/resources(?:\\?.*)?$`)], ['POST', new RegExp(`^/api/projects/${SAFE_ID}/resources$`)],
  ['GET', new RegExp(`^/api/resources/${SAFE_ID}(?:\\?.*)?$`)], ['PATCH', new RegExp(`^/api/resources/${SAFE_ID}$`)], ['DELETE', new RegExp(`^/api/resources/${SAFE_ID}$`)],
  ['POST', new RegExp(`^/api/resources/${SAFE_ID}/(?:provision|attach)$`)],
  ['GET', new RegExp(`^/api/resources/${SAFE_ID}/backups(?:\\?.*)?$`)], ['POST', new RegExp(`^/api/resources/${SAFE_ID}/backups$`)],
  ['DELETE', new RegExp(`^/api/backups/${SAFE_ID}$`)], ['POST', new RegExp(`^/api/backups/${SAFE_ID}/restores$`)], ['GET', new RegExp(`^/api/restores/${SAFE_ID}(?:\\?.*)?$`)],
  ['GET', /^\/api\/integrations\/github(?:\?.*)?$/], ['POST', /^\/api\/integrations\/github$/],
  ['GET', /^\/api\/github\/installations(?:\?.*)?$/], ['GET', new RegExp(`^/api/github/installations/${SAFE_ID}/repositories(?:\\?.*)?$`)],
  ['POST', /^\/api\/github\/repositories\/import$/], ['POST', new RegExp(`^/api/github/repositories/${SAFE_ID}/sync$`)],
  ['GET', /^\/api\/usage\/me(?:\?.*)?$/],
]);

function fail(reason) { throw new EvidenceClientError(reason); }
function nowIso(clock) { const value = clock(); return (value instanceof Date ? value : new Date(value)).toISOString(); }
function parseJson(text, reason) {
  try { return JSON.parse(text); }
  catch (error) { if (error instanceof SyntaxError) fail(reason); throw error; }
}
function assertCommandResult(result, reason) {
  if (!result || result.exitCode !== 0 || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') fail(reason);
  return result;
}
async function kubectl(executeFile, args, reason, timeoutMs = 30_000) {
  return assertCommandResult(await executeFile('kubectl', args, { timeoutMs }), reason);
}
function validRuntimeRef(runtimeRef) {
  if (!runtimeRef || !DNS_LABEL.test(runtimeRef.namespace ?? '') || !DNS_LABEL.test(runtimeRef.releaseName ?? '')) fail('invalid_runtime_reference');
  return runtimeRef;
}

export function validateEvidenceOperatorCredentials(secretRefs, runtimeRef) {
  validRuntimeRef(runtimeRef);
  const refs = Array.isArray(secretRefs) ? secretRefs.filter(ref => ref?.kind === 'helm-existingSecret' && ref.role === 'runtime' && ref.binding === 'runtimeSecrets') : [];
  if (refs.length !== 1) fail('missing_evidence_operator_credentials');
  const ref = refs[0];
  if (ref.namespace !== runtimeRef.namespace || !DNS_LABEL.test(ref.existingSecret ?? '') || !Array.isArray(ref.keys)
    || !ref.keys.includes(EMAIL_KEY) || !ref.keys.includes(PASSWORD_KEY)) fail('missing_evidence_operator_credentials');
  return Object.freeze({ namespace: ref.namespace, secretName: ref.existingSecret, emailKey: EMAIL_KEY, passwordKey: PASSWORD_KEY });
}

const REQUEST_HELPER = String.raw`
const http=require('node:http'),fs=require('node:fs');const method=process.argv[2],path=process.argv[3],host=process.argv[4],body=process.argv[5]?JSON.parse(Buffer.from(process.argv[5],'base64url').toString()):undefined,token=fs.readFileSync('/session/session','utf8');
const clean=v=>Array.isArray(v)?v.map(clean):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([k])=>!/token|secret|password|credential|authorization|cookie|api.?key|private.?key/i.test(k)).map(([k,x])=>[k,clean(x)])):v;
const bytes=body===undefined?null:Buffer.from(JSON.stringify(body)),headers={'content-type':'application/json',authorization:'Bearer '+token};const req=http.request({host,port:3000,path,method,headers,timeout:20000},res=>{let out='';res.setEncoding('utf8');res.on('data',c=>{out+=c;if(Buffer.byteLength(out)>1048576)req.destroy(new Error('response_limit'));});res.on('end',()=>{try{process.stdout.write(JSON.stringify({statusCode:res.statusCode,body:clean(out?JSON.parse(out):null)})+'\n')}catch(error){process.exit(1)}});});req.on('error',()=>process.exit(1));req.on('timeout',()=>req.destroy());if(bytes)req.write(bytes);req.end();`;

const AUTH_BOOTSTRAP = String.raw`
const http=require('node:http'),fs=require('node:fs');
const host=process.argv[1],port=3000,tokenFile='/session/session';
const request=(method,p,body,token)=>new Promise((resolve,reject)=>{const bytes=body?Buffer.from(JSON.stringify(body)):null;const headers={'content-type':'application/json'};if(token)headers.authorization='Bearer '+token;const req=http.request({host,port,path:p,method,headers,timeout:15000},res=>{let out='';res.setEncoding('utf8');res.on('data',c=>{out+=c;if(Buffer.byteLength(out)>1048576)req.destroy(new Error('response_limit'));});res.on('end',()=>{let parsed;try{parsed=out?JSON.parse(out):null}catch(error){reject(error);return}resolve({status:res.statusCode,body:parsed});});});req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('timeout')));if(bytes)req.write(bytes);req.end();});
(async()=>{const login=await request('POST','/api/auth/login',{email:process.env.${EMAIL_KEY},password:process.env.${PASSWORD_KEY}});if(login.status!==200||typeof login.body?.token!=='string')throw new Error('auth_failed');fs.writeFileSync(tokenFile,login.body.token,{mode:0o600,flag:'wx'});fs.writeFileSync('/session/request.cjs',${JSON.stringify(REQUEST_HELPER)},{mode:0o600,flag:'wx'});const me=await request('GET','/api/auth/me',null,login.body.token);if(me.status!==200)throw new Error('auth_me_failed');const memberships=me.body?.memberships;if(!me.body?.user?.id||!Array.isArray(memberships)||memberships.length!==1||memberships[0]?.userId!==me.body.user.id||!memberships[0]?.organizationId||!memberships[0]?.role||!/^(owner|admin)$/i.test(memberships[0].role))throw new Error('membership_failed');process.stdout.write(JSON.stringify({schema:'raibitserver.production-evidence-auth/v1',user:{id:String(me.body.user.id)},membership:{userId:String(memberships[0].userId),organizationId:String(memberships[0].organizationId),role:String(memberships[0].role)}})+'\n');fs.writeFileSync('/session/ready','',{mode:0o600,flag:'wx'});setTimeout(()=>process.exit(0),600000);})().catch(()=>process.exit(1));`;

function clientName(runId) {
  const suffix = String(runId).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 46);
  if (!suffix) fail('invalid_run_identity');
  return `evidence-client-${suffix}`;
}
function manifestFor({ name, runId, credentials, apiTarget }) {
  const labels = { 'app.kubernetes.io/name': 'raibitserver-evidence-client', [RUN_LABEL]: runId };
  const policyName = `${name}-egress`;
  return { apiVersion: 'v1', kind: 'List', items: [
    { apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: credentials.namespace, labels }, spec: {
      automountServiceAccountToken: false, enableServiceLinks: false, hostNetwork: false, hostPID: false, hostIPC: false, restartPolicy: 'Never', terminationGracePeriodSeconds: 1,
      securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001, seccompProfile: { type: 'RuntimeDefault' } },
      containers: [{ name: 'client', image: apiTarget.image, imagePullPolicy: 'IfNotPresent', command: ['node'], args: ['-e', AUTH_BOOTSTRAP, `${apiTarget.serviceName}.${credentials.namespace}.svc`],
        env: [
          { name: EMAIL_KEY, valueFrom: { secretKeyRef: { name: credentials.secretName, key: credentials.emailKey, optional: false } } },
          { name: PASSWORD_KEY, valueFrom: { secretKeyRef: { name: credentials.secretName, key: credentials.passwordKey, optional: false } } },
        ], readinessProbe: { exec: { command: ['node', '-e', "require('node:fs').accessSync('/session/ready')"] }, periodSeconds: 1, timeoutSeconds: 1, failureThreshold: 60 },
        resources: { requests: { cpu: '10m', memory: '32Mi' }, limits: { cpu: '100m', memory: '128Mi' } },
        securityContext: { runAsNonRoot: true, runAsUser: 10001, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
        volumeMounts: [{ name: 'session', mountPath: '/session' }, { name: 'tmp', mountPath: '/tmp' }],
      }], volumes: [{ name: 'session', emptyDir: { medium: 'Memory', sizeLimit: '1Mi' } }, { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '16Mi' } }],
    } },
    { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: policyName, namespace: credentials.namespace, labels }, spec: { podSelector: { matchLabels: labels }, policyTypes: ['Egress'], egress: [
      { to: [{ podSelector: { matchLabels: { 'app.kubernetes.io/name': API_LABELS.name, 'app.kubernetes.io/instance': apiTarget.releaseName } } }], ports: [{ protocol: 'TCP', port: 3000 }] },
      { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } }], ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
    ] } },
  ] };
}

function safeAuthProjection(value) {
  const membership = value?.membership;
  if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(['membership', 'schema', 'user'])
    || JSON.stringify(Object.keys(value.user ?? {})) !== JSON.stringify(['id'])
    || JSON.stringify(Object.keys(membership ?? {}).sort()) !== JSON.stringify(['organizationId', 'role', 'userId'])
    || value.schema !== 'raibitserver.production-evidence-auth/v1' || typeof value.user?.id !== 'string'
    || value.memberships !== undefined || !membership || membership.userId !== value.user.id
    || typeof membership.organizationId !== 'string' || typeof membership.role !== 'string' || !/^(owner|admin)$/i.test(membership.role)) fail('invalid_evidence_operator_membership');
  return Object.freeze({ userId: value.user.id, organizationId: membership.organizationId, role: membership.role });
}

export async function createAuthenticatedEvidenceClient({ runtimeRef, secretRefs, runId, runDirectory, executeFile, clock = () => new Date() }) {
  validRuntimeRef(runtimeRef);
  if (typeof executeFile !== 'function' || !path.isAbsolute(runDirectory) || typeof runId !== 'string' || !KUBE_LABEL_VALUE.test(runId) || !runId) fail('invalid_authenticated_client_input');
  const credentials = validateEvidenceOperatorCredentials(secretRefs, runtimeRef);
  const discovered = await discoverApiTarget(runtimeRef, executeFile);
  const apiTarget = { ...discovered, releaseName: runtimeRef.releaseName };
  const name = clientName(runId);
  const workDirectory = path.join(runDirectory, 'work');
  const manifestPath = path.join(workDirectory, `${name}.json`);
  await mkdir(workDirectory, { recursive: true, mode: 0o700 });
  await writeFile(manifestPath, `${JSON.stringify(manifestFor({ name, runId, credentials, apiTarget }))}\n`, { flag: 'wx', mode: 0o600 });
  const policyName = `${name}-egress`;
  try {
    await kubectl(executeFile, ['apply', '-f', manifestPath], 'authenticated_client_apply_failed');
    await kubectl(executeFile, ['wait', '--for=condition=Ready', `pod/${name}`, '-n', credentials.namespace, '--timeout=60s'], 'authenticated_client_not_ready', 65_000);
    const [pod, policy, logResult] = await Promise.all([
      readPod(executeFile, credentials.namespace, name, 'authenticated_client_not_ready'),
      readPolicy(executeFile, credentials.namespace, policyName, 'authenticated_client_not_ready'),
      kubectl(executeFile, ['logs', name, '-n', credentials.namespace, '--container=client', '--tail=1'], 'authenticated_client_auth_failed'),
    ]);
    if (pod.name !== name || pod.namespace !== credentials.namespace || pod.runId !== runId || !pod.uid || !pod.ready) fail('authenticated_client_not_ready');
    if (policy.name !== policyName || policy.namespace !== credentials.namespace || policy.runId !== runId || !policy.uid) fail('authenticated_client_not_ready');
    const auth = safeAuthProjection(parseJson(logResult.stdout.trim(), 'authenticated_client_auth_failed'));
    const expiresAt = new Date(Date.parse(nowIso(clock)) + 10 * 60_000).toISOString();
    const descriptor = Object.freeze({ schema: 'raibitserver.production-evidence-client/v1', namespace: credentials.namespace, podName: name, podUid: pod.uid,
      apiServiceName: apiTarget.serviceName, apiServiceUid: apiTarget.serviceUid, port: 3000, expiresAt });
    const cleanupInventory = Object.freeze([
      Object.freeze({ type: 'kubernetes', apiVersion: 'v1', kind: 'Pod', namespace: credentials.namespace, name, uid: pod.uid, labels: Object.freeze({ [RUN_LABEL]: runId }) }),
      Object.freeze({ type: 'kubernetes', apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', namespace: credentials.namespace, name: policyName, uid: policy.uid, labels: Object.freeze({ [RUN_LABEL]: runId }) }),
    ]);
    return Object.freeze({ descriptor, auth, cleanupInventory });
  } catch (error) {
    if (!(await cleanupPartialClient(executeFile, credentials.namespace, name, policyName, runId))) fail('authenticated_client_partial_cleanup_failed');
    throw error;
  } finally { await rm(manifestPath, { force: true }); }
}

function validateRequest(options) {
  const allowedKeys = ['descriptor', 'runId', 'method', 'path', 'body', 'executeFile', 'clock'];
  if (!options || Object.keys(options).some(key => !allowedKeys.includes(key))) fail('invalid_authenticated_request');
  const { method, path: requestPath, body } = options;
  if (typeof method !== 'string' || typeof requestPath !== 'string' || requestPath.length > 2048
    || !requestPath.startsWith('/api/') || requestPath.includes('://') || requestPath.includes('..') || requestPath.includes('\\')
    || /%2e|%2f|%5c|[\r\n#]/i.test(requestPath) || !ROUTES.some(([verb, pattern]) => verb === method && pattern.test(requestPath))) fail('invalid_authenticated_request');
  if (body !== undefined && sensitiveValue(body)) fail('invalid_authenticated_request');
}
function sensitiveValue(value) {
  if (Array.isArray(value)) return value.some(sensitiveValue);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => /token|secret|password|credential|authorization|cookie|api.?key|private.?key/i.test(key) || sensitiveValue(child));
}
function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/token|secret|password|credential|authorization|cookie|api.?key|private.?key/i.test(key)).map(([key, child]) => [key, sanitize(child)]));
}
function validateDescriptor(descriptor, clock) {
  const keys = ['schema', 'namespace', 'podName', 'podUid', 'apiServiceName', 'apiServiceUid', 'port', 'expiresAt'];
  if (!descriptor || Object.keys(descriptor).length !== keys.length || keys.some(key => !Object.hasOwn(descriptor, key))
    || descriptor.schema !== 'raibitserver.production-evidence-client/v1' || !DNS_LABEL.test(descriptor.namespace ?? '')
    || !DNS_LABEL.test(descriptor.podName ?? '') || !DNS_LABEL.test(descriptor.apiServiceName ?? '') || typeof descriptor.podUid !== 'string'
    || typeof descriptor.apiServiceUid !== 'string' || descriptor.port !== 3000 || !Number.isFinite(Date.parse(descriptor.expiresAt))) fail('invalid_authenticated_client_descriptor');
  if (Date.parse(nowIso(clock)) >= Date.parse(descriptor.expiresAt)) fail('authenticated_client_expired');
}
function assertNoOutputLeak(text) {
  if (/Bearer\s+\S+|set-cookie|(?:^|[.])[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/i.test(text)) fail('authenticated_client_output_leak');
}
function assertSafeResponse(value, key = '') {
  try { assertRedacted(value); }
  catch (error) { if (error instanceof EvidenceError && error.reason === 'redaction') fail('authenticated_client_output_leak'); throw error; }
  if (typeof value === 'string' && /^[A-Za-z0-9_~+/.=-]{24,}$/.test(value)
    && !/(?:id|uid|digest|sha|hash|checksum|cursor|image|url|domain|path|name|slug)$/i.test(key)) fail('authenticated_client_output_leak');
  if (Array.isArray(value)) value.forEach(item => assertSafeResponse(item, key));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([childKey, child]) => assertSafeResponse(child, childKey));
}

export async function executeAuthenticatedEvidenceRequest(options) {
  validateRequest(options);
  const { descriptor, runId, method, path: requestPath, body, executeFile, clock = () => new Date() } = options;
  validateDescriptor(descriptor, clock);
  if (typeof executeFile !== 'function' || typeof runId !== 'string') fail('invalid_authenticated_request');
  const [pod, service] = await Promise.all([
    readPod(executeFile, descriptor.namespace, descriptor.podName, 'authenticated_client_revalidation_failed'),
    readService(executeFile, descriptor.namespace, descriptor.apiServiceName, 'authenticated_client_revalidation_failed'),
  ]);
  const releaseName = service.releaseName;
  if (!DNS_LABEL.test(releaseName ?? '')) fail('authenticated_client_identity_mismatch');
  let target;
  try { target = await discoverApiTarget({ namespace: descriptor.namespace, releaseName }, executeFile); }
  catch (error) { if (error instanceof EvidenceClientError) fail('authenticated_client_identity_mismatch'); throw error; }
  if (pod.uid !== descriptor.podUid || pod.runId !== runId || !pod.ready
    || service.uid !== descriptor.apiServiceUid || service.name !== descriptor.apiServiceName
    || target.serviceUid !== descriptor.apiServiceUid || target.serviceName !== descriptor.apiServiceName
    || service.projection !== target.serviceProjection) fail('authenticated_client_identity_mismatch');
  const host = `${descriptor.apiServiceName}.${descriptor.namespace}.svc`;
  const encodedBody = body === undefined ? '' : Buffer.from(JSON.stringify(body)).toString('base64url');
  const result = await kubectl(executeFile, ['exec', '-n', descriptor.namespace, descriptor.podName, '--container=client', '--', 'node', '/session/request.cjs', method, requestPath, host, encodedBody], 'authenticated_client_request_failed', 25_000);
  assertNoOutputLeak(result.stdout); assertNoOutputLeak(result.stderr);
  if (Buffer.byteLength(result.stdout) > 1024 * 1024 || Buffer.byteLength(result.stderr) > 64 * 1024) fail('authenticated_client_output_limit');
  const response = parseJson(result.stdout.trim(), 'authenticated_client_request_failed');
  if (!Number.isInteger(response?.statusCode) || response.statusCode < 100 || response.statusCode > 599 || !Object.hasOwn(response, 'body')) fail('authenticated_client_request_failed');
  const safeBody = sanitize(response.body);
  assertSafeResponse(safeBody);
  return Object.freeze({ statusCode: response.statusCode, body: safeBody });
}

async function cleanupPartialClient(executeFile, namespace, name, policyName, runId) {
  try {
    const refs = [['pod', name], ['networkpolicy', policyName]];
    const inspected = await Promise.all(refs.map(([kind, objectName]) => inspectMetadata(executeFile, kind, namespace, objectName)));
    const targets = [];
    for (let index = 0; index < refs.length; index++) {
      if (!inspected[index]) continue;
      if (inspected[index].namespace !== namespace || inspected[index].name !== refs[index][1] || inspected[index].runId !== runId) return false;
      targets.push(`${refs[index][0]}/${refs[index][1]}`);
    }
    if (targets.length) {
      const deleted = await executeFile('kubectl', ['delete', ...targets, '-n', namespace, '--ignore-not-found=true', '--wait=true', '--timeout=30s'], { timeoutMs: 35_000 });
      if (deleted?.exitCode !== 0) return false;
    }
    const checks = await Promise.all(refs.map(([kind, objectName]) => inspectMetadata(executeFile, kind, namespace, objectName)));
    return checks.every(result => result === null);
  } catch (error) { if (error instanceof Error) return false; throw error; }
}
