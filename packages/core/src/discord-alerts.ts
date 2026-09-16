import {
  NotificationPayloadSchema,
  NotificationWriterIntentSchema,
  OperationalEventSchema,
  type NotificationWriterIntent,
  type OperationalEnvironmentKind,
  type OperationalEvent,
} from '@raibitserver/schemas/operational';
import { notificationSemanticKey } from './operational-contract.ts';
import { DiscordPolicyError } from './discord-alert-errors.ts';
export { DiscordPolicyError, type DiscordPolicyErrorCode } from './discord-alert-errors.ts';
export { eventForNotificationTransition, type NotificationTransition } from './discord-alert-events.ts';

export const DISCORD_DEFAULT_EVENTS = Object.freeze([
  'deployment.failed',
  'runtime.unhealthy',
  'backup.failed',
  'promotion.failed',
] satisfies readonly OperationalEvent[]);

export const DISCORD_OPTIONAL_EVENTS = Object.freeze([
  'deployment.ready',
  'runtime.recovered',
  'backup.ready',
  'promotion.ready',
] satisfies readonly OperationalEvent[]);

export const DISCORD_ALERTS_REPOSITORY = Symbol('DiscordAlertsRepository');

export type DiscordConfiguration = {
  readonly webhookUrl: string;
  readonly expectedVersion: number;
  readonly environments: readonly OperationalEnvironmentKind[];
  readonly events: readonly OperationalEvent[];
};

export type DiscordDestinationRecord = {
  readonly id: string;
  readonly projectId: string;
  readonly sealedWebhookUrl: string;
  readonly version: number;
  readonly enabled: boolean;
  readonly environments: readonly OperationalEnvironmentKind[];
  readonly events: readonly OperationalEvent[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
};

export type PublicDiscordDestination = Omit<DiscordDestinationRecord, 'sealedWebhookUrl' | 'deletedAt'> & {
  readonly webhookConfigured: true;
};

export type DiscordIntentRecord = {
  readonly id: string;
  readonly projectId: string;
  readonly semanticKey: string;
  readonly intent: NotificationWriterIntent;
  readonly status: 'pending' | 'sending' | 'succeeded' | 'failed' | 'unknown' | 'cancelled';
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type PublicDiscordDelivery = {
  readonly id: string;
  readonly destinationVersion: number;
  readonly eventCode: OperationalEvent;
  readonly subjectId: string;
  readonly subjectGenerationOrIncidentSequence: number;
  readonly status: DiscordIntentRecord['status'];
  readonly createdAt: string;
  readonly updatedAt: string;
};

export interface DiscordAlertsRepository {
  getDestination(projectId: string): Promise<DiscordDestinationRecord | null>;
  upsertDestination(input: {
    readonly projectId: string;
    readonly expectedVersion: number;
    readonly sealedWebhookUrl: string;
    readonly environments: readonly OperationalEnvironmentKind[];
    readonly events: readonly OperationalEvent[];
    readonly actorUserId: string;
    readonly now: string;
  }): Promise<DiscordDestinationRecord>;
  disableDestination(input: { readonly projectId: string; readonly expectedVersion: number; readonly actorUserId: string; readonly now: string }): Promise<DiscordDestinationRecord>;
  deleteDestination(input: { readonly projectId: string; readonly expectedVersion: number; readonly actorUserId: string; readonly now: string }): Promise<{ readonly deleted: true; readonly version: number }>;
  createTestIntent(input: { readonly projectId: string; readonly expectedDestinationVersion: number; readonly intent: NotificationWriterIntent; readonly actorUserId: string; readonly now: string }): Promise<DiscordIntentRecord>;
  listDeliveries(input: { readonly projectId: string; readonly cursor: string | null; readonly limit: number }): Promise<{ readonly rows: readonly DiscordIntentRecord[]; readonly nextCursor: string | null }>;
}

export function parseDiscordWebhookUrl(value: unknown): string {
  if (typeof value !== 'string' || !/^https:\/\/discord\.com(?::443)?\/api\/webhooks\/[1-9][0-9]*\/[A-Za-z0-9._-]{20,}$/.test(value)) {
    throw new DiscordPolicyError('DISCORD_WEBHOOK_INVALID', 400);
  }
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'discord.com' || (parsed.port !== '' && parsed.port !== '443')
    || parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    throw new DiscordPolicyError('DISCORD_WEBHOOK_INVALID', 400);
  }
  return value;
}

export function parseDiscordConfiguration(input: unknown): DiscordConfiguration {
  if (!isRecord(input) || hasUnknownKeys(input, ['webhookUrl', 'expectedVersion', 'environments', 'events'])) {
    throw new DiscordPolicyError('DISCORD_INPUT_INVALID', 400);
  }
  const expectedVersion = input.expectedVersion;
  if (!Number.isInteger(expectedVersion) || typeof expectedVersion !== 'number' || expectedVersion < 0) {
    throw new DiscordPolicyError('DISCORD_INPUT_INVALID', 400);
  }
  return Object.freeze({
    webhookUrl: parseDiscordWebhookUrl(input.webhookUrl),
    expectedVersion,
    environments: parseEnvironments(input.environments),
    events: parseEvents(input.events),
  });
}

export function parseDiscordExpectedVersion(input: unknown): number {
  if (!isRecord(input) || hasUnknownKeys(input, ['expectedVersion']) || typeof input.expectedVersion !== 'number'
    || !Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new DiscordPolicyError('DISCORD_INPUT_INVALID', 400);
  }
  return input.expectedVersion;
}

export function parseDiscordDeliveryQuery(input: unknown): { readonly cursor: string | null; readonly limit: number } {
  if (!isRecord(input) || hasUnknownKeys(input, ['cursor', 'limit'])) throw new DiscordPolicyError('DISCORD_CURSOR_INVALID', 400);
  let cursor: string | null = null;
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== 'string' || input.cursor.length < 1 || input.cursor.length > 512) {
      throw new DiscordPolicyError('DISCORD_CURSOR_INVALID', 400);
    }
    cursor = input.cursor;
  }
  const numericLimit = input.limit === undefined ? 50 : Number(input.limit);
  if (!Number.isInteger(numericLimit) || numericLimit < 1 || numericLimit > 100) {
    throw new DiscordPolicyError('DISCORD_CURSOR_INVALID', 400);
  }
  return Object.freeze({ cursor, limit: numericLimit });
}

export function publicDiscordDestination(record: DiscordDestinationRecord): PublicDiscordDestination {
  return Object.freeze({
    id: record.id,
    projectId: record.projectId,
    version: record.version,
    enabled: record.enabled,
    environments: record.environments,
    events: record.events,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    webhookConfigured: true,
  });
}

export function publicDiscordDelivery(record: DiscordIntentRecord): PublicDiscordDelivery {
  return Object.freeze({
    id: record.id,
    destinationVersion: record.intent.destinationVersion,
    eventCode: record.intent.eventCode,
    subjectId: record.intent.subjectId,
    subjectGenerationOrIncidentSequence: record.intent.subjectGenerationOrIncidentSequence,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function parseSafeNotificationPayload(input: unknown): NotificationWriterIntent['payload'] {
  const parsed = NotificationPayloadSchema.safeParse(input);
  if (!parsed.success || statusForEvent(parsed.data?.eventCode) !== parsed.data?.status) {
    throw new DiscordPolicyError('DISCORD_PAYLOAD_INVALID', 400);
  }
  if (containsDiscordMention(parsed.data.logicalSubject)) throw new DiscordPolicyError('DISCORD_MENTION_FORBIDDEN', 400);
  const consoleUrl = new URL(parsed.data.consoleUrl);
  if (consoleUrl.username !== '' || consoleUrl.password !== '' || (consoleUrl.hostname === 'discord.com' && consoleUrl.pathname.startsWith('/api/webhooks/'))) {
    throw new DiscordPolicyError('DISCORD_PAYLOAD_INVALID', 400);
  }
  return parsed.data;
}

export function createNotificationIntent(input: Omit<NotificationWriterIntent, 'requiredProtocolVersion' | 'payload'> & { readonly payload: unknown }): NotificationWriterIntent {
  const parsed = NotificationWriterIntentSchema.safeParse({ ...input, requiredProtocolVersion: 2, payload: parseSafeNotificationPayload(input.payload) });
  if (!parsed.success) throw new DiscordPolicyError('DISCORD_PAYLOAD_INVALID', 400);
  return parsed.data;
}

export function discordSemanticKey(intent: NotificationWriterIntent): string {
  return notificationSemanticKey(intent);
}

export function buildDiscordWebhookPayload(input: unknown): { readonly content: string; readonly allowed_mentions: { readonly parse: readonly [] } } {
  const payload = parseSafeNotificationPayload(input);
  const content = JSON.stringify(payload);
  if (content.length > 2_000) throw new DiscordPolicyError('DISCORD_PAYLOAD_INVALID', 400);
  return Object.freeze({ content, allowed_mentions: Object.freeze({ parse: [] as const }) });
}

function parseEnvironments(value: unknown): readonly OperationalEnvironmentKind[] {
  if (value === undefined) return Object.freeze(['prod']);
  if (!Array.isArray(value) || value.length < 1 || value.some(item => item !== 'prod' && item !== 'dev')) {
    throw new DiscordPolicyError('DISCORD_INPUT_INVALID', 400);
  }
  return Object.freeze([...new Set(value)]);
}

function parseEvents(value: unknown): readonly OperationalEvent[] {
  if (value === undefined) return DISCORD_DEFAULT_EVENTS;
  if (!Array.isArray(value) || value.length < 1) throw new DiscordPolicyError('DISCORD_INPUT_INVALID', 400);
  const parsed = value.map(event => OperationalEventSchema.safeParse(event));
  if (parsed.some(result => !result.success)) throw new DiscordPolicyError('DISCORD_INPUT_INVALID', 400);
  return Object.freeze([...new Set(parsed.flatMap(result => result.success ? [result.data] : []))]);
}

function statusForEvent(event: OperationalEvent): NotificationWriterIntent['payload']['status'] {
  switch (event) {
    case 'deployment.failed':
    case 'backup.failed':
    case 'promotion.failed': return 'FAILED';
    case 'runtime.unhealthy': return 'UNHEALTHY';
    case 'deployment.ready':
    case 'backup.ready':
    case 'promotion.ready': return 'READY';
    case 'runtime.recovered': return 'RECOVERED';
    default: return assertNever(event);
  }
}

function containsDiscordMention(value: string): boolean {
  return /@(?:everyone|here)|<@(?:!|&)?[0-9]+>/i.test(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasUnknownKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  return Object.keys(value).some(key => !allowed.includes(key));
}

function assertNever(value: never): never {
  throw new DiscordPolicyError('DISCORD_INPUT_INVALID', 400);
}
