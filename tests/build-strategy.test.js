import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBuildStrategy } from '../packages/core/src/build-strategy.ts';
import { buildExecutionPlan } from '../packages/core/src/build-executor.ts';
import { discoverSource, normalizeSourcePath } from '../packages/core/src/source-discovery.ts';

const nodeFiles = {
  'package.json': JSON.stringify({ dependencies: { next: 'latest' }, scripts: { build: 'next build', start: 'next start' } }),
};

test('Dockerfile wins over framework detection and custom defaults', () => {
  const plan = resolveBuildStrategy({ name: 'api', projectSlug: 'demo', dockerfilePath: 'apps/api/Dockerfile' }, nodeFiles);
  assert.equal(plan.mode, 'dockerfile');
  assert.equal(plan.buildSteps.some((step) => step.type === 'docker-build'), true);
  assert.equal(plan.pipeline.at(-1), 'domain-and-tls');
});

test('custom build command wins when no Dockerfile is configured', () => {
  const plan = resolveBuildStrategy({ name: 'worker', projectSlug: 'demo', buildCommand: 'pnpm build', startCommand: 'node dist/worker.js' }, nodeFiles);
  assert.equal(plan.mode, 'custom');
  assert.equal(plan.runtime.startCommand, 'node dist/worker.js');
});

test('auto detection resolves Next.js into container image plan', () => {
  const plan = resolveBuildStrategy({ name: 'web', projectSlug: 'demo' }, nodeFiles);
  assert.equal(plan.mode, 'framework');
  assert.equal(plan.framework.framework, 'nextjs');
  assert.match(plan.image, /registry\.raibitserver\.local\/demo\/web:latest/);
  assert.equal(plan.controls.previewDeployments, true);
});

test('auto detection normalizes monorepo paths and gives Dockerfile priority', () => {
  const files = {
    'apps\\web\\package.json': JSON.stringify({ dependencies: { next: 'latest' } }),
    'apps/web/pnpm-lock.yaml': 'lockfileVersion: 9',
    'apps/web/Dockerfile': 'FROM node:24-alpine',
  };
  const plan = resolveBuildStrategy({ name: 'web', projectSlug: 'demo' }, files);
  assert.equal(plan.mode, 'dockerfile');
  assert.equal(plan.buildSteps[0].rootDirectory, 'apps/web');
  assert.equal(plan.buildSteps[1].dockerfilePath, 'apps/web/Dockerfile');
});

test('lockfiles select deterministic frozen install commands', () => {
  const cases = [
    ['package-lock.json', 'npm ci'],
    ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
    ['yarn.lock', 'yarn install --frozen-lockfile'],
    ['bun.lock', 'bun install --frozen-lockfile'],
  ];
  for (const [lockfile, command] of cases) {
    const plan = resolveBuildStrategy({ name: 'web' }, {
      'package.json': JSON.stringify({ dependencies: { next: 'latest' } }),
      [lockfile]: '',
    });
    assert.equal(plan.framework.installCommand, command);
  }
});

test('source discovery suggests only example env keys and ignores dependency metadata', () => {
  const discovery = discoverSource({
    'apps/api/package.json': '{}',
    'apps/api/.env.example': 'DATABASE_URL=placeholder\nEMPTY=\n# ignored',
    'apps/api/.env': 'REAL_SECRET=never-return-this',
    'node_modules/pkg/package.json': '{}',
    '.git/config': 'secret',
  }, { serviceName: 'api' });
  assert.equal(discovery.rootDirectory, 'apps/api');
  assert.deepEqual(discovery.suggestedEnvironmentKeys, ['DATABASE_URL', 'EMPTY']);
  assert.equal(JSON.stringify(discovery).includes('placeholder'), false);
  assert.equal(JSON.stringify(discovery).includes('REAL_SECRET'), false);
  assert.deepEqual(discovery.appRoots, [{ rootDirectory: 'apps/api', signals: ['package.json'] }]);
});

test('source discovery rejects absolute and parent paths on every supported host syntax', () => {
  for (const value of ['../outside', '/etc/passwd', 'C:\\Users\\operator\\secret', '\\\\server\\share\\secret']) {
    assert.equal(normalizeSourcePath(value), '.', `${value} must stay inside the source root`);
  }
});

test('additional frameworks are detected deterministically', () => {
  const frameworks = [
    [{ 'package.json': JSON.stringify({ dependencies: { nuxt: 'latest' } }) }, 'nuxt'],
    [{ 'package.json': JSON.stringify({ dependencies: { '@sveltejs/kit': 'latest' } }) }, 'sveltekit'],
    [{ 'package.json': JSON.stringify({ dependencies: { astro: 'latest' } }) }, 'astro'],
    [{ 'requirements.txt': 'Django==5.2' }, 'django'],
    [{ 'requirements.txt': 'Flask==3.1' }, 'flask'],
    [{ 'pom.xml': '<parent><artifactId>spring-boot-starter-parent</artifactId></parent>' }, 'spring-boot'],
  ];
  for (const [files, framework] of frameworks) {
    assert.equal(resolveBuildStrategy({ name: 'app' }, files).framework.framework, framework);
  }
});

test('prebuilt image bypasses build and still has workload pipeline', () => {
  const plan = resolveBuildStrategy({ name: 'cleanup', sourceType: 'image', image: 'ghcr.io/acme/cleanup:1' });
  assert.equal(plan.mode, 'prebuilt-image');
  assert.deepEqual(plan.buildSteps, []);
  assert.equal(plan.pipeline.includes('kubernetes-workload'), true);
});

test('build execution plan can emit registry-backed BuildKit cache hints', () => {
  const plan = buildExecutionPlan(
    { name: 'api', projectSlug: 'demo', buildCache: 'registry' },
    nodeFiles,
    { sourceDir: '.', push: true },
  );
  assert.equal(plan.cache.registry, true);
  assert.equal(plan.cache.cacheFrom[0], 'type=registry,ref=registry.raibitserver.local/demo/api:latest-buildcache');
  assert.equal(plan.cache.cacheTo[0], 'type=registry,ref=registry.raibitserver.local/demo/api:latest-buildcache,mode=max');
  assert.match(plan.buildCommand, /--cache-from type=registry,ref=registry\.raibitserver\.local\/demo\/api:latest-buildcache/);
  assert.match(plan.buildCommand, /--cache-to type=registry,ref=registry\.raibitserver\.local\/demo\/api:latest-buildcache,mode=max/);
});
