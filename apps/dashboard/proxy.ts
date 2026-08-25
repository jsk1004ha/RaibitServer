import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { dashboardRequestUrl, dashboardSecurityHeaders, SESSION_COOKIE_NAME } from './lib/request-security.js';

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
  const consoleRequest = isConsoleHostname(
    new URL(requestHostUrl).hostname,
    process.env.RAIBITSERVER_CONSOLE_URL,
  );
  const headers = dashboardSecurityHeaders({
    nonce,
    production: process.env.NODE_ENV === 'production',
    https: new URL(publicRequestUrl).protocol === 'https:',
  });
  const configured = process.env.RAIBITSERVER_DASHBOARD_BASIC_AUTH;
  if (configured) {
    const credentials = parseBasicHeader(request.headers.get('authorization'));
    if (!credentials || credentials !== configured) return unauthorizedResponse(headers);
  }
  const pathname = request.nextUrl.pathname;
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  const requiresSession = isProtectedPage(pathname) || (consoleRequest && isConsolePage(pathname));
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
  if (pathname === '/login' || pathname.startsWith('/login/')) return false;
  if (pathname.startsWith('/api/')) return false;
  return !/\.(?:avif|css|gif|ico|jpe?g|js|png|svg|webp|woff2?)$/i.test(pathname);
}

function isConsoleHostname(hostname: string, configuredConsoleUrl?: string) {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  if (normalized === 'console.raibit.kr' || normalized === 'console.raibitserver.app') return true;
  if (normalized.startsWith('console--') && normalized.endsWith('.raibitserver.app')) return true;
  if (normalized.endsWith('.console.raibitserver.app')) return true;
  try {
    return Boolean(configuredConsoleUrl) && normalized === new URL(configuredConsoleUrl).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return false;
  }
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
