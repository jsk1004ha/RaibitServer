import {
  DiscordPolicyError,
  discordSemanticKey,
  type DiscordAlertsRepository,
  type DiscordDestinationRecord,
  type DiscordIntentRecord,
} from './discord-alerts.ts';
import { array, decodeCursor, destinationRecord, encodeCursor, integer, intentRecord, record, stringField } from './discord-alerts-postgres-codec.ts';

type PrismaDelegate = Readonly<{
  findUnique(input: unknown): Promise<unknown>;
  findMany(input: unknown): Promise<unknown>;
  create(input: unknown): Promise<unknown>;
  update(input: unknown): Promise<unknown>;
  updateMany(input: unknown): Promise<unknown>;
  deleteMany(input: unknown): Promise<unknown>;
  createMany(input: unknown): Promise<unknown>;
}>;

type DiscordPrismaTransaction = Readonly<{
  notificationDestination: PrismaDelegate;
  notificationSubscription: PrismaDelegate;
  notificationIntent: PrismaDelegate;
  environment: PrismaDelegate;
  $executeRawUnsafe(sql: string, ...values: readonly unknown[]): Promise<unknown>;
  $queryRawUnsafe(sql: string, ...values: readonly unknown[]): Promise<unknown>;
}>;

type DiscordPrismaClient = DiscordPrismaTransaction & Readonly<{
  $transaction<T>(work: (transaction: DiscordPrismaTransaction) => Promise<T>): Promise<T>;
}>;

export class PrismaDiscordAlertsRepository implements DiscordAlertsRepository {
  private readonly client: DiscordPrismaClient;

  constructor(client: unknown) {
    if (!isDiscordPrismaClient(client)) throw new DiscordPolicyError('DISCORD_PERSISTENCE_UNAVAILABLE', 503);
    this.client = client;
  }

  async getDestination(projectId: string): Promise<DiscordDestinationRecord | null> {
    const row = await findDestination(this.client, projectId);
    return row && row.deletionRequestedAt === null ? destinationRecord(row) : null;
  }

  async upsertDestination(input: Parameters<DiscordAlertsRepository['upsertDestination']>[0]): Promise<DiscordDestinationRecord> {
    return this.client.$transaction(async transaction => {
      await lockProject(transaction, input.projectId);
      const current = await findDestination(transaction, input.projectId);
      const visibleVersion = current && current.deletionRequestedAt === null ? integer(current.version) : 0;
      if (visibleVersion !== input.expectedVersion) throw new DiscordPolicyError('DISCORD_STALE_VERSION', 409);
      const oldVersion = current ? integer(current.version) : 0;
      const version = oldVersion + 1;
      const destination = current
        ? await transaction.notificationDestination.update({
          where: { id: stringField(current, 'id') },
          data: { sealedWebhookUrl: input.sealedWebhookUrl, encryptionKeyVersion: 'v1', version, enabled: true, deletionRequestedAt: null, updatedAt: new Date(input.now) },
        })
        : await transaction.notificationDestination.create({
          data: { projectId: input.projectId, kind: 'discord', sealedWebhookUrl: input.sealedWebhookUrl, encryptionKeyVersion: 'v1', version, enabled: true, createdAt: new Date(input.now), updatedAt: new Date(input.now) },
        });
      const destinationId = stringField(record(destination), 'id');
      await replaceSubscriptions(transaction, {
        destinationId,
        projectId: input.projectId,
        environments: input.environments,
        events: input.events,
        now: input.now,
      });
      if (oldVersion > 0) await cancelPending(transaction, destinationId, oldVersion);
      const saved = await findDestination(transaction, input.projectId);
      if (!saved) throw new DiscordPolicyError('DISCORD_PERSISTENCE_UNAVAILABLE', 503);
      return destinationRecord(saved);
    });
  }

  async disableDestination(input: Parameters<DiscordAlertsRepository['disableDestination']>[0]): Promise<DiscordDestinationRecord> {
    return this.client.$transaction(async transaction => {
      const current = await currentDestination(transaction, input.projectId, input.expectedVersion);
      const version = integer(current.version) + 1;
      await transaction.notificationDestination.update({
        where: { id: stringField(current, 'id') },
        data: { version, enabled: false, updatedAt: new Date(input.now) },
      });
      await cancelPending(transaction, stringField(current, 'id'), integer(current.version));
      const saved = await findDestination(transaction, input.projectId);
      if (!saved) throw new DiscordPolicyError('DISCORD_PERSISTENCE_UNAVAILABLE', 503);
      return destinationRecord(saved);
    });
  }

  async deleteDestination(input: Parameters<DiscordAlertsRepository['deleteDestination']>[0]): Promise<{ readonly deleted: true; readonly version: number }> {
    return this.client.$transaction(async transaction => {
      const current = await currentDestination(transaction, input.projectId, input.expectedVersion);
      const version = integer(current.version) + 1;
      await transaction.notificationDestination.update({
        where: { id: stringField(current, 'id') },
        data: { version, enabled: false, deletionRequestedAt: new Date(input.now), updatedAt: new Date(input.now) },
      });
      await cancelPending(transaction, stringField(current, 'id'), integer(current.version));
      return Object.freeze({ deleted: true, version });
    });
  }

  async createTestIntent(input: Parameters<DiscordAlertsRepository['createTestIntent']>[0]): Promise<DiscordIntentRecord> {
    return this.client.$transaction(async transaction => {
      const destination = await currentDestination(transaction, input.projectId, input.expectedDestinationVersion);
      if (destination.enabled !== true) throw new DiscordPolicyError('DISCORD_DESTINATION_NOT_FOUND', 404);
      const row = await transaction.notificationIntent.create({
        data: {
          projectId: input.projectId,
          environmentId: input.intent.payload.environmentId,
          destinationId: input.intent.destinationId,
          destinationVersion: input.intent.destinationVersion,
          environmentKind: input.intent.environmentKind,
          eventCode: input.intent.eventCode,
          subjectId: input.intent.subjectId,
          subjectGenerationOrIncidentSequence: input.intent.subjectGenerationOrIncidentSequence,
          dedupKey: discordSemanticKey(input.intent),
          payload: input.intent.payload,
          protocolVersion: 2,
          status: 'pending',
          createdAt: new Date(input.now),
        },
      });
      return intentRecord(record(row));
    });
  }

  async listDeliveries(input: Parameters<DiscordAlertsRepository['listDeliveries']>[0]): Promise<{ readonly rows: readonly DiscordIntentRecord[]; readonly nextCursor: string | null }> {
    const rows = array(await this.client.notificationIntent.findMany({
      where: { projectId: input.projectId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: decodeCursor(input.cursor) }, skip: 1 } : {}),
    })).map(row => intentRecord(record(row)));
    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    const last = page[page.length - 1];
    return Object.freeze({ rows: Object.freeze(page), nextCursor: hasMore && last ? encodeCursor(last.id) : null });
  }
}

async function currentDestination(transaction: DiscordPrismaTransaction, projectId: string, expectedVersion: number): Promise<Readonly<Record<string, unknown>>> {
  await lockProject(transaction, projectId);
  const current = await findDestination(transaction, projectId);
  if (!current || current.deletionRequestedAt !== null) throw new DiscordPolicyError('DISCORD_DESTINATION_NOT_FOUND', 404);
  if (integer(current.version) !== expectedVersion) throw new DiscordPolicyError('DISCORD_STALE_VERSION', 409);
  return current;
}

async function findDestination(transaction: DiscordPrismaTransaction, projectId: string): Promise<Readonly<Record<string, unknown>> | null> {
  const row = await transaction.notificationDestination.findUnique({
    where: { projectId_kind: { projectId, kind: 'discord' } },
    include: { subscriptions: { where: { enabled: true }, orderBy: [{ environmentKind: 'asc' }, { eventCode: 'asc' }] } },
  });
  return row === null ? null : record(row);
}

async function lockProject(transaction: DiscordPrismaTransaction, projectId: string): Promise<void> {
  await transaction.$executeRawUnsafe("SET LOCAL raibitserver.operational_protocol = '2'");
  await transaction.$queryRawUnsafe('SELECT id FROM "Project" WHERE id=$1 FOR UPDATE', projectId);
}

async function replaceSubscriptions(transaction: DiscordPrismaTransaction, input: {
  readonly destinationId: string;
  readonly projectId: string;
  readonly environments: readonly ('prod' | 'dev')[];
  readonly events: readonly string[];
  readonly now: string;
}): Promise<void> {
  const environments = array(await transaction.environment.findMany({
    where: { projectId: input.projectId, kind: { in: input.environments }, status: 'active' },
    select: { id: true, kind: true },
  })).map(record);
  const kinds = new Set(environments.map(row => stringField(row, 'kind')));
  if (input.environments.some(kind => !kinds.has(kind))) throw new DiscordPolicyError('DISCORD_INPUT_INVALID', 400);
  await transaction.notificationSubscription.deleteMany({ where: { destinationId: input.destinationId } });
  await transaction.notificationSubscription.createMany({
    data: environments.flatMap(environment => input.events.map(eventCode => ({
      projectId: input.projectId,
      destinationId: input.destinationId,
      environmentId: stringField(environment, 'id'),
      environmentKind: stringField(environment, 'kind'),
      eventCode,
      enabled: true,
      createdAt: new Date(input.now),
      updatedAt: new Date(input.now),
    }))),
  });
}

async function cancelPending(transaction: DiscordPrismaTransaction, destinationId: string, destinationVersion: number): Promise<void> {
  await transaction.notificationIntent.updateMany({ where: { destinationId, destinationVersion, status: 'pending' }, data: { status: 'cancelled' } });
}

function isDiscordPrismaClient(value: unknown): value is DiscordPrismaClient {
  return typeof value === 'object' && value !== null
    && '$transaction' in value && typeof value.$transaction === 'function'
    && '$executeRawUnsafe' in value && typeof value.$executeRawUnsafe === 'function'
    && '$queryRawUnsafe' in value && typeof value.$queryRawUnsafe === 'function'
    && 'notificationDestination' in value && isPrismaDelegate(value.notificationDestination)
    && 'notificationSubscription' in value && isPrismaDelegate(value.notificationSubscription)
    && 'notificationIntent' in value && isPrismaDelegate(value.notificationIntent)
    && 'environment' in value && isPrismaDelegate(value.environment);
}

function isPrismaDelegate(value: unknown): value is PrismaDelegate {
  return typeof value === 'object' && value !== null
    && ['findUnique', 'findMany', 'create', 'update', 'updateMany', 'deleteMany', 'createMany']
      .every(method => method in value && typeof value[method] === 'function');
}
