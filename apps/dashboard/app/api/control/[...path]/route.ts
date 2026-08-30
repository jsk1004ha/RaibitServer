import { NextRequest, NextResponse } from 'next/server';
import { dashboardApiContext } from '../../../../lib/api';
import {
  SESSION_COOKIE_NAME,
  boundedPassThrough,
  browserSafePayload,
  dashboardRequestUrl,
  extractSessionToken,
  environmentFilePayloadFromForm,
  environmentPayloadFromForm,
  fetchWithInitialResponseTimeout,
  formMutationMethod,
  isSameOriginMutation,
  projectCreatePayloadFromForm,
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
const PUBLIC_POST_PATHS = new Set(['/auth/login', '/auth/signup', '/auth/email/verify', '/auth/email/resend']);
const PUBLIC_GET_PATHS = new Set(['/health', '/auth/github/login', '/auth/github/callback']);

type RouteContext = { params: Promise<{ path: string[] }> | { path: string[] } };

export async function GET(request: NextRequest, routeContext: RouteContext) {
  return proxyRequest(request, routeContext, 'GET');
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
    return NextResponse.json({ error: code }, { status: upstream.status });
  }

  if (isMutation) {
    const successPath = path === '/auth/signup'
      ? signupVerificationPath(body?.email)
      : returnPath;
    const response = isFormSubmission
      ? NextResponse.redirect(new URL(withFlashMessage(browserRequestUrl, successPath, 'notice', 'saved'), browserRequestUrl), 303)
      : responseStatusAllowsBody(upstream.status)
        ? NextResponse.json(safePayload ?? {}, { status: upstream.status })
        : new NextResponse(null, { status: upstream.status });
    applySessionCookie(response, path, payload);
    response.headers.set('cache-control', 'no-store');
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

function formErrorRedirect(requestUrl: string, returnPath: string, code: string) {
  return NextResponse.redirect(new URL(withFlashMessage(requestUrl, returnPath, 'error', code), requestUrl), 303);
}

function applySessionCookie(response: NextResponse, path: string, payload: any) {
  const token = extractSessionToken(payload);
  const cookieOptions = { ...sessionCookieOptions(), sameSite: 'lax' as const };
  if (token) response.cookies.set(SESSION_COOKIE_NAME, token, cookieOptions);
  if (path === '/auth/logout') response.cookies.set(SESSION_COOKIE_NAME, '', { ...cookieOptions, maxAge: 0 });
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
