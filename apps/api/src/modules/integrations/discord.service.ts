import { HttpException } from '@nestjs/common';
import {
  DiscordPolicyError,
  OperationalPersistenceUnavailable,
  createNotificationIntent,
  parseDiscordConfiguration,
  parseDiscordDeliveryQuery,
  parseDiscordExpectedVersion,
  PrismaDiscordAlertsRepository,
  publicDiscordDelivery,
  publicDiscordDestination,
  sealSecret,
  type DiscordAlertsRepository,
} from '@raibitserver/core';

export const DISCORD_PROJECT_ACCESS = Symbol('DiscordProjectAccess');

export type DiscordSubject = Readonly<Record<string, unknown>>;

export interface DiscordProjectAccess {
  authorize(projectId: string, subject: DiscordSubject): Promise<{ readonly projectId: string; readonly organizationId: string; readonly role: string }>;
}

type DiscordControlPlane = {
  readonly getProject: (projectId: string, subject: DiscordSubject) => Promise<unknown>;
};

export class ControlPlaneDiscordProjectAccess implements DiscordProjectAccess {
  private readonly controlPlane: DiscordControlPlane;

  constructor(controlPlane: DiscordControlPlane) {
    this.controlPlane = controlPlane;
  }

  async authorize(projectId: string, subject: DiscordSubject): Promise<{ readonly projectId: string; readonly organizationId: string; readonly role: string }> {
    let project: unknown;
    try {
      project = await this.controlPlane.getProject(projectId, subject);
    } catch (error) {
      if (httpStatus(error) === 403 || httpStatus(error) === 404) throw new DiscordPolicyError('DISCORD_DESTINATION_NOT_FOUND', 404);
      throw error;
    }
    if (!isRecord(project) || typeof project.id !== 'string' || typeof project.organizationId !== 'string') {
      throw new DiscordPolicyError('DISCORD_PERSISTENCE_UNAVAILABLE', 503);
    }
    return Object.freeze({ projectId: project.id, organizationId: project.organizationId, role: roleForSubject(subject, project.organizationId) });
  }
}

export class DeferredPrismaDiscordAlertsRepository implements DiscordAlertsRepository {
  private readonly clientFactory: () => Promise<unknown>;

  constructor(clientFactory: () => Promise<unknown>) {
    this.clientFactory = clientFactory;
  }

  async getDestination(projectId: string) { return (await this.target()).getDestination(projectId); }
  async upsertDestination(input: Parameters<DiscordAlertsRepository['upsertDestination']>[0]) { return (await this.target()).upsertDestination(input); }
  async disableDestination(input: Parameters<DiscordAlertsRepository['disableDestination']>[0]) { return (await this.target()).disableDestination(input); }
  async deleteDestination(input: Parameters<DiscordAlertsRepository['deleteDestination']>[0]) { return (await this.target()).deleteDestination(input); }
  async createTestIntent(input: Parameters<DiscordAlertsRepository['createTestIntent']>[0]) { return (await this.target()).createTestIntent(input); }
  async listDeliveries(input: Parameters<DiscordAlertsRepository['listDeliveries']>[0]) { return (await this.target()).listDeliveries(input); }

  private async target(): Promise<PrismaDiscordAlertsRepository> {
    try {
      return new PrismaDiscordAlertsRepository(await this.clientFactory());
    } catch (error) {
      if (error instanceof OperationalPersistenceUnavailable) throw new DiscordPolicyError('DISCORD_PERSISTENCE_UNAVAILABLE', 503);
      throw error;
    }
  }
}

export class DiscordAlertsService {
  private readonly repository: DiscordAlertsRepository;
  private readonly projectAccess: DiscordProjectAccess;
  private readonly clock: () => string;
  private readonly consoleBaseUrl: string;

  constructor(repository: DiscordAlertsRepository, projectAccess: DiscordProjectAccess, clock: () => string = () => new Date().toISOString(), consoleBaseUrl = 'https://app.raibitserver.local') {
    this.repository = repository;
    this.projectAccess = projectAccess;
    this.clock = clock;
    this.consoleBaseUrl = consoleBaseUrl;
  }

  read(projectId: string, subject: DiscordSubject) {
    return this.boundary(async () => {
      await this.projectAccess.authorize(projectId, subject);
      const destination = await this.repository.getDestination(projectId);
      return destination ? publicDiscordDestination(destination) : Object.freeze({ configured: false });
    });
  }

  configure(projectId: string, input: unknown, subject: DiscordSubject) {
    return this.boundary(async () => {
      const access = await this.authorizeManage(projectId, subject);
      const parsed = parseDiscordConfiguration(input);
      const destination = await this.repository.upsertDestination({
        projectId,
        expectedVersion: parsed.expectedVersion,
        sealedWebhookUrl: sealSecret(parsed.webhookUrl),
        environments: parsed.environments,
        events: parsed.events,
        actorUserId: subjectId(subject),
        now: this.clock(),
      });
      if (destination.projectId !== access.projectId) throw new DiscordPolicyError('DISCORD_PERSISTENCE_UNAVAILABLE', 503);
      return publicDiscordDestination(destination);
    });
  }

  disable(projectId: string, input: unknown, subject: DiscordSubject) {
    return this.boundary(async () => {
      await this.authorizeManage(projectId, subject);
      const destination = await this.repository.disableDestination({
        projectId,
        expectedVersion: parseDiscordExpectedVersion(input),
        actorUserId: subjectId(subject),
        now: this.clock(),
      });
      return publicDiscordDestination(destination);
    });
  }

  delete(projectId: string, input: unknown, subject: DiscordSubject) {
    return this.boundary(async () => {
      await this.authorizeManage(projectId, subject);
      return this.repository.deleteDestination({
        projectId,
        expectedVersion: parseDiscordExpectedVersion(input),
        actorUserId: subjectId(subject),
        now: this.clock(),
      });
    });
  }

  test(projectId: string, input: unknown, subject: DiscordSubject) {
    return this.boundary(async () => {
      await this.authorizeManage(projectId, subject);
      const parsed = parseTestInput(input);
      const destination = await this.repository.getDestination(projectId);
      if (!destination || !destination.enabled) throw new DiscordPolicyError('DISCORD_DESTINATION_NOT_FOUND', 404);
      if (destination.version !== parsed.expectedVersion) throw new DiscordPolicyError('DISCORD_STALE_VERSION', 409);
      const now = this.clock();
      const sequence = Date.parse(now);
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw new DiscordPolicyError('DISCORD_INPUT_INVALID', 400);
      const intent = createNotificationIntent({
        destinationId: destination.id,
        destinationVersion: destination.version,
        environmentKind: parsed.environmentKind,
        eventCode: 'deployment.failed',
        subjectId: 'discord-test',
        subjectGenerationOrIncidentSequence: sequence,
        payload: {
          projectId,
          environmentId: parsed.environmentId,
          logicalSubject: 'Discord notification test',
          eventCode: 'deployment.failed',
          status: 'FAILED',
          safeErrorCode: 'DISCORD_TEST',
          occurredAt: now,
          shortRevision: '0000000',
          consoleUrl: `${this.consoleBaseUrl}/projects/${encodeURIComponent(projectId)}/notifications`,
        },
      });
      const row = await this.repository.createTestIntent({ projectId, expectedDestinationVersion: destination.version, intent, actorUserId: subjectId(subject), now });
      return Object.freeze({ intentId: row.id, destinationVersion: row.intent.destinationVersion, status: row.status, queued: true, sentInRequest: false });
    });
  }

  deliveries(projectId: string, input: unknown, subject: DiscordSubject) {
    return this.boundary(async () => {
      await this.projectAccess.authorize(projectId, subject);
      const query = parseDiscordDeliveryQuery(input);
      const page = await this.repository.listDeliveries({ projectId, ...query });
      return Object.freeze({ rows: Object.freeze(page.rows.map(publicDiscordDelivery)), nextCursor: page.nextCursor });
    });
  }

  private async authorizeManage(projectId: string, subject: DiscordSubject) {
    const access = await this.projectAccess.authorize(projectId, subject);
    if (access.role !== 'OWNER' && access.role !== 'ADMIN') throw new DiscordPolicyError('DISCORD_FORBIDDEN', 403);
    return access;
  }

  private async boundary<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof DiscordPolicyError) throw new HttpException(Object.freeze({ error: Object.freeze({ code: error.code }) }), error.statusCode);
      throw error;
    }
  }
}

function parseTestInput(input: unknown): { readonly expectedVersion: number; readonly environmentId: string; readonly environmentKind: 'prod' | 'dev' } {
  if (!isRecord(input) || Object.keys(input).some(key => !['expectedVersion', 'environmentId', 'environmentKind'].includes(key))
    || typeof input.expectedVersion !== 'number' || !Number.isInteger(input.expectedVersion) || input.expectedVersion < 1
    || typeof input.environmentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input.environmentId)
    || (input.environmentKind !== undefined && input.environmentKind !== 'prod' && input.environmentKind !== 'dev')) {
    throw new DiscordPolicyError('DISCORD_INPUT_INVALID', 400);
  }
  const environmentKind = input.environmentKind === 'dev' ? 'dev' : 'prod';
  return Object.freeze({ expectedVersion: input.expectedVersion, environmentId: input.environmentId, environmentKind });
}

function subjectId(subject: DiscordSubject): string {
  if (typeof subject.id !== 'string' || subject.id.length < 1) throw new DiscordPolicyError('DISCORD_FORBIDDEN', 403);
  return subject.id;
}

function roleForSubject(subject: DiscordSubject, organizationId: string): string {
  if (isRecord(subject.rolesByOrganization) && typeof subject.rolesByOrganization[organizationId] === 'string') {
    return subject.rolesByOrganization[organizationId].toUpperCase();
  }
  if (typeof subject.role === 'string') return subject.role.toUpperCase();
  return 'VIEWER';
}

function httpStatus(error: unknown): number | null {
  if (error instanceof HttpException) return error.getStatus();
  if (isRecord(error) && typeof error.statusCode === 'number') return error.statusCode;
  return null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
