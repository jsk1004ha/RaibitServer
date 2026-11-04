import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_IMAGE = {
  image: 'node:24.14.0-bookworm-slim',
  indexDigest: 'sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8',
  linuxAmd64Digest: 'sha256:4bd6219054c8bebcd26a66bfd8ca0bd6e1024b4b97474c59bb7ee3bbcbef4fe8',
};
const PYTHON_IMAGE = {
  image: 'python:3.13-slim-bookworm',
  indexDigest: 'sha256:ed86c82274b3c69b52fb5820f358f0bd7df0b603332063cb5c6e32bd220c3e6e',
  linuxAmd64Digest: 'sha256:2f2e5a876c71a6757f55ec57f2add0225ddaf01c802a33fcc29073943f94d907',
};
const STARTERS = [
  {
    id: 'discord-bot', version: 'v1', lock: 'pnpm-lock.yaml',
    graph: { services: [{ logicalSlug: 'bot', type: 'worker', buildMode: 'dockerfile', ingress: false, environment: { DISCORD_TOKEN: { input: 'DISCORD_TOKEN' } } }], resources: [] },
    inputs: [{ key: 'DISCORD_TOKEN', kind: 'secret', required: true }], defaults: {},
    dependencies: [{ name: 'discord.js', version: '14.27.0' }], baseImages: [NODE_IMAGE],
  },
  {
    id: 'fastapi', version: 'v1', lock: 'requirements.lock',
    graph: { services: [{ logicalSlug: 'web', type: 'web', buildMode: 'dockerfile', ingress: true, port: 8000, healthCheck: '/healthz', environment: { PORT: { default: '8000' } } }], resources: [] },
    inputs: [], defaults: { PORT: '8000' },
    dependencies: [{ name: 'fastapi', version: '0.141.1' }, { name: 'uvicorn', version: '0.52.4' }], baseImages: [PYTHON_IMAGE],
  },
  {
    id: 'next-postgres', version: 'v1', lock: 'pnpm-lock.yaml',
    graph: {
      services: [{ logicalSlug: 'web', type: 'web', buildMode: 'dockerfile', ingress: true, port: 3000, healthCheck: '/healthz', environment: { DATABASE_URL: { resource: 'postgres', secretKey: 'DATABASE_URL' }, PORT: { default: '3000' } } }],
      resources: [{ logicalSlug: 'postgres', engine: 'postgresql', plan: 'starter' }],
    },
    inputs: [], defaults: { PORT: '3000' },
    dependencies: [{ name: 'next', version: '16.2.6' }, { name: 'react', version: '19.2.6' }, { name: 'react-dom', version: '19.2.6' }, { name: 'pg', version: '8.23.0' }], baseImages: [NODE_IMAGE],
  },
];

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const artifactPaths = (rootDir) => ({
  catalog: path.join(rootDir, 'test-fixtures/contracts/starter-catalog-v1.json'),
  bundle: path.join(rootDir, 'test-fixtures/contracts/starter-catalog-v1.bundle.json'),
});

export class StarterCatalogError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StarterCatalogError';
  }
}

function safeBundlePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || path.posix.isAbsolute(value)) throw new StarterCatalogError(`unsafe bundle path: ${String(value)}`);
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) throw new StarterCatalogError(`unsafe bundle path: ${value}`);
  return value;
}

async function sourceFiles(directory, relative = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const relativePath = safeBundlePath(relative ? `${relative}/${entry.name}` : entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new StarterCatalogError(`symbolic links are forbidden: ${relativePath}`);
    if (entry.isDirectory()) files.push(...await sourceFiles(absolutePath, relativePath));
    else if (entry.isFile()) {
      const content = await readFile(absolutePath);
      const stats = await lstat(absolutePath);
      files.push({ path: relativePath, mode: stats.mode & 0o111 ? '0755' : '0644', size: content.length, digest: digest(content), contentBase64: content.toString('base64') });
    } else throw new StarterCatalogError(`unsupported source entry: ${relativePath}`);
  }
  return files;
}

function sourceDigest(files) {
  const hash = createHash('sha256');
  for (const file of files) {
    const content = Buffer.from(file.contentBase64, 'base64');
    hash.update(`${safeBundlePath(file.path)}\0${file.mode}\0${content.length}\0`);
    hash.update(content);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

export async function canonicalSourceBundle(sourceRoot) {
  const rootStats = await lstat(sourceRoot);
  if (rootStats.isSymbolicLink()) throw new StarterCatalogError('symbolic links are forbidden: source root');
  const files = await sourceFiles(sourceRoot);
  return { files, digest: sourceDigest(files) };
}

function validateBundle(bundle) {
  if (!bundle || bundle.schema !== 'raibitserver.starter-source-bundle/v1' || !Array.isArray(bundle.sources)) throw new StarterCatalogError('invalid starter bundle schema');
  let previousSource = '';
  for (const source of bundle.sources) {
    const sourceKey = `${source.id}/${source.version}`;
    if (sourceKey <= previousSource || !Array.isArray(source.files)) throw new StarterCatalogError('starter bundle sources are not canonical');
    previousSource = sourceKey;
    let previousPath = '';
    for (const file of source.files) {
      const checkedPath = safeBundlePath(file.path);
      if (checkedPath <= previousPath || !['0644', '0755'].includes(file.mode)) throw new StarterCatalogError('starter bundle files are not canonical');
      const content = Buffer.from(file.contentBase64, 'base64');
      if (file.size !== content.length || file.digest !== digest(content)) throw new StarterCatalogError(`bundle file digest mismatch: ${checkedPath}`);
      previousPath = checkedPath;
    }
    if (source.digest !== sourceDigest(source.files)) throw new StarterCatalogError(`source digest mismatch: ${source.id}`);
  }
  return bundle;
}

export function parseStarterBundle(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) { throw new StarterCatalogError(error instanceof Error ? `invalid starter bundle JSON: ${error.message}` : 'invalid starter bundle JSON'); }
  return validateBundle(parsed);
}

export async function buildStarterArtifacts({ rootDir = defaultRoot } = {}) {
  const sources = [];
  for (const definition of STARTERS) {
    const sourceRoot = path.join(rootDir, 'examples/starters', definition.id, definition.version);
    const source = await canonicalSourceBundle(sourceRoot);
    sources.push({ id: definition.id, version: definition.version, digest: source.digest, files: source.files });
  }
  const bundle = { schema: 'raibitserver.starter-source-bundle/v1', sources };
  const bundleText = `${stableJson(bundle)}\n`;
  const bundleDigest = digest(bundleText);
  const starters = [];
  for (const definition of STARTERS) {
    const source = sources.find((candidate) => candidate.id === definition.id);
    const lockContent = await readFile(path.join(rootDir, 'examples/starters', definition.id, definition.version, definition.lock));
    starters.push({
      id: definition.id, version: definition.version, immutable: true,
      source: { digest: source.digest, format: 'canonical-json-v1', normalization: 'sorted-posix-paths-fixed-modes-no-timestamps', fileCount: source.files.length, byteCount: source.files.reduce((total, file) => total + file.size, 0) },
      graph: definition.graph, inputs: definition.inputs, defaults: definition.defaults,
      provenance: { observedBefore: '2026-09-13T00:00:00Z', dependencyLockDigest: digest(lockContent), dependencies: definition.dependencies, baseImages: definition.baseImages },
    });
  }
  const catalogBody = { schema: 'raibitserver.starter-catalog/v1', packagingStatus: 'source-verified', immutable: true, bundleDigest, starters };
  const catalog = { ...catalogBody, catalogDigest: digest(stableJson(catalogBody)) };
  return { catalog, bundle, catalogText: `${stableJson(catalog)}\n`, bundleText };
}

export async function readStarterArtifacts({ rootDir = defaultRoot } = {}) {
  const locations = artifactPaths(rootDir);
  const [catalogText, bundleText] = await Promise.all([readFile(locations.catalog, 'utf8'), readFile(locations.bundle, 'utf8')]);
  const catalog = JSON.parse(catalogText);
  const bundle = parseStarterBundle(bundleText);
  const { catalogDigest, ...catalogBody } = catalog;
  if (catalogDigest !== digest(stableJson(catalogBody))) throw new StarterCatalogError('catalog digest mismatch');
  if (catalog.bundleDigest !== digest(bundleText)) throw new StarterCatalogError('bundle digest mismatch');
  return { catalog, bundle, catalogText, bundleText };
}

export async function verifyStarterArtifacts({ rootDir = defaultRoot } = {}) {
  const [checked, generated] = await Promise.all([readStarterArtifacts({ rootDir }), buildStarterArtifacts({ rootDir })]);
  if (checked.catalogText !== generated.catalogText || checked.bundleText !== generated.bundleText) throw new StarterCatalogError('generated starter artifacts are stale');
  return generated.catalog;
}

export async function writeStarterArtifacts({ rootDir = defaultRoot } = {}) {
  const generated = await buildStarterArtifacts({ rootDir });
  const locations = artifactPaths(rootDir);
  await mkdir(path.dirname(locations.catalog), { recursive: true });
  await Promise.all([writeFile(locations.catalog, generated.catalogText), writeFile(locations.bundle, generated.bundleText)]);
  return generated.catalog;
}

export function expandStarter(catalog, request) {
  if (request.catalogDigest !== catalog.catalogDigest) throw new StarterCatalogError('catalog digest mismatch');
  const starter = catalog.starters.find((candidate) => candidate.id === request.id && candidate.version === request.version);
  if (!starter) throw new StarterCatalogError('unknown starter id/version');
  if (request.sourceDigest !== starter.source.digest) throw new StarterCatalogError('source digest mismatch');
  for (const input of starter.inputs) if (input.required && (!Object.hasOwn(request.inputs, input.key) || request.inputs[input.key] === '')) throw new StarterCatalogError(`missing required input: ${input.key}`);
  for (const key of Object.keys(request.inputs)) if (!starter.inputs.some((input) => input.key === key)) throw new StarterCatalogError(`undeclared input: ${key}`);
  for (const resource of starter.graph.resources) if (!request.resourceEngines.includes(resource.engine)) throw new StarterCatalogError(`unsupported resource engine: ${resource.engine}`);
  return structuredClone(starter.graph);
}
