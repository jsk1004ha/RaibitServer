import crypto from 'node:crypto';
import { deliverEmailVerificationMessage, emailVerificationSenderFromEnv } from './email-verification.ts';
import { normalizeEmail } from './identity.ts';
import { parseOrganizationMembershipRoleForMutation, type OrganizationMembershipRole } from './rbac.ts';

export const ORGANIZATION_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export type OrganizationInviteRecord = {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly role: OrganizationMembershipRole;
  readonly tokenHash: string;
  readonly tokenVersion: number;
  readonly invitedByUserId: string;
  readonly expiresAt: string;
  readonly acceptedAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
};

export type OrganizationInviteView = Omit<OrganizationInviteRecord, 'tokenHash'>;
export type OrganizationInviteAcceptance =
  | { readonly status: 'accepted'; readonly membership: { readonly organizationId: string; readonly role: OrganizationMembershipRole } }
  | { readonly status: 'already_member' };

export type ReplaceOrganizationInviteInput = Pick<OrganizationInviteRecord, 'id' | 'organizationId' | 'email' | 'role' | 'tokenHash' | 'invitedByUserId' | 'expiresAt' | 'createdAt'>;

export interface OrganizationInviteRepository {
  replaceOrganizationInvite(input: ReplaceOrganizationInviteInput): Promise<OrganizationInviteRecord> | OrganizationInviteRecord;
  revokeOrganizationInviteAfterDeliveryFailure(id: string, revokedAt: string): Promise<void> | void;
  acceptOrganizationInvite(input: { readonly tokenHash: string; readonly userId: string; readonly now: string }): Promise<OrganizationInviteAcceptance | null> | OrganizationInviteAcceptance | null;
  listOrganizationInvites(input: { readonly organizationId: string; readonly actorUserId: string }): Promise<readonly OrganizationInviteRecord[]> | readonly OrganizationInviteRecord[];
}

export type OrganizationInviteDelivery = (message: {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly acceptanceUrl: string;
}) => Promise<void>;

export class OrganizationInviteError extends Error {
  readonly name = 'OrganizationInviteError';
  readonly code: 'organization_invite_forbidden' | 'organization_invite_input_invalid' | 'organization_invite_invalid' | 'organization_invite_url_invalid' | 'organization_invite_delivery_failed';
  readonly statusCode: 400 | 403 | 502;
  constructor(code: OrganizationInviteError['code'], statusCode: OrganizationInviteError['statusCode']) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function hashOrganizationInviteToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('base64url');
}

export async function issueOrganizationInvite(
  repository: OrganizationInviteRepository,
  input: { readonly organizationId: string; readonly email: unknown; readonly role: unknown; readonly actorUserId: string },
  options: { readonly env?: Readonly<Record<string, string | undefined>>; readonly now?: Date; readonly deliver?: OrganizationInviteDelivery } = {},
): Promise<{ readonly invite: OrganizationInviteView; readonly delivery: { readonly accepted: true } }> {
  const role = parseInviteRole(input.role);
  if (typeof input.email !== 'string') throw new OrganizationInviteError('organization_invite_input_invalid', 400);
  const email = normalizeEmail(input.email);
  const now = options.now ?? new Date();
  const token = crypto.randomBytes(32).toString('base64url');
  const invite = await repository.replaceOrganizationInvite({
    id: crypto.randomUUID(), organizationId: input.organizationId, email, role,
    tokenHash: hashOrganizationInviteToken(token), invitedByUserId: input.actorUserId,
    expiresAt: new Date(now.getTime() + ORGANIZATION_INVITE_TTL_MS).toISOString(), createdAt: now.toISOString(),
  });
  try {
    const acceptanceUrl = organizationInviteAcceptanceUrl(token, options.env);
    const message = buildOrganizationInviteMessage({ email, role, acceptanceUrl, expiresAt: invite.expiresAt, env: options.env });
    if (options.deliver) await options.deliver(message);
    else await deliverEmailVerificationMessage(message, { ...process.env, ...options.env, RAIBITSERVER_EMAIL_LOG: '0' });
  } catch (error) {
    await repository.revokeOrganizationInviteAfterDeliveryFailure(invite.id, new Date().toISOString());
    if (error instanceof OrganizationInviteError) throw error;
    throw new OrganizationInviteError('organization_invite_delivery_failed', 502);
  }
  return { invite: publicOrganizationInvite(invite), delivery: { accepted: true } };
}

export async function acceptOrganizationInvite(
  repository: OrganizationInviteRepository,
  input: { readonly token: unknown; readonly userId: string; readonly now?: Date },
): Promise<OrganizationInviteAcceptance> {
  if (typeof input.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.token)) throw new OrganizationInviteError('organization_invite_invalid', 403);
  const accepted = await repository.acceptOrganizationInvite({ tokenHash: hashOrganizationInviteToken(input.token), userId: input.userId, now: (input.now ?? new Date()).toISOString() });
  if (!accepted) throw new OrganizationInviteError('organization_invite_invalid', 403);
  return accepted;
}

export async function listOrganizationInvites(repository: OrganizationInviteRepository, input: { readonly organizationId: string; readonly actorUserId: string }): Promise<{ readonly invites: readonly OrganizationInviteView[] }> {
  const rows = await repository.listOrganizationInvites(input);
  return { invites: rows.map(publicOrganizationInvite) };
}

export function publicOrganizationInvite(invite: OrganizationInviteRecord): OrganizationInviteView {
  const { tokenHash: _tokenHash, ...view } = invite;
  return view;
}

function parseInviteRole(value: unknown): OrganizationMembershipRole {
  const parsed = parseOrganizationMembershipRoleForMutation(value);
  if (!parsed.ok) throw new OrganizationInviteError('organization_invite_input_invalid', 400);
  return parsed.role;
}

function organizationInviteAcceptanceUrl(token: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  if (env.NODE_ENV === 'production' && !env.RAIBITSERVER_APP_URL) throw new OrganizationInviteError('organization_invite_url_invalid', 400);
  const configured = env.RAIBITSERVER_APP_URL ?? 'http://localhost:3000';
  let base: URL;
  try { base = new URL(configured); }
  catch { throw new OrganizationInviteError('organization_invite_url_invalid', 400); }
  const local = ['localhost', '127.0.0.1', '::1'].includes(base.hostname);
  const localDevelopmentUrl = env.NODE_ENV !== 'production' && base.protocol === 'http:' && local;
  if ((base.protocol !== 'https:' && !localDevelopmentUrl) || base.username || base.password || base.search || base.hash) {
    throw new OrganizationInviteError('organization_invite_url_invalid', 400);
  }
  base.pathname = '/organization-invites/accept';
  base.searchParams.set('token', token);
  return base.href;
}

function buildOrganizationInviteMessage(input: { readonly email: string; readonly role: OrganizationMembershipRole; readonly acceptanceUrl: string; readonly expiresAt: string; readonly env?: Readonly<Record<string, string | undefined>> }) {
  return {
    from: emailVerificationSenderFromEnv({ ...process.env, ...input.env }), to: input.email,
    subject: 'RAIBITSERVER 조직 초대', acceptanceUrl: input.acceptanceUrl,
    text: `RAIBITSERVER 조직 초대 (${input.role})\n${input.acceptanceUrl}\n만료: ${input.expiresAt}`,
  };
}
