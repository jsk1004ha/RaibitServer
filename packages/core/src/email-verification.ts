import crypto from 'node:crypto';
import { createSessionToken, hashPassword, normalizeEmail, personalOrganizationSlug, sessionTtlSeconds, signupPolicyForAccount } from './identity.ts';

export const DEFAULT_EMAIL_VERIFICATION_TTL_SECONDS = 10 * 60;
export const MAX_EMAIL_VERIFICATION_TTL_SECONDS = 24 * 60 * 60;
export const MAX_EMAIL_VERIFICATION_ATTEMPTS = 5;
export const DEFAULT_EMAIL_VERIFICATION_SENDER_LOCAL_PART = 'email-verification';
export const DEFAULT_EMAIL_VERIFICATION_SENDER_DOMAIN = 'raibitserver.local';

export function normalizeEmailVerificationCode(code: any) {
  const value = String(code || '').trim();
  if (!/^\d{6}$/.test(value)) throw statusError('email_verification_code_must_be_6_digits', 400);
  return value;
}

export function emailVerificationTtlSeconds(env: Record<string, any> = process.env) {
  const configured = Number(env.RAIBITSERVER_EMAIL_VERIFICATION_TTL_SECONDS || DEFAULT_EMAIL_VERIFICATION_TTL_SECONDS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_EMAIL_VERIFICATION_TTL_SECONDS;
  return Math.max(60, Math.min(Math.floor(configured), MAX_EMAIL_VERIFICATION_TTL_SECONDS));
}

export function generateEmailVerificationCode(env: Record<string, any> = process.env) {
  const testCode = String(env.RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE || '').trim();
  if (testCode && env.NODE_ENV !== 'production') return normalizeEmailVerificationCode(testCode);
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export function emailVerificationSecret(jwtSecret: string, env: Record<string, any> = process.env) {
  const secret = String(env.RAIBITSERVER_EMAIL_VERIFICATION_SECRET || jwtSecret || '');
  if (!secret) throw statusError('email_verification_secret_not_configured', 500);
  return secret;
}

export function emailVerificationSalt() {
  return crypto.randomBytes(16).toString('base64url');
}

export function hashEmailVerificationCode(input: { email: string; code: string; codeSalt: string; secret: string }) {
  const email = normalizeEmail(input.email);
  const code = normalizeEmailVerificationCode(input.code);
  const codeSalt = String(input.codeSalt || '');
  if (!codeSalt) throw statusError('email_verification_salt_required', 500);
  return crypto.createHmac('sha256', input.secret).update(`${email}:${code}:${codeSalt}`).digest('base64url');
}

export function timingSafeEqualText(a: any, b: any) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function verifyEmailVerificationCodeHash(input: { email: string; code: string; codeSalt: string; codeHash: string; secret: string }) {
  const actual = hashEmailVerificationCode(input);
  return timingSafeEqualText(actual, input.codeHash);
}

export function emailVerificationSenderFromEnv(env: Record<string, any> = process.env) {
  const configuredFrom = sanitizeEmailSenderHeader(env.RAIBITSERVER_EMAIL_FROM);
  if (configuredFrom) return configuredFrom;
  const domain = emailVerificationSenderDomainFromEnv(env);
  if ((!domain || isLocalEmailSenderDomain(domain)) && env.NODE_ENV === 'production') throw statusError('email_sender_not_configured', 500);
  return formatEmailVerificationSender(domain || DEFAULT_EMAIL_VERIFICATION_SENDER_DOMAIN);
}

export function emailVerificationSenderDomainFromEnv(env: Record<string, any> = process.env) {
  return normalizeEmailSenderDomain(env.RAIBITSERVER_EMAIL_DOMAIN)
    || normalizeEmailSenderDomain(env.RAIBITSERVER_BASE_DOMAIN)
    || normalizeEmailSenderDomain(env.BASE_DOMAIN);
}

export function formatEmailVerificationSender(domain: string) {
  const normalizedDomain = normalizeEmailSenderDomain(domain);
  if (!normalizedDomain) throw statusError('email_sender_domain_invalid', 500);
  return `RAIBITSERVER <${DEFAULT_EMAIL_VERIFICATION_SENDER_LOCAL_PART}@${normalizedDomain}>`;
}

export function buildEmailVerificationMessage(input: { email: string; code: string; expiresAt: string; appName?: string; env?: Record<string, any>; from?: string }) {
  const appName = input.appName || 'RAIBITSERVER';
  const minutes = Math.max(1, Math.ceil((Date.parse(input.expiresAt) - Date.now()) / 60_000));
  const subject = `${appName} 이메일 인증 코드`;
  const text = [
    `${appName} 회원가입 인증 코드: ${input.code}`,
    '',
    `이 코드는 약 ${minutes}분 후 만료됩니다.`,
    '본인이 요청하지 않았다면 이 메일을 무시하세요.',
  ].join('\n');
  return {
    from: input.from ? sanitizeEmailSenderHeader(input.from) : emailVerificationSenderFromEnv(input.env || process.env),
    to: normalizeEmail(input.email),
    subject,
    text,
  };
}

export async function deliverEmailVerificationMessage(message: Record<string, any>, env: Record<string, any> = process.env) {
  const webhookUrl = String(env.RAIBITSERVER_EMAIL_WEBHOOK_URL || '').trim();
  const configuredMode = String(env.RAIBITSERVER_EMAIL_DELIVERY_MODE || '').trim().toLowerCase();
  assertEmailDeliveryConfigured(env);
  const mode = configuredMode || (webhookUrl ? 'webhook' : 'console');
  if (mode === 'webhook') {
    if (!webhookUrl) throw statusError('email_webhook_url_required', 500);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const token = String(env.RAIBITSERVER_EMAIL_WEBHOOK_TOKEN || '').trim();
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(webhookUrl, { method: 'POST', headers, body: JSON.stringify(message) });
    if (!response.ok) throw statusError(`email_delivery_failed:${response.status}`, 502);
    return {
      mode: 'webhook',
      messageId: response.headers.get('x-message-id') || response.headers.get('x-request-id') || null,
    };
  }
  if (['console', 'log', 'stdout'].includes(mode)) {
    if (env.RAIBITSERVER_EMAIL_LOG === '1') {
      console.info(`[raibitserver-email] from=${message.from} to=${message.to} subject=${message.subject}\n${message.text}`);
    }
    return { mode: 'console', messageId: null };
  }
  throw statusError(`unsupported_email_delivery_mode:${mode}`, 500);
}

export function assertEmailDeliveryConfigured(env: Record<string, any> = process.env) {
  const webhookUrl = String(env.RAIBITSERVER_EMAIL_WEBHOOK_URL || '').trim();
  if (env.NODE_ENV === 'production' && !webhookUrl) throw statusError('email_delivery_not_configured', 500);
  emailVerificationSenderFromEnv(env);
  return true;
}

export async function issueSignupEmailVerificationCode(repository: any, input: Record<string, any>, options: Record<string, any> = {}) {
  const target = repositoryForEmailVerification(repository);
  const env = options.env || process.env;
  const email = normalizeEmail(input.email);
  const existing = await target.findUserByEmail(email);
  if (existing) throw statusError('user_already_exists', 409);
  const organizationSlug = input.organizationSlug || input.orgSlug || personalOrganizationSlug(email);
  const existingOrganization = target.findOrganizationBySlug ? await target.findOrganizationBySlug(organizationSlug) : null;
  if (existingOrganization) throw statusError('organization_slug_already_exists', 409);
  const users = await usersForRepository(target);
  const policy = signupPolicyForAccount(input, email, { firstUser: users.length === 0, env });
  const payload = {
    kind: 'signup',
    name: input.name || email,
    email,
    passwordHash: hashPassword(input.password),
    organizationSlug,
    organizationName: input.organizationName || organizationSlug,
    plan: input.plan || 'free',
    policy,
  };
  return issueEmailVerificationChallenge(target, email, payload, options);
}

export async function resendEmailVerificationCode(repository: any, input: Record<string, any>, options: Record<string, any> = {}) {
  const target = repositoryForEmailVerification(repository);
  const email = normalizeEmail(input.email);
  const existing = await target.findUserByEmail(email);
  if (existing) return { required: false, sent: false, sentTo: maskEmailAddress(email), alreadyRegistered: true };
  const record = await target.findPendingEmailVerificationCode(email, 'signup');
  if (!record?.payload) throw statusError('signup_verification_not_found', 404);
  return issueEmailVerificationChallenge(target, email, record.payload, options);
}

export async function verifyEmailCodeAndCreateSession(repository: any, input: Record<string, any>, options: Record<string, any> = {}) {
  const target = repositoryForEmailVerification(repository);
  const env = options.env || process.env;
  const jwtSecret = String(options.jwtSecret || '');
  const secret = emailVerificationSecret(jwtSecret, env);
  const email = normalizeEmail(input.email);
  const code = normalizeEmailVerificationCode(input.code);
  const record = await target.findPendingEmailVerificationCode(email, 'signup');
  if (!record) throw statusError('invalid_or_expired_email_verification_code', 403);
  if (Date.parse(record.expiresAt) <= Date.now()) {
    if (target.consumeEmailVerificationCode) await target.consumeEmailVerificationCode(record.id);
    throw statusError('invalid_or_expired_email_verification_code', 403);
  }
  if (Number(record.attempts || 0) >= MAX_EMAIL_VERIFICATION_ATTEMPTS) {
    throw statusError('invalid_or_expired_email_verification_code', 403);
  }
  const valid = verifyEmailVerificationCodeHash({
    email,
    code,
    codeSalt: record.codeSalt,
    codeHash: record.codeHash,
    secret,
  });
  if (!valid) {
    if (target.incrementEmailVerificationAttempts) await target.incrementEmailVerificationAttempts(record.id);
    throw statusError('invalid_or_expired_email_verification_code', 403);
  }
  const payload = record.payload || {};
  if (payload.kind !== 'signup') throw statusError('invalid_or_expired_email_verification_code', 403);
  const existing = await target.findUserByEmail(email);
  if (existing) throw statusError('user_already_exists', 409);
  const existingOrganization = target.findOrganizationBySlug ? await target.findOrganizationBySlug(payload.organizationSlug) : null;
  if (existingOrganization) throw statusError('organization_slug_already_exists', 409);
  const verifiedAt = new Date().toISOString();
  const users = await usersForRepository(target);
  const policy = payload.policy?.bootstrapReason === 'first-user'
    ? signupPolicyForAccount({}, email, { firstUser: users.length === 0, env })
    : payload.policy || signupPolicyForAccount({}, email, { firstUser: users.length === 0, env });
  const organization = await target.createOrganization({ name: payload.organizationName || payload.organizationSlug, slug: payload.organizationSlug, plan: payload.plan || 'free' });
  const user = await target.createUser({
    name: payload.name || email,
    email,
    passwordHash: payload.passwordHash,
    role: policy.role,
    accountType: policy.accountType,
    approvalStatus: policy.approvalStatus,
    emailVerifiedAt: verifiedAt,
  });
  const membership = await target.addMember({ organizationId: organization.id, userId: user.id, role: 'owner' });
  if (target.consumeEmailVerificationCode) await target.consumeEmailVerificationCode(record.id, verifiedAt);
  const memberships = target.listMembershipsForUser ? await target.listMembershipsForUser(user.id) : [];
  const token = createSessionToken(user, memberships, jwtSecret, {
    issuer: options.issuer || env.RAIBITSERVER_AUTH_ISSUER || 'raibitserver',
    expiresInSeconds: sessionTtlSeconds(options),
  });
  return { user, organization, membership, memberships, token, emailVerification: { required: false, verified: true, verifiedAt } };
}

export function assertUserEmailVerified(user: Record<string, any>) {
  if (!user.emailVerifiedAt) throw statusError('email_not_verified', 403);
  return true;
}

export function maskEmailAddress(email: string) {
  const [name, domain] = normalizeEmail(email).split('@');
  const maskedName = name.length <= 2 ? `${name[0] || '*'}*` : `${name.slice(0, 2)}***${name.slice(-1)}`;
  return `${maskedName}@${domain}`;
}

function repositoryForEmailVerification(repository: any) {
  return repository?.createEmailVerificationCode ? repository : repository?.store || repository;
}

async function issueEmailVerificationChallenge(target: any, email: string, payload: Record<string, any>, options: Record<string, any> = {}) {
  const env = options.env || process.env;
  const jwtSecret = String(options.jwtSecret || '');
  const secret = emailVerificationSecret(jwtSecret, env);
  assertEmailDeliveryConfigured(env);
  const code = generateEmailVerificationCode(env);
  const codeSalt = emailVerificationSalt();
  const codeHash = hashEmailVerificationCode({ email, code, codeSalt, secret });
  const now = new Date();
  const expiresAt = new Date(now.getTime() + emailVerificationTtlSeconds(env) * 1000).toISOString();
  if (target.invalidatePendingEmailVerificationCodes) await target.invalidatePendingEmailVerificationCodes(email);
  await target.createEmailVerificationCode({
    userId: payload.userId || null,
    email,
    purpose: payload.kind || 'signup',
    payload,
    codeHash,
    codeSalt,
    expiresAt,
    sentAt: now.toISOString(),
    attempts: 0,
  });
  const message = buildEmailVerificationMessage({ email, code, expiresAt, appName: options.appName || 'RAIBITSERVER', env });
  const delivery = await deliverEmailVerificationMessage(message, env);
  if (target.recordEmailDelivery) {
    await target.recordEmailDelivery({
      ...message,
      purpose: 'email-verification',
      deliveryMode: delivery.mode,
      messageId: delivery.messageId || null,
      sentAt: now.toISOString(),
    });
  }
  return {
    required: true,
    sent: true,
    sentTo: maskEmailAddress(email),
    expiresAt,
    deliveryMode: delivery.mode,
  };
}

function sanitizeEmailSenderHeader(value: any) {
  const sender = String(value || '').trim();
  if (!sender) return '';
  if (/[\r\n]/.test(sender)) throw statusError('email_sender_invalid', 500);
  const angleMatch = sender.match(/<([^<>]+)>$/);
  const address = angleMatch ? angleMatch[1] : sender;
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(address)) throw statusError('email_sender_invalid', 500);
  normalizeEmailSenderDomain(address.split('@')[1]);
  return sender;
}

function normalizeEmailSenderDomain(value: any) {
  let domain = String(value || '').trim().toLowerCase();
  if (!domain) return '';
  domain = domain.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
  if (!domain || domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) {
    throw statusError('email_sender_domain_invalid', 500);
  }
  if (!/^[a-z0-9.-]+$/.test(domain)) throw statusError('email_sender_domain_invalid', 500);
  return domain;
}

function isLocalEmailSenderDomain(domain: string) {
  return domain === 'localhost' || domain.endsWith('.local');
}

async function usersForRepository(target: any) {
  if (target?.users) return [...target.users.values()];
  if (target?.store?.users) return [...target.store.users.values()];
  const snapshot = target.snapshot ? await target.snapshot() : { users: [] };
  return snapshot.users || [];
}

function statusError(message: string, statusCode: number) {
  const error = new Error(message);
  (error as any).statusCode = statusCode;
  return error;
}
