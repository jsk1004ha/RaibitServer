import path from 'node:path';

const { posix } = path;

type FileMap = Record<string, unknown>;
type AnyRecord = Record<string, any>;

const IGNORED_SEGMENTS = new Set(['.git', 'node_modules']);
const MANIFEST_NAMES = new Set([
  'package.json',
  'requirements.txt',
  'pyproject.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'go.mod',
  'index.html',
]);
const LOCKFILE_MANAGERS: Record<string, string> = {
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
};

export function normalizeSourcePath(value: unknown, fallback = '.') {
  const input = String(value || fallback).trim().replaceAll('\\', '/');
  if (/^[A-Za-z]:\//.test(input) || input.startsWith('//')) return fallback;
  const normalized = posix.normalize(input || fallback).replace(/^\.\//, '').replace(/\/$/, '') || '.';
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) return fallback;
  return normalized;
}

function isIgnoredPath(path: string) {
  return path.split('/').some((segment) => IGNORED_SEGMENTS.has(segment));
}

function isSecretEnvFile(name: string) {
  const basename = posix.basename(name).toLowerCase();
  return basename.startsWith('.env') && !basename.endsWith('.example') && !basename.endsWith('.sample');
}

function normalizedFiles(files: FileMap = {}) {
  const normalized: FileMap = {};
  for (const [rawPath, contents] of Object.entries(files || {})) {
    const path = normalizeSourcePath(rawPath, '');
    if (!path || path === '.' || isIgnoredPath(path) || isSecretEnvFile(path)) continue;
    normalized[path] = contents;
  }
  return normalized;
}

function directoryOf(path: string) {
  const directory = posix.dirname(path);
  return directory === '.' ? '.' : directory;
}

function isDockerfile(path: string) {
  return /^dockerfile(?:\..+)?$/i.test(posix.basename(path));
}

function envKeys(contents: unknown) {
  const keys = new Set<string>();
  for (const line of String(contents || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match) keys.add(match[1]);
  }
  return [...keys].sort();
}

function candidateRoots(files: FileMap) {
  const roots = new Map<string, Set<string>>();
  for (const path of Object.keys(files)) {
    const basename = posix.basename(path);
    if (!MANIFEST_NAMES.has(basename) && !isDockerfile(path)) continue;
    const root = directoryOf(path);
    const signals = roots.get(root) || new Set<string>();
    signals.add(isDockerfile(path) ? 'Dockerfile' : basename);
    roots.set(root, signals);
  }
  return [...roots.entries()]
    .map(([rootDirectory, signals]) => ({ rootDirectory, signals: [...signals].sort() }))
    .sort((a, b) => a.rootDirectory.localeCompare(b.rootDirectory));
}

function chooseRoot(candidates: Array<{ rootDirectory: string; signals: string[] }>, requestedRoot: string, serviceName?: string) {
  if (requestedRoot !== '.') return requestedRoot;
  if (candidates.some((candidate) => candidate.rootDirectory === '.')) return '.';
  const runnable = candidates.filter((candidate) => candidate.signals.some((signal) => signal === 'Dockerfile' || MANIFEST_NAMES.has(signal)));
  if (serviceName) {
    const normalizedName = normalizeSourcePath(serviceName).toLowerCase();
    const named = runnable.filter((candidate) => posix.basename(candidate.rootDirectory).toLowerCase() === normalizedName);
    if (named.length === 1) return named[0].rootDirectory;
  }
  return runnable.length === 1 ? runnable[0].rootDirectory : '.';
}

function pathIsWithinRoot(path: string, root: string) {
  return root === '.' || path === root || path.startsWith(`${root}/`);
}

export function filesAtSourceRoot(files: FileMap = {}, rootDirectory = '.') {
  const root = normalizeSourcePath(rootDirectory);
  const scoped: FileMap = {};
  for (const [path, contents] of Object.entries(normalizedFiles(files))) {
    if (!pathIsWithinRoot(path, root)) continue;
    const relative = root === '.' ? path : path.slice(root.length + 1);
    if (relative && !relative.includes('/')) scoped[relative] = contents;
  }
  return scoped;
}

export function discoverSource(files: FileMap = {}, options: AnyRecord = {}) {
  const safeFiles = normalizedFiles(files);
  const requestedRoot = normalizeSourcePath(options.rootDirectory || '.');
  const appRoots = candidateRoots(safeFiles);
  const rootDirectory = chooseRoot(appRoots, requestedRoot, options.serviceName || options.name);
  const rootFiles = Object.keys(safeFiles).filter((path) => pathIsWithinRoot(path, rootDirectory));
  const dockerfiles = rootFiles.filter(isDockerfile).sort((a, b) => {
    const aAtRoot = directoryOf(a) === rootDirectory ? 0 : 1;
    const bAtRoot = directoryOf(b) === rootDirectory ? 0 : 1;
    return aAtRoot - bAtRoot || a.localeCompare(b);
  });
  const manifestFiles = rootFiles.filter((path) => MANIFEST_NAMES.has(posix.basename(path))).sort();
  const lockfiles = rootFiles.filter((path) => LOCKFILE_MANAGERS[posix.basename(path)]).sort((a, b) => {
    const aAtRoot = directoryOf(a) === rootDirectory ? 0 : 1;
    const bAtRoot = directoryOf(b) === rootDirectory ? 0 : 1;
    return aAtRoot - bAtRoot || a.localeCompare(b);
  });
  const environmentKeys = new Set<string>();
  for (const path of rootFiles.filter((path) => /\.env\.(?:example|sample)$/i.test(posix.basename(path)))) {
    for (const key of envKeys(safeFiles[path])) environmentKeys.add(key);
  }
  const lockfilePath = lockfiles[0] || null;

  return {
    rootDirectory,
    dockerfilePath: dockerfiles[0] || null,
    manifestFiles,
    lockfilePath,
    packageManager: lockfilePath ? LOCKFILE_MANAGERS[posix.basename(lockfilePath)] : null,
    suggestedEnvironmentKeys: [...environmentKeys].sort(),
    appRoots,
  };
}
