import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePublicSiteLimit, publicSitesFromServices } from '../packages/core/src/public-sites.ts';
import { PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';

const liveService = (id, overrides = {}) => ({
  id: `service-${id}`,
  projectId: `project-${id}`,
  type: 'web',
  status: 'image-ready',
  updatedAt: `2026-08-${String(id).padStart(2, '0')}T00:00:00.000Z`,
  project: {
    id: `project-${id}`,
    name: `Site ${id}`,
    status: 'ACTIVE',
    organization: { name: `Owner ${id}` },
  },
  domains: [{ domain: `site-${id}.apps.raibit.kr`, verified: true }],
  deployments: [{ id: `deployment-${id}`, deploymentType: 'production', status: 'READY' }],
  ...overrides,
});

test('public sites expose only verified live web services and cap the newest projects at five', () => {
  const rows = [
    ...Array.from({ length: 7 }, (_, index) => liveService(index + 1)),
    liveService(8, { deployments: [{ deploymentType: 'production', status: 'BUILDING' }] }),
    liveService(9, { type: 'worker' }),
    liveService(10, { domains: [{ domain: 'unverified.apps.raibit.kr', verified: false }] }),
    liveService(11, { domains: [{ domain: 'https://invalid.example/path', verified: true }] }),
    liveService(12, { project: { ...liveService(12).project, status: 'ARCHIVED' } }),
    liveService(13, { projectId: 'project-7', project: liveService(7).project, updatedAt: '2026-08-01T00:00:00.000Z' }),
    liveService(14, { deployments: [{ deploymentType: 'preview', status: 'READY' }] }),
    liveService(15, { deployments: [] }),
  ];

  assert.deepEqual(publicSitesFromServices(rows, 99), {
    sites: [7, 6, 5, 4, 3].map((id) => ({
      id: `project-${id}`,
      name: `Site ${id}`,
      owner: `Owner ${id}`,
      status: 'LIVE',
      url: `https://site-${id}.apps.raibit.kr`,
    })),
  });
});

test('public LIVE status follows the orchestrator READY production deployment instead of service build state', () => {
  const imageReadyService = liveService(1, { status: 'image-ready' });
  assert.equal(publicSitesFromServices([imageReadyService], 5).sites.length, 1);
  assert.equal(publicSitesFromServices([
    { ...imageReadyService, deployments: [{ deploymentType: 'production', status: 'IMAGE_READY' }] },
  ], 5).sites.length, 0);
});

test('Prisma public-site lookup is bounded and requires a READY production deployment in the database query', async () => {
  let capturedQuery;
  const repository = new PrismaControlPlaneRepository({
    service: {
      async findMany(query) {
        capturedQuery = query;
        return [liveService(1)];
      },
    },
  });

  const result = await repository.listPublicSites(5);
  assert.equal(result.sites.length, 1);
  assert.equal(capturedQuery.take, 5);
  assert.deepEqual(capturedQuery.where.deployments.some, {
    deploymentType: { in: ['production', 'PRODUCTION'] },
    status: { in: ['ready', 'READY'] },
  });
  assert.equal(capturedQuery.select.deployments.take, 1);
});

test('public site limit normalization is bounded and deterministic', () => {
  assert.equal(normalizePublicSiteLimit(undefined), 5);
  assert.equal(normalizePublicSiteLimit('3.9'), 3);
  assert.equal(normalizePublicSiteLimit(-1), 0);
  assert.equal(normalizePublicSiteLimit(100), 5);
});
