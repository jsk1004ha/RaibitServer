import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { dashboardRequestUrl, dashboardSecurityHeaders } from './lib/request-security.js';

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
  const publicRequestUrl = dashboardRequestUrl(request.url, {
    host: request.headers.get('host'),
    forwardedProto: request.headers.get('x-forwarded-proto'),
    configuredOrigin: process.env.RAIBITSERVER_DASHBOARD_ORIGIN,
  });
  const headers = dashboardSecurityHeaders({
    nonce,
    production: process.env.NODE_ENV === 'production',
    https: new URL(publicRequestUrl).protocol === 'https:',
  });
  const configured = process.env.RAIBITSERVER_DASHBOARD_BASIC_AUTH;
  const hasServerApiToken = Boolean(process.env.RAIBITSERVER_DASHBOARD_TOKEN || process.env.RAIBITSERVER_TOKEN);
  if (!configured) {
    if (!hasServerApiToken) {
      return nextResponse(request, nonce, headers);
    }
    return new NextResponse('Set RAIBITSERVER_DASHBOARD_BASIC_AUTH to protect dashboard server-side API token access.', { status: 503, headers });
  }
  const credentials = parseBasicHeader(request.headers.get('authorization'));
  if (!credentials || credentials !== configured) return unauthorizedResponse(headers);
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
