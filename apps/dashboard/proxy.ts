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
