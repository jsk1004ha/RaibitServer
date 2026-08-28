import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  consoleOriginHref,
  dashboardRequestUrl,
  dashboardSecurityHeaders,
  publicHostnameForConsole,
  SESSION_COOKIE_NAME,
} from './lib/request-security.js';

function unauthorizedResponse(headers: Record<string, string>) {
  return new NextResponse('Dashboard admin authentication required.', {
    status: 401,
    headers: { ...headers, 'www-authenticate': 'Basic realm="RAIBITSERVER Dashboard"' },
  });
}

function parseBasicHeader(header: string | null) {
  if (!header || !header.startsWith('Basic ')) return null;
  const encoded = header.slice('Basic '.length).trim();
  try {
    return Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

export function proxy(request: NextRequest) {
  const nonce = crypto.randomUUID();
  const forwardedProto = request.headers.get('x-forwarded-proto');
  const host = request.headers.get('host');
  const publicRequestUrl = dashboardRequestUrl(request.url, {
    host,
    forwardedProto,
    configuredOrigin: process.env.RAIBITSERVER_DASHBOARD_ORIGIN,
  });
  const requestHostUrl = dashboardRequestUrl(request.url, { host, forwardedProto });
  const requestHostname = new URL(requestHostUrl).hostname;
  const dashboardPlane = dashboardPlaneForHostname(
    requestHostname,
    process.env.RAIBITSERVER_CONSOLE_URL,
    process.env.RAIBITSERVER_BASE_DOMAIN || process.env.BASE_DOMAIN,
  );
  const consoleRequest = dashboardPlane === 'console';
  const protectedDashboardHost = dashboardPlane !== null;
  const headers = dashboardSecurityHeaders({
    nonce,
    production: process.env.NODE_ENV === 'production',
    https: new URL(publicRequestUrl).protocol === 'https:',
  });
  const pathname = request.nextUrl.pathname;
  const hostedErrorBackendRequest = isHostedErrorBackendHostname(requestHostname)
    || isHostedWorkloadHostname(
      requestHostname,
      process.env.RAIBITSERVER_CONSOLE_URL,
      process.env.RAIBITSERVER_BASE_DOMAIN || process.env.BASE_DOMAIN,
    );
  if (pathname === '/api/hosted-error') return hostedErrorApiResponse(request, nonce);
  if (hostedErrorBackendRequest && !isDashboardHealthPath(pathname)) {
    return hostedErrorResponse(request, nonce);
  }
  if (isConfiguredPublicHostname(requestHostname, process.env.RAIBITSERVER_CONSOLE_URL)
    && (isLoginPage(pathname) || isProtectedPage(pathname))) {
    const target = consoleOriginHref(
      process.env.RAIBITSERVER_CONSOLE_URL,
      `${pathname}${request.nextUrl.search}`,
    );
    return redirectResponse(new URL(target), headers);
  }
  const configured = process.env.RAIBITSERVER_DASHBOARD_BASIC_AUTH;
  if (configured && protectedDashboardHost) {
    const credentials = parseBasicHeader(request.headers.get('authorization'));
    if (!credentials || credentials !== configured) return unauthorizedResponse(headers);
  }
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  const requiresSession = isProtectedPage(pathname) || (protectedDashboardHost && isConsolePage(pathname));
  if (requiresSession && !hasSession) {
    const login = new URL('/login', publicRequestUrl);
    login.searchParams.set('next', consoleRequest && pathname === '/' ? '/console' : `${pathname}${request.nextUrl.search}`);
    return redirectResponse(login, headers);
  }
  if (consoleRequest && pathname === '/') {
    return redirectResponse(new URL('/console', publicRequestUrl), headers);
  }
  return nextResponse(request, nonce, headers);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

function nextResponse(request: NextRequest, nonce: string, headers: Record<string, string>) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete('authorization');
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', headers['content-security-policy']);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
  return response;
}

function redirectResponse(location: URL, headers: Record<string, string>) {
  const response = NextResponse.redirect(location);
  for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
  return response;
}

function hostedErrorApiResponse(request: NextRequest, nonce: string) {
  const requestHeaders = sanitizedHostedErrorRequestHeaders(request, nonce);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

function hostedErrorResponse(request: NextRequest, nonce: string) {
  const requestHeaders = sanitizedHostedErrorRequestHeaders(request, nonce);
  requestHeaders.set('x-code', hostedErrorCode(request.headers.get('x-code')));
  requestHeaders.set('x-original-uri', safeOriginalPath(
    request.headers.get('x-original-uri') || request.nextUrl.pathname,
  ));
  return NextResponse.rewrite(new URL('/api/hosted-error', request.url), {
    request: { headers: requestHeaders },
  });
}

function sanitizedHostedErrorRequestHeaders(request: NextRequest, nonce: string) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete('authorization');
  requestHeaders.delete('cookie');
  requestHeaders.set('x-nonce', nonce);
  return requestHeaders;
}

function hostedErrorCode(value: string | null) {
  return value && HOSTED_ERROR_STATUS_CODES.has(value) ? value : '404';
}

const HOSTED_ERROR_STATUS_CODES = new Set([
  '400', '401', '402', '403', '404', '405', '406', '407', '408', '409', '410', '411', '412', '413',
  '414', '415', '416', '417', '421', '422', '423', '424', '425', '426', '428', '429', '431', '451',
  '500', '501', '502', '503', '504', '505', '506', '507', '508', '511',
]);

function safeOriginalPath(value: string) {
  const withoutQuery = value.split('#', 1)[0]?.split('?', 1)[0] || '';
  if (!withoutQuery.startsWith('/') || withoutQuery.startsWith('//') || withoutQuery.includes('\\')) return '/';
  return withoutQuery.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240) || '/';
}

function isConsolePage(pathname: string) {
  if (isLoginPage(pathname)) return false;
  if (pathname.startsWith('/api/')) return false;
  return !/\.(?:avif|css|gif|ico|jpe?g|js|png|svg|webp|woff2?)$/i.test(pathname);
}

function dashboardPlaneForHostname(hostname: string, configuredConsoleUrl?: string, configuredBaseDomain?: string) {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return null;
  const configuredConsoleHostname = hostnameFromUrl(configuredConsoleUrl);
  if (normalized === configuredConsoleHostname
    || normalized === 'console.raibit.kr'
    || normalized === 'console.raibitserver.app') return 'console';

  const baseDomains = new Set(['raibit.kr', 'raibitserver.app']);
  const configuredPublicHostname = publicHostnameForConsole(configuredConsoleUrl);
  if (configuredPublicHostname) baseDomains.add(configuredPublicHostname);
  const normalizedBaseDomain = normalizeHostname(configuredBaseDomain);
  if (normalizedBaseDomain) baseDomains.add(normalizedBaseDomain);

  for (const baseDomain of baseDomains) {
    if (isPlaneHostname(normalized, 'console', baseDomain)) return 'console';
    if (isPlaneHostname(normalized, 'resources', baseDomain)) return 'resources';
  }
  return null;
}

function isHostedWorkloadHostname(hostname: string, configuredConsoleUrl?: string, configuredBaseDomain?: string) {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return false;
  const baseDomains = new Set(['raibit.kr', 'raibitserver.app']);
  const configuredPublicHostname = publicHostnameForConsole(configuredConsoleUrl);
  if (configuredPublicHostname) baseDomains.add(configuredPublicHostname);
  const normalizedBaseDomain = normalizeHostname(configuredBaseDomain);
  if (normalizedBaseDomain) baseDomains.add(normalizedBaseDomain);
  for (const baseDomain of baseDomains) {
    const suffix = `.${baseDomain}`;
    if (!normalized.endsWith(suffix)) continue;
    const routeLabel = normalized.slice(0, -suffix.length);
    if (!routeLabel.includes('.')
      && ((routeLabel.startsWith('apps--') && routeLabel.length > 'apps--'.length)
        || (routeLabel.startsWith('preview--') && routeLabel.length > 'preview--'.length))) return true;
  }
  return false;
}

function isHostedErrorBackendHostname(hostname: string) {
  const normalized = normalizeHostname(hostname);
  const serviceLabel = normalized?.split('.', 1)[0] || '';
  return serviceLabel === 'hosted-errors' || serviceLabel.endsWith('-hosted-errors');
}

function isDashboardHealthPath(pathname: string) {
  return pathname === '/healthz' || pathname === '/api/health';
}

function isPlaneHostname(hostname: string, plane: 'console' | 'resources', baseDomain: string) {
  const suffix = `.${baseDomain}`;
  if (!hostname.endsWith(suffix)) return false;
  const routeLabel = hostname.slice(0, -suffix.length);
  return (routeLabel.startsWith(`${plane}--`) && routeLabel.length > `${plane}--`.length && !routeLabel.includes('.'))
    || (hostname.endsWith(`.${plane}.${baseDomain}`) && hostname !== `${plane}.${baseDomain}`);
}

function isConfiguredPublicHostname(hostname: string, configuredConsoleUrl?: string) {
  const publicHostname = publicHostnameForConsole(configuredConsoleUrl);
  return Boolean(publicHostname) && normalizeHostname(hostname) === publicHostname;
}

function hostnameFromUrl(value?: string) {
  try {
    const candidate = new URL(value || '');
    return ['http:', 'https:'].includes(candidate.protocol)
      && !candidate.username
      && !candidate.password
      && !candidate.search
      && !candidate.hash
      ? normalizeHostname(candidate.hostname)
      : null;
  } catch {
    return null;
  }
}

function normalizeHostname(value?: string) {
  const normalized = String(value || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!normalized || normalized.length > 253 || normalized.includes('..')) return null;
  return /^[a-z0-9.-]+$/.test(normalized) ? normalized : null;
}

function isLoginPage(pathname: string) {
  return pathname === '/login' || pathname.startsWith('/login/');
}

function isProtectedPage(pathname: string) {
  return pathname === '/console'
    || pathname.startsWith('/console/')
    || pathname === '/admin'
    || pathname.startsWith('/admin/')
    || pathname === '/github'
    || pathname.startsWith('/github/')
    || pathname === '/guide'
    || pathname.startsWith('/guide/')
    || pathname === '/org'
    || pathname.startsWith('/org/');
}
