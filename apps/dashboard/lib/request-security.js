export const SESSION_COOKIE_NAME = 'raibitserver_session';
export const GITHUB_INSTALL_STATE_COOKIE_NAME = 'raibitserver_github_install_state';
export const GITHUB_OAUTH_STATE_COOKIE_NAME = 'raibitserver_github_oauth_state';
export const GITHUB_OAUTH_VERIFIER_COOKIE_NAME = 'raibitserver_github_oauth_verifier';

const BROWSER_SECRET_KEYS = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'idtoken',
  'jwt',
]);
const MAX_SESSION_TOKEN_BYTES = 4096;

export function sessionCookieOptions(env = process.env) {
  const configuredSecure = env.RAIBITSERVER_SESSION_COOKIE_SECURE;
  const normalizedSecure = configuredSecure?.toLowerCase();
  const secure = env.NODE_ENV === 'production'
    ? true
    : normalizedSecure === 'true';
  const configuredMaxAge = Number.parseInt(env.RAIBITSERVER_SESSION_MAX_AGE_SECONDS || '', 10);
  const maxAge = Number.isFinite(configuredMaxAge)
    ? Math.min(Math.max(configuredMaxAge, 300), 604_800)
    : 28_800;
  // User workloads are sibling hosts under the same base domain. A Domain
  // attribute would send this bearer-token cookie to tenant-controlled apps.
  return { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge };
}

export function githubInstallStateCookieOptions(env = process.env) {
  const { httpOnly, sameSite, secure } = sessionCookieOptions(env);
  return {
    httpOnly,
    sameSite,
    secure,
    path: '/github/callback',
    maxAge: 7 * 24 * 60 * 60,
  };
}

export function githubOAuthCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    path: '/api/control/auth/github/callback',
    maxAge: 600,
  };
}

export function isGitHubOAuthState(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

export function isGitHubOAuthCodeVerifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

export function githubOAuthAuthorizeHref(value, expected = {}) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    const allowedKeys = new Set(['client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method']);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.pathname !== '/login/oauth/authorize' || url.username || url.password || url.hash) return null;
    const queryKeys = [...url.searchParams.keys()];
    if (queryKeys.length !== allowedKeys.size || new Set(queryKeys).size !== allowedKeys.size || queryKeys.some((key) => !allowedKeys.has(key))) return null;
    if (!/^[A-Za-z0-9._-]{1,255}$/.test(url.searchParams.get('client_id') || '')) return null;
    if (url.searchParams.get('state') !== expected.state || url.searchParams.get('redirect_uri') !== expected.redirectUri) return null;
    if (url.searchParams.get('code_challenge') !== expected.codeChallenge || url.searchParams.get('code_challenge_method') !== 'S256') return null;
    const scopes = new Set((url.searchParams.get('scope') || '').split(/\s+/).filter(Boolean));
    if (scopes.size !== 2 || !scopes.has('read:user') || !scopes.has('user:email')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function configuredConsoleHref(value, fallback = '/console') {
  return parseConsoleUrl(value)?.toString() || safeDashboardPath(fallback);
}

export function consoleOriginHref(value, path, fallback = path) {
  const consoleUrl = parseConsoleUrl(value);
  if (!consoleUrl || !isSafeDashboardPath(path)) return safeDashboardPath(fallback);
  return new URL(path, consoleUrl.origin).toString();
}

export function publicHostnameForConsole(value) {
  const hostname = parseConsoleUrl(value)?.hostname.toLowerCase().replace(/\.$/, '') || '';
  return hostname.startsWith('console.') && hostname.length > 'console.'.length
    ? hostname.slice('console.'.length)
    : null;
}

function parseConsoleUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const candidate = new URL(value);
    if (!['http:', 'https:'].includes(candidate.protocol)) return null;
    if (candidate.username || candidate.password || candidate.search || candidate.hash) return null;
    return candidate;
  } catch {
    return null;
  }
}

function safeDashboardPath(value) {
  return isSafeDashboardPath(value) ? value : '/console';
}

function isSafeDashboardPath(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\');
}

export function isSameOriginMutation(requestUrl, origin, referer) {
  const expectedOrigin = new URL(requestUrl).origin;
  if (origin) return parseOrigin(origin) === expectedOrigin;
  return Boolean(referer) && parseOrigin(referer) === expectedOrigin;
}

export function dashboardRequestUrl(requestUrl, { host, forwardedProto, configuredOrigin } = {}) {
  const request = new URL(requestUrl);
  const configured = parseConfiguredOrigin(configuredOrigin);
  if (configured) {
    const publicOrigin = new URL(configured);
    request.protocol = publicOrigin.protocol;
    request.hostname = publicOrigin.hostname;
    request.port = publicOrigin.port;
    request.username = '';
    request.password = '';
    return request.toString();
  }

  const publicHost = parseHost(host);
  if (!publicHost) return request.toString();
  const protocol = forwardedProto === 'https' || forwardedProto === 'http'
    ? `${forwardedProto}:`
    : request.protocol;
  request.protocol = protocol;
  request.hostname = publicHost.hostname;
  request.port = publicHost.port;
  return request.toString();
}

export function safeReturnPath(requestUrl, requestedPath, referer) {
  if (requestedPath && requestedPath.startsWith('/') && !requestedPath.startsWith('//') && !requestedPath.includes('\\')) {
    try {
      const request = new URL(requestUrl);
      const candidate = new URL(requestedPath, request);
      if (candidate.origin === request.origin && !candidate.pathname.startsWith('/api/control')) {
        return `${candidate.pathname}${candidate.search}${candidate.hash}`;
      }
    } catch {
      // Fall through to the validated Referer or dashboard root.
    }
  }
  if (referer) {
    try {
      const request = new URL(requestUrl);
      const candidate = new URL(referer);
      if (candidate.origin === request.origin && !candidate.pathname.startsWith('/api/control')) {
        return `${candidate.pathname}${candidate.search}${candidate.hash}`;
      }
    } catch {
      // Fall through to the dashboard root for malformed client input.
    }
  }
  return '/';
}

export function projectCreatePayloadFromForm(body = {}) {
  const name = formText(body, 'name');
  if (!name) throw boundaryError('invalid_form_body');

  const slug = formText(body, 'slug');
  const type = allowedFormValue(body, 'type', ['web', 'private', 'worker', 'cron', 'job'], 'web');
  const sourceType = allowedFormValue(body, 'sourceType', ['github', 'image', 'local'], 'github');
  const serviceName = formText(body, 'serviceName') || type;
  const database = allowedFormValue(body, 'database', ['none', 'postgresql', 'mysql', 'mongodb'], 'none');
  const cache = allowedFormValue(body, 'cache', ['none', 'redis', 'valkey'], 'none');
  const resources = [
    ...(database === 'none' ? [] : [{ name: database, type: 'database', engine: database }]),
    ...(cache === 'none' ? [] : [{ name: cache, type: 'cache', engine: cache }]),
  ];
  const service = {
    name: serviceName,
    type,
    sourceType,
    buildMode: sourceType === 'image' ? 'prebuilt-image' : sourceType === 'local' ? 'dockerfile' : 'auto',
    ...optionalFormFields(body, sourceType === 'image'
      ? ['image']
      : ['repoUrl', 'branch', 'dockerfilePath', 'buildContext']),
    attachedResources: resources.map((resource) => resource.name),
  };
  return {
    name,
    ...(slug ? { slug } : {}),
    services: [service],
    resources,
  };
}

export function environmentPayloadFromForm(body = {}) {
  const key = formText(body, 'key');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw boundaryError('invalid_form_body');
  const rawValue = body && typeof body === 'object' ? body.value : undefined;
  if (typeof rawValue !== 'string') throw boundaryError('invalid_form_body');
  return {
    entries: [{ key, value: rawValue, isSecret: formBoolean(body, 'isSecret') }],
    source: 'dashboard',
  };
}

export function environmentFilePayloadFromForm(body = {}) {
  const content = body && typeof body === 'object' ? body.content : undefined;
  if (typeof content !== 'string' || !content.trim()) throw boundaryError('invalid_form_body');
  return { content, filename: '.env' };
}

export function formMutationMethod(requestMethod, body = {}) {
	const method = String(requestMethod || '').toUpperCase();
	if (method !== 'POST') return method;
	const override = typeof body._method === 'string' ? body._method.trim().toUpperCase() : '';
	if (!override) return method;
	if (!['PATCH', 'DELETE'].includes(override)) throw boundaryError('invalid_form_method');
	return override;
}

export function resourceRecoveryPayloadFromForm(path, method, body = {}) {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
	const normalized = { ...body };
	const isCreate = method === 'POST' && /^\/resources\/[^/]+\/backups$/.test(path);
	const isRestore = method === 'POST' && /^\/backups\/[^/]+\/restores$/.test(path);
	const isDelete = method === 'DELETE' && /^\/backups\/[^/]+$/.test(path);
	if ((isCreate || isRestore) && normalized.formatVersion === '1') normalized.formatVersion = 1;
	if (isDelete && normalized.confirmed === 'true') normalized.confirmed = true;
	return normalized;
}

export function withFlashMessage(requestUrl, returnPath, kind, value) {
	const safePath = safeReturnPath(requestUrl, returnPath, null);
	const request = new URL(requestUrl);
	const target = new URL(safePath, request);
	const parameter = kind === 'notice' ? 'notice' : 'error';
	const code = typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(value) ? value : 'request_failed';
	target.searchParams.delete(parameter === 'notice' ? 'error' : 'notice');
	target.searchParams.set(parameter, code);
	return `${target.pathname}${target.search}${target.hash}`;
}

export function publicUpstreamErrorCode(payload, status) {
	for (const candidate of [payload?.error, payload?.message]) {
		if (
			typeof candidate === 'string'
			&& /^[A-Za-z0-9_.:-]{1,80}$/.test(candidate)
			&& !/(?:^|[_.:-])(?:secret|password|passwd|token|credential|api[_.:-]?key|private[_.:-]?key)(?:$|[_.:-])/i.test(candidate)
		) return candidate;
	}
	return `request_failed_${Number.isInteger(status) ? status : 500}`;
}

export function upstreamPath(segments) {
  return `/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
}

export function extractSessionToken(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  for (const key of ['token', 'accessToken', 'access_token', 'sessionToken', 'session_token']) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0 && new TextEncoder().encode(value).byteLength <= MAX_SESSION_TOKEN_BYTES) {
      return value;
    }
  }
  return null;
}

export function browserSafePayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const output = Array.isArray(payload) ? [] : {};
  const pending = [{ source: payload, target: output }];
  while (pending.length) {
    const { source, target } = pending.pop();
    for (const key of Object.keys(source)) {
      if (BROWSER_SECRET_KEYS.has(normalizeSecretKey(key))) continue;
      const value = source[key];
      if (value && typeof value === 'object') {
        const child = Array.isArray(value) ? [] : {};
        defineValue(target, key, child);
        pending.push({ source: value, target: child });
      } else {
        defineValue(target, key, value);
      }
    }
  }
  return output;
}

export async function fetchWithInitialResponseTimeout(fetcher, input, init = {}, timeoutMs = 10_000, clientSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const onClientAbort = () => controller.abort(clientSignal?.reason);
  if (clientSignal?.aborted) onClientAbort();
  else clientSignal?.addEventListener('abort', onClientAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(boundaryError('control_plane_timeout'));
  }, positiveInteger(timeoutMs, 10_000));
  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw boundaryError('control_plane_timeout');
    throw error;
  } finally {
    clearTimeout(timeout);
    clientSignal?.removeEventListener('abort', onClientAbort);
  }
}

export async function readBoundedBody(stream, options = {}) {
  const maxBytes = positiveInteger(options.maxBytes, 1_048_576);
  const timeoutMs = positiveInteger(options.timeoutMs, 15_000);
  const tooLargeCode = options.tooLargeCode || 'body_too_large';
  const timeoutCode = options.timeoutCode || 'body_timeout';
  const declaredLength = parseDeclaredLength(options.declaredLength);
  if (declaredLength !== null && declaredLength > maxBytes) {
    void stream?.cancel(boundaryError(tooLargeCode)).catch(() => {});
    throw boundaryError(tooLargeCode);
  }
  if (!stream) return new Uint8Array();

  const reader = stream.getReader();
  const chunks = [];
  const deadline = Date.now() + timeoutMs;
  let totalBytes = 0;
  try {
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw boundaryError(timeoutCode);
      const { done, value } = await promiseWithTimeout(reader.read(), remainingMs, timeoutCode);
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) throw boundaryError(tooLargeCode);
      chunks.push(chunk);
    }
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  }
  reader.releaseLock();

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function boundedPassThrough(source, options = {}) {
  const maxBytes = positiveInteger(options.maxBytes, 16_777_216);
  const idleTimeoutMs = positiveInteger(options.idleTimeoutMs, 45_000);
  const maxLifetimeMs = positiveInteger(options.maxLifetimeMs, 16 * 60_000);
  const tooLargeCode = options.tooLargeCode || 'response_too_large';
  const timeoutCode = options.timeoutCode || 'response_timeout';
  if (!source) return new ReadableStream({ start(controller) { controller.close(); } });

  const reader = source.getReader();
  const startedAt = Date.now();
  let totalBytes = 0;
  let finished = false;
  let activeController;
  const preAborted = Boolean(options.signal?.aborted);
  const cleanup = () => options.signal?.removeEventListener('abort', onAbort);
  const stopWithError = (controller, error) => {
    if (finished) return;
    finished = true;
    cleanup();
    void reader.cancel(error).catch(() => {});
    controller.error(error);
  };
  const onAbort = () => stopWithError(activeController, boundaryError('client_aborted'));

  if (!preAborted) options.signal?.addEventListener('abort', onAbort, { once: true });

  return new ReadableStream({
    start(controller) {
      activeController = controller;
      if (preAborted) stopWithError(controller, boundaryError('client_aborted'));
    },
    async pull(controller) {
      if (finished) return;
      const lifetimeRemaining = maxLifetimeMs - (Date.now() - startedAt);
      if (lifetimeRemaining <= 0) return stopWithError(controller, boundaryError(timeoutCode));
      try {
        const { done, value } = await promiseWithTimeout(reader.read(), Math.min(idleTimeoutMs, lifetimeRemaining), timeoutCode);
        if (done) {
          finished = true;
          cleanup();
          controller.close();
          return;
        }
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        totalBytes += chunk.byteLength;
        if (totalBytes > maxBytes) return stopWithError(controller, boundaryError(tooLargeCode));
        controller.enqueue(chunk);
      } catch (error) {
        stopWithError(controller, error);
      }
    },
    cancel(reason) {
      if (finished) return;
      finished = true;
      cleanup();
      return reader.cancel(reason);
    },
  });
}

export function responseStatusAllowsBody(status) {
  return status !== 204 && status !== 205 && status !== 304;
}

export function dashboardSecurityHeaders({ nonce, production = false, https = false } = {}) {
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(nonce)) throw boundaryError('invalid_csp_nonce');
  const scriptPolicy = [`'self'`, `'nonce-${nonce}'`];
  scriptPolicy.push(production ? `'strict-dynamic'` : `'unsafe-eval'`);
  const directives = [
    `default-src 'self'`,
    `script-src ${scriptPolicy.join(' ')}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: https://avatars.githubusercontent.com`,
    `font-src 'self'`,
    `connect-src 'self'${production ? '' : ' ws: wss:'}`,
    `worker-src 'self' blob:`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
  ];
  if (production && https) directives.push('upgrade-insecure-requests');
  return {
    'content-security-policy': directives.join('; '),
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin',
    'cache-control': 'no-store',
    ...(production && https ? { 'strict-transport-security': 'max-age=31536000' } : {}),
  };
}

function parseOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function parseConfiguredOrigin(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const candidate = new URL(value);
    if (!['http:', 'https:'].includes(candidate.protocol)) return null;
    if (candidate.username || candidate.password || candidate.pathname !== '/' || candidate.search || candidate.hash) return null;
    return candidate.origin;
  } catch {
    return null;
  }
}

function parseHost(value) {
  if (typeof value !== 'string' || !value || value.length > 300 || /[\s,\\/@?#]/.test(value)) return null;
  try {
    const candidate = new URL(`http://${value}`);
    if (candidate.username || candidate.password || candidate.pathname !== '/' || candidate.search || candidate.hash) return null;
    return { hostname: candidate.hostname, port: candidate.port };
  } catch {
    return null;
  }
}

function normalizeSecretKey(value) {
  return String(value).replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function formText(body, key) {
  const value = body && typeof body === 'object' ? body[key] : undefined;
  return typeof value === 'string' ? value.trim() : '';
}

function allowedFormValue(body, key, allowed, fallback) {
  const value = formText(body, key).toLowerCase();
  return allowed.includes(value) ? value : fallback;
}

function formBoolean(body, key) {
  const value = formText(body, key).toLowerCase();
  return ['1', 'true', 'on', 'yes'].includes(value);
}

function optionalFormFields(body, keys) {
  return Object.fromEntries(keys.flatMap((key) => {
    const value = formText(body, key);
    return value ? [[key, value]] : [];
  }));
}

function defineValue(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function parseDeclaredLength(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function promiseWithTimeout(promise, timeoutMs, code) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(boundaryError(code)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function boundaryError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
