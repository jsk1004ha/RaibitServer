import { randomUUID } from 'node:crypto';
import { errorStatusCode, normalizePublicIdentifier, normalizePublicPath, renderHostedErrorHtml } from '../../../lib/error-page-model';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  const url = new URL(request.url);
  const requestedCode = request.headers.get('x-code') || url.searchParams.get('code') || url.searchParams.get('status');
  const code = errorStatusCode(requestedCode, 404);
  const path = normalizePublicPath(request.headers.get('x-original-uri') || url.searchParams.get('path'));
  const identifier = normalizePublicIdentifier(
    request.headers.get('x-error-id') || request.headers.get('x-request-id') || url.searchParams.get('id'),
  ) || randomUUID();
  console.warn('[hosted-error]', JSON.stringify({ code, path, identifier }));
  return new Response(renderHostedErrorHtml(code, { path, identifier }), {
    status: code,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'content-language': 'ko',
      'x-error-id': identifier,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
    },
  });
}
