import crypto from 'node:crypto';
import {
  DiscordPolicyError,
  discordSemanticKey,
  type DiscordAlertsRepository,
  type DiscordDestinationRecord,
  type DiscordIntentRecord,
} from './discord-alerts.ts';

type TestRepositoryOptions = {
  readonly idFactory?: () => string;
};

/** Deterministic repository fixture. Production composition must use the Task 2 durable adapter. */
export class TestDiscordAlertsRepository implements DiscordAlertsRepository {
  private readonly destinations = new Map<string, DiscordDestinationRecord>();
  private readonly intents = new Map<string, DiscordIntentRecord>();
  private readonly idFactory: () => string;

  constructor(options: TestRepositoryOptions = {}) {
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }

  async getDestination(projectId: string): Promise<DiscordDestinationRecord | null> {
    const row = this.destinations.get(projectId);
    return row?.deletedAt === null ? row : null;
  }

  async upsertDestination(input: Parameters<DiscordAlertsRepository['upsertDestination']>[0]): Promise<DiscordDestinationRecord> {
    const current = this.destinations.get(input.projectId);
    const visibleVersion = current?.deletedAt === null ? current.version : 0;
    if (visibleVersion !== input.expectedVersion) throw new DiscordPolicyError('DISCORD_STALE_VERSION', 409);
    const row = Object.freeze({
      id: current?.id ?? this.idFactory(),
      projectId: input.projectId,
      sealedWebhookUrl: input.sealedWebhookUrl,
      version: (current?.version ?? 0) + 1,
      enabled: true,
      environments: Object.freeze([...input.environments]),
      events: Object.freeze([...input.events]),
      createdAt: current?.createdAt ?? input.now,
      updatedAt: input.now,
      deletedAt: null,
    });
    this.cancelPending(input.projectId, current?.version ?? 0, input.now);
    this.destinations.set(input.projectId, row);
    return row;
  }

  async disableDestination(input: Parameters<DiscordAlertsRepository['disableDestination']>[0]): Promise<DiscordDestinationRecord> {
    const current = this.current(input.projectId, input.expectedVersion);
    const row = Object.freeze({ ...current, version: current.version + 1, enabled: false, updatedAt: input.now });
    this.cancelPending(input.projectId, current.version, input.now);
    this.destinations.set(input.projectId, row);
    return row;
  }

  async deleteDestination(input: Parameters<DiscordAlertsRepository['deleteDestination']>[0]): Promise<{ readonly deleted: true; readonly version: number }> {
    const current = this.current(input.projectId, input.expectedVersion);
    const version = current.version + 1;
    this.cancelPending(input.projectId, current.version, input.now);
    this.destinations.set(input.projectId, Object.freeze({ ...current, version, enabled: false, updatedAt: input.now, deletedAt: input.now }));
    return Object.freeze({ deleted: true, version });
  }

  async createTestIntent(input: Parameters<DiscordAlertsRepository['createTestIntent']>[0]): Promise<DiscordIntentRecord> {
    const destination = this.current(input.projectId, input.expectedDestinationVersion);
    if (!destination.enabled) throw new DiscordPolicyError('DISCORD_DESTINATION_NOT_FOUND', 404);
    const semanticKey = discordSemanticKey(input.intent);
    const duplicate = [...this.intents.values()].find(row => row.semanticKey === semanticKey);
    if (duplicate) return duplicate;
    const row = Object.freeze({
      id: this.idFactory(),
      projectId: input.projectId,
      semanticKey,
      intent: input.intent,
      status: 'pending' as const,
      createdAt: input.now,
      updatedAt: input.now,
    });
    this.intents.set(row.id, row);
    return row;
  }

  async listDeliveries(input: Parameters<DiscordAlertsRepository['listDeliveries']>[0]): Promise<{ readonly rows: readonly DiscordIntentRecord[]; readonly nextCursor: string | null }> {
    const rows = [...this.intents.values()]
      .filter(row => row.projectId === input.projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    const start = input.cursor === null ? 0 : rows.findIndex(row => row.id === decodeCursor(input.cursor)) + 1;
    if (start === 0 && input.cursor !== null) throw new DiscordPolicyError('DISCORD_CURSOR_INVALID', 400);
    const page = rows.slice(start, start + input.limit);
    const nextCursor = start + page.length < rows.length && page.length > 0 ? encodeCursor(page[page.length - 1]?.id ?? '') : null;
    return Object.freeze({ rows: Object.freeze(page), nextCursor });
  }

  snapshot(): { readonly destinations: readonly DiscordDestinationRecord[]; readonly intents: readonly DiscordIntentRecord[] } {
    return Object.freeze({ destinations: Object.freeze([...this.destinations.values()]), intents: Object.freeze([...this.intents.values()]) });
  }

  private current(projectId: string, expectedVersion: number): DiscordDestinationRecord {
    const current = this.destinations.get(projectId);
    if (!current || current.deletedAt !== null) throw new DiscordPolicyError('DISCORD_DESTINATION_NOT_FOUND', 404);
    if (current.version !== expectedVersion) throw new DiscordPolicyError('DISCORD_STALE_VERSION', 409);
    return current;
  }

  private cancelPending(projectId: string, version: number, now: string): void {
    for (const [id, row] of this.intents) {
      if (row.projectId === projectId && row.intent.destinationVersion === version && row.status === 'pending') {
        this.intents.set(id, Object.freeze({ ...row, status: 'cancelled', updatedAt: now }));
      }
    }
  }
}

function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): string {
  try {
    const id = Buffer.from(cursor, 'base64url').toString('utf8');
    if (id.length < 1 || encodeCursor(id) !== cursor) throw new DiscordPolicyError('DISCORD_CURSOR_INVALID', 400);
    return id;
  } catch (error) {
    if (error instanceof DiscordPolicyError) throw error;
    throw new DiscordPolicyError('DISCORD_CURSOR_INVALID', 400);
  }
}
