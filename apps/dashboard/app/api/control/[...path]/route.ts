import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { dashboardApiContext } from '../../../../lib/api';
import {
  GITHUB_OAUTH_STATE_COOKIE_NAME,
  GITHUB_OAUTH_VERIFIER_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  boundedPassThrough,
  browserSafePayload,
  dashboardRequestUrl,
  extractSessionToken,
  environmentFilePayloadFromForm,
  environmentPayloadFromForm,
  fetchWithInitialResponseTimeout,
  formMutationMethod,
  githubOAuthAuthorizeHref,
  githubOAuthCookieOptions,
  isGitHubOAuthCodeVerifier,
  isGitHubOAuthState,
  isSameOriginMutation,
  projectCreatePayloadFromForm,
  resourceRecoveryPayloadFromForm,
  publicUpstreamErrorCode,
  readBoundedBody,
  responseStatusAllowsBody,
  safeReturnPath,
  sessionCookieOptions,
  upstreamPath,
  withFlashMessage,
} from '../../../../lib/request-security.js';

const MAX_MUTATION_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 2_097_152;
const MAX_STREAM_BYTES = 16_777_216;
const REQUEST_BODY_TIMEOUT_MS = 10_000;
const UPSTREAM_INITIAL_RESPONSE_TIMEOUT_MS = 10_000;
const UPSTREAM_BODY_TIMEOUT_MS = 15_000;
const STREAM_IDLE_TIMEOUT_MS = 45_000;
const STREAM_MAX_LIFETIME_MS = 16 * 60_000;
const PUBLIC_POST_PATHS = new Set(['/auth/login', '/auth/signup', '/auth/email/verify', '/auth/email/resend', '/auth/password-reset/request', '/auth/password-reset/complete']);
const PUBLIC_GET_PATHS = new Set(['/health', '/auth/github/login', '/auth/github/callback']);

type RouteContext = { params: Promise<{ path: string[] }> | { path: string[] } };

export async function GET(request: NextRequest, routeContext: RouteContext) {
  try {
    return await proxyRequest(request, routeContext, 'GET');
  } catch (error) {
    if (request.nextUrl.pathname === '/api/control/auth/github/callback') {
      return githubOAuthErrorRedirect(request.url, 'github_oauth_unavailable', true);
    }
    throw error;
  }
}

export async function POST(request: NextRequest, routeContext: RouteContext) {
  return proxyRequest(request, routeContext, 'POST');
}

export async function PATCH(request: NextRequest, routeContext: RouteContext) {
  return proxyRequest(request, routeContext, 'PATCH');
}

export async function DELETE(request: NextRequest, routeContext: RouteContext) {
  return proxyRequest(request, routeContext, 'DELETE');
}

async function proxyRequest(request: NextRequest, routeContext: RouteContext, method: string) {
  const params = await routeContext.params;
  const path = upstreamPath(params.path || []);
  const isMutation = method !== 'GET' && method !== 'HEAD';
  const contentType = request.headers.get('content-type') || '';
  const isFormSubmission = isMutation && (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data'));
  const browserRequestUrl = dashboardRequestUrl(request.url, {
    host: request.headers.get('host'),
    forwardedProto: request.headers.get('x-forwarded-proto'),
    configuredOrigin: process.env.RAIBITSERVER_DASHBOARD_ORIGIN,
  });
  let returnPath = safeReturnPath(browserRequestUrl, null, request.headers.get('referer'));
  if (isMutation && !isSameOriginMutation(browserRequestUrl, request.headers.get('origin'), request.headers.get('referer'))) {
    if (isFormSubmission) return formErrorRedirect(browserRequestUrl, returnPath, 'invalid_request_origin');
    return NextResponse.json({ error: 'invalid_request_origin' }, { status: 403 });
  }

  if (method === 'GET' && (path === '/auth/github/login' || path === '/auth/github/callback')) {
    return handleGitHubOAuthRequest(request, browserRequestUrl, path);
  }
  const context = await dashboardApiContext();
  const isPublicPath = method === 'GET' ? PUBLIC_GET_PATHS.has(path) : PUBLIC_POST_PATHS.has(path);
  if (!context.token && !isPublicPath) {
    if (isFormSubmission) return formErrorRedirect(browserRequestUrl, '/login', 'authentication_required');
    return NextResponse.json({ error: 'authentication_required' }, { status: 401 });
  }

  let upstreamMethod = method;
  let body: Record<string, unknown> | undefined;
  if (isMutation) {
    try {
      body = await readMutationBody(request);
      upstreamMethod = isFormSubmission ? formMutationMethod(method, body) : method;
      const requestedReturn = typeof body._returnTo === 'string' ? body._returnTo : null;
      delete body._returnTo;
      delete body._method;
      delete body._confirmProject;
      returnPath = safeReturnPath(browserRequestUrl, requestedReturn, request.headers.get('referer'));
      if (isFormSubmission && upstreamMethod === 'POST' && path === '/projects') body = projectCreatePayloadFromForm(body);
      if (isFormSubmission && upstreamMethod === 'POST' && /\/projects\/[^/]+\/services\/[^/]+\/env$/.test(path)) body = environmentPayloadFromForm(body);
      if (isFormSubmission && upstreamMethod === 'POST' && /\/projects\/[^/]+\/services\/[^/]+\/env-file$/.test(path)) body = environmentFilePayloadFromForm(body);
      if (isFormSubmission) body = resourceRecoveryPayloadFromForm(path, upstreamMethod, body);
      if (isFormSubmission && upstreamMethod === 'POST' && path === '/auth/password-reset/complete') {
        if (body.confirmPassword !== body.newPassword) return formErrorRedirect(browserRequestUrl, returnPath, 'password_confirmation_mismatch');
        delete body.confirmPassword;
      }
    } catch (error) {
      const code = requestBodyErrorCode(error);
      if (isFormSubmission) return formErrorRedirect(browserRequestUrl, returnPath, code);
      return NextResponse.json({ error: code }, { status: requestBodyErrorStatus(code) });
    }
  }

  const query = upstreamMethod === 'GET' ? request.nextUrl.search : '';
  const requestedAccept = request.headers.get('accept') || '';
  let upstream: Response;
  try {
    upstream = await fetchWithInitialResponseTimeout(
      fetch,
      `${context.baseUrl}${path}${query}`,
      {
        method: upstreamMethod,
        headers: {
          ...context.headers,
          accept: requestedAccept.includes('text/event-stream') ? 'text/event-stream' : 'application/json',
          ...(request.headers.get('last-event-id') ? { 'last-event-id': request.headers.get('last-event-id') as string } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        redirect: 'manual',
      },
      UPSTREAM_INITIAL_RESPONSE_TIMEOUT_MS,
      request.signal,
    );
  } catch (error) {
    const code = boundaryErrorCode(error, 'control_plane_unavailable');
    if (isFormSubmission) return formErrorRedirect(browserRequestUrl, returnPath, code);
    return NextResponse.json({ error: code }, { status: code === 'control_plane_timeout' ? 504 : 502 });
  }

  const upstreamContentType = upstream.headers.get('content-type') || 'application/json';
  if (upstreamMethod === 'GET' && upstream.ok && upstreamContentType.toLowerCase().includes('text/event-stream')) {
    if (declaredLengthExceeds(upstream.headers.get('content-length'), MAX_STREAM_BYTES)) {
      void upstream.body?.cancel('response_too_large').catch(() => {});
      return NextResponse.json({ error: 'control_plane_response_too_large' }, { status: 502 });
    }
    return new NextResponse(boundedPassThrough(upstream.body, {
      maxBytes: MAX_STREAM_BYTES,
      idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
      maxLifetimeMs: STREAM_MAX_LIFETIME_MS,
      signal: request.signal,
    }), {
      status: upstream.status,
      headers: {
        'content-type': upstreamContentType,
        'cache-control': 'no-store, no-transform',
        'x-accel-buffering': 'no',
      },
    });
  }

  let responseBytes: Uint8Array;
  try {
    responseBytes = await readBoundedBody(upstream.body, {
      maxBytes: MAX_RESPONSE_BYTES,
      timeoutMs: UPSTREAM_BODY_TIMEOUT_MS,
      declaredLength: upstream.headers.get('content-length'),
      tooLargeCode: 'control_plane_response_too_large',
      timeoutCode: 'control_plane_response_timeout',
    });
  } catch (error) {
    const code = boundaryErrorCode(error, 'invalid_control_plane_response');
    if (isFormSubmission) return formErrorRedirect(browserRequestUrl, returnPath, code);
    return NextResponse.json({ error: code }, { status: code === 'control_plane_response_timeout' ? 504 : 502 });
  }

  const responseText = new TextDecoder().decode(responseBytes);
  const parsed = parseJson(responseText);
  const payload = parsed.payload;
  const safePayload = browserSafePayload(payload);
  if (!upstream.ok) {
    const code = publicUpstreamErrorCode(payload, upstream.status);
    if (isFormSubmission) {
      return formErrorRedirect(browserRequestUrl, returnPath, code);
    }
    const response = NextResponse.json({ error: code }, { status: upstream.status });
    copyRetryAfterHeader(response, upstream.headers.get('retry-after'));
    return response;
  }

  if (isMutation) {
    const successPath = path === '/auth/signup'
      ? signupVerificationPath(body?.email)
      : path === '/auth/password-reset/request'
        ? '/login?mode=reset'
        : path === '/auth/password-reset/complete'
          ? '/login?mode=login'
      : returnPath;
    const successNotice = path === '/auth/password-reset/request'
      ? 'password_reset_requested'
      : path === '/auth/password-reset/complete'
        ? 'password_reset_completed'
        : 'saved';
    const response = isFormSubmission
      ? NextResponse.redirect(new URL(withFlashMessage(browserRequestUrl, successPath, 'notice', successNotice), browserRequestUrl), 303)
      : responseStatusAllowsBody(upstream.status)
        ? NextResponse.json(safePayload ?? {}, { status: upstream.status })
        : new NextResponse(null, { status: upstream.status });
    applySessionCookie(response, path, payload);
    if (path === '/organizations' && payload?.reauthenticationRequired === true) {
      response.cookies.set(SESSION_COOKIE_NAME, '', { ...sessionCookieOptions(), sameSite: 'lax', maxAge: 0 });
    }
    response.headers.set('cache-control', 'no-store');
    copyRetryAfterHeader(response, upstream.headers.get('retry-after'));
    return response;
  }

  if (parsed.valid) {
    return responseStatusAllowsBody(upstream.status)
      ? NextResponse.json(safePayload, {
          status: upstream.status,
          headers: { 'cache-control': 'no-store' },
        })
      : new NextResponse(null, { status: upstream.status, headers: { 'cache-control': 'no-store' } });
  }
  return new NextResponse(ownedArrayBuffer(responseBytes), {
    status: upstream.status,
    headers: { 'content-type': upstreamContentType, 'cache-control': 'no-store' },
  });
}

function copyRetryAfterHeader(response: NextResponse, value: string | null) {
  if (value && /^\d{1,4}$/.test(value) && Number(value) >= 1 && Number(value) <= 3600) response.headers.set('retry-after', value);
}

function formErrorRedirect(requestUrl: string, returnPath: string, code: string) {
  return NextResponse.redirect(new URL(withFlashMessage(requestUrl, returnPath, 'error', code), requestUrl), 303);
}

function applySessionCookie(response: NextResponse, path: string, payload: any) {
  const token = extractSessionToken(payload);
  const cookieOptions = { ...sessionCookieOptions(), sameSite: 'lax' as const };
  if (token) response.cookies.set(SESSION_COOKIE_NAME, token, cookieOptions);
  if (path === '/auth/logout') response.cookies.set(SESSION_COOKIE_NAME, '', { ...cookieOptions, maxAge: 0 });
}

async function handleGitHubOAuthRequest(request: NextRequest, browserRequestUrl: string, path: string) {
  if (path === '/auth/github/login') {
    const codeVerifier = crypto.randomBytes(48).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const redirectUri = new URL('/api/control/auth/github/callback', browserRequestUrl).toString();
    const context = await dashboardApiContext();
    const result = await requestGitHubOAuthJson(context, path, new URLSearchParams({ redirectUri, codeChallenge }), request.signal);
    if (!result.ok) return githubOAuthUpstreamFailure(browserRequestUrl, result);
    const state = result.payload?.state;
    if (!isGitHubOAuthState(state)) return githubOAuthErrorRedirect(browserRequestUrl, 'github_oauth_configuration_invalid');
    const authorizeHref = githubOAuthAuthorizeHref(result.payload?.oauthUrl, { state, redirectUri, codeChallenge });
    if (!authorizeHref) return githubOAuthErrorRedirect(browserRequestUrl, result.payload?.configured === false ? 'github_oauth_not_configured' : 'github_oauth_configuration_invalid');
    const response = NextResponse.redirect(new URL(authorizeHref), 302);
    const cookieOptions = { ...githubOAuthCookieOptions(), sameSite: 'lax' as const };
    response.cookies.set(GITHUB_OAUTH_STATE_COOKIE_NAME, state, cookieOptions);
    response.cookies.set(GITHUB_OAUTH_VERIFIER_COOKIE_NAME, codeVerifier, cookieOptions);
    response.headers.set('cache-control', 'no-store');
    return response;
  }

  const expectedState = request.cookies.get(GITHUB_OAUTH_STATE_COOKIE_NAME)?.value || '';
  const codeVerifier = request.cookies.get(GITHUB_OAUTH_VERIFIER_COOKIE_NAME)?.value || '';
  const returnedState = request.nextUrl.searchParams.get('state') || '';
  if (request.nextUrl.searchParams.getAll('state').length !== 1 || request.nextUrl.searchParams.getAll('code').length > 1
    || request.nextUrl.searchParams.getAll('redirectUri').length > 1 || !oauthStateMatches(expectedState, returnedState) || !isGitHubOAuthCodeVerifier(codeVerifier)) {
    return githubOAuthErrorRedirect(browserRequestUrl, 'github_oauth_state_invalid', true);
  }
  const denied = request.nextUrl.searchParams.has('error');
  if (denied && (request.nextUrl.searchParams.getAll('error').length !== 1 || request.nextUrl.searchParams.get('error') !== 'access_denied' || request.nextUrl.searchParams.has('code'))) {
    return githubOAuthErrorRedirect(browserRequestUrl, 'github_oauth_input_invalid', true);
  }
  const code = request.nextUrl.searchParams.get('code');
  if (!denied && !validOAuthCode(code)) return githubOAuthErrorRedirect(browserRequestUrl, 'github_oauth_code_required', true);
  const redirectUri = request.nextUrl.searchParams.get('redirectUri') ?? new URL('/api/control/auth/github/callback', browserRequestUrl).toString();
  const context = await dashboardApiContext();
  const query = new URLSearchParams({ state: returnedState, codeVerifier, redirectUri });
  if (denied) query.set('error', 'access_denied');
  else if (code !== null) query.set('code', code);
  const result = await requestGitHubOAuthJson(context, path, query, request.signal);
  if (!result.ok) return githubOAuthUpstreamFailure(browserRequestUrl, result, true);
  if (!extractSessionToken(result.payload)) return githubOAuthErrorRedirect(browserRequestUrl, 'github_oauth_session_invalid', true);
  const response = NextResponse.redirect(new URL('/console', browserRequestUrl), 302);
  applySessionCookie(response, path, result.payload);
  clearGitHubOAuthCookies(response);
  response.headers.set('cache-control', 'no-store');
  return response;
}

async function requestGitHubOAuthJson(context: Awaited<ReturnType<typeof dashboardApiContext>>, path: string, query: URLSearchParams, signal: AbortSignal) {
  try {
    const upstream = await fetchWithInitialResponseTimeout(
      fetch,
      `${context.baseUrl}${path}?${query.toString()}`,
      { method: 'GET', headers: { ...context.headers, accept: 'application/json' }, cache: 'no-store', redirect: 'manual' },
      UPSTREAM_INITIAL_RESPONSE_TIMEOUT_MS,
      signal,
    );
    const bytes = await readBoundedBody(upstream.body, {
      maxBytes: MAX_RESPONSE_BYTES,
      timeoutMs: UPSTREAM_BODY_TIMEOUT_MS,
      declaredLength: upstream.headers.get('content-length'),
      tooLargeCode: 'control_plane_response_too_large',
      timeoutCode: 'control_plane_response_timeout',
    });
    const parsed = parseJson(new TextDecoder().decode(bytes));
    if (!parsed.valid || !parsed.payload || typeof parsed.payload !== 'object') return { ok: false as const, error: 'invalid_control_plane_response', payload: null };
    if (!upstream.ok) {
      const retry = upstream.status === 429 ? upstream.headers.get('retry-after') : null;
      const retryAfter = retry && /^[0-9]{1,4}$/.test(retry) && Number(retry) >= 1 && Number(retry) <= 3600 ? Number(retry) : null;
      return { ok: false as const, error: publicUpstreamErrorCode(parsed.payload, upstream.status), payload: null, retryAfter };
    }
    return { ok: true as const, error: '', payload: parsed.payload };
  } catch (error) {
    return { ok: false as const, error: boundaryErrorCode(error, 'control_plane_unavailable'), payload: null };
  }
}

function githubOAuthUpstreamFailure(url: string, result: Awaited<ReturnType<typeof requestGitHubOAuthJson>>, clearCookies = false) {
  const response = githubOAuthErrorRedirect(url, result.error, clearCookies);
  if ('retryAfter' in result && result.retryAfter) response.headers.set('Retry-After', String(result.retryAfter));
  return response;
}

function oauthStateMatches(expected: string, actual: string) {
  if (!isGitHubOAuthState(expected) || !isGitHubOAuthState(actual)) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.byteLength === actualBytes.byteLength && crypto.timingSafeEqual(expectedBytes, actualBytes);
}

function validOAuthCode(value: string | null): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function githubOAuthErrorRedirect(browserRequestUrl: string, code: string, clearCookies = false) {
  const response = NextResponse.redirect(new URL(withFlashMessage(browserRequestUrl, '/login', 'error', code), browserRequestUrl), 302);
  if (clearCookies) clearGitHubOAuthCookies(response);
  response.headers.set('cache-control', 'no-store');
  return response;
}

function clearGitHubOAuthCookies(response: NextResponse) {
  const cookieOptions = { ...githubOAuthCookieOptions(), sameSite: 'lax' as const };
  response.cookies.set(GITHUB_OAUTH_STATE_COOKIE_NAME, '', { ...cookieOptions, maxAge: 0 });
  response.cookies.set(GITHUB_OAUTH_VERIFIER_COOKIE_NAME, '', { ...cookieOptions, maxAge: 0 });
}

function signupVerificationPath(email: unknown) {
  const target = new URL('/login?mode=verify', 'http://dashboard.local');
  if (typeof email === 'string' && email.length <= 320) target.searchParams.set('email', email);
  return `${target.pathname}${target.search}`;
}

async function readMutationBody(request: NextRequest) {
  const contentType = request.headers.get('content-type') || '';
  const bytes = await readBoundedBody(request.body, {
    maxBytes: MAX_MUTATION_BYTES,
    timeoutMs: REQUEST_BODY_TIMEOUT_MS,
    declaredLength: request.headers.get('content-length'),
    tooLargeCode: 'request_too_large',
    timeoutCode: 'request_body_timeout',
  });
  if (bytes.byteLength === 0) return {};
  if (contentType.includes('application/json')) {
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error('invalid_json_body');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_json_body');
    return value as Record<string, unknown>;
  }
  if (!contentType.includes('application/x-www-form-urlencoded') && !contentType.includes('multipart/form-data')) {
    throw codedError('unsupported_content_type');
  }
  let formData: FormData;
  try {
    formData = await new Response(bytes, { headers: { 'content-type': contentType } }).formData();
  } catch {
    throw codedError('invalid_form_body');
  }
  const body: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value !== 'string') throw new Error('file_upload_not_supported');
    const existing = body[key];
    body[key] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
  }
  return body;
}

function parseJson(value: string): { valid: boolean; payload: any } {
  if (!value) return { valid: true, payload: null };
  try { return { valid: true, payload: JSON.parse(value) }; } catch { return { valid: false, payload: { message: value } }; }
}

function requestBodyErrorCode(error: unknown) {
  const code = boundaryErrorCode(error, 'invalid_request_body');
  return new Set([
    'request_too_large',
    'request_body_timeout',
    'invalid_json_body',
    'invalid_form_body',
    'unsupported_content_type',
    'file_upload_not_supported',
  ]).has(code) ? code : 'invalid_request_body';
}

function requestBodyErrorStatus(code: string) {
  if (code === 'request_too_large') return 413;
  if (code === 'request_body_timeout') return 408;
  if (code === 'unsupported_content_type') return 415;
  return 400;
}

function boundaryErrorCode(error: unknown, fallback: string) {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  if (error instanceof Error && /^[A-Za-z0-9_.:-]{1,80}$/.test(error.message)) return error.message;
  return fallback;
}

function declaredLengthExceeds(value: string | null, maxBytes: number) {
  return Boolean(value && /^\d+$/.test(value) && Number(value) > maxBytes);
}

function codedError(code: string) {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

function ownedArrayBuffer(bytes: Uint8Array) {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
