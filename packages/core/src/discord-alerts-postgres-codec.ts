import { NotificationWriterIntentSchema, OperationalEventSchema } from '@raibitserver/schemas/operational';
import { DiscordPolicyError, type DiscordDestinationRecord, type DiscordIntentRecord } from './discord-alerts.ts';

export function destinationRecord(row: Readonly<Record<string, unknown>>): DiscordDestinationRecord {
  const subscriptions = array(row.subscriptions).map(record);
  const environments = [...new Set(subscriptions.map(item => stringField(item, 'environmentKind')).filter(kind => kind === 'prod' || kind === 'dev'))];
  const events = subscriptions.map(item => stringField(item, 'eventCode')).map(value => {
    const parsed = OperationalEventSchema.safeParse(value);
    if (!parsed.success) throw unavailable();
    return parsed.data;
  });
  return Object.freeze({
    id: stringField(row, 'id'),
    projectId: stringField(row, 'projectId'),
    sealedWebhookUrl: stringField(row, 'sealedWebhookUrl'),
    version: integer(row.version),
    enabled: row.enabled === true,
    environments,
    events,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    deletedAt: row.deletionRequestedAt === null ? null : iso(row.deletionRequestedAt),
  });
}

export function intentRecord(row: Readonly<Record<string, unknown>>): DiscordIntentRecord {
  const parsed = NotificationWriterIntentSchema.safeParse({
    requiredProtocolVersion: row.protocolVersion,
    destinationId: row.destinationId,
    destinationVersion: row.destinationVersion,
    environmentKind: row.environmentKind,
    eventCode: row.eventCode,
    subjectId: row.subjectId,
    subjectGenerationOrIncidentSequence: row.subjectGenerationOrIncidentSequence,
    payload: row.payload,
  });
  if (!parsed.success) throw unavailable();
  const status = row.status;
  if (status !== 'pending' && status !== 'sending' && status !== 'succeeded' && status !== 'failed' && status !== 'unknown' && status !== 'cancelled') throw unavailable();
  const createdAt = iso(row.createdAt);
  return Object.freeze({
    id: stringField(row, 'id'),
    projectId: stringField(row, 'projectId'),
    semanticKey: stringField(row, 'dedupKey'),
    intent: parsed.data,
    status,
    createdAt,
    updatedAt: createdAt,
  });
}

export function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw unavailable();
  return value;
}

export function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw unavailable();
  return value;
}

export function stringField(row: Readonly<Record<string, unknown>>, field: string): string {
  const value = row[field];
  if (typeof value !== 'string' || value.length < 1) throw unavailable();
  return value;
}

export function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw unavailable();
  return value;
}

export function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (id.length < 1 || encodeCursor(id) !== cursor) throw new DiscordPolicyError('DISCORD_CURSOR_INVALID', 400);
  return id;
}

function iso(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  throw unavailable();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unavailable(): DiscordPolicyError {
  return new DiscordPolicyError('DISCORD_PERSISTENCE_UNAVAILABLE', 503);
}
