import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_COOKIE_NAME,
	boundedPassThrough,
	browserSafePayload,
	configuredConsoleHref,
	consoleOriginHref,
	dashboardRequestUrl,
	dashboardSecurityHeaders,
	environmentFilePayloadFromForm,
	environmentPayloadFromForm,
	extractSessionToken,
	fetchWithInitialResponseTimeout,
  formMutationMethod,
  isSameOriginMutation,
	projectCreatePayloadFromForm,
	publicHostnameForConsole,
	readBoundedBody,
	responseStatusAllowsBody,
  sessionCookieOptions,
  safeReturnPath,
	withFlashMessage,
  upstreamPath,
} from './request-security.js';

test('session cookie is host-only, HttpOnly and only Secure when configured or in production', () => {
  assert.equal(SESSION_COOKIE_NAME, 'raibitserver_session');
  assert.deepEqual(sessionCookieOptions({ NODE_ENV: 'development' }), {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    path: '/',
    maxAge: 28_800,
  });
  assert.equal(sessionCookieOptions({ NODE_ENV: 'production' }).secure, true);
  assert.equal(sessionCookieOptions({ NODE_ENV: 'production', RAIBITSERVER_SESSION_COOKIE_SECURE: 'false' }).secure, true);
  assert.equal(sessionCookieOptions({ NODE_ENV: 'development', RAIBITSERVER_SESSION_COOKIE_SECURE: 'true' }).secure, true);
  assert.equal(sessionCookieOptions({ NODE_ENV: 'production', RAIBITSERVER_COOKIE_DOMAIN: '.raibit.kr' }).domain, undefined);
});

test('console navigation accepts only credential-free HTTP origins and derives the public apex safely', () => {
  const configured = 'https://console.raibit.kr/console';
  assert.equal(configuredConsoleHref(configured), configured);
  assert.equal(consoleOriginHref(configured, '/login?mode=signup'), 'https://console.raibit.kr/login?mode=signup');
  assert.equal(consoleOriginHref(configured, '/github'), 'https://console.raibit.kr/github');
  assert.equal(publicHostnameForConsole(configured), 'raibit.kr');
  assert.equal(configuredConsoleHref('javascript:alert(1)'), '/console');
  assert.equal(consoleOriginHref('https://user:secret@console.raibit.kr/console', '/login'), '/login');
  assert.equal(consoleOriginHref(configured, '//attacker.example'), '/console');
  assert.equal(publicHostnameForConsole('https://dashboard.example.test/console'), null);
});

test('mutation origin validation requires an exact same-origin Origin or Referer', () => {
  const requestUrl = 'https://console.example.test/api/control/projects';
  assert.equal(isSameOriginMutation(requestUrl, 'https://console.example.test', null), true);
  assert.equal(isSameOriginMutation(requestUrl, null, 'https://console.example.test/projects'), true);
  assert.equal(isSameOriginMutation(requestUrl, 'https://evil.example.test', 'https://console.example.test/projects'), false);
  assert.equal(isSameOriginMutation(requestUrl, null, null), false);
  assert.equal(isSameOriginMutation(requestUrl, 'https://console.example.test.evil.test', null), false);
});

test('browser request URL uses a validated public Host instead of an internal standalone origin', () => {
	assert.equal(
		dashboardRequestUrl('http://localhost:3000/api/control/auth/login', { host: '127.0.0.1:39100' }),
		'http://127.0.0.1:39100/api/control/auth/login',
	);
	assert.equal(
		dashboardRequestUrl('http://dashboard:3000/api/control/auth/login', { host: 'console.example.test', forwardedProto: 'https' }),
		'https://console.example.test/api/control/auth/login',
	);
	assert.equal(
		dashboardRequestUrl('http://dashboard:3000/api/control/auth/login', {
			host: 'dashboard.internal:3000',
			forwardedProto: 'https',
			configuredOrigin: 'https://console.example.test',
		}),
		'https://console.example.test/api/control/auth/login',
	);
	assert.equal(
		dashboardRequestUrl('https://console.example.test/api/control/auth/login', { host: 'evil.test/path' }),
		'https://console.example.test/api/control/auth/login',
	);
	assert.equal(
		dashboardRequestUrl('http://dashboard:3000//evil.test/path', { configuredOrigin: 'https://console.example.test' }),
		'https://console.example.test//evil.test/path',
		'a double-slash request path must not override the configured dashboard origin',
	);
});

test('proxy path encodes every dynamic segment and return paths cannot leave the dashboard origin', () => {
  assert.equal(upstreamPath(['github', 'repositories', 'owner/repo', 'sync']), '/github/repositories/owner%2Frepo/sync');
  const requestUrl = 'https://console.example.test/api/control/projects';
  assert.equal(safeReturnPath(requestUrl, '/org/acme/projects', null), '/org/acme/projects');
  assert.equal(safeReturnPath(requestUrl, 'https://evil.test/', 'https://console.example.test/login'), '/login');
  assert.equal(safeReturnPath(requestUrl, '//evil.test/', null), '/');
  assert.equal(safeReturnPath(requestUrl, '/\\evil.test/', null), '/');
});

test('flash redirects stay same-origin and expose only bounded safe status codes', () => {
	const requestUrl = 'https://console.example.test/api/control/projects';
	assert.equal(withFlashMessage(requestUrl, '/org/acme/projects?tab=all', 'notice', 'saved'), '/org/acme/projects?tab=all&notice=saved');
	assert.equal(withFlashMessage(requestUrl, '/org/acme/projects?error=old', 'notice', 'saved'), '/org/acme/projects?notice=saved');
	assert.equal(withFlashMessage(requestUrl, '/org/acme/projects?notice=old', 'error', 'request_failed'), '/org/acme/projects?error=request_failed');
	assert.equal(withFlashMessage(requestUrl, '/login', 'error', 'invalid_credentials'), '/login?error=invalid_credentials');
	assert.equal(withFlashMessage(requestUrl, '/login', 'error', '<script>alert(1)</script>'), '/login?error=request_failed');
	assert.equal(withFlashMessage(requestUrl, '//evil.test', 'notice', 'saved'), '/?notice=saved');
});

test('project creation form becomes one atomic desired-state payload', () => {
	assert.deepEqual(projectCreatePayloadFromForm({
		name: 'Browser Gate Project',
		slug: 'browser-gate-project',
		serviceName: 'web',
		type: 'web',
		sourceType: 'image',
		image: 'registry.example.test/browser/gate:1.0.0',
		repoUrl: '',
		branch: 'main',
		dockerfilePath: '',
		buildContext: '.',
		database: 'postgresql',
		cache: 'redis',
	}), {
		name: 'Browser Gate Project',
		slug: 'browser-gate-project',
		services: [{
			name: 'web',
			type: 'web',
			sourceType: 'image',
			buildMode: 'prebuilt-image',
			image: 'registry.example.test/browser/gate:1.0.0',
			attachedResources: ['postgresql', 'redis'],
		}],
		resources: [
			{ name: 'postgresql', type: 'database', engine: 'postgresql' },
			{ name: 'redis', type: 'cache', engine: 'redis' },
		],
	});
	assert.deepEqual(projectCreatePayloadFromForm({
		name: 'Local Worker',
		serviceName: 'worker',
		type: 'worker',
		sourceType: 'local',
		dockerfilePath: 'ops/Dockerfile',
		buildContext: 'ops',
		database: 'none',
		cache: 'none',
	}), {
		name: 'Local Worker',
		services: [{
			name: 'worker',
			type: 'worker',
			sourceType: 'local',
			buildMode: 'dockerfile',
			dockerfilePath: 'ops/Dockerfile',
			buildContext: 'ops',
			attachedResources: [],
		}],
		resources: [],
	});
});

test('environment forms become bounded API payloads without putting secret values in metadata', () => {
	assert.deepEqual(environmentPayloadFromForm({ key: 'API_TOKEN', value: 'secret value', isSecret: 'on' }), {
		entries: [{ key: 'API_TOKEN', value: 'secret value', isSecret: true }],
		source: 'dashboard',
	});
	assert.deepEqual(environmentPayloadFromForm({ key: 'NODE_ENV', value: 'production' }), {
		entries: [{ key: 'NODE_ENV', value: 'production', isSecret: false }],
		source: 'dashboard',
	});
	assert.deepEqual(environmentFilePayloadFromForm({ content: 'API_TOKEN=secret\nNODE_ENV=production' }), {
		content: 'API_TOKEN=secret\nNODE_ENV=production',
		filename: '.env',
	});
	assert.throws(() => environmentPayloadFromForm({ key: 'INVALID-KEY', value: 'value' }), (error) => error?.code === 'invalid_form_body');
	assert.throws(() => environmentFilePayloadFromForm({ content: '  ' }), (error) => error?.code === 'invalid_form_body');
});

test('HTML forms can safely request only supported mutation methods', () => {
	assert.equal(formMutationMethod('POST', {}), 'POST');
	assert.equal(formMutationMethod('POST', { _method: 'patch' }), 'PATCH');
	assert.equal(formMutationMethod('POST', { _method: 'DELETE' }), 'DELETE');
	assert.equal(formMutationMethod('PATCH', { _method: 'DELETE' }), 'PATCH');
	assert.throws(
		() => formMutationMethod('POST', { _method: 'PUT' }),
		(error) => error?.code === 'invalid_form_method',
	);
});

test('auth credentials are extracted for HttpOnly storage and removed from browser JSON', () => {
	const payload = {
		user: { id: 'user-1' },
		token: 'session-secret',
		access_token: 'access-secret',
		refreshToken: 'refresh-secret',
		nested: [{ sessionToken: 'nested-secret', tokenFingerprint: 'public-fingerprint' }],
		csrfToken: 'browser-required',
	};
	assert.equal(extractSessionToken(payload), 'session-secret');
	assert.equal(extractSessionToken({ accessToken: 'access-secret' }), 'access-secret');
	assert.equal(extractSessionToken({ session_token: 'session-secret' }), 'session-secret');
	assert.equal(extractSessionToken({ refreshToken: 'refresh-only' }), null);
	assert.equal(extractSessionToken({ token: 'x'.repeat(4097) }), null);
	assert.deepEqual(browserSafePayload(payload), {
		user: { id: 'user-1' },
		nested: [{ tokenFingerprint: 'public-fingerprint' }],
		csrfToken: 'browser-required',
	});
	assert.equal(payload.token, 'session-secret', 'sanitizing a response must not mutate the upstream payload');
});

test('bounded body reads enforce declared and streamed byte limits', async () => {
	const accepted = await readBoundedBody(new Response('hello').body, {
		maxBytes: 5,
		timeoutMs: 1_000,
		declaredLength: '5',
	});
	assert.equal(new TextDecoder().decode(accepted), 'hello');

	await assert.rejects(
		readBoundedBody(new Response('ignored').body, {
			maxBytes: 5,
			timeoutMs: 1_000,
			declaredLength: '7',
			tooLargeCode: 'response_too_large',
		}),
		(error) => error?.code === 'response_too_large',
	);
	await assert.rejects(
		readBoundedBody(new Response('abcdef').body, {
			maxBytes: 5,
			timeoutMs: 1_000,
			tooLargeCode: 'response_too_large',
		}),
		(error) => error?.code === 'response_too_large',
	);
});

test('upstream connection timeout aborts a stalled fetch with a public error code', async () => {
	const stalledFetch = (_input, init) => new Promise((_resolve, reject) => {
		init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
	});
	await assert.rejects(
		fetchWithInitialResponseTimeout(stalledFetch, 'https://api.example.test/health', {}, 10),
		(error) => error?.code === 'control_plane_timeout',
	);
});

test('SSE pass-through streams incrementally and terminates at its byte boundary', async () => {
	const accepted = boundedPassThrough(new Response('hello').body, {
		maxBytes: 5,
		idleTimeoutMs: 1_000,
		maxLifetimeMs: 1_000,
	});
	assert.equal(await new Response(accepted).text(), 'hello');

	const rejected = boundedPassThrough(new Response('abcdef').body, {
		maxBytes: 5,
		idleTimeoutMs: 1_000,
		maxLifetimeMs: 1_000,
	});
	await assert.rejects(new Response(rejected).arrayBuffer(), (error) => error?.code === 'response_too_large');

	const abort = new AbortController();
	abort.abort();
	const aborted = boundedPassThrough(new Response('unreachable').body, {
		maxBytes: 20,
		idleTimeoutMs: 1_000,
		maxLifetimeMs: 1_000,
		signal: abort.signal,
	});
	await assert.rejects(
		Promise.race([
			new Response(aborted).arrayBuffer(),
			new Promise((_resolve, reject) => setTimeout(() => reject(new Error('stream_did_not_abort')), 100)),
		]),
		(error) => error?.code === 'client_aborted',
	);
});

test('HTTP statuses that forbid response bodies remain bodyless', () => {
	assert.equal(responseStatusAllowsBody(200), true);
	assert.equal(responseStatusAllowsBody(204), false);
	assert.equal(responseStatusAllowsBody(205), false);
	assert.equal(responseStatusAllowsBody(304), false);
});

test('dashboard security headers use a production nonce and gate HSTS on HTTPS', () => {
	const headers = dashboardSecurityHeaders({ nonce: 'nonce-value', production: true, https: true });
	assert.match(headers['content-security-policy'], /script-src 'self' 'nonce-nonce-value' 'strict-dynamic'/);
	assert.doesNotMatch(headers['content-security-policy'], /script-src[^;]*'unsafe-inline'/);
	assert.match(headers['content-security-policy'], /frame-ancestors 'none'/);
	assert.equal(headers['strict-transport-security'], 'max-age=31536000');
	assert.equal(headers['permissions-policy'], 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
	assert.equal(headers['x-content-type-options'], 'nosniff');
	assert.equal(headers['x-frame-options'], 'DENY');

	const httpHeaders = dashboardSecurityHeaders({ nonce: 'dev-nonce', production: true, https: false });
	assert.equal(httpHeaders['strict-transport-security'], undefined);

	const developmentHeaders = dashboardSecurityHeaders({ nonce: 'dev-nonce', production: false, https: false });
	assert.doesNotMatch(developmentHeaders['content-security-policy'], /'strict-dynamic'/);
	assert.match(developmentHeaders['content-security-policy'], /script-src 'self' 'nonce-dev-nonce' 'unsafe-eval'/);
});
