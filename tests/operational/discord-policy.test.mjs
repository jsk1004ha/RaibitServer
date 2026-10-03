import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { ForbiddenException, HttpException } from '@nestjs/common';
import {
  DISCORD_DEFAULT_EVENTS,
  buildDiscordWebhookPayload,
  createNotificationIntent,
  discordSemanticKey,
  eventForNotificationTransition,
  parseDiscordConfiguration,
  parseDiscordWebhookUrl,
} from '@raibitserver/core/discord-alerts';
import { TestDiscordAlertsRepository } from '../../packages/core/src/discord-alerts-memory.ts';
import { PrismaDiscordAlertsRepository } from '../../packages/core/src/discord-alerts-postgres.ts';
import {
  ControlPlaneDiscordProjectAccess,
  DeferredPrismaDiscordAlertsRepository,
  DiscordAlertsService,
} from '../../apps/api/src/modules/integrations/discord.service.ts';
import { OperationalPersistenceUnavailable } from '@raibitserver/core';

const webhookToken = 'abcdefghijklmnopqrstuvwxyz_ABCDEF-1234567890';
const webhookUrl = `https://discord.com/api/webhooks/123456789012345678/${webhookToken}`;
const now = '2026-09-13T03:00:00.000Z';

function subject(id, role, projectIds = ['project-a']) {
  return Object.freeze({
    id,
    projectIds,
    organizationIds: ['org-a'],
    rolesByOrganization: Object.freeze({ 'org-a': role }),
  });
}

function fixtureProjectAccess() {
  return new ControlPlaneDiscordProjectAccess({
    async getProject(projectId, actor) {
      if (projectId !== 'project-a' || !actor.projectIds?.includes(projectId)) throw new ForbiddenException('hidden project');
      return Object.freeze({ id: projectId, organizationId: 'org-a' });
    },
  });
}

function serviceFixture() {
  let id = 0;
  const repository = new TestDiscordAlertsRepository({ idFactory: () => `discord-${++id}` });
  return Object.freeze({
    repository,
    service: new DiscordAlertsService(repository, fixtureProjectAccess(), () => now, 'https://console.example.test'),
  });
}

function validPayload(overrides = {}) {
  return {
    projectId: 'project-a',
    environmentId: 'env-prod',
    logicalSubject: 'api',
    eventCode: 'deployment.failed',
    status: 'FAILED',
    safeErrorCode: 'BUILD_FAILED',
    occurredAt: now,
    shortRevision: 'abcdef0',
    consoleUrl: 'https://console.example.test/projects/project-a',
    ...overrides,
  };
}

test('Given webhook input, when canonical validation runs, then only the exact Discord HTTPS endpoint shape is accepted', () => {
  assert.equal(parseDiscordWebhookUrl(webhookUrl), webhookUrl);
  assert.equal(parseDiscordWebhookUrl(`https://discord.com:443/api/webhooks/123456789012345678/${webhookToken}`), `https://discord.com:443/api/webhooks/123456789012345678/${webhookToken}`);
});

test('Given adversarial webhook inputs, when canonical validation runs, then credentials, query, fragment, redirect, private/IP, host and port variants fail without echoing secrets', () => {
  const invalid = [
    `https://user@discord.com/api/webhooks/123/${webhookToken}`,
    `${webhookUrl}?wait=true`,
    `${webhookUrl}#fragment`,
    `${webhookUrl}/redirect`,
    `https://127.0.0.1/api/webhooks/123/${webhookToken}`,
    `https://10.0.0.1/api/webhooks/123/${webhookToken}`,
    `https://discord.example/api/webhooks/123/${webhookToken}`,
    `https://discord.com:444/api/webhooks/123/${webhookToken}`,
    `http://discord.com/api/webhooks/123/${webhookToken}`,
    `https://DISCORD.com/api/webhooks/123/${webhookToken}`,
  ];
  for (const candidate of invalid) {
    assert.throws(() => parseDiscordWebhookUrl(candidate), error => {
      assert.equal(error.code, 'DISCORD_WEBHOOK_INVALID');
      assert.equal(JSON.stringify(error).includes(webhookToken), false);
      return true;
    });
  }
});

test('Given omitted subscriptions, when configuration is parsed, then prod and terminal-failure events are the exact defaults', () => {
  const parsed = parseDiscordConfiguration({ webhookUrl, expectedVersion: 0 });
  assert.deepEqual(parsed.environments, ['prod']);
  assert.deepEqual(parsed.events, DISCORD_DEFAULT_EVENTS);
  assert.throws(() => parseDiscordConfiguration({ webhookUrl, expectedVersion: 0, allowed_mentions: { parse: ['everyone'] } }), error => error.code === 'DISCORD_INPUT_INVALID');
});

test('Given a frozen safe payload, when Discord content is built, then the payload is allowlisted, bounded and mentions are disabled', () => {
  const outbound = buildDiscordWebhookPayload(validPayload());
  assert.deepEqual(Object.keys(outbound).sort(), ['allowed_mentions', 'content']);
  assert.deepEqual(outbound.allowed_mentions, { parse: [] });
  assert.ok(outbound.content.length <= 2_000);
  assert.deepEqual(Object.keys(JSON.parse(outbound.content)).sort(), [
    'consoleUrl', 'environmentId', 'eventCode', 'logicalSubject', 'occurredAt', 'projectId', 'safeErrorCode', 'shortRevision', 'status',
  ]);
  assert.throws(() => buildDiscordWebhookPayload(validPayload({ logs: 'secret logs' })), error => error.code === 'DISCORD_PAYLOAD_INVALID');
  assert.throws(() => buildDiscordWebhookPayload(validPayload({ logicalSubject: '<@123456789> @everyone' })), error => error.code === 'DISCORD_MENTION_FORBIDDEN');
  assert.throws(() => buildDiscordWebhookPayload(validPayload({ status: 'READY' })), error => error.code === 'DISCORD_PAYLOAD_INVALID');
});

test('Given D4 transitions, when the event matrix is evaluated, then all eight events and retry exhaustion semantics are exact', () => {
  const cases = [
    [{ source: 'deployment', outcome: 'failed', terminal: true }, 'deployment.failed'],
    [{ source: 'deployment', outcome: 'ready', terminal: true }, 'deployment.ready'],
    [{ source: 'runtime', outcome: 'unhealthy', previouslyReady: true, consecutiveFailures: 2, observationGapSeconds: 60 }, 'runtime.unhealthy'],
    [{ source: 'runtime', outcome: 'recovered', incidentOpen: true, verifiedHealthy: true }, 'runtime.recovered'],
    [{ source: 'backup', outcome: 'failed', terminal: true }, 'backup.failed'],
    [{ source: 'backup', outcome: 'ready', terminal: true }, 'backup.ready'],
    [{ source: 'promotion', outcome: 'failed', terminal: true }, 'promotion.failed'],
    [{ source: 'promotion', outcome: 'ready', terminal: true }, 'promotion.ready'],
  ];
  for (const [transition, expected] of cases) assert.equal(eventForNotificationTransition(transition), expected);
  assert.equal(eventForNotificationTransition({ source: 'build', outcome: 'failed', retry: 'scheduled' }), null);
  assert.equal(eventForNotificationTransition({ source: 'build', outcome: 'failed', retry: 'exhausted' }), 'deployment.failed');
  assert.equal(eventForNotificationTransition({ source: 'runtime', outcome: 'unhealthy', previouslyReady: true, consecutiveFailures: 2, observationGapSeconds: 59 }), null);
});

test('Given two intents, when semantic keys are built, then exactly the five frozen identity fields control deduplication', () => {
  const base = {
    destinationId: 'destination-a', destinationVersion: 7, environmentKind: 'prod', eventCode: 'deployment.failed',
    subjectId: 'service-a', subjectGenerationOrIncidentSequence: 3, payload: validPayload(),
  };
  const first = createNotificationIntent(base);
  const changedTimestamp = createNotificationIntent({ ...base, payload: validPayload({ occurredAt: '2026-09-13T04:00:00.000Z' }) });
  assert.equal(discordSemanticKey(first), 'destination-a:7:deployment.failed:service-a:3');
  assert.equal(discordSemanticKey(first), discordSemanticKey(changedTimestamp));
  assert.notEqual(discordSemanticKey(first), discordSemanticKey(createNotificationIntent({ ...base, destinationVersion: 8 })));
});

test('Given an owner and concrete repository, when configure, masked read and explicit test run, then state persists as encrypted data and only an intent is queued', async () => {
  const { repository, service } = serviceFixture();
  const owner = subject('owner-a', 'OWNER');
  const configured = await service.configure('project-a', { webhookUrl, expectedVersion: 0 }, owner);
  const read = await service.read('project-a', owner);
  const queued = await service.test('project-a', { expectedVersion: 1, environmentId: 'env-prod' }, owner);
  const persisted = repository.snapshot();

  assert.deepEqual(configured, read);
  assert.equal(configured.version, 1);
  assert.equal(configured.enabled, true);
  assert.equal(configured.webhookConfigured, true);
  assert.equal(JSON.stringify(configured).includes(webhookToken), false);
  assert.equal(JSON.stringify(configured).includes('webhookUrl'), false);
  assert.match(persisted.destinations[0].sealedWebhookUrl, /^aes256gcm:v1:/);
  assert.equal(persisted.destinations[0].sealedWebhookUrl.includes(webhookToken), false);
  assert.deepEqual(queued, { intentId: 'discord-2', destinationVersion: 1, status: 'pending', queued: true, sentInRequest: false });
  assert.equal(persisted.intents.length, 1);
});

test('Given member, admin and foreign scopes, when Discord operations run, then reads are shared, owner/admin mutate, same-scope forbidden is 403 and foreign is hidden as 404', async () => {
  const { service } = serviceFixture();
  const owner = subject('owner-a', 'OWNER');
  await service.configure('project-a', { webhookUrl, expectedVersion: 0 }, owner);
  assert.equal((await service.read('project-a', subject('member-a', 'VIEWER'))).version, 1);
  await assert.rejects(service.configure('project-a', { webhookUrl, expectedVersion: 1 }, subject('member-a', 'MAINTAINER')), httpError(403, 'DISCORD_FORBIDDEN'));
  assert.equal((await service.configure('project-a', { webhookUrl, expectedVersion: 1 }, subject('admin-a', 'ADMIN'))).version, 2);
  await assert.rejects(service.read('foreign-project', subject('foreign', 'OWNER', ['foreign-project'])), httpError(404, 'DISCORD_DESTINATION_NOT_FOUND'));
});

test('Given stale, rotated and disabled destination state, when mutations run, then stale writes fail and queued old versions are cancelled', async () => {
  const { service } = serviceFixture();
  const owner = subject('owner-a', 'OWNER');
  await service.configure('project-a', { webhookUrl, expectedVersion: 0 }, owner);
  await service.test('project-a', { expectedVersion: 1, environmentId: 'env-prod' }, owner);
  await assert.rejects(service.configure('project-a', { webhookUrl, expectedVersion: 0 }, owner), httpError(409, 'DISCORD_STALE_VERSION'));
  assert.equal((await service.configure('project-a', { webhookUrl, expectedVersion: 1, environments: ['prod', 'dev'] }, owner)).version, 2);
  assert.equal((await service.deliveries('project-a', { limit: '10' }, owner)).rows[0].status, 'cancelled');
  await service.test('project-a', { expectedVersion: 2, environmentId: 'env-dev', environmentKind: 'dev' }, owner);
  assert.equal((await service.disable('project-a', { expectedVersion: 2 }, owner)).version, 3);
  assert.equal((await service.deliveries('project-a', {}, owner)).rows[0].status, 'cancelled');
  await assert.rejects(service.test('project-a', { expectedVersion: 3, environmentId: 'env-prod' }, owner), httpError(404, 'DISCORD_DESTINATION_NOT_FOUND'));
  assert.deepEqual(await service.delete('project-a', { expectedVersion: 3 }, owner), { deleted: true, version: 4 });
  assert.deepEqual(await service.read('project-a', owner), { configured: false });
});

test('Given invalid URL and cursor input, when the public service rejects it, then the typed error envelope contains no submitted URL', async () => {
  const { service } = serviceFixture();
  const owner = subject('owner-a', 'OWNER');
  const invalidUrl = `https://localhost/api/webhooks/123/${webhookToken}`;
  await assert.rejects(service.configure('project-a', { webhookUrl: invalidUrl, expectedVersion: 0 }, owner), error => {
    assert.equal(error.getStatus(), 400);
    assert.deepEqual(error.getResponse(), { error: { code: 'DISCORD_WEBHOOK_INVALID' } });
    assert.equal(JSON.stringify(error.getResponse()).includes(invalidUrl), false);
    return true;
  });
  await assert.rejects(service.deliveries('project-a', { limit: 101 }, owner), httpError(400, 'DISCORD_CURSOR_INVALID'));
});

test('Given default-OFF in-memory composition, when the module constructs lazily, then legacy boot is preserved and only Discord access returns typed 503', async () => {
  let clientRequests = 0;
  const repository = new DeferredPrismaDiscordAlertsRepository(async () => {
    clientRequests += 1;
    throw new OperationalPersistenceUnavailable();
  });
  const service = new DiscordAlertsService(repository, fixtureProjectAccess(), () => now);
  assert.equal(clientRequests, 0);
  await assert.rejects(service.read('project-a', subject('owner-a', 'OWNER')), httpError(503, 'DISCORD_PERSISTENCE_UNAVAILABLE'));
  assert.equal(clientRequests, 1);
});

test('Given the Nest integrations module, when registration is inspected, then the Discord controller, service and concrete shared-client Prisma adapter are registered without replacing GitHub', async () => {
  const source = await readFile(new URL('../../apps/api/src/modules/integrations/integrations.module.ts', import.meta.url), 'utf8');
  assert.match(source, /controllers: \[GitHubIntegrationController, DiscordAlertsController\]/);
  assert.match(source, /provide: DISCORD_ALERTS_REPOSITORY/);
  assert.match(source, /provide: DiscordAlertsService/);
  assert.match(source, /new DeferredPrismaDiscordAlertsRepository\(\(\) => controlPlane\.requireOperationalPrismaClient\(\)\)/);
  assert.doesNotMatch(source, /TestDiscordAlertsRepository/);
  assert.throws(() => new PrismaDiscordAlertsRepository({}), error => error.code === 'DISCORD_PERSISTENCE_UNAVAILABLE');
});

test('Given the actual Nest AppModule, when it boots in default-OFF memory mode, then all Discord routes are registered and the owned port is closed', async () => {
  const { bootParityApi } = await import('../fixtures/api-parity-runtime.mjs');
  const runtime = await bootParityApi();
  try {
    const routes = runtime.routes
      .filter(route => route.path.startsWith('/projects/{projectId}/integrations/discord'))
      .map(({ method, path, permission, status }) => ({ method, path, permission, status }))
      .sort((left, right) => `${left.path}:${left.method}`.localeCompare(`${right.path}:${right.method}`));
    assert.deepEqual(routes, [
      { method: 'delete', path: '/projects/{projectId}/integrations/discord', permission: 'notifications:manage', status: 200 },
      { method: 'get', path: '/projects/{projectId}/integrations/discord', permission: 'notifications:read', status: 200 },
      { method: 'put', path: '/projects/{projectId}/integrations/discord', permission: 'notifications:manage', status: 200 },
      { method: 'get', path: '/projects/{projectId}/integrations/discord/deliveries', permission: 'notifications:read', status: 200 },
      { method: 'post', path: '/projects/{projectId}/integrations/discord/disable', permission: 'notifications:manage', status: 200 },
      { method: 'post', path: '/projects/{projectId}/integrations/discord/test', permission: 'notifications:manage', status: 202 },
    ]);
  } finally {
    await runtime.app.close();
  }
});

function httpError(status, code) {
  return error => {
    assert.ok(error instanceof HttpException);
    assert.equal(error.getStatus(), status);
    assert.deepEqual(error.getResponse(), { error: { code } });
    return true;
  };
}
