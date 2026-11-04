import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildStarterArtifacts,
  canonicalSourceBundle,
  expandStarter,
  parseStarterBundle,
  readStarterArtifacts,
  verifyStarterArtifacts,
} from '../../scripts/package-starter-catalog.mjs';

const rootDir = path.resolve(import.meta.dirname, '../..');
const node = process.execPath;

test('real catalog exposes three complete immutable graphs without caller-selected paths or URLs', async () => {
  const { catalog } = await readStarterArtifacts({ rootDir });
  assert.equal(catalog.schema, 'raibitserver.starter-catalog/v1');
  assert.equal(catalog.packagingStatus, 'source-verified');
  assert.equal(catalog.starters.length, 3);
  assert.deepEqual(catalog.starters.map(({ id }) => id), ['discord-bot', 'fastapi', 'next-postgres']);

  for (const starter of catalog.starters) {
    assert.equal(starter.version, 'v1');
    assert.equal(starter.immutable, true);
    assert.match(starter.source.digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(starter.source.normalization, 'sorted-posix-paths-fixed-modes-no-timestamps');
    assert.ok(starter.source.fileCount >= 6);
    assert.ok(starter.graph.services.length >= 1);
    assert.ok(Array.isArray(starter.graph.resources));
    assert.ok(Array.isArray(starter.inputs));
    assert.ok(starter.provenance.dependencies.length >= 1);
    assert.ok(starter.provenance.baseImages.every(({ indexDigest, linuxAmd64Digest }) =>
      /^sha256:[a-f0-9]{64}$/.test(indexDigest) && /^sha256:[a-f0-9]{64}$/.test(linuxAmd64Digest)));
  }
  assert.doesNotMatch(JSON.stringify(catalog), /"(?:path|url)"\s*:/i);
});

test('all starters expand only their declared graph and preserve Dockerfile-first builds', async () => {
  const { catalog } = await readStarterArtifacts({ rootDir });
  const cases = [
    ['next-postgres', {}, ['postgresql'], 'web'],
    ['fastapi', {}, [], 'web'],
    ['discord-bot', { DISCORD_TOKEN: 'secret:discord-token' }, [], 'worker'],
  ];
  for (const [id, inputs, resourceEngines, serviceType] of cases) {
    const starter = catalog.starters.find((candidate) => candidate.id === id);
    const expanded = expandStarter(catalog, {
      id,
      version: 'v1',
      catalogDigest: catalog.catalogDigest,
      sourceDigest: starter.source.digest,
      inputs,
      resourceEngines,
    });
    assert.equal(expanded.services[0].buildMode, 'dockerfile');
    assert.equal(expanded.services[0].type, serviceType);
    assert.deepEqual(expanded.resources.map(({ engine }) => engine), resourceEngines);
  }
});

test('packaging is canonical, checked artifacts are current, and repacking preserves the real bundle hash', async () => {
  const first = await buildStarterArtifacts({ rootDir });
  const second = await buildStarterArtifacts({ rootDir });
  assert.equal(first.catalogText, second.catalogText);
  assert.equal(first.bundleText, second.bundleText);
  assert.equal(first.catalog.bundleDigest, second.catalog.bundleDigest);
  assert.match(first.catalog.bundleDigest, /^sha256:[a-f0-9]{64}$/);
  await verifyStarterArtifacts({ rootDir });
});

test('API and builder images copy the same fixed catalog and source bundle', async () => {
  const [apiDockerfile, builderDockerfile] = await Promise.all([
    readFile(path.join(rootDir, 'apps/api/Dockerfile'), 'utf8'),
    readFile(path.join(rootDir, 'services/builder/Dockerfile'), 'utf8'),
  ]);
  for (const dockerfile of [apiDockerfile, builderDockerfile]) {
    assert.match(dockerfile, /COPY .*examples\/starters/);
    assert.match(dockerfile, /starter-catalog-v1\.json/);
    assert.match(dockerfile, /starter-catalog-v1\.bundle\.json/);
  }
});

test('Next health endpoint matches the catalog, Docker probe, README and packaged App Router route', async () => {
  const sourceRoot = path.join(rootDir, 'examples/starters/next-postgres/v1');
  const [{ catalog, bundle }, source] = await Promise.all([
    readStarterArtifacts({ rootDir }), canonicalSourceBundle(sourceRoot),
  ]);
  const healthPath = catalog.starters.find(({ id }) => id === 'next-postgres').graph.services[0].healthCheck;
  assert.equal(healthPath, '/healthz');
  const packagedSource = bundle.sources.find(({ id }) => id === 'next-postgres');
  for (const { files } of [source, packagedSource]) {
    const routePaths = files.filter(({ path }) => /^app\/.+\/route\.js$/.test(path))
      .map(({ path }) => path.slice('app'.length, -'/route.js'.length));
    assert.deepEqual(routePaths, [healthPath]);
  }
  const [dockerfile, readme, route] = await Promise.all([
    readFile(path.join(sourceRoot, 'Dockerfile'), 'utf8'),
    readFile(path.join(sourceRoot, 'README.md'), 'utf8'),
    readFile(path.join(sourceRoot, 'app', healthPath.slice(1), 'route.js'), 'utf8'),
  ]);
  const healthCommand = dockerfile.split('\n').find((line) => line.startsWith('HEALTHCHECK '));
  const healthUrl = healthCommand.match(/http:\/\/127\.0\.0\.1:\d+\/[^'"]+/)?.[0];
  assert.ok(healthUrl, 'Docker healthcheck must request the declared endpoint');
  assert.equal(new URL(healthUrl).pathname, healthPath);
  assert.equal(readme.match(/`GET ([^`]+)`/)?.[1], healthPath);
  assert.match(route, /export async function GET\(/);
});

test('required input, catalog/source digests, and resource compatibility fail closed', async () => {
  const { catalog } = await readStarterArtifacts({ rootDir });
  const bot = catalog.starters.find(({ id }) => id === 'discord-bot');
  const next = catalog.starters.find(({ id }) => id === 'next-postgres');
  assert.throws(() => expandStarter(catalog, {
    id: 'discord-bot', version: 'v1', catalogDigest: catalog.catalogDigest,
    sourceDigest: bot.source.digest, inputs: {}, resourceEngines: [],
  }), /missing required input: DISCORD_TOKEN/);
  assert.throws(() => expandStarter(catalog, {
    id: 'discord-bot', version: 'v1', catalogDigest: `sha256:${'0'.repeat(64)}`,
    sourceDigest: bot.source.digest, inputs: { DISCORD_TOKEN: 'secret:x' }, resourceEngines: [],
  }), /catalog digest mismatch/);
  assert.throws(() => expandStarter(catalog, {
    id: 'discord-bot', version: 'v1', catalogDigest: catalog.catalogDigest,
    sourceDigest: `sha256:${'0'.repeat(64)}`, inputs: { DISCORD_TOKEN: 'secret:x' }, resourceEngines: [],
  }), /source digest mismatch/);
  assert.throws(() => expandStarter(catalog, {
    id: 'next-postgres', version: 'v1', catalogDigest: catalog.catalogDigest,
    sourceDigest: next.source.digest, inputs: {}, resourceEngines: [],
  }), /unsupported resource engine: postgresql/);
});

test('mutated sources, traversal bundle entries, and source symlinks are rejected', async (context) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'raibit-starters-'));
  context.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  const fixtureRoot = path.join(temporaryRoot, 'checkout');
  const { cp, mkdir } = await import('node:fs/promises');
  await mkdir(path.join(fixtureRoot, 'examples'), { recursive: true });
  await mkdir(path.join(fixtureRoot, 'test-fixtures', 'contracts'), { recursive: true });
  await cp(path.join(rootDir, 'examples', 'starters'), path.join(fixtureRoot, 'examples', 'starters'), { recursive: true });
  await cp(path.join(rootDir, 'test-fixtures', 'contracts', 'starter-catalog-v1.json'), path.join(fixtureRoot, 'test-fixtures', 'contracts', 'starter-catalog-v1.json'));
  await cp(path.join(rootDir, 'test-fixtures', 'contracts', 'starter-catalog-v1.bundle.json'), path.join(fixtureRoot, 'test-fixtures', 'contracts', 'starter-catalog-v1.bundle.json'));
  await writeFile(path.join(fixtureRoot, 'examples', 'starters', 'fastapi', 'v1', 'README.md'), 'mutated\n');
  await assert.rejects(verifyStarterArtifacts({ rootDir: fixtureRoot }), /generated starter artifacts are stale/);

  const { bundle } = await readStarterArtifacts({ rootDir });
  const hostile = structuredClone(bundle);
  hostile.sources[0].files[0].path = '../escape';
  assert.throws(() => parseStarterBundle(JSON.stringify(hostile)), /unsafe bundle path/);
  const corrupted = structuredClone(bundle);
  corrupted.sources[0].files[0].contentBase64 = Buffer.from('corrupted').toString('base64');
  assert.throws(() => parseStarterBundle(JSON.stringify(corrupted)), /bundle file digest mismatch/);

  const sourceRoot = path.join(fixtureRoot, 'examples', 'starters', 'discord-bot', 'v1');
  const link = path.join(sourceRoot, 'linked-app');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(path.join(sourceRoot, 'src'), link, linkType);
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  await assert.rejects(canonicalSourceBundle(sourceRoot), /symbolic links are forbidden/);
  context.diagnostic(`${process.platform}: rejected real ${linkType} at ${link}`);
});

test('starter entrypoints expose health checks and bot self-test is tokenless but live mode is not', async () => {
  const { bundle } = await readStarterArtifacts({ rootDir });
  for (const source of bundle.sources) {
    const names = source.files.map((file) => file.path);
    assert.ok(names.includes('Dockerfile'));
    assert.ok(names.includes('README.md'));
    assert.ok(names.includes('.env.example'));
    assert.ok(names.some((name) => name.endsWith('lock.yaml') || name.endsWith('requirements.lock')));
    const dockerfile = Buffer.from(source.files.find((file) => file.path === 'Dockerfile').contentBase64, 'base64').toString('utf8');
    assert.match(dockerfile, /HEALTHCHECK/);
  }
  const sourceText = bundle.sources.flatMap(({ files }) => files.map(({ contentBase64 }) => Buffer.from(contentBase64, 'base64').toString('utf8'))).join('\n');
  assert.doesNotMatch(sourceText, /postgresql:\/\/[^\s"']+:[^\s"']+@|DISCORD_TOKEN=\S+/);
  const nextRoute = await readFile(path.join(rootDir, 'examples/starters/next-postgres/v1/app/healthz/route.js'), 'utf8');
  const fastapiMain = await readFile(path.join(rootDir, 'examples/starters/fastapi/v1/app/main.py'), 'utf8');
  assert.match(nextRoute, /CREATE SCHEMA IF NOT EXISTS raibit_starter/);
  assert.match(nextRoute, /INSERT INTO raibit_starter\.health_probe/);
  assert.match(fastapiMain, /@app\.get\('\/healthz'\)/);

  const botEntrypoint = path.join(rootDir, 'examples/starters/discord-bot/v1/src/index.mjs');
  const output = execFileSync(node, [botEntrypoint, '--self-test'], { encoding: 'utf8', env: { ...process.env, DISCORD_TOKEN: '' } });
  assert.equal(JSON.parse(output).status, 'self-test-ok');
  assert.throws(() => execFileSync(node, [botEntrypoint], {
    encoding: 'utf8', env: { ...process.env, DISCORD_TOKEN: '' }, stdio: 'pipe',
  }), /Command failed/);
});
