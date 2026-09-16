import {
  buildEmailVerificationMessage,
  deliverEmailVerificationMessage,
  emailVerificationSalt,
  emailVerificationSecret,
  generateEmailVerificationCode,
  hashEmailVerificationCode,
  normalizeEmailVerificationCode,
  verifyEmailVerificationCodeHash,
} from './email-verification.ts';
import { hashPasswordAsync, normalizeEmail } from './identity.ts';

export const PASSWORD_RESET_PURPOSE = 'password-reset';
export const PASSWORD_RESET_TTL_SECONDS = 10 * 60;
export const PASSWORD_RESET_MAX_ATTEMPTS = 5;
export const PASSWORD_RESET_COOLDOWN_SECONDS = 60;

export type PasswordRecoveryRecord = Readonly<{
  id: string;
  codeHash: string;
  codeSalt: string;
}>;

export type PasswordRecoveryCompletionInput = Readonly<{
  email: string;
  purpose: string;
  passwordHash: string;
  maxAttempts: number;
  now: number;
  verifyCode(record: PasswordRecoveryRecord): boolean;
}>;

export type PasswordRecoveryDeliveryFailureInput = Readonly<{
  challengeId: string;
  failedAt: string;
  reasonCode: 'password_reset_delivery_failed';
}>;

type PasswordRecoveryRepository = Readonly<{
  findUserByEmail(email: string): unknown | Promise<unknown>;
  replaceEmailVerificationCode(input: Readonly<Record<string, unknown>>): unknown | Promise<unknown>;
  completePasswordRecovery(input: PasswordRecoveryCompletionInput): unknown | Promise<unknown>;
  failPasswordRecoveryDelivery(input: PasswordRecoveryDeliveryFailureInput): unknown | Promise<unknown>;
  recordEmailDelivery?(input: Readonly<Record<string, unknown>>): unknown | Promise<unknown>;
}>;

type PasswordRecoveryOptions = Readonly<{
  jwtSecret: string;
  env?: Record<string, unknown>;
  now?: number;
  scheduleDelivery?: (task: () => void) => void;
  operatorAlert?: (event: Readonly<{ code: 'password_reset_delivery_failed'; challengeId: string }>) => void;
}>;

export async function requestPasswordRecovery(
  repository: PasswordRecoveryRepository,
  input: Readonly<{ email: string }>,
  options: PasswordRecoveryOptions,
) {
  const env = options.env ?? process.env;
  const email = normalizeEmail(input.email);
  const user = await repository.findUserByEmail(email);
  const deliverableUser = passwordRecoveryUser(user, options.now ?? Date.now());
  const code = generateEmailVerificationCode(env);
  const codeSalt = emailVerificationSalt();
  const codeHash = hashEmailVerificationCode({
    email,
    code,
    codeSalt,
    secret: emailVerificationSecret(options.jwtSecret, env),
  });
  const now = new Date(options.now ?? Date.now());
  const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TTL_SECONDS * 1_000).toISOString();
  const challenge = passwordRecoveryRecord(await repository.replaceEmailVerificationCode({
    userId: deliverableUser?.id ?? null,
    email,
    purpose: PASSWORD_RESET_PURPOSE,
    payload: deliverableUser
      ? { kind: PASSWORD_RESET_PURPOSE, userId: deliverableUser.id }
      : { kind: 'request-padding' },
    codeHash,
    codeSalt,
    expiresAt,
    sentAt: now.toISOString(),
    attempts: 0,
  }));

  scheduleDelivery(options, async () => {
    if (!deliverableUser) return;
    try {
      const message = passwordResetMessage(email, code, expiresAt, env);
      const delivery = deliveryResult(await deliverEmailVerificationMessage(message, env));
      await repository.recordEmailDelivery?.({
        ...message,
        purpose: PASSWORD_RESET_PURPOSE,
        deliveryMode: delivery.mode,
        messageId: delivery.messageId,
        sentAt: now.toISOString(),
      });
    } catch {
      try {
        await repository.failPasswordRecoveryDelivery({
          challengeId: challenge.id,
          failedAt: new Date().toISOString(),
          reasonCode: 'password_reset_delivery_failed',
        });
      } finally {
        const event = { code: 'password_reset_delivery_failed', challengeId: challenge.id } as const;
        if (options.operatorAlert) options.operatorAlert(event);
        else console.error('[raibitserver] password_reset_delivery_failed');
      }
    }
  });

  return { accepted: true } as const;
}

export async function completePasswordRecovery(
  repository: PasswordRecoveryRepository,
  input: Readonly<{ email: string; code: string; newPassword: string }>,
  options: PasswordRecoveryOptions,
) {
  const env = options.env ?? process.env;
  const email = normalizeEmail(input.email);
  const code = normalizeEmailVerificationCode(input.code);
  const passwordHash = await hashPasswordAsync(input.newPassword);
  const secret = emailVerificationSecret(options.jwtSecret, env);
  const result = await repository.completePasswordRecovery({
    email,
    purpose: PASSWORD_RESET_PURPOSE,
    passwordHash,
    maxAttempts: PASSWORD_RESET_MAX_ATTEMPTS,
    now: options.now ?? Date.now(),
    verifyCode: (record: PasswordRecoveryRecord) => verifyEmailVerificationCodeHash({
      email,
      code,
      codeHash: record.codeHash,
      codeSalt: record.codeSalt,
      secret,
    }),
  });
  if (!passwordRecoveryCompleted(result)) {
    throw passwordRecoveryError('invalid_or_expired_password_reset_code', 403);
  }
  return { reset: true } as const;
}

function passwordRecoveryUser(value: unknown, now: number): Readonly<{ id: string }> | null {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.passwordHash !== 'string'
    || value.passwordHash.length === 0
    || !value.emailVerifiedAt
    || String(value.approvalStatus ?? 'PENDING').toUpperCase() !== 'APPROVED'
    || activeBan(value, now)) return null;
  return { id: value.id };
}

function activeBan(user: Readonly<Record<string, unknown>>, now = Date.now()) {
  if (!user.bannedAt) return false;
  if (!user.banExpiresAt) return true;
  const expiresAt = new Date(String(user.banExpiresAt)).getTime();
  return !Number.isFinite(expiresAt) || expiresAt > now;
}

function passwordRecoveryRecord(value: unknown): PasswordRecoveryRecord {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.codeHash !== 'string'
    || typeof value.codeSalt !== 'string') {
    throw passwordRecoveryError('password_reset_challenge_persistence_failed', 500);
  }
  return { id: value.id, codeHash: value.codeHash, codeSalt: value.codeSalt };
}

function passwordRecoveryCompleted(value: unknown) {
  return isRecord(value) && value.status === 'reset';
}

function deliveryResult(value: unknown): Readonly<{ mode: string; messageId: string | null }> {
  if (!isRecord(value) || typeof value.mode !== 'string') {
    throw passwordRecoveryError('password_reset_delivery_result_invalid', 500);
  }
  return { mode: value.mode, messageId: typeof value.messageId === 'string' ? value.messageId : null };
}

function passwordResetMessage(email: string, code: string, expiresAt: string, env: Record<string, unknown>) {
  const base = buildEmailVerificationMessage({ email, code, expiresAt, env, appName: 'RAIBITSERVER' });
  return {
    ...base,
    subject: 'RAIBITSERVER 비밀번호 재설정 코드',
    text: [
      `RAIBITSERVER 비밀번호 재설정 코드: ${code}`,
      '',
      '이 코드는 10분 후 만료됩니다.',
      '본인이 요청하지 않았다면 이 메일을 무시하세요.',
    ].join('\n'),
  };
}

function scheduleDelivery(options: PasswordRecoveryOptions, task: () => Promise<void>) {
  const schedule = options.scheduleDelivery ?? ((callback: () => void) => setTimeout(callback, 0));
  try {
    schedule(() => { void task().catch(() => {}); });
  } catch {
    void task().catch(() => {});
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function passwordRecoveryError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode });
}
