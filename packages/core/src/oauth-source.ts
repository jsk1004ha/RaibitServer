import crypto from 'node:crypto';
import { OAuthPublicError } from './oauth-security.ts';

export const OAUTH_RELAY_HEADER = 'x-raibitserver-oauth-relay';
export const OAUTH_BROWSER_COOKIE_NAME = '__Host-raibitserver_github_oauth_browser';
type OAuthOperation = 'login' | 'callback';
type OAuthRelayInput = {
  readonly browserId: string;
  readonly operation: OAuthOperation;
  readonly query: Readonly<Record<string, unknown>>;
  readonly now?: number;
};
type OAuthSourceRequest = {
  readonly source: string;
  readonly rawHeaders: readonly string[];
  readonly operation: OAuthOperation;
  readonly query: unknown;
  readonly now?: number;
};
const browserDomain = 'raibitserver:oauth-browser:v1\0';
const relayDomain = 'raibitserver:oauth-relay:v1\0';

function relayKey(secret: unknown): Uint8Array {
  if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/.test(secret)) throw new OAuthPublicError('github_oauth_relay_not_configured');
  return Buffer.from(secret, 'hex');
}

function mac(key: Uint8Array, domain: string, value: string): string {
  return crypto.createHmac('sha256', key).update(domain).update(value).digest('hex');
}

function sameMac(received: string, expected: string): boolean {
  return crypto.timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
}

export function issueOAuthBrowserCookie(secret: unknown): string {
  const key = relayKey(secret);
  const id = crypto.randomBytes(32).toString('hex');
  return `v1.${id}.${mac(key, browserDomain, id)}`;
}

export function parseOAuthBrowserCookie(value: unknown, secret: unknown): string | null {
  const key = relayKey(secret);
  if (typeof value !== 'string' || value.length !== 132) return null;
  const match = /^v1\.([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(value);
  if (!match) return null;
  const [, id, signature] = match;
  return sameMac(signature, mac(key, browserDomain, id)) ? id : null;
}

function canonicalQuery(value: unknown): readonly (readonly [string, string])[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OAuthPublicError('github_oauth_relay_invalid');
  const entries: [string, unknown][] = Object.entries(value);
  if (entries.length > 8) throw new OAuthPublicError('github_oauth_relay_invalid');
  const sorted = entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || typeof item !== 'string' || item.length > 2048) throw new OAuthPublicError('github_oauth_relay_invalid');
    return [key, item] as const;
  });
  if (Buffer.byteLength(JSON.stringify(sorted), 'utf8') > 8192) throw new OAuthPublicError('github_oauth_relay_invalid');
  return sorted;
}

function timestamp(value: number = Date.now()): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new OAuthPublicError('github_oauth_relay_invalid');
  return value;
}

function relayMessage(input: { readonly browserId: string; readonly operation: OAuthOperation; readonly query: unknown }, now: number): string {
  if (typeof input.browserId !== 'string' || !/^[a-f0-9]{64}$/.test(input.browserId)
    || (input.operation !== 'login' && input.operation !== 'callback')) throw new OAuthPublicError('github_oauth_relay_invalid');
  return JSON.stringify([input.browserId, now, 'GET', input.operation, canonicalQuery(input.query)]);
}

export function signOAuthRelay(input: OAuthRelayInput, secret: unknown): string {
  const key = relayKey(secret);
  const now = timestamp(input.now);
  return `v1.${input.browserId}.${now}.${mac(key, relayDomain, relayMessage(input, now))}`;
}

export function resolveOAuthSource(request: OAuthSourceRequest, secret: unknown): string {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === OAUTH_RELAY_HEADER) values.push(request.rawHeaders[index + 1]);
  }
  if (values.length === 0) return request.source;
  const key = relayKey(secret);
  if (values.length !== 1 || typeof values[0] !== 'string' || values[0].length > 160) throw new OAuthPublicError('github_oauth_relay_invalid');
  const match = /^v1\.([a-f0-9]{64})\.(0|[1-9][0-9]{0,15})\.([a-f0-9]{64})$/.exec(values[0]);
  if (!match) throw new OAuthPublicError('github_oauth_relay_invalid');
  const [, browserId, issuedAt, signature] = match;
  const issued = timestamp(Number(issuedAt));
  const now = timestamp(request.now);
  // Allow bounded clock skew between dashboard and API hosts.
  if (issued - now > 5_000 || now - issued > 30_000) throw new OAuthPublicError('github_oauth_relay_invalid');
  const expected = mac(key, relayDomain, relayMessage({ browserId, operation: request.operation, query: request.query }, issued));
  if (!sameMac(signature, expected)) throw new OAuthPublicError('github_oauth_relay_invalid');
  return `dashboard:${browserId}`;
}
