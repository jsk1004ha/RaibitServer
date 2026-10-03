import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import '../fixtures/api-parity-runtime.mjs';

const apiRequire = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { downloadTemplateSource, readPackagedTemplateCatalog, validateTemplateSourceDownload } = apiRequire('./src/modules/projects/template-source.ts');
const root = path.resolve(import.meta.dirname, '../..');
const [catalogText, bundleText] = await Promise.all([
  readFile(path.join(root, 'test-fixtures/contracts/starter-catalog-v1.json'), 'utf8'),
  readFile(path.join(root, 'test-fixtures/contracts/starter-catalog-v1.bundle.json'), 'utf8'),
]);
const catalog = JSON.parse(catalogText);
const bundle = JSON.parse(bundleText);
const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const stableJson = value => Array.isArray(value) ? `[${value.map(stableJson).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}` : JSON.stringify(value);
const identity = (input = catalog, starter = input.starters[0]) => ({
  catalogId: starter.id, catalogVersion: starter.version, catalogDigest: input.catalogDigest, sourceDigest: starter.source.digest,
});
const sourceError = error => error.code === 'TEMPLATE_SOURCE_DIGEST_MISMATCH' && error.statusCode === 409;
const catalogError = error => error.code === 'TEMPLATE_CATALOG_DIGEST_MISMATCH' && error.statusCode === 409;

// Re-sign the outer documents so corrupt inner content must pass its own checks.
function altered(mutateBundle = () => {}, mutateCatalog = () => {}) {
  const nextCatalog = structuredClone(catalog);
  const nextBundle = structuredClone(bundle);
  mutateBundle(nextBundle);
  mutateCatalog(nextCatalog);
  const nextText = JSON.stringify(nextBundle);
  nextCatalog.bundleDigest = digest(nextText);
  const { catalogDigest: _old, ...body } = nextCatalog;
  nextCatalog.catalogDigest = digest(stableJson(body));
  return [nextCatalog, nextText, identity(nextCatalog)];
}

test('download returns all three catalog-pinned sources with exact file bytes', () => {
  for (const starter of catalog.starters) {
    const result = validateTemplateSourceDownload(catalog, bundleText, identity(catalog, starter));
    assert.equal(result.contentType, 'application/vnd.raibitserver.starter-source.v1+json');
    assert.equal(result.filename, `${starter.id}-${starter.version}.raibit-starter.json`);
    assert.equal(result.catalogDigest, catalog.catalogDigest);
    assert.equal(result.sourceDigest, starter.source.digest);
    assert.deepEqual(result.source, bundle.sources.find(source => source.id === starter.id));
  }
});

test('exact outer bytes and every requested identity component are required', () => {
  assert.throws(() => validateTemplateSourceDownload(catalog, `${bundleText}\n`, identity()), catalogError);
  assert.throws(() => validateTemplateSourceDownload(catalog, bundleText, { ...identity(), catalogDigest: `sha256:${'0'.repeat(64)}` }), catalogError);
  for (const overrides of [
    { catalogId: 'unknown' }, { catalogVersion: 'v2' }, { sourceDigest: `sha256:${'0'.repeat(64)}` }, { sourceDigest: undefined },
  ]) assert.throws(() => validateTemplateSourceDownload(catalog, bundleText, { ...identity(), ...overrides }), sourceError);
});

test('unsafe relative, absolute, Windows, control, and NUL paths are rejected', () => {
  for (const unsafePath of ['', '../escape', '/absolute', 'C:/escape', 'C:escape', 'dir\\file', '//host/share', 'a//b', 'a/./b', 'a/../b', 'a\0b', 'a\nb', 'a\x7fb', 'a\x85b']) {
    assert.throws(() => validateTemplateSourceDownload(...altered(value => { value.sources[0].files[0].path = unsafePath; })), sourceError, unsafePath);
  }
});

test('source and file order, uniqueness, schema, and catalog coverage are enforced', () => {
  for (const mutate of [
    value => { value.schema = 'unknown'; },
    value => { value.extra = true; },
    value => { value.sources.reverse(); },
    value => { value.sources[1] = structuredClone(value.sources[0]); },
    value => { value.sources.pop(); },
    value => { value.sources[0].id = 'unknown'; },
    value => { value.sources[0].files.reverse(); },
    value => { value.sources[0].files[1] = structuredClone(value.sources[0].files[0]); },
    value => { value.sources[0].files[0].extra = true; },
    value => { value.sources[0].files[0].mode = '0777'; },
  ]) assert.throws(() => validateTemplateSourceDownload(...altered(mutate)), sourceError);
});

test('canonical base64, per-file size/digest, source digest, and catalog counts are independently checked', () => {
  for (const mutate of [
    value => { value.sources[0].files[0].contentBase64 += '\n'; },
    value => { value.sources[0].files[0].contentBase64 = '!'; },
    value => { value.sources[0].files[0].contentBase64 = Buffer.from('changed').toString('base64'); },
    value => { value.sources[0].files[0].size += 1; },
    value => { value.sources[0].files[0].digest = `sha256:${'0'.repeat(64)}`; },
    value => { value.sources[0].digest = `sha256:${'0'.repeat(64)}`; },
    value => { value.sources[0].files[0].mode = value.sources[0].files[0].mode === '0644' ? '0755' : '0644'; },
    // An unselected source must be validated too.
    value => { value.sources.at(-1).files[0].digest = `sha256:${'0'.repeat(64)}`; },
  ]) assert.throws(() => validateTemplateSourceDownload(...altered(mutate)), sourceError);
  for (const mutate of [
    value => { value.starters[0].source.fileCount += 1; },
    value => { value.starters[0].source.byteCount += 1; },
    value => { value.starters[0].source.digest = `sha256:${'0'.repeat(64)}`; },
  ]) assert.throws(() => validateTemplateSourceDownload(...altered(undefined, mutate)), sourceError);
});

test('runtime reads packaged root files; checkout fallback is disabled in production', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'raibit-template-source-'));
  const previousDirectory = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    const fixtures = path.join(directory, 'test-fixtures/contracts');
    await mkdir(fixtures, { recursive: true });
    for (const filename of ['starter-catalog-v1.json', 'starter-catalog-v1.bundle.json']) {
      await copyFile(path.join(root, 'test-fixtures/contracts', filename), path.join(fixtures, filename));
    }
    process.chdir(directory);
    process.env.NODE_ENV = 'test';
    assert.deepEqual(await readPackagedTemplateCatalog(), catalog);
    const request = identity();
    const args = [request.catalogId, request.catalogVersion, request.catalogDigest, request.sourceDigest];
    assert.equal((await downloadTemplateSource(...args)).sourceDigest, request.sourceDigest);
    process.env.NODE_ENV = 'production';
    await assert.rejects(readPackagedTemplateCatalog, error => error.code === 'ENOENT');
    await assert.rejects(() => downloadTemplateSource(...args), error => error.code === 'ENOENT');
    for (const filename of ['starter-catalog-v1.json', 'starter-catalog-v1.bundle.json']) {
      await copyFile(path.join(fixtures, filename), path.join(directory, filename));
    }
    assert.deepEqual(await readPackagedTemplateCatalog(), catalog);
    assert.equal((await downloadTemplateSource(...args)).sourceDigest, request.sourceDigest);
  } finally {
    process.chdir(previousDirectory);
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    await rm(directory, { recursive: true, force: true });
  }
});
