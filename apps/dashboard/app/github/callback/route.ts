import { NextRequest, NextResponse } from 'next/server';
import { getJson } from '../../../lib/api';
import { consoleOriginHref, dashboardRequestUrl } from '../../../lib/request-security.js';

export async function GET(request: NextRequest) {
  const githubError = request.nextUrl.searchParams.get('error');
  if (githubError) return githubPageError(request, githubError === 'access_denied' ? 'github_access_denied' : 'github_callback_failed');

  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  if (code) {
    const result = await getJson(`/github/callback?${new URLSearchParams({ code, state: state || '' })}`, {});
    if (!result.ok) return githubPageError(request, result.errorCode);
    const target = githubConsoleTarget(request);
    target.searchParams.set('step', 'import');
    target.searchParams.set('notice', 'github_connected');
    return NextResponse.redirect(target, 303);
  }

  const installationId = request.nextUrl.searchParams.get('installation_id');
  const setupAction = request.nextUrl.searchParams.get('setup_action') || 'install';
  if (!installationId || !state) return githubPageError(request, 'github_callback_invalid');
  const query = new URLSearchParams({ installation_id: installationId, setup_action: setupAction, state });
  const result = await getJson(`/github/authorize?${query}`, {});
  if (!result.ok) return githubPageError(request, result.errorCode);
  const authorizationUrl = safeAuthorizationUrl(result.body?.authorizationUrl);
  if (!authorizationUrl) return githubPageError(request, 'github_authorization_url_invalid');
  return NextResponse.redirect(authorizationUrl, 302);
}

function githubPageError(request: NextRequest, code = 'github_callback_failed') {
  const target = githubConsoleTarget(request);
  target.searchParams.set('step', 'connect');
  target.searchParams.set('error', code);
  return NextResponse.redirect(target, 303);
}

function githubConsoleTarget(request: NextRequest) {
  const browserRequestUrl = dashboardRequestUrl(request.url, {
    host: request.headers.get('host'),
    forwardedProto: request.headers.get('x-forwarded-proto'),
  });
  return new URL(
    consoleOriginHref(process.env.RAIBITSERVER_CONSOLE_URL, '/github', '/github'),
    browserRequestUrl,
  );
}

function safeAuthorizationUrl(value: unknown) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && url.port === ''
      && url.pathname === '/login/oauth/authorize'
      && Boolean(url.searchParams.get('client_id'))
      && Boolean(url.searchParams.get('state'))
      ? url
      : null;
  } catch {
    return null;
  }
}
