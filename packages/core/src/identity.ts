import crypto from 'node:crypto';
import { signJwtHs256 } from './auth.ts';
import { slugify } from './ids.ts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACCOUNT_TYPE_ALIASES: Record<string, string> = Object.freeze({
  CLUB: 'CLUB_MEMBER',
  CLUB_MEMBER: 'CLUB_MEMBER',
  CLUBMEMBER: 'CLUB_MEMBER',
  NON_CLUB: 'NON_CLUB',
  NONCLUB: 'NON_CLUB',
  NON_MEMBER: 'NON_CLUB',
  NONMEMBER: 'NON_CLUB',
});

export const DEFAULT_SESSION_TTL_SECONDS = 3600;
export const MAX_SESSION_TTL_SECONDS = 24 * 60 * 60;

export function normalizeEmail(email: string) {
  const value = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(value)) {
    const error = new Error('valid email is required');
    (error as any).statusCode = 400;
    throw error;
  }
  return value;
}

export function assertPasswordStrength(password: string) {
  if (String(password || '').length < 8) {
    const error = new Error('password must be at least 8 characters');
    (error as any).statusCode = 400;
    throw error;
  }
  return true;
}

export function hashPassword(password: string, options: Record<string, any> = {}) {
  assertPasswordStrength(password);
  const salt = options.salt || crypto.randomBytes(16).toString('base64url');
  const cost = Number(options.cost || 16384);
  const hash = crypto.scryptSync(String(password), salt, 32, { N: cost }).toString('base64url');
  return `scrypt:v1:${cost}:${salt}:${hash}`;
}

export function verifyPassword(password: string, encoded: string) {
  const [scheme, version, costText, salt, expected] = String(encoded || '').split(':');
  if (scheme !== 'scrypt' || version !== 'v1' || !salt || !expected) return false;
  const cost = Number(costText || 16384);
  const actual = crypto.scryptSync(String(password || ''), salt, 32, { N: cost }).toString('base64url');
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export function sessionPayloadForUser(user: Record<string, any>, memberships: Array<Record<string, any>> = []) {
  const organizationIds = memberships.map((membership) => membership.organizationId).filter(Boolean);
  return {
    sub: user.id,
    email: user.email,
    role: memberships[0]?.role || 'developer',
    organizationId: organizationIds[0] || null,
    organizationIds,
    accountType: user.accountType || 'NON_CLUB',
    approvalStatus: user.approvalStatus || 'PENDING',
    userRole: user.role || 'USER',
    emailVerified: Boolean(user.emailVerifiedAt),
  };
}

export function createSessionToken(user: Record<string, any>, memberships: Array<Record<string, any>>, jwtSecret: string, options: Record<string, any> = {}) {
  return signJwtHs256(sessionPayloadForUser(user, memberships), jwtSecret, { expiresInSeconds: sessionTtlSeconds(options), issuer: options.issuer || 'raibitserver' });
}

export function sessionTtlSeconds(options: Record<string, any> = {}) {
  const configured = Number(options.sessionTtlSeconds || options.expiresInSeconds || process.env.RAIBITSERVER_SESSION_TTL_SECONDS || DEFAULT_SESSION_TTL_SECONDS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_SESSION_TTL_SECONDS;
  return Math.max(60, Math.min(Math.floor(configured), MAX_SESSION_TTL_SECONDS));
}

export function personalOrganizationSlug(email: string) {
  return slugify(String(email).split('@')[0] || 'user');
}

export function normalizeAccountType(value: any, fallback = 'NON_CLUB') {
  const raw = value === undefined || value === null || String(value).trim() === '' ? fallback : value;
  const normalized = String(raw || fallback).trim().toUpperCase().replace(/[\s-]+/g, '_');
  const accountType = ACCOUNT_TYPE_ALIASES[normalized];
  if (!accountType) {
    const error = new Error('accountType must be CLUB_MEMBER or NON_CLUB');
    (error as any).statusCode = 400;
    throw error;
  }
  return accountType;
}

export function configuredAdminEmails(env: Record<string, any> = process.env) {
  return String(env.ADMIN_EMAILS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export function signupPolicyForAccount(input: Record<string, any>, email: string, options: Record<string, any> = {}) {
  const env = options.env || process.env;
  const production = env.NODE_ENV === 'production';
  const adminEmails = configuredAdminEmails(env);
  const isAdminEmail = adminEmails.includes(String(email || '').toLowerCase());
  const firstUser = options.firstUser === true;
  if (production) {
    const token = String(input.bootstrapToken || input.adminBootstrapToken || '');
    const expected = String(env.RAIBITSERVER_ADMIN_BOOTSTRAP_TOKEN || '');
    const tokenOk = Boolean(expected && token && token === expected);
    const isAdminBootstrap = tokenOk && isAdminEmail;
    return {
      isAdminBootstrap,
      bootstrapReason: isAdminBootstrap ? 'admin-invite-token' : null,
      role: isAdminBootstrap ? 'ADMIN' : 'USER',
      accountType: 'NON_CLUB',
      approvalStatus: isAdminBootstrap ? 'APPROVED' : 'PENDING',
    };
  }
  const isAdminBootstrap = firstUser || isAdminEmail;
  if (isAdminBootstrap) {
    return {
      isAdminBootstrap,
      bootstrapReason: firstUser ? 'first-user' : 'admin-email',
      role: 'ADMIN',
      accountType: 'NON_CLUB',
      approvalStatus: 'APPROVED',
    };
  }
  return {
    isAdminBootstrap: false,
    bootstrapReason: null,
    role: 'USER',
    accountType: 'NON_CLUB',
    approvalStatus: 'PENDING',
  };
}

export function shouldPromoteFirstLogin(user: Record<string, any>, users: Array<Record<string, any>> = []) {
  if (process.env.NODE_ENV === 'production') return false;
  if (!user || user.role === 'ADMIN') return false;
  if (!users.length) return false;
  if (users.some((candidate) => candidate.role === 'ADMIN')) return false;
  const first = [...users].sort(compareUsersByCreation)[0];
  return Boolean(first && sameUser(first, user));
}

function sameUser(a: Record<string, any>, b: Record<string, any>) {
  if (a.id && b.id && String(a.id) === String(b.id)) return true;
  return Boolean(a.email && b.email && String(a.email).toLowerCase() === String(b.email).toLowerCase());
}

function compareUsersByCreation(a: Record<string, any>, b: Record<string, any>) {
  const aTime = Date.parse(a.createdAt || '') || 0;
  const bTime = Date.parse(b.createdAt || '') || 0;
  if (aTime !== bTime) return aTime - bTime;
  return String(a.id || a.email || '').localeCompare(String(b.id || b.email || ''));
}
